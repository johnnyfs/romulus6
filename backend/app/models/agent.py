import uuid
from enum import Enum
from typing import TYPE_CHECKING, Annotated, Literal, Optional

from pydantic import BaseModel, model_validator
from pydantic import Field as PydanticField
from romulus_common.supported_models import (
    SupportedModel,
    validate_supported_model_for_agent_type,
)
from sqlalchemy import Index, text
from sqlmodel import Field as SQLField
from sqlmodel import Relationship

from .base import RomulusBase

if TYPE_CHECKING:
    from .sandbox import Sandbox
    from .workspace import Workspace


class AgentType(str, Enum):
    opencode = "opencode"
    pydantic = "pydantic"
    codex = "codex"
    claude_code = "claude_code"


class AgentStatus(str, Enum):
    starting = "starting"
    busy = "busy"
    idle = "idle"
    waiting = "waiting"
    completed = "completed"
    error = "error"
    interrupted = "interrupted"


class OpenCodeAgentConfig(BaseModel):
    """OpenCode configuration used by graph and template agent nodes."""
    agent_type: Literal["opencode"] = "opencode"
    model: SupportedModel
    prompt: str
    graph_tools: bool = False

    @model_validator(mode="after")
    def validate_model(self) -> "OpenCodeAgentConfig":
        validate_supported_model_for_agent_type(self.agent_type, self.model.value)
        return self

    model_config = {"from_attributes": True}


class ImageAttachment(BaseModel):
    """An image to attach to a pydantic agent call."""
    type: Literal["url", "sandbox_path"]
    url: str | None = None
    path: str | None = None

    @model_validator(mode="after")
    def validate_fields(self) -> "ImageAttachment":
        if self.type == "url" and not self.url:
            raise ValueError("url is required when type is 'url'")
        if self.type == "sandbox_path" and not self.path:
            raise ValueError("path is required when type is 'sandbox_path'")
        return self


class PydanticAgentConfig(BaseModel):
    """Pydantic configuration used by graph and template agent nodes."""
    agent_type: Literal["pydantic"] = "pydantic"
    model: SupportedModel
    prompt: str
    image_attachments: list[ImageAttachment] = PydanticField(default_factory=list)

    @model_validator(mode="after")
    def validate_model(self) -> "PydanticAgentConfig":
        validate_supported_model_for_agent_type(self.agent_type, self.model.value)
        return self

    model_config = {"from_attributes": True}


class CodexAgentConfig(BaseModel):
    """Codex configuration used by graph and template agent nodes."""
    agent_type: Literal["codex"] = "codex"
    model: SupportedModel
    prompt: str
    graph_tools: bool = False
    sandbox_mode: str = "read-only"

    @model_validator(mode="after")
    def validate_model(self) -> "CodexAgentConfig":
        validate_supported_model_for_agent_type(self.agent_type, self.model.value)
        return self

    model_config = {"from_attributes": True}


class ClaudeCodeAgentConfig(BaseModel):
    """Claude Code configuration used by graph and template agent nodes."""
    agent_type: Literal["claude_code"] = "claude_code"
    model: SupportedModel
    prompt: str
    graph_tools: bool = False

    @model_validator(mode="after")
    def validate_model(self) -> "ClaudeCodeAgentConfig":
        validate_supported_model_for_agent_type(self.agent_type, self.model.value)
        return self

    model_config = {"from_attributes": True}


AgentConfig = Annotated[
    OpenCodeAgentConfig | PydanticAgentConfig | CodexAgentConfig | ClaudeCodeAgentConfig,
    PydanticField(discriminator="agent_type"),
]


class CommandConfig(BaseModel):
    """Configuration for command nodes (bash commands executed in a sandbox)."""
    command: str

    model_config = {"from_attributes": True}


class Agent(RomulusBase, table=True):
    __table_args__ = (
        Index(
            "ix_agent_workspace_name_unique",
            "workspace_id",
            "name",
            unique=True,
            postgresql_where=text("deleted = false"),
        ),
    )

    id: uuid.UUID = SQLField(default_factory=uuid.uuid4, primary_key=True)
    workspace_id: uuid.UUID = SQLField(
        foreign_key="workspace.id",
        index=True,
        nullable=False,
    )
    sandbox_id: Optional[uuid.UUID] = SQLField(
        default=None,
        foreign_key="sandbox.id",
        nullable=True,
    )
    agent_type: AgentType
    model: str
    session_id: Optional[str] = SQLField(default=None)
    status: AgentStatus = SQLField(default=AgentStatus.starting)
    dismissed: bool = SQLField(default=False)
    name: str
    prompt: str
    graph_tools: bool = SQLField(default=False)
    graph_run_id: Optional[uuid.UUID] = SQLField(default=None, index=True)

    workspace: Optional["Workspace"] = Relationship(back_populates="agents")
    sandbox: Optional["Sandbox"] = Relationship(back_populates="agents")
