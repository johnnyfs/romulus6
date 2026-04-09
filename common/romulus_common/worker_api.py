from typing import Any

from pydantic import BaseModel, model_validator

from .output_schema import validate_output_schema_definition
from .pydantic_schemas import PydanticSchemaId
from .supported_models import validate_supported_model_for_agent_type


class CreateSessionRequest(BaseModel):
    prompt: str
    agent_type: str = "opencode"
    model: str = "anthropic/claude-sonnet-4-6"
    schema_id: str | None = None
    output_schema: dict[str, str] | None = None
    images: list[dict[str, Any]] | None = None
    workspace_name: str | None = None
    graph_tools: bool = False
    workspace_id: str | None = None
    sandbox_id: str | None = None

    @model_validator(mode="after")
    def validate_request(self) -> "CreateSessionRequest":
        validate_supported_model_for_agent_type(self.agent_type, self.model)
        validate_output_schema_definition(self.output_schema)
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
