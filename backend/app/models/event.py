import datetime
import uuid
from typing import Any

from sqlalchemy import Column, DateTime, Index
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel


class Event(SQLModel, table=True):
    __tablename__ = "event"
    __table_args__ = (
        Index("ix_event_workspace_type_source", "workspace_id", "type", "source_id"),
        Index("ix_event_workspace_received_at", "workspace_id", "received_at"),
    )

    id: str = Field(primary_key=True)
    workspace_id: uuid.UUID = Field(foreign_key="workspace.id", index=True, nullable=False)
    type: str = Field(index=True)       # source type: "agent" now, "command" etc. later
    source_id: str = Field(index=True)  # agent_id or future source ids as string
    session_id: str | None = Field(default=None, index=True)
    agent_id: uuid.UUID | None = Field(default=None, index=True)
    run_id: uuid.UUID | None = Field(default=None, index=True)
    node_id: uuid.UUID | None = Field(default=None, index=True)
    sandbox_id: uuid.UUID | None = Field(default=None, index=True)
    worker_id: uuid.UUID | None = Field(default=None, index=True)
    event_type: str                     # specific event: "session.busy", "text.delta", etc.
    timestamp: str                      # ISO-8601 from source
    source_name: str | None = Field(default=None)  # denormalized human-readable name
    data: dict[str, Any] = Field(sa_column=Column(JSONB, nullable=False))
    received_at: datetime.datetime = Field(
        default_factory=datetime.datetime.utcnow,
        sa_column=Column(DateTime(), nullable=False),
    )
    persisted_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)
