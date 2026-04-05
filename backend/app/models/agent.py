import datetime
import uuid
from enum import Enum
from typing import Optional

from sqlmodel import Field, SQLModel


class AgentType(str, Enum):
    opencode = "opencode"


# Anthropic model IDs follow Anthropic's versioning scheme and may need
# periodic updates as new versions are released.
class AnthropicModel(str, Enum):
    claude_sonnet = "anthropic/claude-sonnet-4-6"
    claude_opus = "anthropic/claude-opus-4-6"
    claude_haiku = "anthropic/claude-haiku-4-5"


# OpenAI model IDs are stable aliases that don't require versioning.
class OpenAIModel(str, Enum):
    gpt_4o = "openai/gpt-4o"
    gpt_4o_mini = "openai/gpt-4o-mini"
    o3_mini = "openai/o3-mini"


class AgentStatus(str, Enum):
    starting = "starting"
    busy = "busy"
    idle = "idle"
    completed = "completed"
    error = "error"
    interrupted = "interrupted"


class Agent(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    workspace_id: uuid.UUID = Field(foreign_key="workspace.id", index=True, nullable=False)
    sandbox_id: uuid.UUID = Field(foreign_key="sandbox.id", nullable=False)
    agent_type: AgentType
    model: str
    session_id: Optional[str] = Field(default=None)
    status: AgentStatus = Field(default=AgentStatus.starting)
    name: Optional[str] = Field(default=None)
    prompt: str
    created_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)
    updated_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)
