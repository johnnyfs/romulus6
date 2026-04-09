import asyncio
import json
from contextlib import contextmanager

import httpx
import pytest
from sqlmodel import select

from app.models.agent import Agent, AgentStatus, AgentType
from app.models.event import Event
from app.models.run import GraphRun, GraphRunNode, RunNodeState, RunNodeType, RunState
from app.models.sandbox import Sandbox
from app.models.worker import Worker, WorkerStatus
from app.services import agents as agent_svc
from app.services import events as event_svc
from app.services import workers as worker_svc
from app.services import workspaces as workspace_svc
from app.utils.time import utcnow

pytestmark = pytest.mark.fast


def _parse_sse_payload(chunk: bytes) -> dict:
    for line in chunk.decode().splitlines():
        if line.startswith("data: "):
            return json.loads(line[6:])
    raise AssertionError("No data payload found in SSE chunk")


def test_workspace_stream_replays_backlog_and_publishes_live_events(session):
    workspace = workspace_svc.create_workspace(session, "streaming")
    event_svc.persist_event(
        session,
        workspace_id=workspace.id,
        source_type="agent",
        source_id="agent-1",
        payload={
            "id": "event-1",
            "type": "session.busy",
            "timestamp": utcnow().isoformat(),
            "data": {"message": "backlog"},
        },
    )

    @contextmanager
    def session_factory():
        yield session

    async def consume_stream() -> tuple[dict, dict]:
        stream = event_svc.stream_workspace_events(
            session_factory,
            workspace.id,
            keepalive_interval=0.05,
        )
        try:
            first = _parse_sse_payload(
                await asyncio.wait_for(anext(stream), timeout=0.2)
            )
            event_svc.persist_event(
                session,
                workspace_id=workspace.id,
                source_type="agent",
                source_id="agent-1",
                payload={
                    "id": "event-2",
                    "type": "text.delta",
                    "timestamp": utcnow().isoformat(),
                    "data": {"message": "live"},
                },
            )
            second = _parse_sse_payload(
                await asyncio.wait_for(anext(stream), timeout=0.2)
            )
            return first, second
        finally:
            await stream.aclose()

    backlog_item, live_item = asyncio.run(consume_stream())

    assert backlog_item["id"] == "event-1"
    assert backlog_item["type"] == "session.busy"
    assert live_item["id"] == "event-2"
    assert live_item["type"] == "text.delta"


def test_list_agent_events_after_cursor_filters_to_newer_events(session):
    workspace = workspace_svc.create_workspace(session, "agent-events")
    agent = Agent(
        workspace_id=workspace.id,
        agent_type=AgentType.opencode,
        model="openai/gpt-4o",
        status=AgentStatus.idle,
        name="debug-agent",
        prompt="trace me",
    )
    session.add(agent)
    session.commit()
    session.refresh(agent)

    event_svc.persist_event(
        session,
        workspace_id=workspace.id,
        source_type="agent",
        source_id=str(agent.id),
        payload={
            "id": "agent-event-1",
            "type": "session.create.requested",
            "timestamp": utcnow().isoformat(),
            "data": {"step": 1},
        },
        agent_id=agent.id,
    )
    event_svc.persist_event(
        session,
        workspace_id=workspace.id,
        source_type="user",
        source_id=str(agent.id),
        payload={
            "id": "agent-event-2",
            "type": "feedback.response",
            "timestamp": utcnow().isoformat(),
            "data": {"step": 2},
        },
        agent_id=agent.id,
    )

    events = event_svc.list_agent_events(session, workspace.id, agent.id)
    resumed = event_svc.list_agent_events(
        session,
        workspace.id,
        agent.id,
        after=events[0]["cursor"],
    )

    assert [item["id"] for item in events] == ["agent-event-1", "agent-event-2"]
    assert [item["id"] for item in resumed] == ["agent-event-2"]


def test_create_agent_failure_persists_lifecycle_events(session, monkeypatch):
    workspace = workspace_svc.create_workspace(session, "failed-launch")
    session.add(
        Worker(
            status=WorkerStatus.running,
            worker_url="http://worker.test",
            worker_metadata={},
            last_heartbeat_at=utcnow(),
        )
    )
    session.commit()

    async def fail_post_session(*args, **kwargs):
        raise RuntimeError("session boot failed")

    monkeypatch.setattr(agent_svc, "_post_session_with_retry", fail_post_session)

    with pytest.raises(RuntimeError, match="session boot failed"):
        asyncio.run(
            agent_svc.create_agent(
                session,
                workspace_id=workspace.id,
                agent_type=AgentType.opencode,
                model="openai/gpt-4o",
                prompt="launch me",
                name="broken-agent",
            )
        )

    agent = session.exec(select(Agent)).one()
    events = session.exec(
        select(Event)
        .where(Event.agent_id == agent.id)
        .order_by(Event.received_at.asc(), Event.id.asc())
    ).all()

    assert agent.status == AgentStatus.error
    assert agent.deleted is False
    assert agent.sandbox_id is None
    assert [event.event_type for event in events] == [
        "session.create.requested",
        "session.create.failed",
    ]
    assert events[-1].data["data"]["error"] == "session boot failed"


def test_create_codex_agent_forwards_sandbox_mode(session, monkeypatch):
    workspace = workspace_svc.create_workspace(session, "codex-launch")
    worker = Worker(
        status=WorkerStatus.running,
        worker_url="http://worker.test",
        worker_metadata={},
        last_heartbeat_at=utcnow(),
    )
    session.add(worker)
    session.commit()

    captured: dict[str, object] = {}

    async def fake_post_session(worker_url: str, *, payload, **kwargs):
        assert worker_url == worker.worker_url
        captured["sandbox_mode"] = payload.sandbox_mode
        return {"session": {"id": "codex-session"}}

    monkeypatch.setattr(agent_svc, "_post_session_with_retry", fake_post_session)

    agent = asyncio.run(
        agent_svc.create_agent(
            session,
            workspace_id=workspace.id,
            agent_type=AgentType.codex,
            model="openai/gpt-5.3-codex",
            prompt="launch codex",
            name="codex-agent",
            sandbox_mode="workspace-write",
        )
    )

    assert agent.sandbox_mode == "workspace-write"
    assert captured["sandbox_mode"] == "workspace-write"


def test_send_message_recovers_on_missing_worker_session(session, monkeypatch):
    workspace = workspace_svc.create_workspace(session, "stale-session")
    worker = Worker(
        status=WorkerStatus.running,
        worker_url="http://worker.test",
        worker_metadata={},
        last_heartbeat_at=utcnow(),
    )
    session.add(worker)
    session.commit()
    session.refresh(worker)

    sandbox = Sandbox(
        workspace_id=workspace.id,
        name="stale-sandbox",
        worker_id=worker.id,
    )
    session.add(sandbox)
    session.commit()
    session.refresh(sandbox)

    agent = Agent(
        workspace_id=workspace.id,
        sandbox_id=sandbox.id,
        agent_type=AgentType.opencode,
        model="openai/gpt-4o",
        status=AgentStatus.idle,
        name="stale-agent",
        prompt="recover me",
        session_id="missing-session",
    )
    session.add(agent)
    session.commit()
    session.refresh(agent)

    event_svc.persist_event(
        session,
        workspace_id=workspace.id,
        source_type="agent",
        source_id=str(agent.id),
        payload={
            "id": "agent-bootstrap",
            "type": "session.create.requested",
            "session_id": "missing-session",
            "timestamp": utcnow().isoformat(),
            "data": {
                "prompt": "recover me",
                "agent_type": "opencode",
                "model": "openai/gpt-4o",
                "graph_tools": False,
                "schema_id": None,
            },
        },
        source_name=agent.name,
        session_id="missing-session",
        agent_id=agent.id,
        sandbox_id=sandbox.id,
        worker_id=worker.id,
    )

    async def raise_missing_session(*args, **kwargs):
        request = httpx.Request(
            "POST",
            "http://worker.test/sessions/missing-session/messages",
        )
        response = httpx.Response(404, request=request, text="Session not found")
        raise httpx.HTTPStatusError(
            "404 Session not found",
            request=request,
            response=response,
        )

    recovered_payload: dict[str, object] = {}

    async def boot_recovered_session(*args, **kwargs):
        payload = kwargs["payload"]
        recovered_payload["prompt"] = payload.prompt
        recovered_payload["sandbox_id"] = payload.sandbox_id
        recovered_payload["recovery"] = payload.recovery
        return {"session": {"id": "replacement-session"}}

    monkeypatch.setattr(agent_svc, "post_session_message", raise_missing_session)
    monkeypatch.setattr(agent_svc, "_post_session_with_retry", boot_recovered_session)

    asyncio.run(agent_svc.send_message(session, agent, "hello again"))

    session.refresh(agent)
    replacement_sandbox = session.get(Sandbox, agent.sandbox_id)
    session.refresh(sandbox)
    events = session.exec(
        select(Event)
        .where(Event.agent_id == agent.id)
        .order_by(Event.received_at.asc(), Event.id.asc())
    ).all()

    recovery = recovered_payload["recovery"]

    assert agent.status == AgentStatus.busy
    assert agent.session_id == "replacement-session"
    assert sandbox.deleted is True
    assert replacement_sandbox is not None
    assert replacement_sandbox.deleted is False
    assert replacement_sandbox.id != sandbox.id
    assert recovered_payload["prompt"] == "hello again"
    assert recovered_payload["sandbox_id"] == str(replacement_sandbox.id)
    assert recovery is not None
    assert recovery.previous_session_id == "missing-session"
    assert recovery.previous_sandbox_id == str(sandbox.id)
    assert [item.type for item in recovery.history] == ["user_message"]
    assert recovery.history[0].content == "recover me"
    assert [event.event_type for event in events] == [
        "session.create.requested",
        "message.dispatch.requested",
        "session.recovery.requested",
        "sandbox.lost",
        "session.create.requested",
        "session.create.acknowledged",
        "session.recovered",
        "message.dispatched",
    ]


def test_send_message_marks_agent_error_when_recovery_launch_fails(
    session,
    monkeypatch,
):
    workspace = workspace_svc.create_workspace(session, "recovery-fails")
    worker = Worker(
        status=WorkerStatus.running,
        worker_url="http://worker.test",
        worker_metadata={},
        last_heartbeat_at=utcnow(),
    )
    session.add(worker)
    session.commit()
    session.refresh(worker)

    sandbox = Sandbox(
        workspace_id=workspace.id,
        name="stale-sandbox",
        worker_id=worker.id,
    )
    session.add(sandbox)
    session.commit()
    session.refresh(sandbox)

    agent = Agent(
        workspace_id=workspace.id,
        sandbox_id=sandbox.id,
        agent_type=AgentType.opencode,
        model="openai/gpt-4o",
        status=AgentStatus.idle,
        name="stale-agent",
        prompt="recover me",
        session_id="missing-session",
    )
    session.add(agent)
    session.commit()
    session.refresh(agent)

    event_svc.persist_event(
        session,
        workspace_id=workspace.id,
        source_type="agent",
        source_id=str(agent.id),
        payload={
            "id": "agent-bootstrap-fail",
            "type": "session.create.requested",
            "session_id": "missing-session",
            "timestamp": utcnow().isoformat(),
            "data": {
                "prompt": "recover me",
                "agent_type": "opencode",
                "model": "openai/gpt-4o",
                "graph_tools": False,
                "schema_id": None,
            },
        },
        source_name=agent.name,
        session_id="missing-session",
        agent_id=agent.id,
        sandbox_id=sandbox.id,
        worker_id=worker.id,
    )

    async def raise_missing_session(*args, **kwargs):
        request = httpx.Request(
            "POST",
            "http://worker.test/sessions/missing-session/messages",
        )
        response = httpx.Response(404, request=request, text="Session not found")
        raise httpx.HTTPStatusError(
            "404 Session not found",
            request=request,
            response=response,
        )

    async def fail_recovery(*args, **kwargs):
        raise RuntimeError("recovery session boot failed")

    monkeypatch.setattr(agent_svc, "post_session_message", raise_missing_session)
    monkeypatch.setattr(agent_svc, "_post_session_with_retry", fail_recovery)

    with pytest.raises(RuntimeError, match="recovery session boot failed"):
        asyncio.run(agent_svc.send_message(session, agent, "hello again"))

    session.refresh(agent)
    events = session.exec(
        select(Event)
        .where(Event.agent_id == agent.id)
        .order_by(Event.received_at.asc(), Event.id.asc())
    ).all()

    assert agent.status == AgentStatus.error
    assert agent.session_id is None
    assert agent.sandbox_id is None
    assert sandbox.deleted is True
    assert [event.event_type for event in events][-5:] == [
        "session.recovery.requested",
        "sandbox.lost",
        "session.create.requested",
        "session.recovery.failed",
        "message.dispatch.failed",
    ]
    assert events[-1].data["data"]["error"] == "recovery session boot failed"


def test_register_worker_restart_invalidates_attached_agent_sessions(session):
    workspace = workspace_svc.create_workspace(session, "worker-restart")
    worker = Worker(
        status=WorkerStatus.running,
        worker_url="http://worker.test",
        pod_name="worker-a",
        worker_metadata={"pid": 1001},
        last_heartbeat_at=utcnow(),
    )
    session.add(worker)
    session.commit()
    session.refresh(worker)

    sandbox = Sandbox(
        workspace_id=workspace.id,
        name="restart-sandbox",
        worker_id=worker.id,
    )
    session.add(sandbox)
    session.commit()
    session.refresh(sandbox)

    agent = Agent(
        workspace_id=workspace.id,
        sandbox_id=sandbox.id,
        agent_type=AgentType.opencode,
        model="openai/gpt-4o",
        status=AgentStatus.idle,
        name="restart-agent",
        prompt="watch me",
        session_id="live-session",
    )
    session.add(agent)
    session.commit()
    session.refresh(agent)

    registered = worker_svc.register_worker(
        session,
        worker_url="http://worker.test",
        pod_name="worker-a",
        metadata={"pid": 2002},
    )

    session.refresh(agent)
    events = session.exec(
        select(Event)
        .where(Event.agent_id == agent.id)
        .order_by(Event.received_at.asc(), Event.id.asc())
    ).all()

    assert registered.id == worker.id
    assert agent.status == AgentStatus.error
    assert agent.session_id is None
    assert [event.event_type for event in events] == ["session.error"]
    assert (
        events[0].data["data"]["error"]
        == (
            "worker restarted; session lost and will recover on a fresh "
            "sandbox when resumed"
        )
    )


def test_ingest_worker_event_completes_opencode_graph_node_from_mark_complete_args(session):
    workspace = workspace_svc.create_workspace(session, "graph-node-complete")
    worker = Worker(
        status=WorkerStatus.running,
        worker_url="http://worker.test",
        worker_metadata={},
        last_heartbeat_at=utcnow(),
    )
    session.add(worker)
    session.flush()

    sandbox = Sandbox(
        workspace_id=workspace.id,
        name="graph-node-sandbox",
        worker_id=worker.id,
    )
    session.add(sandbox)
    session.flush()

    run = GraphRun(
        workspace_id=workspace.id,
        state=RunState.running,
        sandbox_id=sandbox.id,
    )
    session.add(run)
    session.flush()

    node = GraphRunNode(
        run_id=run.id,
        node_type=RunNodeType.agent,
        state=RunNodeState.running,
        agent_type="opencode",
        graph_tools=True,
        output_schema={"answer": "string"},
        session_id="graph-session",
    )
    session.add(node)
    session.flush()

    agent = Agent(
        workspace_id=workspace.id,
        sandbox_id=sandbox.id,
        agent_type=AgentType.opencode,
        model="openai/gpt-4o",
        status=AgentStatus.busy,
        name="graph-agent",
        prompt="complete the node",
        graph_run_id=run.id,
        session_id="graph-session",
    )
    session.add(agent)
    session.commit()
    session.refresh(node)
    session.refresh(agent)

    event_svc.ingest_worker_event(
        session,
        worker_id=worker.id,
        payload={
            "id": "mark-complete-event",
            "session_id": "graph-session",
            "type": "tool.use",
            "timestamp": utcnow().isoformat(),
            "data": {
                "tool_name": "mark_node_complete",
                "args": {"output": {"answer": "done"}},
            },
        },
    )

    session.refresh(node)
    session.refresh(agent)
    events = session.exec(
        select(Event)
        .where(Event.run_id == run.id)
        .order_by(Event.received_at.asc(), Event.id.asc())
    ).all()

    assert agent.status == AgentStatus.busy
    assert node.state == RunNodeState.completed
    assert node.output == {"answer": "done"}
    assert [event.event_type for event in events][-2:] == [
        "tool.use",
        "run.node.completed",
    ]


@pytest.mark.parametrize("agent_type", ["codex", "claude_code"])
def test_ingest_worker_event_completes_non_opencode_graph_tools_node_on_idle(
    session,
    agent_type,
):
    workspace = workspace_svc.create_workspace(session, f"idle-complete-{agent_type}")
    worker = Worker(
        status=WorkerStatus.running,
        worker_url="http://worker.test",
        worker_metadata={},
        last_heartbeat_at=utcnow(),
    )
    session.add(worker)
    session.flush()

    sandbox = Sandbox(
        workspace_id=workspace.id,
        name=f"{agent_type}-sandbox",
        worker_id=worker.id,
    )
    session.add(sandbox)
    session.flush()

    run = GraphRun(
        workspace_id=workspace.id,
        state=RunState.running,
        sandbox_id=sandbox.id,
    )
    session.add(run)
    session.flush()

    node = GraphRunNode(
        run_id=run.id,
        node_type=RunNodeType.agent,
        state=RunNodeState.running,
        agent_type=agent_type,
        graph_tools=True,
        session_id=f"{agent_type}-session",
    )
    session.add(node)
    session.flush()

    agent = Agent(
        workspace_id=workspace.id,
        sandbox_id=sandbox.id,
        agent_type=AgentType(agent_type),
        model="anthropic/claude-sonnet-4-6"
        if agent_type == "claude_code"
        else "openai/gpt-5.3-codex",
        status=AgentStatus.busy,
        name=f"{agent_type}-agent",
        prompt="finish when idle",
        graph_run_id=run.id,
        session_id=f"{agent_type}-session",
    )
    session.add(agent)
    session.commit()
    session.refresh(node)
    session.refresh(agent)

    event_svc.ingest_worker_event(
        session,
        worker_id=worker.id,
        payload={
            "id": f"{agent_type}-idle-event",
            "session_id": f"{agent_type}-session",
            "type": "session.idle",
            "timestamp": utcnow().isoformat(),
            "data": {},
        },
    )

    session.refresh(node)
    session.refresh(agent)

    assert agent.status == AgentStatus.idle
    assert node.state == RunNodeState.completed
