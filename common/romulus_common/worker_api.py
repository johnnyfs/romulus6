from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from .output_schema import validate_output_schema_definition
from .pydantic_schemas import PydanticSchemaId
from .sandbox_modes import SandboxMode, normalize_codex_sandbox_mode
from .supported_models import validate_supported_model_for_agent_type


class RecoveryHistoryEvent(BaseModel):
    type: Literal[
        "user_message",
        "assistant_message",
        "tool_call",
        "tool_result",
        "structured_output",
        "system_note",
    ]
    content: str | None = None
    name: str | None = None
    timestamp: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)


class RecoveryContext(BaseModel):
    previous_session_id: str | None = None
    previous_sandbox_id: str | None = None
    reason: str | None = None
    history: list[RecoveryHistoryEvent] = Field(default_factory=list)


class CreateSessionRequest(BaseModel):
    prompt: str
    agent_type: str = "opencode"
    model: str = "anthropic/claude-sonnet-4-6"
    schema_id: str | None = None
    output_schema: dict[str, Any] | None = None
    images: list[dict[str, Any]] | None = None
    workspace_name: str | None = None
    graph_tools: bool = False
    graph_run_id: str | None = None
    graph_run_node_id: str | None = None
    sandbox_mode: SandboxMode | None = None
    workspace_id: str | None = None
    sandbox_id: str | None = None
    recovery: RecoveryContext | None = None

    @model_validator(mode="after")
    def validate_request(self) -> "CreateSessionRequest":
        validate_supported_model_for_agent_type(self.agent_type, self.model)
        if self.output_schema is not None:
            if all(isinstance(value, str) for value in self.output_schema.values()):
                validate_output_schema_definition(
                    self.output_schema,  # type: ignore[arg-type]
                )
            elif not all(
                isinstance(key, str) and key.strip() for key in self.output_schema
            ):
                raise ValueError("output_schema keys must be non-empty strings")
        if (
            self.agent_type == "pydantic"
            and self.schema_id is None
            and self.output_schema is None
        ):
            raise ValueError("schema_id or output_schema is required for pydantic sessions")
        if (
            self.schema_id is not None
            and self.schema_id not in {item.value for item in PydanticSchemaId}
        ):
            raise ValueError(f"Unsupported schema_id: {self.schema_id}")
        self.sandbox_mode = normalize_codex_sandbox_mode(
            agent_type=self.agent_type,
            sandbox_mode=self.sandbox_mode,
        )
        return self


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
