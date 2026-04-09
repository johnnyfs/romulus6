import asyncio
import datetime

import pytest
from sqlmodel import select

from app.models.event import Event
from app.models.graph import Graph
from app.models.reconcile import RunReconcile
from app.models.run import GraphRun, GraphRunNode, RunNodeState, RunNodeType, RunState
from app.models.sandbox import Sandbox
from app.models.worker import Worker, WorkerStatus
from app.services import runs as run_svc
from app.services import workspaces as workspace_svc

pytestmark = pytest.mark.fast


def _build_command_run(session, *, command: str = "echo hi"):
    workspace = workspace_svc.create_workspace(session, "run-exec")
    graph = Graph(workspace_id=workspace.id, name="run-graph")
    session.add(graph)
    session.flush()

    worker = Worker(
        status=WorkerStatus.running,
        worker_url="http://worker.test",
        worker_metadata={},
        last_heartbeat_at=datetime.datetime.utcnow(),
    )
    session.add(worker)
    session.flush()

    sandbox = Sandbox(
        workspace_id=workspace.id,
        name="run-sandbox",
        worker_id=worker.id,
    )
    session.add(sandbox)
    session.flush()

    run = GraphRun(
        graph_id=graph.id,
        workspace_id=workspace.id,
        sandbox_id=sandbox.id,
        state=RunState.running,
    )
    session.add(run)
    session.flush()

    node = GraphRunNode(
        run_id=run.id,
        node_type=RunNodeType.command,
        name="command-node",
        command=command,
        state=RunNodeState.dispatching,
    )
    session.add(node)
    session.commit()
    return workspace, worker, sandbox, run, node


def test_dispatch_command_node_completes_and_enqueues_reconcile(session, monkeypatch):
    _, worker, sandbox, run, node = _build_command_run(session)
    commands: list[tuple[list[str], str]] = []

    async def fake_execute_command(
        worker_url: str,
        *,
        command: list[str],
        cwd: str,
        timeout: int,
        request_timeout: float | None = None,
    ) -> dict[str, object]:
        assert worker_url == worker.worker_url
        commands.append((command, cwd))
        if command[:2] == ["bash", "-c"] and command[2].startswith("mkdir -p "):
            return {"exit_code": 0, "stdout": "", "stderr": ""}
        if command == ["bash", "-c", "echo hi"]:
            return {"exit_code": 0, "stdout": "hi\n", "stderr": ""}
        raise AssertionError(f"Unexpected command payload: {command!r}")

    monkeypatch.setattr(run_svc, "engine", session.get_bind())
    monkeypatch.setattr(run_svc, "execute_command", fake_execute_command)

    asyncio.run(run_svc._dispatch_command_node(run.id, node.id, worker.id))

    session.expire_all()
    node = session.get(GraphRunNode, node.id)
    run = session.get(GraphRun, run.id)
    events = session.exec(
        select(Event)
        .where(Event.run_id == run.id)
        .order_by(Event.received_at.asc(), Event.id.asc())
    ).all()
    reconcile = session.exec(
        select(RunReconcile).where(RunReconcile.run_id == run.id)
    ).one()

    assert node is not None
    assert node.state == RunNodeState.completed
    assert node.output == {"stdout": "hi\n"}
    assert run is not None
    assert run.state == RunState.running
    assert reconcile.reason == "node completed"
    assert commands == [
        (["bash", "-c", f"mkdir -p '/workspaces/{sandbox.id}'"], "/"),
        (["bash", "-c", "echo hi"], f"/workspaces/{sandbox.id}"),
    ]
    assert [event.event_type for event in events] == [
        "run.node.running",
        "command.output",
        "run.node.completed",
    ]


def test_dispatch_command_node_schedules_single_retry_on_failure(session, monkeypatch):
    _, worker, sandbox, run, node = _build_command_run(session, command="exit 7")

    async def fake_execute_command(
        worker_url: str,
        *,
        command: list[str],
        cwd: str,
        timeout: int,
        request_timeout: float | None = None,
    ) -> dict[str, object]:
        assert worker_url == worker.worker_url
        if command[:2] == ["bash", "-c"] and command[2].startswith("mkdir -p "):
            return {"exit_code": 0, "stdout": "", "stderr": ""}
        assert command == ["bash", "-c", "exit 7"]
        assert cwd == f"/workspaces/{sandbox.id}"
        return {"exit_code": 7, "stdout": "", "stderr": "boom"}

    monkeypatch.setattr(run_svc, "engine", session.get_bind())
    monkeypatch.setattr(run_svc, "execute_command", fake_execute_command)

    asyncio.run(run_svc._dispatch_command_node(run.id, node.id, worker.id))

    session.expire_all()
    original = session.get(GraphRunNode, node.id)
    retry_nodes = session.exec(
        select(GraphRunNode)
        .where(GraphRunNode.run_id == run.id)
        .order_by(GraphRunNode.attempt.asc(), GraphRunNode.created_at.asc())
    ).all()
    run = session.get(GraphRun, run.id)
    events = session.exec(
        select(Event)
        .where(Event.run_id == run.id)
        .order_by(Event.received_at.asc(), Event.id.asc())
    ).all()
    reconcile = session.exec(
        select(RunReconcile).where(RunReconcile.run_id == run.id)
    ).one()

    assert original is not None
    assert original.state == RunNodeState.error
    assert original.next_attempt_run_node_id is not None
    assert len(retry_nodes) == 2
    assert retry_nodes[1].attempt == 2
    assert retry_nodes[1].state == RunNodeState.pending
    assert run is not None
    assert run.state == RunState.running
    assert reconcile.reason == "node retry scheduled: command exited 7"
    assert [event.event_type for event in events] == [
        "run.node.running",
        "command.output",
        "run.node.retry_scheduled",
    ]
