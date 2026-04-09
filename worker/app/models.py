import uuid
from datetime import datetime, UTC
from enum import StrEnum
from typing import Any
from pydantic import BaseModel, Field
from romulus_common.worker_api import (
    CommandRequest,
    CommandResponse,
    CreateSessionRequest,
    InterruptRequest,
    RecoveryContext,
    SendMessageRequest,
)

class SessionStatus(StrEnum):
    STARTING = "starting"
    BUSY = "busy"
    IDLE = "idle"
    WAITING = "waiting"
    COMPLETED = "completed"
    ERROR = "error"
    INTERRUPTED = "interrupted"

class EventType(StrEnum):
    SESSION_STARTED = "session.started"
    SESSION_IDLE = "session.idle"
    SESSION_BUSY = "session.busy"
    SESSION_COMPLETED = "session.completed"
    SESSION_ERROR = "session.error"
    SESSION_INTERRUPTED = "session.interrupted"
    FEEDBACK_REQUEST = "feedback.request"
    FEEDBACK_RESPONSE = "feedback.response"
    TEXT_DELTA = "text.delta"
    TEXT_COMPLETE = "text.complete"
    TOOL_USE = "tool.use"
    FILE_EDIT = "file.edit"
    COMMAND_OUTPUT = "command.output"

class Event(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    session_id: str
    type: EventType
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))
    data: dict[str, Any] = Field(default_factory=dict)

class Session(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    agent_type: str
    model: str
    schema_id: str | None = None
    output_schema: dict[str, str] | None = None
    images: list[dict[str, str]] | None = None
    recovery: RecoveryContext | None = None
    sandbox_mode: str | None = None
    runner_state: dict[str, Any] = Field(default_factory=dict)
    status: SessionStatus = SessionStatus.STARTING
    workspace_dir: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

class CreateSessionResponse(BaseModel):
    session: Session
