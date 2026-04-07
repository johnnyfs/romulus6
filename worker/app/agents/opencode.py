import asyncio
import json
import logging
import httpx
from collections.abc import AsyncIterator
from app.agents.base import AgentRunner
from app.config import settings
from app.models import Event, EventType, Session

logger = logging.getLogger(__name__)

OPENCODE_PORT = 4096


class OpenCodeServer:
    """
    Manages a single `opencode serve` process for the lifetime of the worker pod.
    One server handles all sessions — create sessions via POST /session, send
    messages via POST /session/{id}/message, stream events via GET /global/event.

    NOTE: The server's cwd becomes the "project" for all sessions. Sessions are
    isolated by conversation history but share the same filesystem context.
    If per-session filesystem isolation is needed, switch to one server per session
    (pass workspace_dir as cwd and manage process lifecycle per session).
    """

    def __init__(self):
        self._proc: asyncio.subprocess.Process | None = None
        self._client: httpx.AsyncClient | None = None
        self._queues: dict[str, asyncio.Queue] = {}
        self._fan_out_task: asyncio.Task | None = None

    async def start(self, workdir: str) -> None:
        self._proc = await asyncio.create_subprocess_exec(
            settings.opencode_binary, "serve", "--port", str(OPENCODE_PORT), "--hostname", "127.0.0.1",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=workdir,
        )
        self._client = httpx.AsyncClient(base_url=f"http://127.0.0.1:{OPENCODE_PORT}", timeout=30.0)
        await self._wait_ready()
        self._fan_out_task = asyncio.create_task(self._fan_out_events())
        logger.info("opencode server ready at port %d (cwd=%s)", OPENCODE_PORT, workdir)

    async def stop(self) -> None:
        if self._fan_out_task:
            self._fan_out_task.cancel()
        if self._client:
            await self._client.aclose()
        if self._proc and self._proc.returncode is None:
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                self._proc.kill()

    async def _wait_ready(self) -> None:
        for _ in range(40):
            try:
                r = await self._client.get("/global/health")
                if r.status_code == 200:
                    return
            except Exception:
                pass
            await asyncio.sleep(0.5)
        raise RuntimeError("opencode server did not become ready within 20s")

    def subscribe(self, opencode_session_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._queues[opencode_session_id] = q
        return q

    def unsubscribe(self, opencode_session_id: str) -> None:
        self._queues.pop(opencode_session_id, None)

    def _extract_session_id(self, payload: dict) -> str | None:
        props = payload.get("properties", {})
        if props.get("sessionID"):
            return props["sessionID"]
        part = props.get("part", {})
        if isinstance(part, dict) and part.get("sessionID"):
            return part["sessionID"]
        info = props.get("info", {})
        if isinstance(info, dict) and info.get("id") and payload.get("type", "").startswith("session."):
            return info["id"]
        return None

    async def _fan_out_events(self) -> None:
        while True:
            try:
                async with self._client.stream(
                    "GET", "/global/event",
                    headers={"Accept": "text/event-stream"},
                    timeout=None,
                ) as resp:
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        try:
                            envelope = json.loads(line[6:])
                        except json.JSONDecodeError:
                            continue
                        payload = envelope.get("payload", {})
                        session_id = self._extract_session_id(payload)
                        if session_id and session_id in self._queues:
                            await self._queues[session_id].put(payload)
                            logger.debug("fanned out event %s for session %s", payload.get("type"), session_id)
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.warning("global event stream dropped, reconnecting: %s", e)
                await asyncio.sleep(1.0)

    @property
    def client(self) -> httpx.AsyncClient:
        assert self._client is not None, "server not started"
        return self._client


class OpenCodeRunner(AgentRunner):
    def __init__(self, session_id: str, server: OpenCodeServer):
        self._session_id = session_id
        self._server = server
        self.opencode_session_id: str | None = None
        self._queue: asyncio.Queue | None = None
        self._text_by_part_id: dict[str, str] = {}

    async def start(self, *, prompt: str, session: Session) -> None:
        client = self._server.client
        model = session.model
        opencode_session_id = session.runner_state.get("opencode_session_id")

        if opencode_session_id:
            self.opencode_session_id = opencode_session_id
        else:
            r = await client.post("/session", json={"title": self._session_id})
            r.raise_for_status()
            self.opencode_session_id = r.json()["id"]
            session.runner_state["opencode_session_id"] = self.opencode_session_id
            logger.info("created opencode session %s", self.opencode_session_id)

        # Subscribe before sending so we don't miss early events
        self._queue = self._server.subscribe(self.opencode_session_id)

        provider_id, model_id = model.split("/", 1) if "/" in model else ("anthropic", model)
        r = await client.post(f"/session/{self.opencode_session_id}/message", json={
            "parts": [{"type": "text", "text": prompt}],
            "model": {"providerID": provider_id, "modelID": model_id},
        })
        r.raise_for_status()
        logger.debug("sent message to opencode session %s", self.opencode_session_id)

    async def events(self) -> AsyncIterator[Event]:
        assert self._queue is not None
        try:
            while True:
                try:
                    payload = await asyncio.wait_for(self._queue.get(), timeout=120.0)
                except asyncio.TimeoutError:
                    logger.warning("no events for 120s on session %s", self._session_id)
                    continue

                event = self._translate(payload)
                if event:
                    yield event

                if payload.get("type") in ("session.idle", "session.error"):
                    return
        finally:
            if self.opencode_session_id:
                self._server.unsubscribe(self.opencode_session_id)

    async def interrupt(self) -> None:
        if self.opencode_session_id:
            try:
                await self._server.client.post(f"/session/{self.opencode_session_id}/abort")
            except Exception as e:
                logger.warning("abort failed: %s", e)

    @property
    def is_running(self) -> bool:
        return self._queue is not None

    def _translate(self, payload: dict) -> Event | None:
        oc_type = payload.get("type", "")
        props = payload.get("properties", {})
        part = props.get("part", {}) if isinstance(props.get("part"), dict) else {}

        if oc_type == "session.status":
            status = props.get("status", {}).get("type")
            if status == "busy":
                return Event(session_id=self._session_id, type=EventType.SESSION_BUSY, data={})
            if status == "idle":
                return Event(session_id=self._session_id, type=EventType.SESSION_IDLE, data={})
            return None

        elif oc_type == "session.idle":
            return Event(session_id=self._session_id, type=EventType.SESSION_IDLE, data={})

        elif oc_type == "session.error":
            return Event(session_id=self._session_id, type=EventType.SESSION_ERROR, data={
                "error": str(props.get("error", "unknown")),
            })

        elif oc_type == "feedback.request":
            return Event(session_id=self._session_id, type=EventType.FEEDBACK_REQUEST, data=props)

        elif oc_type == "feedback.response":
            return Event(session_id=self._session_id, type=EventType.FEEDBACK_RESPONSE, data=props)

        elif oc_type in ("message.part.delta", "message.part.updated"):
            if props.get("field") == "text" or part.get("type") == "text":
                part_id = str(props.get("partID") or part.get("id") or "")
                delta = str(props.get("delta", ""))
                if not delta:
                    current_text = str(part.get("text") or "")
                    previous_text = self._text_by_part_id.get(part_id, "")
                    if current_text.startswith(previous_text):
                        delta = current_text[len(previous_text):]
                    else:
                        delta = current_text
                    if part_id:
                        self._text_by_part_id[part_id] = current_text
                return Event(session_id=self._session_id, type=EventType.TEXT_DELTA, data={
                    "delta": delta,
                    "message_id": props.get("messageID") or part.get("messageID"),
                    "part_id": part_id or None,
                })
            if part.get("type") == "tool":
                state = part.get("state", {}) if isinstance(part.get("state"), dict) else {}
                metadata = state.get("metadata", {}) if isinstance(state.get("metadata"), dict) else {}
                return Event(session_id=self._session_id, type=EventType.TOOL_USE, data={
                    "tool": part.get("tool", ""),
                    "tool_name": part.get("tool", ""),
                    "args": state.get("input", {}),
                    "state": state,
                    "message_id": part.get("messageID"),
                    "part_id": part.get("id"),
                    "stdout": metadata.get("output"),
                })

        elif oc_type == "file.edited":
            return Event(session_id=self._session_id, type=EventType.FILE_EDIT, data={
                "path": props.get("path"),
            })

        elif oc_type == "message.part.done":
            # Tool call completions include the tool name and arguments
            if part.get("type") == "text":
                part_id = str(props.get("partID") or part.get("id") or "")
                if part_id:
                    self._text_by_part_id.pop(part_id, None)
                return None
            if part.get("type") == "tool-invocation":
                return Event(session_id=self._session_id, type=EventType.TOOL_USE, data={
                    "tool": part.get("toolInvocation", {}).get("toolName", ""),
                    "tool_name": part.get("toolInvocation", {}).get("toolName", ""),
                    "args": part.get("toolInvocation", {}).get("args", {}),
                    "state": part.get("toolInvocation", {}).get("state", ""),
                    "message_id": props.get("messageID"),
                    "part_id": props.get("partID"),
                })

        elif oc_type == "tool.call":
            # Alternative event format for tool calls
            return Event(session_id=self._session_id, type=EventType.TOOL_USE, data={
                "tool": props.get("name", props.get("toolName", "")),
                "tool_name": props.get("name", props.get("toolName", "")),
                "args": props.get("args", props.get("arguments", {})),
                "message_id": props.get("messageID"),
            })

        logger.debug("dropping opencode event: %s", oc_type)
        return None
