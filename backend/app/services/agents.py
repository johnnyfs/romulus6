import datetime
import uuid
from collections.abc import AsyncGenerator
from typing import Any

import httpx
from sqlmodel import Session, select

from app.models.agent import Agent, AgentStatus, AgentType
from app.models.event import Event
from app.models.sandbox import Sandbox
from app.services import events as event_svc
from app.services import sandboxes as sandbox_svc
from app.services import workers as worker_svc
from app.services.worker_client import post_session_message, post_session_with_retry

_post_session_with_retry = post_session_with_retry


def _mark_agent_session_unavailable(
    session: Session,
    agent: Agent,
    *,
    prompt: str,
    worker_id: uuid.UUID | None,
    error: str,
) -> None:
    _persist_agent_event(
        session,
        agent,
        "message.dispatch.failed",
        data={"prompt": prompt, "error": error},
        worker_id=worker_id,
    )
    agent.status = AgentStatus.error
    agent.session_id = None
    agent.updated_at = datetime.datetime.utcnow()
    session.add(agent)
    session.commit()


def _persist_agent_event(
    session: Session,
    agent: Agent,
    event_type: str,
    *,
    data: dict[str, Any] | None = None,
    worker_id: uuid.UUID | None = None,
) -> None:
    event_svc.persist_event(
        session,
        workspace_id=agent.workspace_id,
        source_type="agent",
        source_id=str(agent.id),
        payload={
            "id": str(uuid.uuid4()),
            "type": event_type,
            "session_id": agent.session_id,
            "timestamp": datetime.datetime.utcnow().isoformat(),
            "data": data or {},
        },
        source_name=agent.name,
        session_id=agent.session_id,
        agent_id=agent.id,
        sandbox_id=agent.sandbox_id,
        worker_id=worker_id,
    )


def _mark_agent_launch_failed(
    session: Session,
    agent: Agent,
    *,
    worker_id: uuid.UUID | None,
    error: Exception | str,
) -> None:
    agent.status = AgentStatus.error
    agent.session_id = None
    agent.updated_at = datetime.datetime.utcnow()
    session.add(agent)
    session.commit()

    _persist_agent_event(
        session,
        agent,
        "session.create.failed",
        data={"error": str(error)},
        worker_id=worker_id,
    )

    if agent.sandbox_id is not None:
        sandbox_id = agent.sandbox_id
        sandbox_svc.delete_sandbox(session, agent.workspace_id, sandbox_id)
        agent.sandbox_id = None
        agent.updated_at = datetime.datetime.utcnow()
        session.add(agent)
        session.commit()


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

    _persist_agent_event(
        session,
        agent,
        "session.create.requested",
        data={
            "agent_type": agent_type.value,
            "model": model,
            "graph_tools": graph_tools,
            "schema_id": schema_id,
        },
        worker_id=worker.id,
    )

    if worker.worker_url is None:
        _mark_agent_launch_failed(
            session,
            agent,
            worker_id=worker.id,
            error="Worker URL not available",
        )
        raise RuntimeError("Worker URL not available")

    try:
        data = await _post_session_with_retry(
            worker.worker_url,
            payload={
                "prompt": prompt,
                "agent_type": agent_type.value,
                "model": model,
                "workspace_name": str(sandbox.id),
                "graph_tools": graph_tools,
                "workspace_id": str(workspace_id),
                "sandbox_id": str(sandbox.id),
                "schema_id": schema_id,
            },
        )
    except Exception as exc:
        _mark_agent_launch_failed(session, agent, worker_id=worker.id, error=exc)
        raise

    agent.session_id = data["session"]["id"]
    agent.status = AgentStatus.busy
    agent.updated_at = datetime.datetime.utcnow()
    session.add(agent)
    session.commit()
    session.refresh(agent)

    _persist_agent_event(
        session,
        agent,
        "session.create.acknowledged",
        data={"session": data.get("session", {})},
        worker_id=worker.id,
    )
    return agent


def list_agents(session: Session, workspace_id: uuid.UUID) -> list[Agent]:
    return list(
        session.exec(
            Agent.active()
            .where(Agent.workspace_id == workspace_id)
            .order_by(
                Agent.dismissed.asc(),
                Agent.updated_at.desc(),
                Agent.created_at.desc(),
            )
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
    sandbox = session.get(Sandbox, agent.sandbox_id)
    worker = worker_svc.get_worker_for_sandbox(session, sandbox)
    worker_id = worker.id if worker is not None else None

    agent.status = AgentStatus.busy
    agent.updated_at = datetime.datetime.utcnow()
    session.add(agent)
    session.commit()

    _persist_agent_event(
        session,
        agent,
        "message.dispatch.requested",
        data={"prompt": prompt},
        worker_id=worker_id,
    )

    if agent.session_id is None:
        _mark_agent_session_unavailable(
            session,
            agent,
            prompt=prompt,
            worker_id=worker_id,
            error="Agent has no active session",
        )
        raise RuntimeError("Agent has no active session")
    if worker is None or worker.worker_url is None:
        message = "Agent session is no longer available; recreate the agent"
        _mark_agent_session_unavailable(
            session,
            agent,
            prompt=prompt,
            worker_id=worker_id,
            error=message,
        )
        raise RuntimeError(message)
    try:
        await post_session_message(worker.worker_url, agent.session_id, prompt)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            message = "Agent session was lost after worker restart; recreate the agent"
            _mark_agent_session_unavailable(
                session,
                agent,
                prompt=prompt,
                worker_id=worker_id,
                error=message,
            )
            raise RuntimeError(message) from exc
        _persist_agent_event(
            session,
            agent,
            "message.dispatch.failed",
            data={"prompt": prompt, "error": str(exc)},
            worker_id=worker_id,
        )
        raise
    except Exception as exc:
        _persist_agent_event(
            session,
            agent,
            "message.dispatch.failed",
            data={"prompt": prompt, "error": str(exc)},
            worker_id=worker_id,
        )
        raise

    _persist_agent_event(
        session,
        agent,
        "message.dispatched",
        data={"prompt": prompt},
        worker_id=worker_id,
    )


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
    agent.status = AgentStatus.busy
    agent.updated_at = datetime.datetime.utcnow()
    session.add(agent)
    session.commit()

    event_svc.persist_event(
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


def delete_agent(
    session: Session,
    workspace_id: uuid.UUID,
    agent_id: uuid.UUID,
) -> bool:
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


async def get_agent_events(
    session: Session,
    agent: Agent,
    since: int = 0,
    after: str | None = None,
) -> list[dict[str, Any]]:
    return event_svc.list_agent_events(
        session,
        agent.workspace_id,
        agent.id,
        since=since,
        after=after,
    )


async def stream_agent_events(
    session_factory,
    agent: Agent,
    since: int = 0,
    after: str | None = None,
) -> AsyncGenerator[bytes, None]:
    async for chunk in event_svc.stream_agent_events(
        session_factory,
        agent.workspace_id,
        agent.id,
        since=since,
        after=after,
    ):
        yield chunk
