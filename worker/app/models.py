import uuid
from datetime import datetime, UTC
from enum import StrEnum
from typing import Any
from pydantic import BaseModel, Field

class SessionStatus(StrEnum):
    STARTING = "starting"
    BUSY = "busy"
    IDLE = "idle"
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
    opencode_session_id: str | None = None
    agent_type: str
    model: str
    status: SessionStatus = SessionStatus.STARTING
    workspace_dir: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

class CreateSessionRequest(BaseModel):
    prompt: str
    agent_type: str = "opencode"
    model: str = "anthropic/claude-sonnet-4-5"
    workspace_name: str | None = None
    graph_tools: bool = False
    workspace_id: str | None = None
    sandbox_id: str | None = None

class CreateSessionResponse(BaseModel):
    session: Session

class SendMessageRequest(BaseModel):
    prompt: str

class InterruptRequest(BaseModel):
    reason: str = "user_requested"

class CommandRequest(BaseModel):
    command: list[str]
    cwd: str | None = None
    timeout: int = 30

class CommandResponse(BaseModel):
    exit_code: int
    stdout: str
    stderr: str
