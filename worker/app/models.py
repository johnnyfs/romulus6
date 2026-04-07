import uuid
from datetime import datetime, UTC
from enum import StrEnum
from typing import Any
from pydantic import BaseModel, Field, model_validator

from app.pydantic_schema_registry import PydanticSchemaId
from app.supported_models import validate_supported_model_for_agent_type
from app.output_schema import validate_output_schema_definition

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
    runner_state: dict[str, Any] = Field(default_factory=dict)
    status: SessionStatus = SessionStatus.STARTING
    workspace_dir: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(UTC))

class CreateSessionRequest(BaseModel):
    prompt: str
    agent_type: str = "opencode"
    model: str = "anthropic/claude-sonnet-4-6"
    schema_id: str | None = None
    output_schema: dict[str, str] | None = None
    workspace_name: str | None = None
    graph_tools: bool = False
    workspace_id: str | None = None
    sandbox_id: str | None = None

    @model_validator(mode="after")
    def validate_request(self) -> "CreateSessionRequest":
        validate_supported_model_for_agent_type(self.agent_type, self.model)
        validate_output_schema_definition(self.output_schema)
        if self.agent_type == "pydantic" and self.schema_id is None and self.output_schema is None:
            raise ValueError("schema_id or output_schema is required for pydantic sessions")
        if self.schema_id is not None and self.schema_id not in {item.value for item in PydanticSchemaId}:
            raise ValueError(f"Unsupported schema_id: {self.schema_id}")
        return self

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
