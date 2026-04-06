import asyncio
import logging
import os
import uuid
from collections import defaultdict
from datetime import datetime, UTC
from typing import Any

from app.agents.opencode import OpenCodeRunner, OpenCodeServer
from app.backend_client import BackendClient
from app.config import settings
from app.models import Event, EventType, Session, SessionStatus

logger = logging.getLogger(__name__)

# NOTE: In-memory state only. Single replica required. For horizontal scaling,
# replace _sessions/_events with a shared backend (Redis, PostgreSQL).

class SessionManager:
    def __init__(self, server: OpenCodeServer, backend_client: BackendClient):
        self._server = server
        self._backend_client = backend_client
        self._sessions: dict[str, Session] = {}
        self._events: dict[str, list[Event]] = defaultdict(list)
        self._runners: dict[str, OpenCodeRunner] = {}
        self._notify: dict[str, asyncio.Event] = {}
        self._session_meta: dict[str, dict[str, Any]] = {}

    async def create_session(
        self,
        prompt: str,
        agent_type: str,
        model: str,
        workspace_name: str | None = None,
        graph_tools: bool = False,
        workspace_id: str | None = None,
        sandbox_id: str | None = None,
    ) -> Session:
        session_id = str(uuid.uuid4())
        workspace_name = workspace_name or session_id
        workspace_dir = os.path.join(settings.workspace_root, workspace_name)
        os.makedirs(workspace_dir, exist_ok=True)

        session = Session(id=session_id, agent_type=agent_type, model=model, workspace_dir=workspace_dir)
        self._sessions[session_id] = session
        self._notify[session_id] = asyncio.Event()
        self._session_meta[session_id] = {
            "workspace_id": workspace_id,
            "sandbox_id": sandbox_id,
        }

        asyncio.create_task(self._run_agent(session_id, prompt, model))
        return session

    async def send_message(self, session_id: str, prompt: str) -> None:
        session = self._get_or_raise(session_id)
        if session.status not in (SessionStatus.IDLE, SessionStatus.COMPLETED):
            raise ValueError(f"Session not idle (status={session.status})")
        session.status = SessionStatus.BUSY
        session.updated_at = datetime.now(UTC)
        asyncio.create_task(self._run_agent(session_id, prompt, session.model, opencode_session_id=session.opencode_session_id))

    async def interrupt(self, session_id: str, reason: str = "user_requested") -> None:
        runner = self._runners.get(session_id)
        if runner:
            await runner.interrupt()
        session = self._sessions.get(session_id)
        if session:
            session.status = SessionStatus.INTERRUPTED
            session.updated_at = datetime.now(UTC)
        self._append_event(session_id, Event(session_id=session_id, type=EventType.SESSION_INTERRUPTED, data={"reason": reason}))

    def get_session(self, session_id: str) -> Session:
        return self._get_or_raise(session_id)

    def get_events(self, session_id: str, since: int = 0) -> list[Event]:
        self._get_or_raise(session_id)
        return self._events.get(session_id, [])[since:]

    async def stream_events(self, session_id: str, since: int = 0):
        TERMINAL = {SessionStatus.COMPLETED, SessionStatus.ERROR, SessionStatus.INTERRUPTED}
        index = since
        while True:
            session = self._sessions.get(session_id)
            events = self._events.get(session_id, [])
            while index < len(events):
                yield events[index]
                index += 1
            if session and session.status in TERMINAL:
                return
            notify = self._notify.get(session_id)
            if notify:
                notify.clear()
                try:
                    await asyncio.wait_for(notify.wait(), timeout=30.0)
                except asyncio.TimeoutError:
                    yield None  # caller sends SSE keepalive comment

    async def _run_agent(self, session_id: str, prompt: str, model: str, opencode_session_id: str | None = None) -> None:
        session = self._sessions[session_id]
        runner = OpenCodeRunner(session_id, self._server)
        self._runners[session_id] = runner
        try:
            await runner.start(prompt=prompt, workspace_dir=session.workspace_dir, model=model, opencode_session_id=opencode_session_id)
            session.status = SessionStatus.BUSY
            session.updated_at = datetime.now(UTC)

            async for event in runner.events():
                self._append_event(session_id, event)
                if event.type == EventType.SESSION_IDLE:
                    session.status = SessionStatus.IDLE
                    if runner.opencode_session_id:
                        session.opencode_session_id = runner.opencode_session_id
                elif event.type == EventType.SESSION_BUSY:
                    session.status = SessionStatus.BUSY
                elif event.type == EventType.SESSION_ERROR:
                    session.status = SessionStatus.ERROR
                session.updated_at = datetime.now(UTC)

            if session.status in (SessionStatus.BUSY, SessionStatus.IDLE):
                session.status = SessionStatus.COMPLETED
                session.updated_at = datetime.now(UTC)
                self._append_event(session_id, Event(session_id=session_id, type=EventType.SESSION_COMPLETED, data={}))

        except Exception as exc:
            logger.exception("agent error in session %s", session_id)
            session.status = SessionStatus.ERROR
            session.updated_at = datetime.now(UTC)
            self._append_event(session_id, Event(session_id=session_id, type=EventType.SESSION_ERROR, data={"error": str(exc)}))
        finally:
            self._runners.pop(session_id, None)

    def _append_event(self, session_id: str, event: Event) -> None:
        self._events[session_id].append(event)
        asyncio.create_task(self._backend_client.send_event(event.model_dump(mode="json")))
        notify = self._notify.get(session_id)
        if notify:
            notify.set()

    def _get_or_raise(self, session_id: str) -> Session:
        session = self._sessions.get(session_id)
        if session is None:
            raise KeyError(f"Session {session_id} not found")
        return session
