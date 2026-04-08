import asyncio
import datetime
import json
from contextlib import contextmanager

import pytest
from sqlmodel import select

from app.models.agent import Agent, AgentStatus, AgentType
from app.models.event import Event
from app.models.worker import Worker, WorkerStatus
from app.services import agents as agent_svc
from app.services import events as event_svc
from app.services import workspaces as workspace_svc


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
            "timestamp": datetime.datetime.utcnow().isoformat(),
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
                    "timestamp": datetime.datetime.utcnow().isoformat(),
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
            "timestamp": datetime.datetime.utcnow().isoformat(),
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
            "timestamp": datetime.datetime.utcnow().isoformat(),
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
            last_heartbeat_at=datetime.datetime.utcnow(),
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
