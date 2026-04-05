import datetime
import uuid
from typing import Any

from sqlalchemy import Column, Index
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel


class Event(SQLModel, table=True):
    __tablename__ = "event"
    __table_args__ = (
        Index("ix_event_workspace_type_source", "workspace_id", "type", "source_id"),
    )

    id: str = Field(primary_key=True)
    workspace_id: uuid.UUID = Field(foreign_key="workspace.id", index=True, nullable=False)
    type: str = Field(index=True)       # source type: "agent" now, "command" etc. later
    source_id: str = Field(index=True)  # agent_id or future source ids as string
    event_type: str                     # specific event: "session.busy", "text.delta", etc.
    timestamp: str                      # ISO-8601 from source
    data: dict[str, Any] = Field(sa_column=Column(JSONB, nullable=False))
    persisted_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)
