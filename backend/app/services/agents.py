import datetime
import uuid
from collections.abc import AsyncGenerator
from typing import Any

import httpx
from romulus_common.worker_api import CreateSessionRequest
from sqlmodel import Session, select

from app.models.agent import Agent, AgentStatus, AgentType
from app.models.event import Event
from app.models.sandbox import Sandbox
from app.services import agent_recovery as agent_recovery_svc
from app.services import events as event_svc
from app.services import sandboxes as sandbox_svc
from app.services import workers as worker_svc
from app.services.worker_client import post_session_message, post_session_with_retry

_post_session_with_retry = post_session_with_retry
_UNSET = object()


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
    session_id_override: str | None | object = _UNSET,
    sandbox_id_override: uuid.UUID | None | object = _UNSET,
) -> Event:
    event_session_id = (
        agent.session_id
        if session_id_override is _UNSET
        else session_id_override
    )
    event_sandbox_id = (
        agent.sandbox_id
        if sandbox_id_override is _UNSET
        else sandbox_id_override
    )
    return event_svc.persist_event(
        session,
        workspace_id=agent.workspace_id,
        source_type="agent",
        source_id=str(agent.id),
        payload={
            "id": str(uuid.uuid4()),
            "type": event_type,
            "session_id": event_session_id,
            "timestamp": datetime.datetime.utcnow().isoformat(),
            "data": data or {},
        },
        source_name=agent.name,
        session_id=event_session_id,
        agent_id=agent.id,
        sandbox_id=event_sandbox_id,
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


async def _create_worker_session(
    *,
    worker_url: str,
    workspace_id: uuid.UUID,
    sandbox_id: uuid.UUID,
    prompt: str,
    agent_type: AgentType,
    model: str,
    graph_tools: bool,
    schema_id: str | None,
    recovery: Any | None = None,
) -> dict[str, Any]:
    request = CreateSessionRequest(
        prompt=prompt,
        agent_type=agent_type.value,
        model=model,
        workspace_name=str(sandbox_id),
        graph_tools=graph_tools,
        workspace_id=str(workspace_id),
        sandbox_id=str(sandbox_id),
        schema_id=schema_id,
        recovery=recovery,
    )
    return await _post_session_with_retry(worker_url, payload=request)


def _set_agent_runtime_state(
    session: Session,
    agent: Agent,
    *,
    sandbox_id: uuid.UUID | None = _UNSET,
    session_id: str | None = _UNSET,
    status: AgentStatus | None = None,
) -> None:
    if sandbox_id is not _UNSET:
        agent.sandbox_id = sandbox_id
    if session_id is not _UNSET:
        agent.session_id = session_id
    if status is not None:
        agent.status = status
    agent.updated_at = datetime.datetime.utcnow()
    session.add(agent)
    session.commit()
    session.refresh(agent)


async def _recover_agent_for_prompt(
    session: Session,
    agent: Agent,
    *,
    prompt: str,
    reason: str,
    request_event_id: str | None,
) -> uuid.UUID:
    if agent.graph_run_id is not None:
        _mark_agent_session_unavailable(
            session,
            agent,
            prompt=prompt,
            worker_id=None,
            error=reason,
        )
        raise RuntimeError(reason)

    previous_session_id = agent_recovery_svc.last_known_session_id(session, agent)
    previous_sandbox_id = agent_recovery_svc.last_known_sandbox_id(session, agent)
    previous_worker_id: uuid.UUID | None = None
    if previous_sandbox_id is not None:
        previous_sandbox = session.get(Sandbox, previous_sandbox_id)
        if previous_sandbox is not None:
            previous_worker_id = previous_sandbox.worker_id

    history = agent_recovery_svc.build_recovery_context(
        session,
        agent,
        reason=reason,
        previous_session_id=previous_session_id,
        previous_sandbox_id=previous_sandbox_id,
        exclude_event_ids={request_event_id} if request_event_id else None,
    )
    schema_id = agent_recovery_svc.resolve_agent_schema_id(session, agent)

    _persist_agent_event(
        session,
        agent,
        "session.recovery.requested",
        data={
            "reason": reason,
            "previous_session_id": previous_session_id,
            "previous_sandbox_id": (
                str(previous_sandbox_id) if previous_sandbox_id is not None else None
            ),
            "history_length": len(history.history),
        },
        worker_id=previous_worker_id,
        session_id_override=previous_session_id,
        sandbox_id_override=previous_sandbox_id,
    )

    if previous_sandbox_id is not None:
        _persist_agent_event(
            session,
            agent,
            "sandbox.lost",
            data={
                "reason": reason,
                "sandbox_id": str(previous_sandbox_id),
            },
            worker_id=previous_worker_id,
            session_id_override=previous_session_id,
            sandbox_id_override=previous_sandbox_id,
        )
        sandbox_svc.delete_sandbox(session, agent.workspace_id, previous_sandbox_id)

    _set_agent_runtime_state(
        session,
        agent,
        sandbox_id=None,
        session_id=None,
        status=AgentStatus.starting,
    )

    sandbox: Sandbox | None = None
    worker_id: uuid.UUID | None = previous_worker_id
    try:
        sandbox_name = f"{agent.name}-recovery-{uuid.uuid4().hex[:8]}"
        sandbox, worker = sandbox_svc.create_sandbox(
            session,
            agent.workspace_id,
            sandbox_name,
        )
        worker_id = worker.id
        _set_agent_runtime_state(
            session,
            agent,
            sandbox_id=sandbox.id,
            session_id=None,
            status=AgentStatus.starting,
        )

        _persist_agent_event(
            session,
            agent,
            "session.create.requested",
            data={
                "prompt": prompt,
                "agent_type": agent.agent_type.value,
                "model": agent.model,
                "graph_tools": agent.graph_tools,
                "schema_id": schema_id,
                "recovery": {
                    "reason": reason,
                    "previous_session_id": previous_session_id,
                    "previous_sandbox_id": (
                        str(previous_sandbox_id)
                        if previous_sandbox_id is not None
                        else None
                    ),
                    "history_length": len(history.history),
                },
            },
            worker_id=worker.id,
            sandbox_id_override=sandbox.id,
        )

        if worker.worker_url is None:
            raise RuntimeError("Worker URL not available")

        data = await _create_worker_session(
            worker_url=worker.worker_url,
            workspace_id=agent.workspace_id,
            sandbox_id=sandbox.id,
            prompt=prompt,
            agent_type=agent.agent_type,
            model=agent.model,
            graph_tools=agent.graph_tools,
            schema_id=schema_id,
            recovery=history,
        )
    except Exception as exc:
        if sandbox is not None and sandbox.id is not None:
            sandbox_svc.delete_sandbox(session, agent.workspace_id, sandbox.id)
        _set_agent_runtime_state(
            session,
            agent,
            sandbox_id=None,
            session_id=None,
            status=AgentStatus.error,
        )
        _persist_agent_event(
            session,
            agent,
            "session.recovery.failed",
            data={"reason": reason, "error": str(exc)},
            worker_id=worker_id,
        )
        _persist_agent_event(
            session,
            agent,
            "message.dispatch.failed",
            data={"prompt": prompt, "error": str(exc)},
            worker_id=worker_id,
        )
        raise

    session_id = data["session"]["id"]
    _set_agent_runtime_state(
        session,
        agent,
        sandbox_id=sandbox.id,
        session_id=session_id,
        status=AgentStatus.busy,
    )
    _persist_agent_event(
        session,
        agent,
        "session.create.acknowledged",
        data={"session": data.get("session", {})},
        worker_id=worker.id,
    )
    _persist_agent_event(
        session,
        agent,
        "session.recovered",
        data={
            "reason": reason,
            "session": data.get("session", {}),
            "previous_session_id": previous_session_id,
            "previous_sandbox_id": (
                str(previous_sandbox_id) if previous_sandbox_id is not None else None
            ),
        },
        worker_id=worker.id,
    )
    return worker.id


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
            "prompt": prompt,
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
        data = await _create_worker_session(
            worker_url=worker.worker_url,
            workspace_id=workspace_id,
            sandbox_id=sandbox.id,
            prompt=prompt,
            agent_type=agent_type,
            model=model,
            graph_tools=graph_tools,
            schema_id=schema_id,
        )
    except Exception as exc:
        _mark_agent_launch_failed(session, agent, worker_id=worker.id, error=exc)
        raise

    _set_agent_runtime_state(
        session,
        agent,
        sandbox_id=sandbox.id,
        session_id=data["session"]["id"],
        status=AgentStatus.busy,
    )

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

    dispatch_event = _persist_agent_event(
        session,
        agent,
        "message.dispatch.requested",
        data={"prompt": prompt},
        worker_id=worker_id,
    )

    if agent.session_id is None:
        worker_id = await _recover_agent_for_prompt(
            session,
            agent,
            prompt=prompt,
            reason="agent session was lost; starting a fresh sandbox",
            request_event_id=dispatch_event.id,
        )
        _persist_agent_event(
            session,
            agent,
            "message.dispatched",
            data={"prompt": prompt, "recovered": True},
            worker_id=worker_id,
        )
        return
    if worker is None or worker.worker_url is None:
        worker_id = await _recover_agent_for_prompt(
            session,
            agent,
            prompt=prompt,
            reason="worker became unavailable; starting a fresh sandbox",
            request_event_id=dispatch_event.id,
        )
        _persist_agent_event(
            session,
            agent,
            "message.dispatched",
            data={"prompt": prompt, "recovered": True},
            worker_id=worker_id,
        )
        return
    try:
        await post_session_message(worker.worker_url, agent.session_id, prompt)
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code == 404:
            worker_id = await _recover_agent_for_prompt(
                session,
                agent,
                prompt=prompt,
                reason="worker session disappeared; starting a fresh sandbox",
                request_event_id=dispatch_event.id,
            )
            _persist_agent_event(
                session,
                agent,
                "message.dispatched",
                data={"prompt": prompt, "recovered": True},
                worker_id=worker_id,
            )
            return
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
