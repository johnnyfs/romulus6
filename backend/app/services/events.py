import asyncio
import datetime
import json
import logging
import select as select_lib
import threading
import time
import uuid
from collections.abc import AsyncGenerator, Callable, Generator
from contextlib import contextmanager
from typing import Any

import psycopg2
from psycopg2.extensions import ISOLATION_LEVEL_AUTOCOMMIT
from sqlalchemy import and_, or_, text
from sqlmodel import Session, asc, select

from app.database import DATABASE_URL
from app.models.agent import Agent, AgentStatus
from app.models.event import Event
from app.models.graph import Graph
from app.models.run import GraphRun, GraphRunNode
from app.services.event_broadcast import event_broadcaster
from app.utils.time import utcnow

MARK_COMPLETE_TOOL = "mark_node_complete"
DEFAULT_EVENT_PAGE_SIZE = 200
DEFAULT_KEEPALIVE_INTERVAL_SECONDS = 15.0
CURSOR_SEPARATOR = "|"
EVENT_NOTIFY_CHANNEL = "romulus_events"
EVENT_PUBLISHER_ID = str(uuid.uuid4())

logger = logging.getLogger(__name__)


def encode_event_cursor(event: Event) -> str:
    return f"{event.received_at.isoformat()}{CURSOR_SEPARATOR}{event.id}"


def decode_event_cursor(cursor: str) -> tuple[datetime.datetime, str]:
    timestamp_text, separator, event_id = cursor.rpartition(CURSOR_SEPARATOR)
    if not separator or not timestamp_text or not event_id:
        raise ValueError("Invalid event cursor")
    try:
        received_at = datetime.datetime.fromisoformat(timestamp_text)
    except ValueError as exc:
        raise ValueError("Invalid event cursor") from exc
    return received_at, event_id


def _apply_after_cursor(statement, cursor: str):
    received_at, event_id = decode_event_cursor(cursor)
    return statement.where(
        or_(
            Event.received_at > received_at,
            and_(Event.received_at == received_at, Event.id > event_id),
        )
    )


def _sse_payload(item: dict[str, Any]) -> bytes:
    return f"id: {item['cursor']}\ndata: {json.dumps(item)}\n\n".encode()


def _notification_payload(event_id: str) -> str:
    return json.dumps({"event_id": event_id, "origin": EVENT_PUBLISHER_ID})


def _decode_notification_payload(payload: str) -> tuple[str, str | None]:
    try:
        decoded = json.loads(payload)
    except json.JSONDecodeError:
        return payload, None
    return str(decoded.get("event_id", "")), decoded.get("origin")


def _extract_mark_complete_output(payload: dict[str, Any]) -> Any:
    data = payload.get("data", {})
    if not isinstance(data, dict):
        return None

    for key in ("tool_input", "args", "input"):
        candidate = data.get(key)
        if isinstance(candidate, dict) and "output" in candidate:
            return candidate.get("output")

    state = data.get("state")
    if isinstance(state, dict):
        for key in ("tool_input", "args", "input"):
            candidate = state.get(key)
            if isinstance(candidate, dict) and "output" in candidate:
                return candidate.get("output")

    return None


def _requires_explicit_graph_completion(node: GraphRunNode) -> bool:
    return bool(
        node.node_type == "agent"
        and node.agent_type in {"opencode", "codex", "claude_code"}
    )


class _DatabaseEventListener:
    def __init__(
        self,
        database_url: str,
        session_factory: Callable[[], Session] | Callable[[], Generator[Session, None, None]],
    ) -> None:
        self._database_url = database_url
        self._session_factory = session_factory
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._connection: Any = None

    def start(self) -> None:
        if not self._database_url.startswith("postgresql"):
            return
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="event-listener")
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()
        if self._connection is not None:
            try:
                self._connection.close()
            except Exception:
                logger.exception("failed to close event listener connection")
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        self._thread = None
        self._connection = None

    def _connect(self) -> Any:
        dsn = self._database_url.replace("postgresql+psycopg2://", "postgresql://", 1)
        connection = psycopg2.connect(dsn)
        connection.set_isolation_level(ISOLATION_LEVEL_AUTOCOMMIT)
        cursor = connection.cursor()
        cursor.execute(f"LISTEN {EVENT_NOTIFY_CHANNEL};")
        cursor.close()
        return connection

    def _publish_remote_event(self, event_id: str) -> None:
        with _session_from_factory(self._session_factory) as session:
            event = session.get(Event, event_id)
            if event is None:
                return
            event_broadcaster.publish(_serialize_event(session, event))

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                if self._connection is None:
                    self._connection = self._connect()
                if not select_lib.select([self._connection], [], [], 1.0)[0]:
                    continue
                self._connection.poll()
                while self._connection.notifies:
                    notify = self._connection.notifies.pop(0)
                    event_id, origin = _decode_notification_payload(notify.payload)
                    if not event_id or origin == EVENT_PUBLISHER_ID:
                        continue
                    self._publish_remote_event(event_id)
            except Exception:
                logger.exception("event listener loop failed")
                if self._connection is not None:
                    try:
                        self._connection.close()
                    except Exception:
                        logger.exception("failed to reset event listener connection")
                self._connection = None
                time.sleep(1.0)


_event_listener: _DatabaseEventListener | None = None


@contextmanager
def _session_from_factory(
    session_factory: (
        Callable[[], Session]
        | Callable[[], Generator[Session, None, None]]
    ),
):
    session_or_context = session_factory()
    if (
        hasattr(session_or_context, "__enter__")
        and hasattr(session_or_context, "__exit__")
    ):
        with session_or_context as session:
            yield session
        return
    try:
        yield session_or_context
    finally:
        close = getattr(session_or_context, "close", None)
        if callable(close):
            close()


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
    now = utcnow()
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
    serialized = _serialize_event(session, event)
    event_broadcaster.publish(serialized)
    _notify_other_backends(session, event.id)
    return event


def _notify_other_backends(session: Session, event_id: str) -> None:
    bind = session.get_bind()
    if bind is None or bind.dialect.name != "postgresql":
        return
    with bind.connect() as connection:
        connection.execute(
            text("SELECT pg_notify(:channel, :payload)"),
            {
                "channel": EVENT_NOTIFY_CHANNEL,
                "payload": _notification_payload(event_id),
            },
        )
        connection.commit()


def _run_path_parts(session: Session, event: Event) -> list[str]:
    if event.node_id is None:
        return []

    parts: list[str] = []
    node = session.get(GraphRunNode, event.node_id)
    if node is None:
        return parts

    current_node = node
    current_run = session.get(GraphRun, current_node.run_id)
    parts.append(current_node.name or current_node.node_type)

    while current_run is not None and current_run.parent_run_node_id is not None:
        parent_node = session.get(GraphRunNode, current_run.parent_run_node_id)
        if parent_node is None:
            break
        parts.append(parent_node.name or parent_node.node_type)
        current_run = session.get(GraphRun, parent_node.run_id)

    if current_run is not None and current_run.graph_id is not None:
        graph = session.get(Graph, current_run.graph_id)
        if graph is not None:
            parts.append(graph.name)

    return list(reversed(parts))


def _serialize_event(session: Session, event: Event) -> dict[str, Any]:
    path_parts = _run_path_parts(session, event)
    display_label = " / ".join(path_parts)
    if not display_label:
        display_label = event.source_name or event.source_id

    if event.node_id is not None:
        stream_key = f"node:{event.node_id}"
    elif event.agent_id is not None:
        stream_key = f"agent:{event.agent_id}"
    elif event.run_id is not None:
        stream_key = f"run:{event.run_id}"
    else:
        stream_key = f"{event.type}:{event.source_id}"

    return {
        "id": event.id,
        "cursor": encode_event_cursor(event),
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
        "display_label": display_label,
        "path_parts": path_parts,
        "stream_key": stream_key,
        "type": event.event_type,
        "event_time": event.timestamp,
        "received_at": event.received_at.isoformat(),
        "data": event.data.get("data", event.data),
        "raw": event.data,
    }


def _serialize_agent_event_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "cursor": item["cursor"],
        "session_id": item["session_id"] or "",
        "type": item["type"],
        "timestamp": item["event_time"],
        "received_at": item["received_at"],
        "data": item["data"],
        "raw": item["raw"],
        "source_name": item["source_name"],
        "source_type": item["source_type"],
        "agent_id": item["agent_id"],
    }


def _list_events(
    session: Session,
    statement,
    *,
    since: int = 0,
    after: str | None = None,
    limit: int = DEFAULT_EVENT_PAGE_SIZE,
) -> list[Event]:
    if after is not None:
        statement = _apply_after_cursor(statement, after)
    else:
        statement = statement.offset(since)
    return session.exec(
        statement
        .order_by(asc(Event.received_at), asc(Event.id))
        .limit(limit)
    ).all()


def _iter_workspace_event_items(
    session_factory: (
        Callable[[], Session]
        | Callable[[], Generator[Session, None, None]]
    ),
    workspace_id: uuid.UUID,
    *,
    since: int = 0,
    after: str | None = None,
) -> Generator[dict[str, Any], None, None]:
    cursor = after
    offset = since
    while True:
        with _session_from_factory(session_factory) as session:
            items = list_workspace_events(
                session,
                workspace_id,
                since=offset,
                after=cursor,
                limit=DEFAULT_EVENT_PAGE_SIZE,
            )
        if not items:
            return
        for item in items:
            yield item
        if len(items) < DEFAULT_EVENT_PAGE_SIZE:
            return
        cursor = items[-1]["cursor"]
        offset = 0


def _iter_agent_event_items(
    session_factory: (
        Callable[[], Session]
        | Callable[[], Generator[Session, None, None]]
    ),
    workspace_id: uuid.UUID,
    agent_id: uuid.UUID,
    *,
    since: int = 0,
    after: str | None = None,
) -> Generator[dict[str, Any], None, None]:
    cursor = after
    offset = since
    while True:
        with _session_from_factory(session_factory) as session:
            items = list_agent_events(
                session,
                workspace_id,
                agent_id,
                since=offset,
                after=cursor,
                limit=DEFAULT_EVENT_PAGE_SIZE,
            )
        if not items:
            return
        for item in items:
            yield item
        if len(items) < DEFAULT_EVENT_PAGE_SIZE:
            return
        cursor = items[-1]["cursor"]
        offset = 0


def list_workspace_events(
    session: Session,
    workspace_id: uuid.UUID,
    *,
    since: int = 0,
    after: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    results = _list_events(
        session,
        select(Event).where(Event.workspace_id == workspace_id),
        since=since,
        after=after,
        limit=limit,
    )
    return [_serialize_event(session, e) for e in results]


def list_agent_events(
    session: Session,
    workspace_id: uuid.UUID,
    agent_id: uuid.UUID,
    *,
    since: int = 0,
    after: str | None = None,
    limit: int = 200,
) -> list[dict[str, Any]]:
    results = _list_events(
        session,
        select(Event)
        .where(Event.workspace_id == workspace_id)
        .where(Event.agent_id == agent_id),
        since=since,
        after=after,
        limit=limit,
    )
    return [_serialize_agent_event_item(_serialize_event(session, e)) for e in results]


async def stream_workspace_events(
    session_factory,
    workspace_id: uuid.UUID,
    *,
    since: int = 0,
    after: str | None = None,
    keepalive_interval: float = DEFAULT_KEEPALIVE_INTERVAL_SECONDS,
) -> AsyncGenerator[bytes, None]:
    channel = event_broadcaster.workspace_channel(workspace_id)
    token, queue = event_broadcaster.subscribe(channel)
    backlog_ids: set[str] = set()
    try:
        for item in _iter_workspace_event_items(
            session_factory,
            workspace_id,
            since=since,
            after=after,
        ):
            backlog_ids.add(item["id"])
            yield _sse_payload(item)

        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=keepalive_interval)
            except asyncio.TimeoutError:
                yield b": keepalive\n\n"
                continue
            if item["id"] in backlog_ids:
                backlog_ids.remove(item["id"])
                continue
            yield _sse_payload(item)
    finally:
        event_broadcaster.unsubscribe(token, channel)


async def stream_agent_events(
    session_factory,
    workspace_id: uuid.UUID,
    agent_id: uuid.UUID,
    *,
    since: int = 0,
    after: str | None = None,
    keepalive_interval: float = DEFAULT_KEEPALIVE_INTERVAL_SECONDS,
) -> AsyncGenerator[bytes, None]:
    channel = event_broadcaster.agent_channel(agent_id)
    token, queue = event_broadcaster.subscribe(channel)
    backlog_ids: set[str] = set()
    try:
        for item in _iter_agent_event_items(
            session_factory,
            workspace_id,
            agent_id,
            since=since,
            after=after,
        ):
            backlog_ids.add(item["id"])
            yield _sse_payload(item)

        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=keepalive_interval)
            except asyncio.TimeoutError:
                yield b": keepalive\n\n"
                continue
            if item["id"] in backlog_ids:
                backlog_ids.remove(item["id"])
                continue
            yield _sse_payload(_serialize_agent_event_item(item))
    finally:
        event_broadcaster.unsubscribe(token, channel)


def start_event_listener(
    session_factory: (
        Callable[[], Session]
        | Callable[[], Generator[Session, None, None]]
    ),
) -> None:
    global _event_listener
    if _event_listener is None:
        _event_listener = _DatabaseEventListener(DATABASE_URL, session_factory)
    _event_listener.start()


def stop_event_listener() -> None:
    global _event_listener
    if _event_listener is None:
        return
    _event_listener.stop()
    _event_listener = None


def ingest_worker_event(
    session: Session,
    *,
    worker_id: uuid.UUID,
    payload: dict[str, Any],
) -> Event | None:
    from app.services import controller as controller_svc
    from app.services import runs as run_svc

    session_id = str(
        payload.get("session_id")
        or payload.get("data", {}).get("session_id")
        or ""
    )
    agent = (
        session.exec(select(Agent).where(Agent.session_id == session_id)).first()
        if session_id
        else None
    )

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
        node = session.exec(
            select(GraphRunNode).where(GraphRunNode.session_id == session_id)
        ).first()
        if node is not None:
            node_id = node.id
            run_id = node.run_id

    if workspace_id is None:
        logger.info(
            "ignoring worker event for unknown or deleted session",
            extra={"worker_id": str(worker_id), "payload": payload},
        )
        return None

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
        agent.updated_at = utcnow()
        session.add(agent)
        session.commit()

    if node_id is not None and run_id is not None:
        node = session.get(GraphRunNode, node_id)
        if node is not None:
            explicit_completion = _requires_explicit_graph_completion(node)
            # Capture structured output from pydantic agents as it arrives
            if event_type == "text.delta":
                structured = payload.get("data", {}).get("structured_output")
                if structured:
                    node.output = structured
                    session.add(node)
                    session.commit()

            if (
                explicit_completion
                and event_type == "tool.use"
                and payload.get("data", {}).get("tool_name") == MARK_COMPLETE_TOOL
            ):
                output = _extract_mark_complete_output(payload)
                try:
                    run_svc.complete_node(session, run_id, node_id, output=output)
                except ValueError as exc:
                    run_svc.fail_node_and_run(
                        session,
                        run_id,
                        node_id,
                        str(exc),
                        allow_retry=False,
                    )
            elif explicit_completion and event_type in ("session.idle", "session.completed"):
                if node.state != "completed":
                    run_svc.fail_node_and_run(
                        session,
                        run_id,
                        node_id,
                        "agent finished without calling mark_node_complete",
                        allow_retry=False,
                    )
            elif not explicit_completion and event_type == "session.idle":
                try:
                    run_svc.complete_node(session, run_id, node_id)
                except ValueError as exc:
                    run_svc.fail_node_and_run(session, run_id, node_id, str(exc))
            elif event_type == "session.error":
                run_svc.fail_node_and_run(
                    session,
                    run_id,
                    node_id,
                    "worker session error",
                )
            else:
                controller_svc.enqueue_run_reconcile(
                    session,
                    run_id,
                    reason=f"event:{event_type}",
                )

    return event
