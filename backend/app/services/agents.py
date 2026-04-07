import asyncio
import datetime
import json
import uuid
from collections.abc import AsyncGenerator
from typing import Any

import httpx
from sqlmodel import Session, asc, select

from app.models.agent import Agent, AgentStatus, AgentType
from app.models.event import Event
from app.models.sandbox import Sandbox
from app.services import sandboxes as sandbox_svc
from app.services import workers as worker_svc


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


async def create_agent(
    session: Session,
    workspace_id: uuid.UUID,
    agent_type: AgentType,
    model: str,
    prompt: str,
    name: str | None,
    graph_tools: bool = False,
    schema_id: str | None = None,
) -> Agent:
    resolved_name = name or f"{agent_type.value}-{uuid.uuid4().hex[:8]}"
    sandbox, worker = sandbox_svc.create_sandbox(session, workspace_id, resolved_name)
    if worker.worker_url is None:
        sandbox_svc.delete_sandbox(session, workspace_id, sandbox.id)
        raise RuntimeError("Worker URL not available")

    agent = Agent(
        workspace_id=workspace_id,
        sandbox_id=sandbox.id,
        agent_type=agent_type,
        model=model,
        prompt=prompt,
        name=resolved_name,
        status=AgentStatus.starting,
        dismissed=False,
        graph_tools=graph_tools,
    )
    session.add(agent)
    session.commit()
    session.refresh(agent)

    try:
        data = await _post_session_with_retry(
            worker.worker_url,
            payload={
                "prompt": prompt,
                "agent_type": agent_type.value,
                "model": model,
                "workspace_name": str(workspace_id),
                "graph_tools": graph_tools,
                "workspace_id": str(workspace_id),
                "sandbox_id": str(sandbox.id),
                "schema_id": schema_id,
            },
        )
    except Exception:
        delete_agent(session, workspace_id, agent.id)
        raise

    agent.session_id = data["session"]["id"]
    agent.status = AgentStatus.busy
    agent.updated_at = datetime.datetime.utcnow()
    session.add(agent)
    session.commit()
    session.refresh(agent)
    return agent


def list_agents(session: Session, workspace_id: uuid.UUID) -> list[Agent]:
    return list(
        session.exec(
            Agent.active()
            .where(Agent.workspace_id == workspace_id)
            .order_by(Agent.dismissed.asc(), Agent.updated_at.desc(), Agent.created_at.desc())
        ).all()
    )


def get_agent(
    session: Session,
    workspace_id: uuid.UUID,
    agent_id: uuid.UUID,
    include_deleted: bool = False,
) -> Agent | None:
    agent = session.get(Agent, agent_id)
    if agent is None or agent.workspace_id != workspace_id:
        return None
    if not include_deleted and agent.deleted:
        return None
    return agent


async def send_message(session: Session, agent: Agent, prompt: str) -> None:
    if agent.session_id is None:
        raise RuntimeError("Agent has no active session")
    sandbox = session.get(Sandbox, agent.sandbox_id)
    worker = worker_svc.get_worker_for_sandbox(session, sandbox)
    if worker is None or worker.worker_url is None:
        raise RuntimeError("Agent session is no longer available; recreate the agent")
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{worker.worker_url}/sessions/{agent.session_id}/messages",
            json={"prompt": prompt},
            timeout=10.0,
        )
        resp.raise_for_status()


def set_agent_dismissed(
    session: Session,
    workspace_id: uuid.UUID,
    agent_id: uuid.UUID,
    *,
    dismissed: bool,
) -> Agent | None:
    agent = get_agent(session, workspace_id, agent_id)
    if agent is None:
        return None
    if dismissed and agent.sandbox_id is not None:
        sandbox_svc.delete_sandbox(session, workspace_id, agent.sandbox_id)
        agent.sandbox_id = None
        agent.session_id = None
        if agent.status in {
            AgentStatus.starting,
            AgentStatus.busy,
            AgentStatus.idle,
            AgentStatus.waiting,
        }:
            agent.status = AgentStatus.interrupted
    agent.dismissed = dismissed
    agent.updated_at = datetime.datetime.utcnow()
    session.add(agent)
    session.commit()
    session.refresh(agent)
    return agent


async def send_feedback(
    session: Session,
    agent: Agent,
    feedback_id: str,
    feedback_type: str,
    response: str,
) -> None:
    from app.services.events import persist_event

    agent.status = AgentStatus.busy
    agent.updated_at = datetime.datetime.utcnow()
    session.add(agent)
    session.commit()

    persist_event(
        session,
        workspace_id=agent.workspace_id,
        source_type="user",
        source_id=str(agent.id),
        payload={
            "id": str(uuid.uuid4()),
            "type": "feedback.response",
            "session_id": agent.session_id,
            "timestamp": datetime.datetime.utcnow().isoformat(),
            "data": {
                "feedback_id": feedback_id,
                "feedback_type": feedback_type,
                "response": response,
            },
        },
        source_name=None,
        session_id=agent.session_id,
        agent_id=agent.id,
        sandbox_id=agent.sandbox_id,
    )
    await send_message(session, agent, response)


def delete_agent(session: Session, workspace_id: uuid.UUID, agent_id: uuid.UUID) -> bool:
    agent = get_agent(session, workspace_id, agent_id)
    if agent is None:
        return False
    if not agent.dismissed:
        raise ValueError("Agent must be dismissed before deletion")
    for event in session.exec(
        select(Event)
        .where(Event.workspace_id == workspace_id)
        .where(Event.agent_id == agent.id)
    ).all():
        session.delete(event)
    if agent.sandbox_id is not None:
        sandbox_svc.delete_sandbox(session, workspace_id, agent.sandbox_id)
    agent.deleted = True
    agent.sandbox_id = None
    agent.session_id = None
    agent.updated_at = datetime.datetime.utcnow()
    session.add(agent)
    session.commit()
    return True


async def get_agent_events(session: Session, agent: Agent, since: int = 0) -> list[dict[str, Any]]:
    results = session.exec(
        select(Event)
        .where(Event.workspace_id == agent.workspace_id)
        .where(Event.type == "agent")
        .where(Event.source_id == str(agent.id))
        .order_by(asc(Event.received_at), asc(Event.id))
        .offset(since)
    ).all()
    return [
        {
            "id": e.id,
            "session_id": e.session_id or "",
            "type": e.event_type,
            "timestamp": e.timestamp,
            "received_at": e.received_at.isoformat(),
            "data": e.data.get("data", e.data),
            "source_name": e.source_name,
            "agent_id": str(e.agent_id) if e.agent_id else None,
        }
        for e in results
    ]


async def stream_agent_events(session: Session, agent: Agent, since: int = 0) -> AsyncGenerator[bytes, None]:
    cursor = since
    while True:
        events = await get_agent_events(session, agent, since=cursor)
        if events:
            for item in events:
                cursor += 1
                yield f"id: {item['id']}\ndata: {json.dumps(item)}\n\n".encode()
        else:
            yield b": keepalive\n\n"
        await asyncio.sleep(1.0)
