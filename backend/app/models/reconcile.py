import datetime
import uuid

from sqlmodel import Field

from .base import RomulusBase


class RunReconcile(RomulusBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    run_id: uuid.UUID = Field(foreign_key="graphrun.id", index=True, nullable=False, unique=True)
    next_attempt_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow, index=True)
    reason: str | None = Field(default=None)
