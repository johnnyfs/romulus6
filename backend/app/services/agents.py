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
from app.models.worker import Worker
from app.services import sandboxes as sandbox_svc


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


async def create_agent(
    session: Session,
    workspace_id: uuid.UUID,
    agent_type: AgentType,
    model: str,
    prompt: str,
    name: str,
) -> Agent:
    sandbox, worker = sandbox_svc.create_sandbox(session, workspace_id, name)

    if worker.worker_url is None:
        sandbox_svc.delete_sandbox(session, workspace_id, sandbox.id)
        raise RuntimeError("Worker URL not available")

    agent = Agent(
        workspace_id=workspace_id,
        sandbox_id=sandbox.id,
        agent_type=agent_type,
        model=model,
        prompt=prompt,
        name=name,
        status=AgentStatus.starting,
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
            },
        )
    except Exception:
        # Clean up the orphaned agent, sandbox, and K8s worker so they don't
        # accumulate across failed creation attempts.
        delete_agent(session, workspace_id, agent.id)
        raise

    agent.session_id = data["session"]["id"]
    agent.updated_at = datetime.datetime.utcnow()
    session.add(agent)
    session.commit()
    session.refresh(agent)
    return agent


def list_agents(session: Session, workspace_id: uuid.UUID) -> list[Agent]:
    return list(
        session.exec(
            Agent.active().where(Agent.workspace_id == workspace_id)
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
    worker = session.get(Worker, sandbox.worker_id)
    if worker is None or worker.worker_url is None:
        raise RuntimeError("Worker URL not available")

    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{worker.worker_url}/sessions/{agent.session_id}/messages",
            json={"prompt": prompt},
            timeout=10.0,
        )
        resp.raise_for_status()


def delete_agent(
    session: Session, workspace_id: uuid.UUID, agent_id: uuid.UUID
) -> bool:
    agent = get_agent(session, workspace_id, agent_id)
    if agent is None:
        return False
    if agent.sandbox_id is not None:
        sandbox_svc.delete_sandbox(session, workspace_id, agent.sandbox_id)
    agent.deleted = True
    agent.sandbox_id = None
    agent.updated_at = datetime.datetime.utcnow()
    session.add(agent)
    session.commit()
    return True


def _persist_event(
    session: Session,
    workspace_id: uuid.UUID,
    agent_id: uuid.UUID,
    payload: dict[str, Any],
) -> None:
    event = Event(
        id=str(payload.get("id", uuid.uuid4())),
        workspace_id=workspace_id,
        type="agent",
        source_id=str(agent_id),
        event_type=str(payload.get("type", "unknown")),
        timestamp=str(payload.get("timestamp", "")),
        data=payload,
    )
    session.merge(event)
    session.commit()


async def _sync_events_from_worker(
    session: Session, agent: Agent
) -> None:
    """Fetch events from the worker and persist any that are missing in the DB."""
    if agent.session_id is None or agent.sandbox_id is None:
        return

    sandbox = session.get(Sandbox, agent.sandbox_id)
    if sandbox is None or sandbox.worker_id is None:
        return

    worker = session.get(Worker, sandbox.worker_id)
    if worker is None or worker.worker_url is None:
        return

    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(
                f"{worker.worker_url}/sessions/{agent.session_id}/events",
                params={"stream": "false"},
                timeout=5.0,
            )
            if resp.status_code != 200:
                return
            for payload in resp.json():
                _persist_event(session, agent.workspace_id, agent.id, payload)
    except Exception:
        pass  # best-effort: never block the read path on sync failures


async def get_agent_events(
    session: Session, agent: Agent, since: int = 0
) -> list[dict[str, Any]]:
    await _sync_events_from_worker(session, agent)

    results = session.exec(
        select(Event)
        .where(Event.workspace_id == agent.workspace_id)
        .where(Event.type == "agent")
        .where(Event.source_id == str(agent.id))
        .order_by(asc(Event.persisted_at))
        .offset(since)
    ).all()
    return [
        {
            "id": e.id,
            "session_id": e.data.get("session_id", ""),
            "type": e.event_type,
            "timestamp": e.timestamp,
            "data": e.data.get("data", {}),
        }
        for e in results
    ]


async def stream_agent_events(
    session: Session, agent: Agent, since: int = 0
) -> AsyncGenerator[bytes, None]:
    if agent.session_id is None:
        return

    sandbox = session.get(Sandbox, agent.sandbox_id)
    if sandbox is None:
        return

    worker = session.get(Worker, sandbox.worker_id)
    if worker is None or worker.worker_url is None:
        return

    worker_url = str(worker.worker_url)
    session_id = str(agent.session_id)
    workspace_id = agent.workspace_id
    agent_id = agent.id

    async with httpx.AsyncClient() as client:
        async with client.stream(
            "GET",
            f"{worker_url}/sessions/{session_id}/events",
            params={"stream": "True", "since": str(since)},
            timeout=None,
        ) as resp:
            resp.raise_for_status()
            sse_buffer = ""
            async for chunk in resp.aiter_bytes():
                yield chunk
                sse_buffer += chunk.decode("utf-8", errors="replace")
                while "\n\n" in sse_buffer:
                    message, sse_buffer = sse_buffer.split("\n\n", 1)
                    for line in message.split("\n"):
                        if line.startswith("data: "):
                            try:
                                payload = json.loads(line[6:])
                                _persist_event(session, workspace_id, agent_id, payload)
                            except Exception:
                                pass  # never block the stream on persistence failure
