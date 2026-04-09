import asyncio
import datetime
import json
import logging
import uuid
from typing import Any

from sqlmodel import Session, select

from app.database import engine
from app.models.agent import Agent, AgentStatus, AgentType
from app.models.run import (
    GraphRun,
    GraphRunEdge,
    GraphRunNode,
    RunNodeSourceType,
    RunNodeState,
    RunNodeType,
    RunState,
)
from app.models.sandbox import Sandbox
from app.models.template import SchemaTemplate
from app.models.worker import Worker
from app.services import controller as controller_svc
from app.services import events as event_svc
from app.services import sandboxes as sandbox_svc
from app.services import workers as worker_svc
from app.services.worker_client import execute_command, post_session_with_retry
from app.utils.output_schema import validate_output_against_schema
from app.utils.slugify import slugify

logger = logging.getLogger(__name__)
MAX_RUN_NODE_ATTEMPTS = 3

TOOL_FILE_CONTENT = """\
import { tool } from "@opencode/tool";

export default tool({
  name: "mark_node_complete",
  description: "Call this tool when you have completed the task assigned to you. Pass your output as a JSON object matching the required output schema.",
  parameters: {
    type: "object",
    properties: {
      output: {
        type: "object",
        description: "The output data for this node. Must match the node's output schema if one is defined.",
      },
    },
    required: [],
  },
  async execute(params) {
    return JSON.stringify({ status: "complete", output: params.output ?? {} });
  },
});
"""


def _persist_run_node_event(
    session: Session,
    run: GraphRun,
    node: GraphRunNode,
    event_type: str,
    *,
    data: dict[str, Any] | None = None,
    worker_id: uuid.UUID | None = None,
) -> None:
    event_svc.persist_event(
        session,
        workspace_id=run.workspace_id,
        source_type="run",
        source_id=str(node.id),
        payload={
            "id": str(uuid.uuid4()),
            "type": event_type,
            "timestamp": datetime.datetime.utcnow().isoformat(),
            "data": {
                "node_type": node.node_type,
                "node_state": node.state,
                "attempt": node.attempt,
                **(data or {}),
            },
        },
        source_name=node.name,
        session_id=node.session_id,
        agent_id=node.agent_id,
        run_id=run.id,
        node_id=node.id,
        sandbox_id=run.sandbox_id,
        worker_id=worker_id,
    )


def _build_predecessor_context(session: Session, run: GraphRun, node: GraphRunNode) -> dict[str, Any]:
    """Build Jinja2 context from completed predecessor nodes."""
    predecessor_ids = {
        e.from_run_node_id for e in run.run_edges if e.to_run_node_id == node.id
    }
    context: dict[str, Any] = {}
    for pred_id in predecessor_ids:
        pred = session.get(GraphRunNode, pred_id)
        if pred and pred.state == RunNodeState.completed and pred.name:
            slug = slugify(pred.name)
            output_data = pred.output or {}
            context[slug] = {**output_data, "output": output_data}
    return context


def _resolve_output_references(session: Session, run: GraphRun, node: GraphRunNode) -> str | None:
    """Resolve {{ slug.field }} references in a node's prompt/command using completed predecessors."""
    text = node.prompt if node.node_type == RunNodeType.agent else node.command
    if not text or "{{" not in text:
        return text

    context = _build_predecessor_context(session, run, node)
    from app.services.graphs import _jinja_env

    return _jinja_env.from_string(text).render(context)


def _resolve_image_references(
    session: Session,
    run: GraphRun,
    node: GraphRunNode,
) -> list[dict[str, Any]] | None:
    """Resolve {{ slug.field }} references in image URLs/paths using completed predecessors."""
    if not node.image_attachments:
        return node.image_attachments

    images = node.image_attachments
    has_templates = any(
        "{{" in (img.get("url", "") or img.get("path", "") or "")
        for img in images
    )
    if not has_templates:
        return node.image_attachments

    context = _build_predecessor_context(session, run, node)
    from app.services.graphs import _jinja_env

    resolved = []
    for img in images:
        new_img = dict(img)
        if img.get("url") and "{{" in img["url"]:
            new_img["url"] = _jinja_env.from_string(img["url"]).render(context)
        if img.get("path") and "{{" in img["path"]:
            new_img["path"] = _jinja_env.from_string(img["path"]).render(context)
        resolved.append(new_img)

    return resolved


def _collect_child_run_output(session: Session, run: GraphRun) -> dict | None:
    """Collect outputs from leaf nodes (no outgoing edges) of a completed run."""
    outgoing = {e.from_run_node_id for e in run.run_edges}
    leaf_nodes = [
        n
        for n in run.run_nodes
        if n.id not in outgoing and n.state == RunNodeState.completed
    ]
    if not leaf_nodes:
        return None
    # Single leaf: use its output directly
    if len(leaf_nodes) == 1 and leaf_nodes[0].output:
        return leaf_nodes[0].output
    # Multiple leaves: merge keyed by slugified node name
    merged: dict = {}
    for leaf in leaf_nodes:
        if leaf.output:
            leaf_data = leaf.output
            if leaf.name:
                merged[slugify(leaf.name)] = leaf_data
            else:
                merged.update(leaf_data)
    return merged or None


def enqueue_run(session: Session, run_id: uuid.UUID, reason: str | None = None) -> None:
    controller_svc.enqueue_run_reconcile(session, run_id, reason=reason)


def _parent_run_id(session: Session, child_run: GraphRun) -> uuid.UUID:
    """Get the run_id of the parent run node."""
    parent_node = session.get(GraphRunNode, child_run.parent_run_node_id)
    assert parent_node is not None
    return parent_node.run_id


def _parent_run(session: Session, child_run: GraphRun) -> GraphRun | None:
    if child_run.parent_run_node_id is None:
        return None
    parent_node = session.get(GraphRunNode, child_run.parent_run_node_id)
    if parent_node is None:
        return None
    return session.get(GraphRun, parent_node.run_id)


def _get_unblocked_nodes(
    run_nodes: list[GraphRunNode],
    run_edges: list[GraphRunEdge],
) -> list[GraphRunNode]:
    predecessors: dict[uuid.UUID, set[uuid.UUID]] = {n.id: set() for n in run_nodes}
    for edge in run_edges:
        predecessors[edge.to_run_node_id].add(edge.from_run_node_id)

    completed_ids = {n.id for n in run_nodes if n.state == RunNodeState.completed}
    return [
        node
        for node in run_nodes
        if node.state == RunNodeState.pending
        and predecessors[node.id].issubset(completed_ids)
    ]


def _active_run_nodes(run_nodes: list[GraphRunNode]) -> list[GraphRunNode]:
    return [node for node in run_nodes if node.next_attempt_run_node_id is None]


def _active_run_edges(
    run_edges: list[GraphRunEdge],
    active_nodes: list[GraphRunNode],
) -> list[GraphRunEdge]:
    active_ids = {node.id for node in active_nodes}
    return [
        edge
        for edge in run_edges
        if edge.from_run_node_id in active_ids and edge.to_run_node_id in active_ids
    ]


def _create_retry_attempt(
    session: Session,
    run: GraphRun,
    node: GraphRunNode,
) -> GraphRunNode:
    retry = GraphRunNode(
        run_id=run.id,
        source_node_id=node.source_node_id,
        source_type=node.source_type,
        attempt=node.attempt + 1,
        retry_of_run_node_id=node.id,
        node_type=node.node_type,
        name=node.name,
        state=RunNodeState.pending,
        agent_type=node.agent_type,
        model=node.model,
        prompt=node.prompt,
        command=node.command,
        graph_tools=node.graph_tools,
        output_schema=node.output_schema,
        image_attachments=node.image_attachments,
    )
    session.add(retry)
    session.flush()

    edges = list(
        session.exec(
            select(GraphRunEdge).where(GraphRunEdge.run_id == run.id)
        ).all()
    )
    for edge in edges:
        if edge.from_run_node_id == node.id:
            session.add(
                GraphRunEdge(
                    run_id=run.id,
                    from_run_node_id=retry.id,
                    to_run_node_id=edge.to_run_node_id,
                )
            )
        if edge.to_run_node_id == node.id:
            session.add(
                GraphRunEdge(
                    run_id=run.id,
                    from_run_node_id=edge.from_run_node_id,
                    to_run_node_id=retry.id,
                )
            )

    node.next_attempt_run_node_id = retry.id
    node.updated_at = datetime.datetime.utcnow()
    session.add(node)
    session.flush()
    return retry


async def _ensure_workspace_dir(worker_url: str, workspace_dir: str) -> None:
    await execute_command(
        worker_url,
        command=["bash", "-c", f"mkdir -p '{workspace_dir}'"],
        cwd="/",
        timeout=10,
        request_timeout=15.0,
    )


_MEDIA_TYPE_MAP = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
}


def _guess_media_type(path: str) -> str:
    import os
    ext = os.path.splitext(path)[1].lower()
    return _MEDIA_TYPE_MAP.get(ext, "image/png")


async def _read_sandbox_file_base64(worker_url: str, path: str) -> str:
    """Read a file from the sandbox and return its base64-encoded content."""
    result = await execute_command(
        worker_url,
        command=["base64", path],
        cwd="/",
        timeout=30,
        request_timeout=35.0,
    )
    if result.get("exit_code", 1) != 0:
        raise RuntimeError(f"Failed to read image {path}: {result.get('stderr', '')}")
    return result["stdout"].strip()


async def _resolve_images(
    worker_url: str,
    images: list[dict[str, Any]] | None,
) -> list[dict[str, str]] | None:
    """Resolve image attachments, reading sandbox files as base64."""
    if not images:
        return None
    resolved = []
    for img in images:
        if img["type"] == "url":
            resolved.append({"type": "url", "url": img["url"]})
        elif img["type"] == "sandbox_path":
            data = await _read_sandbox_file_base64(worker_url, img["path"])
            resolved.append({
                "type": "base64",
                "data": data,
                "media_type": _guess_media_type(img["path"]),
            })
    return resolved or None


# TODO: renderable type registry — when adding new renderable types, add
# their JSON Schema mapping here.
_SCHEMA_TYPE_MAP = {
    "string": "string",
    "number": "number",
    "boolean": "boolean",
    "image": "string",
}


def _make_schema_resolver(session: Session):
    """Create a schema_resolver callback for validate_output_against_schema."""
    cache: dict[str, dict[str, str] | None] = {}

    def resolve(schema_id: str) -> dict[str, str] | None:
        if schema_id in cache:
            return cache[schema_id]
        try:
            tmpl = session.get(SchemaTemplate, uuid.UUID(schema_id))
        except ValueError:
            cache[schema_id] = None
            return None
        if tmpl is None or tmpl.deleted:
            cache[schema_id] = None
            return None
        cache[schema_id] = tmpl.fields
        return tmpl.fields

    return resolve


def _expand_type_to_json_schema(
    field_type: str,
    session: Session,
    visited: set[uuid.UUID] | None = None,
) -> dict[str, Any]:
    """Expand an output schema field type string to a JSON Schema fragment.

    Handles primitives, schema references (recursively), list, and map containers.
    """
    # Container: list
    if field_type.startswith("list:"):
        inner = field_type[len("list:"):]
        return {
            "type": "array",
            "items": _expand_type_to_json_schema(inner, session, visited),
        }

    # Container: map (string-keyed object)
    if field_type.startswith("map:"):
        inner = field_type[len("map:"):]
        return {
            "type": "object",
            "additionalProperties": _expand_type_to_json_schema(inner, session, visited),
        }

    # Schema reference
    if field_type.startswith("schema:"):
        schema_uuid_str = field_type[len("schema:"):]
        try:
            schema_id = uuid.UUID(schema_uuid_str)
        except ValueError:
            return {"type": "object"}
        visited = (visited or set()) | {schema_id}
        tmpl = session.get(SchemaTemplate, schema_id)
        if not tmpl or not tmpl.fields:
            return {"type": "object"}
        props: dict[str, Any] = {}
        for name, ftype in tmpl.fields.items():
            # Prevent infinite recursion (should not happen if cycles are blocked)
            if ftype.startswith("schema:"):
                try:
                    ref_id = uuid.UUID(ftype[len("schema:"):])
                except ValueError:
                    props[name] = {"type": "object"}
                    continue
                if ref_id in visited:
                    props[name] = {"type": "object"}
                    continue
            props[name] = _expand_type_to_json_schema(ftype, session, visited)
        return {
            "type": "object",
            "properties": props,
            "required": list(tmpl.fields.keys()),
        }

    # Primitive / renderable type
    json_type = _SCHEMA_TYPE_MAP.get(field_type, "string")
    return {"type": json_type}


def _expand_output_schema_for_worker(
    output_schema: dict[str, str] | None,
    session: Session,
) -> dict[str, Any] | None:
    """Expand schema references in an output_schema for the worker.

    Replaces "schema:<uuid>" (and list/map wrappers) with inline expanded
    dicts so the worker can build Pydantic models without DB access.

    Primitive types pass through unchanged as strings.
    Complex types become dicts: {"_type": "object", "fields": {...}} etc.
    """
    if not output_schema:
        return output_schema
    expanded: dict[str, Any] = {}
    for field_name, field_type in output_schema.items():
        if _is_complex_type(field_type):
            expanded[field_name] = _expand_type_for_worker(field_type, session, set())
        else:
            expanded[field_name] = field_type
    return expanded


def _is_complex_type(field_type: str) -> bool:
    """Check if a field type requires expansion (is not a bare primitive)."""
    return (
        field_type.startswith("schema:")
        or field_type.startswith("list:")
        or field_type.startswith("map:")
    )


def _expand_type_for_worker(
    field_type: str,
    session: Session,
    visited: set[uuid.UUID],
) -> dict[str, Any] | str:
    """Expand a single type string for the worker payload."""
    if field_type.startswith("list:"):
        inner = field_type[len("list:"):]
        if _is_complex_type(inner):
            return {"_type": "list", "items": _expand_type_for_worker(inner, session, visited)}
        return {"_type": "list", "items": inner}

    if field_type.startswith("map:"):
        inner = field_type[len("map:"):]
        if _is_complex_type(inner):
            return {"_type": "map", "values": _expand_type_for_worker(inner, session, visited)}
        return {"_type": "map", "values": inner}

    if field_type.startswith("schema:"):
        try:
            schema_id = uuid.UUID(field_type[len("schema:"):])
        except ValueError:
            return {"_type": "object", "fields": {}}
        if schema_id in visited:
            return {"_type": "object", "fields": {}}
        visited = visited | {schema_id}
        tmpl = session.get(SchemaTemplate, schema_id)
        if not tmpl or not tmpl.fields:
            return {"_type": "object", "fields": {}}
        expanded_fields: dict[str, Any] = {}
        for name, ftype in tmpl.fields.items():
            if _is_complex_type(ftype):
                expanded_fields[name] = _expand_type_for_worker(ftype, session, visited)
            else:
                expanded_fields[name] = ftype
        return {"_type": "object", "fields": expanded_fields}

    return field_type


def _generate_tool_content(
    output_schema: dict[str, str] | None,
    session: Session | None = None,
) -> str:
    """Generate mark_node_complete tool content with typed parameters when schema is provided."""
    if not output_schema:
        return TOOL_FILE_CONTENT

    properties: dict[str, dict] = {}
    for field_name, field_type in output_schema.items():
        if session and _is_complex_type(field_type):
            # Expand complex types to full JSON Schema
            properties[field_name] = _expand_type_to_json_schema(
                field_type, session
            )
            properties[field_name]["description"] = (
                f"The {field_name} output field ({field_type})"
            )
        else:
            json_type = _SCHEMA_TYPE_MAP.get(field_type, "string")
            desc = f"The {field_name} output field ({field_type})"
            if field_type == "image":
                desc += ". Provide a URL or data URI (data:image/...;base64,...)"
            properties[field_name] = {
                "type": json_type,
                "description": desc,
            }

    required = list(output_schema.keys())

    params_json = json.dumps({
        "type": "object",
        "properties": {
            "output": {
                "type": "object",
                "description": "The output data for this node. Must match the required output schema.",
                "properties": properties,
                "required": required,
            },
        },
        "required": ["output"],
    }, indent=6)

    return (
        'import { tool } from "@opencode/tool";\n'
        "\n"
        "export default tool({\n"
        '  name: "mark_node_complete",\n'
        '  description: "Call this tool when you have completed the task assigned to you. '
        'Pass your output as a JSON object matching the required output schema.",\n'
        f"  parameters: {params_json},\n"
        "  async execute(params) {\n"
        '    return JSON.stringify({ status: "complete", output: params.output ?? {} });\n'
        "  },\n"
        "});\n"
    )


async def _place_tool_file(
    worker_url: str,
    workspace_dir: str,
    output_schema: dict[str, str] | None = None,
    db_session: Session | None = None,
) -> None:
    tool_content = _generate_tool_content(output_schema, session=db_session)
    script = (
        f"mkdir -p '{workspace_dir}/.opencode/tools' && "
        f"cat > '{workspace_dir}/.opencode/tools/mark_node_complete.ts' << 'TOOLEOF'\n"
        f"{tool_content}TOOLEOF"
    )
    result = await execute_command(
        worker_url,
        command=["bash", "-c", script],
        cwd="/",
        timeout=10,
        request_timeout=15.0,
    )
    if result.get("exit_code", 1) != 0:
        raise RuntimeError(f"Failed to place tool file: {result.get('stderr', '')}")


async def reconcile_run(run_id: uuid.UUID) -> None:
    with Session(engine) as session:
        run = session.get(GraphRun, run_id)
        if run is None or run.deleted:
            return

        if run.state == RunState.error:
            if run.parent_run_node_id is None:
                _maybe_release_run_sandbox(session, run)
            return

        active_nodes = _active_run_nodes(list(run.run_nodes))
        active_edges = _active_run_edges(list(run.run_edges), active_nodes)

        if active_nodes and all(node.state == RunNodeState.completed for node in active_nodes):
            run.state = RunState.completed
            run.updated_at = datetime.datetime.utcnow()
            session.add(run)
            session.commit()
            if run.parent_run_node_id is not None:
                # Propagate completion and output to parent run node
                child_output = _collect_child_run_output(session, run)
                complete_node(session, _parent_run_id(session, run), run.parent_run_node_id, output=child_output)
            else:
                _maybe_release_run_sandbox(session, run)
            return

        if any(node.state == RunNodeState.error for node in active_nodes):
            run.state = RunState.error
            run.updated_at = datetime.datetime.utcnow()
            session.add(run)
            session.commit()
            if run.parent_run_node_id is not None:
                # Propagate error to parent run node
                parent_node = session.get(GraphRunNode, run.parent_run_node_id)
                if parent_node:
                    fail_node_and_run(
                        session, parent_node.run_id, run.parent_run_node_id,
                        "child run failed", release_lease=False,
                    )
            else:
                _maybe_release_run_sandbox(session, run)
            return

        # Subgraph child runs don't need their own sandbox/worker — they share the parent's
        has_dispatchable_nodes = any(
            n.node_type in (RunNodeType.agent, RunNodeType.command)
            and n.state == RunNodeState.pending
            for n in active_nodes
        )
        worker = None
        if has_dispatchable_nodes:
            worker = _ensure_run_sandbox_worker(session, run)
            if worker is None:
                enqueue_run(session, run.id, reason="awaiting worker capacity")
                return

        if run.state == RunState.pending:
            run.state = RunState.running
            run.updated_at = datetime.datetime.utcnow()
            session.add(run)
            session.commit()

        unblocked = _get_unblocked_nodes(active_nodes, active_edges)
        for node in unblocked:
            if node.state != RunNodeState.pending:
                continue

            if node.node_type == RunNodeType.subgraph:
                # Start the child run by enqueueing it
                node.state = RunNodeState.running
                node.updated_at = datetime.datetime.utcnow()
                session.add(node)
                session.commit()
                _persist_run_node_event(session, run, node, "run.node.running")
                if node.child_run_id:
                    enqueue_run(session, node.child_run_id, reason="parent node unblocked")
                continue

            node.state = RunNodeState.dispatching
            node.updated_at = datetime.datetime.utcnow()
            session.add(node)
            session.commit()
            _persist_run_node_event(session, run, node, "run.node.dispatching")
            if worker is None:
                worker = _ensure_run_sandbox_worker(session, run)
                if worker is None:
                    enqueue_run(session, run.id, reason="awaiting worker capacity")
                    return
            if node.node_type == RunNodeType.agent:
                asyncio.create_task(_dispatch_agent_node(run.id, node.id, worker.id))
            elif node.node_type == RunNodeType.command:
                asyncio.create_task(_dispatch_command_node(run.id, node.id, worker.id))


def _ensure_run_sandbox_worker(session: Session, run: GraphRun) -> Worker | None:
    if run.sandbox_id is None and run.parent_run_node_id is not None:
        parent_run = _parent_run(session, run)
        if parent_run is not None and parent_run.sandbox_id is not None:
            run.sandbox_id = parent_run.sandbox_id
            run.updated_at = datetime.datetime.utcnow()
            session.add(run)
            session.commit()

    if run.sandbox_id is None:
        try:
            sandbox, worker = sandbox_svc.create_sandbox(session, run.workspace_id, f"run-{run.id}")
        except RuntimeError:
            logger.info("run %s is waiting for worker capacity", run.id)
            return None
        run.sandbox_id = sandbox.id
        run.updated_at = datetime.datetime.utcnow()
        session.add(run)
        session.commit()
        return worker

    sandbox = session.get(Sandbox, run.sandbox_id)
    if sandbox is None:
        run.state = RunState.error
        run.updated_at = datetime.datetime.utcnow()
        session.add(run)
        session.commit()
        return None

    worker = worker_svc.get_worker_for_sandbox(session, sandbox)
    if worker is None:
        try:
            _, worker = worker_svc.lease_worker_for_sandbox(
                session,
                workspace_id=run.workspace_id,
                sandbox=sandbox,
            )
        except RuntimeError:
            logger.info("run %s is waiting for worker capacity", run.id)
            return None
    if worker is None or worker.worker_url is None:
        run.state = RunState.error
        run.updated_at = datetime.datetime.utcnow()
        session.add(run)
        session.commit()
        return None
    return worker


async def _dispatch_agent_node(run_id: uuid.UUID, node_id: uuid.UUID, worker_id: uuid.UUID) -> None:
    with Session(engine) as session:
        run = session.get(GraphRun, run_id)
        node = session.get(GraphRunNode, node_id)
        worker = session.get(Worker, worker_id)
        if run is None or node is None or worker is None or worker.worker_url is None:
            return

        sandbox = session.get(Sandbox, run.sandbox_id) if run.sandbox_id else None
        workspace_dir = f"/workspaces/{run.sandbox_id}"

        try:
            await _ensure_workspace_dir(worker.worker_url, workspace_dir)
            if node.graph_tools and node.agent_type not in ("pydantic", "codex", "claude_code"):
                await _place_tool_file(
                    worker.worker_url,
                    workspace_dir,
                    output_schema=node.output_schema,
                    db_session=session,
                )

            agent = Agent(
                workspace_id=run.workspace_id,
                sandbox_id=run.sandbox_id,
                agent_type=AgentType(node.agent_type),
                model=node.model,
                prompt=node.prompt,
                name=f"run-{run.id}-{node.name or node.id}",
                status=AgentStatus.starting,
                graph_run_id=run.id,
            )
            session.add(agent)
            session.commit()
            session.refresh(agent)

            resolved_prompt = _resolve_output_references(session, run, node) or ""
            dispatch_prompt = resolved_prompt
            if node.graph_tools and node.agent_type not in ("pydantic", "codex", "claude_code"):
                dispatch_prompt = (
                    f"{dispatch_prompt}\n\n"
                    "IMPORTANT: When you have fully completed the task described above, "
                    "you MUST call the `mark_node_complete` tool to signal completion."
                )
                if node.output_schema:
                    fields_desc = ", ".join(
                        f'"{k}" ({v})'
                        + (" - provide a URL or data URI" if v == "image" else "")
                        for k, v in node.output_schema.items()
                    )
                    dispatch_prompt += (
                        f"\n\nWhen calling mark_node_complete, you MUST pass an 'output' "
                        f"object with these fields: {fields_desc}."
                    )

            if node.agent_type == "pydantic" and not node.output_schema:
                raise ValueError("pydantic agent requires output_schema")

            resolved_images = await _resolve_images(worker.worker_url, node.image_attachments)

            # Expand schema references so the worker can build models without DB
            expanded_schema = _expand_output_schema_for_worker(
                node.output_schema, session
            )

            data = await post_session_with_retry(
                worker.worker_url,
                payload={
                    "prompt": dispatch_prompt,
                    "agent_type": node.agent_type,
                    "model": node.model,
                    "output_schema": expanded_schema,
                    "workspace_name": str(run.sandbox_id),
                    "graph_tools": node.graph_tools,
                    "workspace_id": str(run.workspace_id),
                    "sandbox_id": str(run.sandbox_id) if run.sandbox_id else None,
                    "images": resolved_images,
                },
            )

            agent.session_id = data["session"]["id"]
            agent.status = AgentStatus.busy
            agent.updated_at = datetime.datetime.utcnow()
            node.agent_id = agent.id
            node.session_id = agent.session_id
            node.state = RunNodeState.running
            node.updated_at = datetime.datetime.utcnow()
            session.add(agent)
            session.add(node)
            session.commit()
            _persist_run_node_event(
                session,
                run,
                node,
                "run.node.running",
                data={
                    "agent_id": str(agent.id),
                    "session_id": agent.session_id,
                },
                worker_id=worker.id,
            )
        except Exception:
            logger.exception("failed to dispatch agent node %s", node_id)
            fail_node_and_run(session, run_id, node_id, "agent dispatch failed")


async def _dispatch_command_node(run_id: uuid.UUID, node_id: uuid.UUID, worker_id: uuid.UUID) -> None:
    with Session(engine) as session:
        run = session.get(GraphRun, run_id)
        node = session.get(GraphRunNode, node_id)
        worker = session.get(Worker, worker_id)
        if run is None or node is None or worker is None or worker.worker_url is None:
            return
        if not node.command:
            fail_node_and_run(session, run_id, node_id, "missing command")
            return

        node.state = RunNodeState.running
        node.updated_at = datetime.datetime.utcnow()
        session.add(node)
        session.commit()
        _persist_run_node_event(
            session,
            run,
            node,
            "run.node.running",
            worker_id=worker.id,
        )

        try:
            resolved_command = _resolve_output_references(session, run, node) or node.command
            await _ensure_workspace_dir(worker.worker_url, f"/workspaces/{run.sandbox_id}")
            resp_data = await execute_command(
                worker.worker_url,
                command=["bash", "-c", resolved_command],
                cwd=f"/workspaces/{run.sandbox_id}",
                timeout=300,
                request_timeout=310.0,
            )

            event_svc.persist_event(
                session,
                workspace_id=run.workspace_id,
                source_type="run",
                source_id=str(node.id),
                payload={
                    "id": str(uuid.uuid4()),
                    "type": "command.output",
                    "timestamp": datetime.datetime.utcnow().isoformat(),
                    "data": {
                        "stdout": resp_data["stdout"],
                        "stderr": resp_data["stderr"],
                        "exit_code": resp_data["exit_code"],
                    },
                },
                source_name=node.name,
                run_id=run.id,
                node_id=node.id,
                sandbox_id=run.sandbox_id,
                worker_id=worker.id,
            )

            if resp_data["exit_code"] == 0:
                complete_node(session, run_id, node_id, output={"stdout": resp_data["stdout"]})
            else:
                fail_node_and_run(session, run_id, node_id, f"command exited {resp_data['exit_code']}")
        except Exception:
            logger.exception("command dispatch failed for node %s", node_id)
            fail_node_and_run(session, run_id, node_id, "command dispatch failed")


def complete_node(
    session: Session,
    run_id: uuid.UUID,
    node_id: uuid.UUID,
    output: dict | None = None,
) -> None:
    node = session.get(GraphRunNode, node_id)
    if (
        node is None
        or node.state == RunNodeState.completed
        or node.next_attempt_run_node_id is not None
    ):
        return
    schema = node.output_schema
    if output is None and node.output is not None:
        output = node.output
    validate_output_against_schema(
        output, schema, schema_resolver=_make_schema_resolver(session)
    )
    if output is not None:
        node.output = output
    node.state = RunNodeState.completed
    node.updated_at = datetime.datetime.utcnow()
    session.add(node)
    session.commit()
    run = session.get(GraphRun, run_id)
    if run is not None:
        _persist_run_node_event(
            session,
            run,
            node,
            "run.node.completed",
            data={
                "output": output,
                "output_schema": node.output_schema,
                "node_name": node.name,
            },
        )
    enqueue_run(session, run_id, reason="node completed")


def fail_node_and_run(
    session: Session,
    run_id: uuid.UUID,
    node_id: uuid.UUID,
    reason: str,
    *,
    release_lease: bool = True,
) -> None:
    node = session.get(GraphRunNode, node_id)
    run = session.get(GraphRun, run_id)
    if node is not None and node.next_attempt_run_node_id is not None:
        return
    if (
        node is not None
        and run is not None
        and node.child_run_id is None
        and node.attempt < MAX_RUN_NODE_ATTEMPTS
    ):
        node.state = RunNodeState.error
        node.updated_at = datetime.datetime.utcnow()
        session.add(node)
        _create_retry_attempt(session, run, node)
        _resume_run_if_terminal(session, run)
        session.commit()
        if run is not None:
            _persist_run_node_event(
                session,
                run,
                node,
                "run.node.retry_scheduled",
                data={
                    "reason": reason,
                    "next_attempt_run_node_id": (
                        str(node.next_attempt_run_node_id)
                        if node.next_attempt_run_node_id
                        else None
                    ),
                },
            )
        enqueue_run(session, run_id, reason=f"node retry scheduled: {reason}")
        return
    if node is not None and node.state != RunNodeState.error:
        node.state = RunNodeState.error
        node.updated_at = datetime.datetime.utcnow()
        session.add(node)
    if run is not None and run.state != RunState.error:
        run.state = RunState.error
        run.updated_at = datetime.datetime.utcnow()
        session.add(run)
    session.commit()
    if node is not None and run is not None:
        _persist_run_node_event(
            session,
            run,
            node,
            "run.node.failed",
            data={"reason": reason},
        )
    if release_lease and run is not None:
        _maybe_release_run_sandbox(session, run, failure_reason=reason)


def _maybe_release_run_sandbox(
    session: Session,
    run: GraphRun,
    *,
    failure_reason: str | None = None,
) -> None:
    if run.sandbox_id is None:
        return
    sandbox = session.get(Sandbox, run.sandbox_id)
    if sandbox is None:
        return
    if sandbox.current_lease_id is None:
        return
    status = worker_svc.WorkerLeaseStatus.failed if failure_reason else worker_svc.WorkerLeaseStatus.released
    worker_svc.release_sandbox_lease(session, sandbox, status=status, failure_reason=failure_reason)


def _resume_run_if_terminal(session: Session, run: GraphRun) -> None:
    """Set run back to 'running' if it was in a terminal state."""
    if run.state in (RunState.error, RunState.completed):
        run.state = RunState.running
        run.updated_at = datetime.datetime.utcnow()
        session.add(run)


SETTABLE_NODE_STATES = {
    RunNodeState.pending,
    RunNodeState.completed,
    RunNodeState.error,
}


def sync_run_node(session: Session, run_id: uuid.UUID, node_id: uuid.UUID) -> GraphRun:
    from app.models.graph import GraphNode

    node = session.get(GraphRunNode, node_id)
    if node is None or node.run_id != run_id:
        raise ValueError("run node not found")
    if node.source_type != RunNodeSourceType.graph_node:
        raise ValueError("sync is only supported for graph_node source type")
    if node.state in (RunNodeState.running, RunNodeState.dispatching):
        raise ValueError("cannot sync a node that is running or dispatching")
    if node.child_run_id is not None:
        raise ValueError("cannot sync subgraph nodes")

    source = session.get(GraphNode, node.source_node_id)
    if source is None or source.deleted:
        raise ValueError("source graph node not found or deleted")

    node.name = source.name
    node.node_type = RunNodeType(source.node_type.value)
    node.agent_type = source.agent_type
    node.model = source.model
    node.prompt = source.prompt
    node.command = source.command
    node.graph_tools = source.graph_tools
    node.output_schema = source.output_schema
    node.image_attachments = source.image_attachments
    node.output = None
    node.state = RunNodeState.pending
    node.agent_id = None
    node.session_id = None
    node.updated_at = datetime.datetime.utcnow()
    session.add(node)

    run = session.get(GraphRun, run_id)
    if run is not None:
        _resume_run_if_terminal(session, run)

    session.commit()
    if run is not None:
        enqueue_run(session, run_id, reason="node synced")
        session.refresh(run)
    return run


def patch_run_node_state(
    session: Session,
    run_id: uuid.UUID,
    node_id: uuid.UUID,
    new_state: RunNodeState,
) -> GraphRun:
    if new_state not in SETTABLE_NODE_STATES:
        raise ValueError(f"state must be one of {SETTABLE_NODE_STATES}")

    node = session.get(GraphRunNode, node_id)
    if node is None or node.run_id != run_id:
        raise ValueError("run node not found")
    if node.state in (RunNodeState.running, RunNodeState.dispatching):
        raise ValueError("cannot change state of a node that is running or dispatching")
    if node.child_run_id is not None:
        raise ValueError("cannot change state of subgraph nodes")

    node.state = new_state
    node.updated_at = datetime.datetime.utcnow()
    if new_state == RunNodeState.pending:
        node.agent_id = None
        node.session_id = None
    session.add(node)

    run = session.get(GraphRun, run_id)
    if run is not None and new_state == RunNodeState.pending:
        _resume_run_if_terminal(session, run)

    session.commit()
    if run is not None:
        enqueue_run(session, run_id, reason="node state patched")
        session.refresh(run)
    return run
