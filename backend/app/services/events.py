import datetime
import json
import uuid
from collections.abc import AsyncGenerator
from typing import Any

from sqlmodel import Session, asc, select

from app.models.agent import Agent, AgentStatus
from app.models.event import Event
from app.models.run import GraphRunNode

MARK_COMPLETE_TOOL = "mark_node_complete"


def persist_event(
    session: Session,
    *,
    workspace_id: uuid.UUID,
    source_type: str,
    source_id: str,
    payload: dict[str, Any],
    source_name: str | None = None,
    session_id: str | None = None,
    agent_id: uuid.UUID | None = None,
    run_id: uuid.UUID | None = None,
    node_id: uuid.UUID | None = None,
    sandbox_id: uuid.UUID | None = None,
    worker_id: uuid.UUID | None = None,
) -> Event:
    now = datetime.datetime.utcnow()
    event = Event(
        id=str(payload.get("id", uuid.uuid4())),
        workspace_id=workspace_id,
        type=source_type,
        source_id=source_id,
        session_id=session_id,
        agent_id=agent_id,
        run_id=run_id,
        node_id=node_id,
        sandbox_id=sandbox_id,
        worker_id=worker_id,
        source_name=source_name,
        event_type=str(payload.get("type", "unknown")),
        timestamp=str(payload.get("timestamp", "")),
        data=payload,
        received_at=now,
        persisted_at=now,
    )
    session.merge(event)
    session.commit()
    return event


def _serialize_event(event: Event) -> dict[str, Any]:
    return {
        "id": event.id,
        "workspace_id": str(event.workspace_id),
        "source_type": event.type,
        "source_id": event.source_id,
        "session_id": event.session_id,
        "agent_id": str(event.agent_id) if event.agent_id else None,
        "run_id": str(event.run_id) if event.run_id else None,
        "node_id": str(event.node_id) if event.node_id else None,
        "sandbox_id": str(event.sandbox_id) if event.sandbox_id else None,
        "worker_id": str(event.worker_id) if event.worker_id else None,
        "source_name": event.source_name,
        "type": event.event_type,
        "event_time": event.timestamp,
        "received_at": event.received_at.isoformat(),
        "data": event.data.get("data", event.data),
        "raw": event.data,
    }


def list_workspace_events(
    session: Session,
    workspace_id: uuid.UUID,
    *,
    since: int = 0,
    limit: int = 200,
) -> list[dict[str, Any]]:
    results = session.exec(
        select(Event)
        .where(Event.workspace_id == workspace_id)
        .order_by(asc(Event.received_at), asc(Event.id))
        .offset(since)
        .limit(limit)
    ).all()
    return [_serialize_event(e) for e in results]


async def stream_workspace_events(
    session_factory,
    workspace_id: uuid.UUID,
    *,
    since: int = 0,
) -> AsyncGenerator[bytes, None]:
    cursor = since
    while True:
        with session_factory() as session:
            items = list_workspace_events(session, workspace_id, since=cursor, limit=200)
        if items:
            for item in items:
                cursor += 1
                yield f"id: {item['id']}\ndata: {json.dumps(item)}\n\n".encode()
        else:
            yield b": keepalive\n\n"
        await __import__("asyncio").sleep(1.0)


def ingest_worker_event(
    session: Session,
    *,
    worker_id: uuid.UUID,
    payload: dict[str, Any],
) -> Event:
    from app.services import controller as controller_svc
    from app.services import runs as run_svc

    session_id = str(payload.get("session_id") or payload.get("data", {}).get("session_id") or "")
    agent = session.exec(select(Agent).where(Agent.session_id == session_id)).first() if session_id else None

    workspace_id = agent.workspace_id if agent is not None else None
    source_type = "worker"
    source_id = str(worker_id)
    source_name = None
    agent_id = None
    run_id = None
    node_id = None
    sandbox_id = None

    if agent is not None:
        source_type = "agent"
        source_id = str(agent.id)
        source_name = agent.name
        workspace_id = agent.workspace_id
        agent_id = agent.id
        sandbox_id = agent.sandbox_id
        node = session.exec(select(GraphRunNode).where(GraphRunNode.session_id == session_id)).first()
        if node is not None:
            node_id = node.id
            run_id = node.run_id

    if workspace_id is None:
        raise ValueError("Unable to resolve workspace for worker event")

    event = persist_event(
        session,
        workspace_id=workspace_id,
        source_type=source_type,
        source_id=source_id,
        payload=payload,
        source_name=source_name,
        session_id=session_id or None,
        agent_id=agent_id,
        run_id=run_id,
        node_id=node_id,
        sandbox_id=sandbox_id,
        worker_id=worker_id,
    )

    event_type = event.event_type
    if agent is not None:
        if event_type == "session.busy":
            agent.status = AgentStatus.busy
        elif event_type == "session.idle":
            agent.status = AgentStatus.idle
        elif event_type == "session.completed":
            agent.status = AgentStatus.completed
        elif event_type == "session.error":
            agent.status = AgentStatus.error
        elif event_type == "session.interrupted":
            agent.status = AgentStatus.interrupted
        elif event_type == "feedback.request":
            agent.status = AgentStatus.waiting
        agent.updated_at = datetime.datetime.utcnow()
        session.add(agent)
        session.commit()

    if node_id is not None and run_id is not None:
        node = session.get(GraphRunNode, node_id)
        if node is not None:
            if node.graph_tools and event_type == "tool.use" and payload.get("data", {}).get("tool_name") == MARK_COMPLETE_TOOL:
                run_svc.complete_node(session, run_id, node_id)
            elif not node.graph_tools and event_type == "session.idle":
                run_svc.complete_node(session, run_id, node_id)
            elif event_type == "session.error":
                run_svc.fail_node_and_run(session, run_id, node_id, "worker session error")
            else:
                controller_svc.enqueue_run_reconcile(session, run_id, reason=f"event:{event_type}")

    return event
