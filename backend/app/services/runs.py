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
from app.models.event import Event
from app.models.run import GraphRun, GraphRunEdge, GraphRunNode
from app.models.sandbox import Sandbox
from app.models.worker import Worker
from app.services import sandboxes as sandbox_svc

logger = logging.getLogger(__name__)

MARK_COMPLETE_TOOL = "mark_node_complete"

# The TypeScript tool file placed in the workspace for opencode to discover.
# It accepts no arguments — the run_id and node_id are baked into the file per-node
# but for simplicity the tool is shared across all nodes in a run and accepts
# run_id/node_id as parameters.
TOOL_FILE_CONTENT = """\
import { tool } from "@opencode/tool";

export default tool({
  name: "mark_node_complete",
  description: "Call this tool when you have completed the task assigned to you. This signals the orchestrator that your work is done.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute() {
    return "Node marked as complete. The orchestrator will continue the workflow.";
  },
});
"""


async def _post_session_with_retry(
    worker_url: str,
    payload: dict[str, Any],
    max_wait: int = 60,
    interval: float = 2.0,
) -> dict[str, Any]:
    """POST to worker /sessions, retrying on ConnectError until the pod is ready."""
    deadline = asyncio.get_event_loop().time() + max_wait
    last_exc: Exception | None = None
    while asyncio.get_event_loop().time() < deadline:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{worker_url}/sessions",
                    json=payload,
                    timeout=10.0,
                )
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
    """Return pending nodes whose predecessors are all completed."""
    # Build set of predecessor node IDs for each node
    predecessors: dict[uuid.UUID, set[uuid.UUID]] = {n.id: set() for n in run_nodes}
    for edge in run_edges:
        predecessors[edge.to_run_node_id].add(edge.from_run_node_id)

    completed_ids = {n.id for n in run_nodes if n.state == "completed"}

    unblocked = []
    for node in run_nodes:
        if node.state != "pending":
            continue
        if predecessors[node.id].issubset(completed_ids):
            unblocked.append(node)
    return unblocked


def _resolve_nops(session: Session, run: GraphRun) -> None:
    """Auto-complete all unblocked nop nodes, repeating until no nops remain unblocked."""
    while True:
        unblocked = _get_unblocked_nodes(list(run.run_nodes), list(run.run_edges))
        nops = [n for n in unblocked if n.node_type == "nop"]
        if not nops:
            return
        for n in nops:
            n.state = "completed"
            n.updated_at = datetime.datetime.utcnow()
            session.add(n)
        session.commit()
        session.refresh(run)


async def _ensure_workspace_dir(worker_url: str, workspace_dir: str) -> None:
    """Create the workspace directory on the worker pod if it doesn't exist."""
    deadline = asyncio.get_event_loop().time() + 60
    last_exc: Exception | None = None
    while asyncio.get_event_loop().time() < deadline:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{worker_url}/commands",
                    json={
                        "command": ["bash", "-c", f"mkdir -p '{workspace_dir}'"],
                        "cwd": "/",
                        "timeout": 10,
                    },
                    timeout=15.0,
                )
                resp.raise_for_status()
                return
        except (httpx.ConnectError, httpx.TimeoutException) as exc:
            last_exc = exc
            await asyncio.sleep(2.0)
    raise RuntimeError(f"Worker not ready: {last_exc}") from last_exc


async def _place_tool_file(worker_url: str, workspace_dir: str) -> None:
    """Write the mark_node_complete tool into the workspace's .opencode/tools/ dir on the worker pod."""
    script = (
        f"mkdir -p '{workspace_dir}/.opencode/tools' && "
        f"cat > '{workspace_dir}/.opencode/tools/mark_node_complete.ts' << 'TOOLEOF'\n"
        f"{TOOL_FILE_CONTENT}TOOLEOF"
    )
    deadline = asyncio.get_event_loop().time() + 60
    last_exc: Exception | None = None
    while asyncio.get_event_loop().time() < deadline:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{worker_url}/commands",
                    json={
                        "command": ["bash", "-c", script],
                        "cwd": "/",
                        "timeout": 10,
                    },
                    timeout=15.0,
                )
                resp.raise_for_status()
                result = resp.json()
                if result.get("exit_code", 1) != 0:
                    raise RuntimeError(
                        f"Failed to place tool file: {result.get('stderr', '')}"
                    )
                return
        except (httpx.ConnectError, httpx.TimeoutException) as exc:
            last_exc = exc
            await asyncio.sleep(2.0)
    raise RuntimeError(f"Worker not ready for tool placement: {last_exc}") from last_exc


def _persist_event(
    session: Session,
    workspace_id: uuid.UUID,
    source_type: str,
    source_id: str,
    payload: dict[str, Any],
    source_name: str | None = None,
) -> None:
    event = Event(
        id=str(payload.get("id", uuid.uuid4())),
        workspace_id=workspace_id,
        type=source_type,
        source_id=source_id,
        source_name=source_name,
        event_type=str(payload.get("type", "unknown")),
        timestamp=str(payload.get("timestamp", "")),
        data=payload,
    )
    session.merge(event)
    session.commit()


async def execute_run(run_id: uuid.UUID, workspace_id: uuid.UUID) -> None:
    """Background task: create sandbox, dispatch agent and command nodes."""
    with Session(engine) as session:
        run = session.get(GraphRun, run_id)
        if run is None:
            logger.error("run %s not found", run_id)
            return

        try:
            run.state = "running"
            session.add(run)
            session.commit()

            needs_sandbox = any(
                n.node_type in ("agent", "command") for n in run.run_nodes
            )

            if not needs_sandbox:
                _resolve_nops(session, run)
                session.refresh(run)
                if all(n.state == "completed" for n in run.run_nodes) or not run.run_nodes:
                    run.state = "completed"
                    run.updated_at = datetime.datetime.utcnow()
                    session.add(run)
                    session.commit()
                return

            # Create shared sandbox for the run
            sandbox, worker = sandbox_svc.create_sandbox(
                session, workspace_id, f"run-{run_id}"
            )
            run.sandbox_id = sandbox.id
            session.add(run)
            session.commit()
            session.refresh(run)

            # Ensure workspace directory exists on the worker pod
            workspace_dir = f"/workspaces/{workspace_id}"
            await _ensure_workspace_dir(worker.worker_url, workspace_dir)

            # Place the completion tool if any agent node uses graph_tools
            has_graph_tools = any(
                n.graph_tools for n in run.run_nodes if n.node_type == "agent"
            )
            if has_graph_tools:
                await _place_tool_file(worker.worker_url, workspace_dir)

            await _resolve_and_dispatch(session, run, worker)

        except Exception:
            logger.exception("run %s failed", run_id)
            session.refresh(run)
            run.state = "error"
            session.add(run)
            session.commit()


async def _resolve_and_dispatch(
    session: Session, run: GraphRun, worker: Worker
) -> None:
    """Resolve nops, then dispatch all unblocked agent and command nodes."""
    _resolve_nops(session, run)

    unblocked = _get_unblocked_nodes(list(run.run_nodes), list(run.run_edges))
    agent_nodes = [n for n in unblocked if n.node_type == "agent"]
    command_nodes = [n for n in unblocked if n.node_type == "command"]

    if not agent_nodes and not command_nodes:
        # Check if all nodes are completed
        all_completed = all(n.state == "completed" for n in run.run_nodes)
        if all_completed:
            run.state = "completed"
            run.updated_at = datetime.datetime.utcnow()
            session.add(run)
            session.commit()
        return

    for node in agent_nodes:
        await _dispatch_agent_node(session, run, node, worker)

    for node in command_nodes:
        asyncio.create_task(
            _dispatch_command_node(
                run.id, node.id, run.workspace_id, worker.id, worker.worker_url
            )
        )


async def _dispatch_agent_node(
    session: Session, run: GraphRun, node: GraphRunNode, worker: Worker
) -> None:
    """Create an Agent, start a worker session, and launch a watcher task."""
    if worker.worker_url is None:
        raise RuntimeError("Worker URL not available")

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

    # Augment prompt with completion tool instructions if graph_tools enabled
    dispatch_prompt = node.prompt
    if node.graph_tools:
        dispatch_prompt = (
            f"{node.prompt}\n\n"
            "IMPORTANT: When you have fully completed the task described above, "
            "you MUST call the `mark_node_complete` tool to signal that your work is done. "
            "Do not forget this step."
        )

    data = await _post_session_with_retry(
        worker.worker_url,
        payload={
            "prompt": dispatch_prompt,
            "agent_type": node.agent_type,
            "model": node.model,
            "workspace_name": str(run.workspace_id),
            "graph_tools": node.graph_tools,
            "workspace_id": str(run.workspace_id),
        },
    )

    agent.session_id = data["session"]["id"]
    agent.status = AgentStatus.busy
    agent.updated_at = datetime.datetime.utcnow()
    session.add(agent)

    node.agent_id = agent.id
    node.session_id = agent.session_id
    node.state = "running"
    node.updated_at = datetime.datetime.utcnow()
    session.add(node)
    session.commit()

    # Launch watcher in background
    asyncio.create_task(
        _watch_node(run.id, node.id, worker.id, worker.worker_url)
    )


async def _dispatch_command_node(
    run_id: uuid.UUID,
    node_id: uuid.UUID,
    workspace_id: uuid.UUID,
    worker_id: uuid.UUID,
    worker_url: str,
) -> None:
    """Execute a command node remotely via the worker's /commands endpoint."""
    with Session(engine) as session:
        node = session.get(GraphRunNode, node_id)
        if node is None:
            logger.error("dispatch_command_node: node %s not found", node_id)
            return

        run = session.get(GraphRun, run_id)
        if run is None:
            return

        if not node.command:
            logger.error("dispatch_command_node: node %s has no command", node_id)
            node.state = "error"
            node.updated_at = datetime.datetime.utcnow()
            session.add(node)
            run.state = "error"
            run.updated_at = datetime.datetime.utcnow()
            session.add(run)
            session.commit()
            return

        node.state = "running"
        node.updated_at = datetime.datetime.utcnow()
        session.add(node)
        session.commit()

        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{worker_url}/commands",
                    json={
                        "command": ["bash", "-c", node.command],
                        "cwd": f"/workspaces/{workspace_id}",
                        "timeout": 300,
                    },
                    timeout=310.0,
                )
                resp.raise_for_status()
                resp_data = resp.json()

            _persist_event(
                session,
                workspace_id,
                "run",
                str(node_id),
                {
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
            )

            if resp_data["exit_code"] == 0:
                await _complete_node(session, run_id, node_id, worker_id, worker_url)
            else:
                logger.error(
                    "command node %s failed with exit code %d",
                    node_id,
                    resp_data["exit_code"],
                )
                node = session.get(GraphRunNode, node_id)
                node.state = "error"
                node.updated_at = datetime.datetime.utcnow()
                session.add(node)
                run = session.get(GraphRun, run_id)
                run.state = "error"
                run.updated_at = datetime.datetime.utcnow()
                session.add(run)
                session.commit()

        except Exception:
            logger.exception("dispatch_command_node: error executing node %s", node_id)
            try:
                node = session.get(GraphRunNode, node_id)
                if node and node.state == "running":
                    node.state = "error"
                    node.updated_at = datetime.datetime.utcnow()
                    session.add(node)

                    run = session.get(GraphRun, run_id)
                    if run:
                        run.state = "error"
                        run.updated_at = datetime.datetime.utcnow()
                        session.add(run)
                    session.commit()
            except Exception:
                pass


async def _watch_node(
    run_id: uuid.UUID,
    node_id: uuid.UUID,
    worker_id: uuid.UUID,
    worker_url: str,
) -> None:
    """Monitor a node's agent session via SSE. On completion-tool call, mark done and cascade."""
    with Session(engine) as session:
        node = session.get(GraphRunNode, node_id)
        if node is None or node.session_id is None:
            logger.error("watch_node: node %s not found or has no session", node_id)
            return

        run = session.get(GraphRun, run_id)
        if run is None:
            return

        session_id = node.session_id
        use_graph_tools = node.graph_tools
        node_agent_id = node.agent_id
        node_name = node.name
        worker = session.get(Worker, worker_id)
        if worker is None or worker.worker_url is None:
            logger.error("watch_node: worker %s not available", worker_id)
            return

        try:
            async with httpx.AsyncClient() as client:
                async with client.stream(
                    "GET",
                    f"{worker_url}/sessions/{session_id}/events",
                    params={"stream": "True", "since": "0"},
                    timeout=None,
                ) as resp:
                    resp.raise_for_status()
                    sse_buffer = ""
                    async for chunk in resp.aiter_bytes():
                        sse_buffer += chunk.decode("utf-8", errors="replace")
                        while "\n\n" in sse_buffer:
                            message, sse_buffer = sse_buffer.split("\n\n", 1)
                            for line in message.split("\n"):
                                if not line.startswith("data: "):
                                    continue
                                try:
                                    payload = json.loads(line[6:])
                                except Exception:
                                    continue

                                # Agent nodes persist as type="agent" so
                                # events are queryable via the standard
                                # agent events endpoints.
                                _persist_event(
                                    session,
                                    run.workspace_id,
                                    "agent" if node_agent_id else "run",
                                    str(node_agent_id) if node_agent_id else str(node_id),
                                    payload,
                                    source_name=node_name,
                                )

                                event_type = payload.get("type", "")
                                event_data = payload.get("data", {})

                                # Detect the completion tool call (graph_tools mode)
                                if use_graph_tools and event_type == "tool.use" and event_data.get("tool_name") == MARK_COMPLETE_TOOL:
                                    logger.info(
                                        "node %s completed via tool call", node_id
                                    )
                                    await _complete_node(session, run_id, node_id, worker_id, worker_url)
                                    return

                                # Detect session idle (fallback when graph_tools is off)
                                if not use_graph_tools and event_type == "session.idle":
                                    logger.info(
                                        "node %s completed via session.idle", node_id
                                    )
                                    await _complete_node(session, run_id, node_id, worker_id, worker_url)
                                    return

                                # Detect session error
                                if event_type == "session.error":
                                    logger.error(
                                        "node %s session error", node_id
                                    )
                                    node = session.get(GraphRunNode, node_id)
                                    node.state = "error"
                                    node.updated_at = datetime.datetime.utcnow()
                                    session.add(node)

                                    run = session.get(GraphRun, run_id)
                                    run.state = "error"
                                    run.updated_at = datetime.datetime.utcnow()
                                    session.add(run)
                                    session.commit()
                                    return

        except Exception:
            logger.exception("watch_node: error watching node %s", node_id)
            try:
                node = session.get(GraphRunNode, node_id)
                if node and node.state == "running":
                    node.state = "error"
                    node.updated_at = datetime.datetime.utcnow()
                    session.add(node)
                    session.commit()
            except Exception:
                pass


async def _complete_node(
    session: Session,
    run_id: uuid.UUID,
    node_id: uuid.UUID,
    worker_id: uuid.UUID,
    worker_url: str,
) -> None:
    """Mark a node completed and cascade: dispatch newly unblocked nodes."""
    node = session.get(GraphRunNode, node_id)
    if node is None:
        return
    node.state = "completed"
    node.updated_at = datetime.datetime.utcnow()
    session.add(node)
    session.commit()

    run = session.get(GraphRun, run_id)
    if run is None:
        return
    session.refresh(run)

    worker = session.get(Worker, worker_id)
    if worker is None:
        return

    await _resolve_and_dispatch(session, run, worker)
