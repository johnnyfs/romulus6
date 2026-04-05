import asyncio
import datetime
import uuid
from collections.abc import AsyncGenerator
from typing import Any

import httpx
from sqlmodel import Session, select

from app.models.agent import Agent, AgentStatus, AgentType
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
    name: str | None = None,
) -> Agent:
    sandbox_name = name or prompt[:40]
    sandbox, worker = sandbox_svc.create_sandbox(session, workspace_id, sandbox_name)

    if worker.worker_url is None:
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

    data = await _post_session_with_retry(
        worker.worker_url,
        payload={
            "prompt": prompt,
            "agent_type": agent_type.value,
            "model": model,
            "workspace_name": str(workspace_id),
        },
    )

    agent.session_id = data["session"]["id"]
    agent.updated_at = datetime.datetime.utcnow()
    session.add(agent)
    session.commit()
    session.refresh(agent)
    return agent


def list_agents(session: Session, workspace_id: uuid.UUID) -> list[Agent]:
    return list(
        session.exec(select(Agent).where(Agent.workspace_id == workspace_id)).all()
    )


def get_agent(
    session: Session, workspace_id: uuid.UUID, agent_id: uuid.UUID
) -> Agent | None:
    agent = session.get(Agent, agent_id)
    if agent is None or agent.workspace_id != workspace_id:
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
    session.delete(agent)
    session.commit()
    return True


async def get_agent_events(
    session: Session, agent: Agent, since: int = 0
) -> list[dict[str, Any]]:
    if agent.session_id is None:
        return []

    sandbox = session.get(Sandbox, agent.sandbox_id)
    if sandbox is None:
        return []

    worker = session.get(Worker, sandbox.worker_id)
    if worker is None or worker.worker_url is None:
        return []

    async with httpx.AsyncClient() as client:
        resp = await client.get(
            f"{worker.worker_url}/sessions/{agent.session_id}/events",
            params={"stream": "False", "since": since},
            timeout=10.0,
        )
        resp.raise_for_status()
        return resp.json()


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

    async with httpx.AsyncClient() as client:
        async with client.stream(
            "GET",
            f"{worker_url}/sessions/{session_id}/events",
            params={"stream": "True", "since": str(since)},
            timeout=None,
        ) as resp:
            resp.raise_for_status()
            async for chunk in resp.aiter_bytes():
                yield chunk
