import asyncio
import datetime
import json
import logging
import uuid
from typing import Any

import httpx
from sqlmodel import Session, select

from app.database import engine
from app.models.agent import Agent, AgentStatus, AgentType
from app.models.run import GraphRun, GraphRunEdge, GraphRunNode
from app.models.sandbox import Sandbox
from app.models.worker import Worker
from app.services import controller as controller_svc
from app.services import events as event_svc
from app.services import sandboxes as sandbox_svc
from app.services import workers as worker_svc
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


def _resolve_output_references(session: Session, run: GraphRun, node: GraphRunNode) -> str | None:
    """Resolve {{ slug.field }} references in a node's prompt/command using completed predecessors."""
    text = node.prompt if node.node_type == "agent" else node.command
    if not text or "{{" not in text:
        return text

    predecessor_ids = {
        e.from_run_node_id for e in run.run_edges if e.to_run_node_id == node.id
    }
    context: dict[str, Any] = {}
    for pred_id in predecessor_ids:
        pred = session.get(GraphRunNode, pred_id)
        if pred and pred.state == "completed" and pred.name:
            slug = slugify(pred.name)
            output_data = json.loads(pred.output) if pred.output else {}
            context[slug] = {**output_data, "output": output_data}

    from app.services.graphs import _jinja_env

    return _jinja_env.from_string(text).render(context)


def _collect_child_run_output(session: Session, run: GraphRun) -> dict | None:
    """Collect outputs from leaf nodes (no outgoing edges) of a completed run."""
    outgoing = {e.from_run_node_id for e in run.run_edges}
    leaf_nodes = [n for n in run.run_nodes if n.id not in outgoing and n.state == "completed"]
    if not leaf_nodes:
        return None
    # Single leaf: use its output directly
    if len(leaf_nodes) == 1 and leaf_nodes[0].output:
        return json.loads(leaf_nodes[0].output)
    # Multiple leaves: merge keyed by slugified node name
    merged: dict = {}
    for leaf in leaf_nodes:
        if leaf.output:
            leaf_data = json.loads(leaf.output)
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


async def _post_session_with_retry(
    worker_url: str,
    payload: dict[str, Any],
    max_wait: int = 60,
    interval: float = 2.0,
) -> dict[str, Any]:
    deadline = asyncio.get_event_loop().time() + max_wait
    last_exc: Exception | None = None
    while asyncio.get_event_loop().time() < deadline:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(f"{worker_url}/sessions", json=payload, timeout=10.0)
                resp.raise_for_status()
                return resp.json()
        except (httpx.ConnectError, httpx.TimeoutException) as exc:
            last_exc = exc
            await asyncio.sleep(interval)
    raise RuntimeError(f"Worker did not become ready in time: {last_exc}") from last_exc


def _get_unblocked_nodes(
    run_nodes: list[GraphRunNode],
    run_edges: list[GraphRunEdge],
) -> list[GraphRunNode]:
    predecessors: dict[uuid.UUID, set[uuid.UUID]] = {n.id: set() for n in run_nodes}
    for edge in run_edges:
        predecessors[edge.to_run_node_id].add(edge.from_run_node_id)

    completed_ids = {n.id for n in run_nodes if n.state == "completed"}
    return [
        node
        for node in run_nodes
        if node.state == "pending" and predecessors[node.id].issubset(completed_ids)
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
        state="pending",
        agent_type=node.agent_type,
        model=node.model,
        prompt=node.prompt,
        command=node.command,
        graph_tools=node.graph_tools,
        output_schema=node.output_schema,
        images=node.images,
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
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{worker_url}/commands",
            json={"command": ["bash", "-c", f"mkdir -p '{workspace_dir}'"], "cwd": "/", "timeout": 10},
            timeout=15.0,
        )
        resp.raise_for_status()


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
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{worker_url}/commands",
            json={"command": ["base64", path], "cwd": "/", "timeout": 30},
            timeout=35.0,
        )
        resp.raise_for_status()
        result = resp.json()
        if result.get("exit_code", 1) != 0:
            raise RuntimeError(f"Failed to read image {path}: {result.get('stderr', '')}")
        return result["stdout"].strip()


async def _resolve_images(
    worker_url: str, images_json: str | None
) -> list[dict[str, str]] | None:
    """Resolve image attachments, reading sandbox files as base64."""
    if not images_json:
        return None
    images = json.loads(images_json)
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


_SCHEMA_TYPE_MAP = {
    "string": "string",
    "number": "number",
    "boolean": "boolean",
}


def _generate_tool_content(output_schema: dict[str, str] | None) -> str:
    """Generate mark_node_complete tool content with typed parameters when schema is provided."""
    if not output_schema:
        return TOOL_FILE_CONTENT

    properties: dict[str, dict] = {}
    for field_name, field_type in output_schema.items():
        json_type = _SCHEMA_TYPE_MAP.get(field_type, "string")
        properties[field_name] = {
            "type": json_type,
            "description": f"The {field_name} output field ({field_type})",
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
    worker_url: str, workspace_dir: str, output_schema: dict[str, str] | None = None
) -> None:
    tool_content = _generate_tool_content(output_schema)
    script = (
        f"mkdir -p '{workspace_dir}/.opencode/tools' && "
        f"cat > '{workspace_dir}/.opencode/tools/mark_node_complete.ts' << 'TOOLEOF'\n"
        f"{tool_content}TOOLEOF"
    )
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{worker_url}/commands",
            json={"command": ["bash", "-c", script], "cwd": "/", "timeout": 10},
            timeout=15.0,
        )
        resp.raise_for_status()
        result = resp.json()
        if result.get("exit_code", 1) != 0:
            raise RuntimeError(f"Failed to place tool file: {result.get('stderr', '')}")


async def reconcile_run(run_id: uuid.UUID) -> None:
    with Session(engine) as session:
        run = session.get(GraphRun, run_id)
        if run is None or run.deleted:
            return

        if run.state == "error":
            if run.parent_run_node_id is None:
                _maybe_release_run_sandbox(session, run)
            return

        active_nodes = _active_run_nodes(list(run.run_nodes))
        active_edges = _active_run_edges(list(run.run_edges), active_nodes)

        if active_nodes and all(node.state == "completed" for node in active_nodes):
            run.state = "completed"
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

        if any(node.state == "error" for node in active_nodes):
            run.state = "error"
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
            n.node_type in ("agent", "command") and n.state == "pending"
            for n in active_nodes
        )
        worker = None
        if has_dispatchable_nodes:
            worker = _ensure_run_sandbox_worker(session, run)
            if worker is None:
                enqueue_run(session, run.id, reason="awaiting worker capacity")
                return

        if run.state == "pending":
            run.state = "running"
            run.updated_at = datetime.datetime.utcnow()
            session.add(run)
            session.commit()

        unblocked = _get_unblocked_nodes(active_nodes, active_edges)
        for node in unblocked:
            if node.state != "pending":
                continue

            if node.node_type == "subgraph":
                # Start the child run by enqueueing it
                node.state = "running"
                node.updated_at = datetime.datetime.utcnow()
                session.add(node)
                session.commit()
                if node.child_run_id:
                    enqueue_run(session, node.child_run_id, reason="parent node unblocked")
                continue

            node.state = "dispatching"
            node.updated_at = datetime.datetime.utcnow()
            session.add(node)
            session.commit()
            if worker is None:
                worker = _ensure_run_sandbox_worker(session, run)
                if worker is None:
                    enqueue_run(session, run.id, reason="awaiting worker capacity")
                    return
            if node.node_type == "agent":
                asyncio.create_task(_dispatch_agent_node(run.id, node.id, worker.id))
            elif node.node_type == "command":
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
        run.state = "error"
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
        run.state = "error"
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
        workspace_dir = f"/workspaces/{run.workspace_id}"

        try:
            await _ensure_workspace_dir(worker.worker_url, workspace_dir)
            if node.graph_tools and node.agent_type != "pydantic":
                schema = json.loads(node.output_schema) if node.output_schema else None
                await _place_tool_file(worker.worker_url, workspace_dir, output_schema=schema)

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
            if node.graph_tools and node.agent_type != "pydantic":
                dispatch_prompt = (
                    f"{dispatch_prompt}\n\n"
                    "IMPORTANT: When you have fully completed the task described above, "
                    "you MUST call the `mark_node_complete` tool to signal completion."
                )
                if node.output_schema:
                    schema = json.loads(node.output_schema)
                    fields_desc = ", ".join(f'"{k}" ({v})' for k, v in schema.items())
                    dispatch_prompt += (
                        f"\n\nWhen calling mark_node_complete, you MUST pass an 'output' "
                        f"object with these fields: {fields_desc}."
                    )

            if node.agent_type == "pydantic" and not node.output_schema:
                raise ValueError("pydantic agent requires output_schema")

            resolved_images = await _resolve_images(worker.worker_url, node.images)

            data = await _post_session_with_retry(
                worker.worker_url,
                payload={
                    "prompt": dispatch_prompt,
                    "agent_type": node.agent_type,
                    "model": node.model,
                    "output_schema": json.loads(node.output_schema) if node.output_schema else None,
                    "workspace_name": str(run.workspace_id),
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
            node.state = "running"
            node.updated_at = datetime.datetime.utcnow()
            session.add(agent)
            session.add(node)
            session.commit()
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

        node.state = "running"
        node.updated_at = datetime.datetime.utcnow()
        session.add(node)
        session.commit()

        try:
            resolved_command = _resolve_output_references(session, run, node) or node.command
            await _ensure_workspace_dir(worker.worker_url, f"/workspaces/{run.workspace_id}")
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{worker.worker_url}/commands",
                    json={
                        "command": ["bash", "-c", resolved_command],
                        "cwd": f"/workspaces/{run.workspace_id}",
                        "timeout": 300,
                    },
                    timeout=310.0,
                )
                resp.raise_for_status()
                resp_data = resp.json()

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
    if node is None or node.state == "completed" or node.next_attempt_run_node_id is not None:
        return
    schema = json.loads(node.output_schema) if node.output_schema else None
    if output is None and node.output is not None:
        output = json.loads(node.output)
    validate_output_against_schema(output, schema)
    if output is not None:
        node.output = json.dumps(output)
    node.state = "completed"
    node.updated_at = datetime.datetime.utcnow()
    session.add(node)
    session.commit()
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
        node.state = "error"
        node.updated_at = datetime.datetime.utcnow()
        session.add(node)
        _create_retry_attempt(session, run, node)
        _resume_run_if_terminal(session, run)
        session.commit()
        enqueue_run(session, run_id, reason=f"node retry scheduled: {reason}")
        return
    if node is not None and node.state != "error":
        node.state = "error"
        node.updated_at = datetime.datetime.utcnow()
        session.add(node)
    if run is not None and run.state != "error":
        run.state = "error"
        run.updated_at = datetime.datetime.utcnow()
        session.add(run)
    session.commit()
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
    if run.state in ("error", "completed"):
        run.state = "running"
        run.updated_at = datetime.datetime.utcnow()
        session.add(run)


SETTABLE_NODE_STATES = {"pending", "completed", "error"}


def sync_run_node(session: Session, run_id: uuid.UUID, node_id: uuid.UUID) -> GraphRun:
    from app.models.graph import GraphNode

    node = session.get(GraphRunNode, node_id)
    if node is None or node.run_id != run_id:
        raise ValueError("run node not found")
    if node.source_type != "graph_node":
        raise ValueError("sync is only supported for graph_node source type")
    if node.state in ("running", "dispatching"):
        raise ValueError("cannot sync a node that is running or dispatching")
    if node.child_run_id is not None:
        raise ValueError("cannot sync subgraph nodes")

    source = session.get(GraphNode, node.source_node_id)
    if source is None or source.deleted:
        raise ValueError("source graph node not found or deleted")

    node.name = source.name
    node.node_type = source.node_type.value
    node.agent_type = source.agent_type
    node.model = source.model
    node.prompt = source.prompt
    node.command = source.command
    node.graph_tools = source.graph_tools
    node.output_schema = source.output_schema
    node.images = source.images
    node.output = None
    node.state = "pending"
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
    session: Session, run_id: uuid.UUID, node_id: uuid.UUID, new_state: str
) -> GraphRun:
    if new_state not in SETTABLE_NODE_STATES:
        raise ValueError(f"state must be one of {SETTABLE_NODE_STATES}")

    node = session.get(GraphRunNode, node_id)
    if node is None or node.run_id != run_id:
        raise ValueError("run node not found")
    if node.state in ("running", "dispatching"):
        raise ValueError("cannot change state of a node that is running or dispatching")
    if node.child_run_id is not None:
        raise ValueError("cannot change state of subgraph nodes")

    node.state = new_state
    node.updated_at = datetime.datetime.utcnow()
    if new_state == "pending":
        node.agent_id = None
        node.session_id = None
    session.add(node)

    run = session.get(GraphRun, run_id)
    if run is not None and new_state == "pending":
        _resume_run_if_terminal(session, run)

    session.commit()
    if run is not None:
        enqueue_run(session, run_id, reason="node state patched")
        session.refresh(run)
    return run
