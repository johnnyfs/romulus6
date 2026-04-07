import uuid
from enum import Enum
from typing import TYPE_CHECKING, Literal, Optional

from pydantic import BaseModel
from sqlalchemy import Index, text
from sqlmodel import Field, Relationship

from .base import RomulusBase
from .pydantic_agent import PydanticSchemaId
from .supported_models import SupportedModel

if TYPE_CHECKING:
    from .sandbox import Sandbox
    from .workspace import Workspace


class AgentType(str, Enum):
    opencode = "opencode"
    pydantic = "pydantic"


class AgentStatus(str, Enum):
    starting = "starting"
    busy = "busy"
    idle = "idle"
    waiting = "waiting"
    completed = "completed"
    error = "error"
    interrupted = "interrupted"


class AgentConfig(BaseModel):
    """Shared agent configuration used by both ad hoc dispatch and graph agent nodes."""
    agent_type: Literal["opencode"] = "opencode"
    model: SupportedModel
    prompt: str
    graph_tools: bool = False

    model_config = {"from_attributes": True}


class PydanticAgentConfig(BaseModel):
    agent_type: Literal["pydantic"] = "pydantic"
    model: SupportedModel
    prompt: str
    schema_id: PydanticSchemaId

    model_config = {"from_attributes": True}


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

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    workspace_id: uuid.UUID = Field(foreign_key="workspace.id", index=True, nullable=False)
    sandbox_id: Optional[uuid.UUID] = Field(default=None, foreign_key="sandbox.id", nullable=True)
    agent_type: AgentType
    model: str
    session_id: Optional[str] = Field(default=None)
    status: AgentStatus = Field(default=AgentStatus.starting)
    name: str
    prompt: str
    graph_tools: bool = Field(default=False)
    graph_run_id: Optional[uuid.UUID] = Field(default=None, index=True)

    workspace: Optional["Workspace"] = Relationship(back_populates="agents")
    sandbox: Optional["Sandbox"] = Relationship(back_populates="agents")
