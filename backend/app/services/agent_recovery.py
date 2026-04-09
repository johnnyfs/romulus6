import json
import uuid

from romulus_common.worker_api import RecoveryContext, RecoveryHistoryEvent
from sqlmodel import Session, select

from app.models.agent import Agent
from app.models.event import Event

IGNORED_EVENT_TYPES = {
    "message.dispatched",
    "message.dispatch.failed",
    "session.busy",
    "session.idle",
    "session.completed",
    "session.error",
    "session.interrupted",
    "session.create.acknowledged",
    "session.create.failed",
    "session.recovery.requested",
    "session.recovery.failed",
    "session.recovered",
    "sandbox.lost",
}


def build_recovery_context(
    session: Session,
    agent: Agent,
    *,
    reason: str,
    previous_session_id: str | None,
    previous_sandbox_id: uuid.UUID | None,
    exclude_event_ids: set[str] | None = None,
) -> RecoveryContext:
    history = build_recovery_history(
        session,
        agent,
        exclude_event_ids=exclude_event_ids,
    )
    return RecoveryContext(
        previous_session_id=previous_session_id,
        previous_sandbox_id=str(previous_sandbox_id) if previous_sandbox_id else None,
        reason=reason,
        history=history,
    )


def build_recovery_history(
    session: Session,
    agent: Agent,
    *,
    exclude_event_ids: set[str] | None = None,
) -> list[RecoveryHistoryEvent]:
    events = list(
        session.exec(
            select(Event)
            .where(Event.agent_id == agent.id)
            .order_by(Event.received_at.asc(), Event.id.asc())
        ).all()
    )
    excluded = exclude_event_ids or set()

    history: list[RecoveryHistoryEvent] = []
    assistant_chunks: list[str] = []
    assistant_timestamp: str | None = None
    assistant_data: dict[str, object] = {}

    def flush_assistant() -> None:
        nonlocal assistant_chunks, assistant_timestamp, assistant_data
        if not assistant_chunks and not assistant_data:
            return
        content = "".join(assistant_chunks).strip() or None
        history.append(
            RecoveryHistoryEvent(
                type="assistant_message",
                content=content,
                timestamp=assistant_timestamp,
                data=dict(assistant_data),
            )
        )
        assistant_chunks = []
        assistant_timestamp = None
        assistant_data = {}

    for event in events:
        if event.id in excluded:
            continue

        event_type = event.event_type
        data = _event_data(event)

        if event_type == "text.delta":
            delta = data.get("delta")
            if isinstance(delta, str) and delta:
                assistant_chunks.append(delta)
                assistant_timestamp = assistant_timestamp or event.timestamp
            structured_output = data.get("structured_output")
            if structured_output is not None:
                assistant_data["structured_output"] = structured_output
                assistant_timestamp = assistant_timestamp or event.timestamp
            continue

        flush_assistant()

        if event_type in IGNORED_EVENT_TYPES:
            continue

        if event_type in {"session.create.requested", "message.dispatch.requested"}:
            prompt = data.get("prompt")
            if isinstance(prompt, str) and prompt:
                history.append(
                    RecoveryHistoryEvent(
                        type="user_message",
                        content=prompt,
                        timestamp=event.timestamp,
                    )
                )
            continue

        if event_type == "feedback.response":
            response = data.get("response")
            if isinstance(response, str) and response:
                history.append(
                    RecoveryHistoryEvent(
                        type="user_message",
                        content=response,
                        timestamp=event.timestamp,
                    )
                )
            continue

        if event_type == "feedback.request":
            feedback_type = data.get("feedback_type")
            content = (
                f"Feedback requested ({feedback_type})"
                if feedback_type
                else "Feedback requested"
            )
            history.append(
                RecoveryHistoryEvent(
                    type="system_note",
                    content=content,
                    timestamp=event.timestamp,
                    data=data,
                )
            )
            continue

        if event_type == "tool.use":
            tool_name = _as_str(data.get("tool_name") or data.get("tool"))
            tool_content = _tool_call_content(data)
            history.append(
                RecoveryHistoryEvent(
                    type="tool_call",
                    name=tool_name,
                    content=tool_content,
                    timestamp=event.timestamp,
                    data=data,
                )
            )
            continue

        if event_type == "file.edit":
            path = _as_str(data.get("path"))
            if path:
                history.append(
                    RecoveryHistoryEvent(
                        type="system_note",
                        content=f"Edited file: {path}",
                        timestamp=event.timestamp,
                        data=data,
                    )
                )
            continue

        if event_type == "command.output":
            history.append(
                RecoveryHistoryEvent(
                    type="tool_result",
                    name="command",
                    content=_command_output_content(data),
                    timestamp=event.timestamp,
                    data=data,
                )
            )
            continue

    flush_assistant()
    return history


def resolve_agent_schema_id(session: Session, agent: Agent) -> str | None:
    events = list(
        session.exec(
            select(Event)
            .where(Event.agent_id == agent.id)
            .where(Event.event_type == "session.create.requested")
            .order_by(Event.received_at.desc(), Event.id.desc())
        ).all()
    )
    for event in events:
        schema_id = _event_data(event).get("schema_id")
        if isinstance(schema_id, str) and schema_id:
            return schema_id
    return None


def last_known_session_id(session: Session, agent: Agent) -> str | None:
    if agent.session_id:
        return agent.session_id
    event = session.exec(
        select(Event)
        .where(Event.agent_id == agent.id)
        .where(Event.session_id.is_not(None))
        .order_by(Event.received_at.desc(), Event.id.desc())
    ).first()
    return event.session_id if event is not None else None


def last_known_sandbox_id(session: Session, agent: Agent) -> uuid.UUID | None:
    if agent.sandbox_id is not None:
        return agent.sandbox_id
    event = session.exec(
        select(Event)
        .where(Event.agent_id == agent.id)
        .where(Event.sandbox_id.is_not(None))
        .order_by(Event.received_at.desc(), Event.id.desc())
    ).first()
    return event.sandbox_id if event is not None else None


def _event_data(event: Event) -> dict[str, object]:
    payload = event.data if isinstance(event.data, dict) else {}
    nested = payload.get("data")
    if isinstance(nested, dict):
        return nested
    return {}


def _tool_call_content(data: dict[str, object]) -> str | None:
    args = data.get("args")
    stdout = data.get("stdout")
    parts: list[str] = []
    if args:
        parts.append(f"args={json.dumps(args, sort_keys=True)}")
    if stdout:
        parts.append(f"stdout={stdout}")
    return "; ".join(parts) or None


def _command_output_content(data: dict[str, object]) -> str | None:
    stdout = _as_str(data.get("stdout"))
    stderr = _as_str(data.get("stderr"))
    parts = [part for part in (stdout, stderr) if part]
    return "\n".join(parts) or None


def _as_str(value: object) -> str | None:
    if isinstance(value, str) and value:
        return value
    return None
