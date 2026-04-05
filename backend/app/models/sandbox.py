import datetime
import uuid
from typing import Optional

from sqlmodel import Field, SQLModel


class Sandbox(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    workspace_id: uuid.UUID = Field(foreign_key="workspace.id", index=True, nullable=False)
    name: str
    worker_id: Optional[uuid.UUID] = Field(default=None, foreign_key="worker.id")
    created_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)
    updated_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)
