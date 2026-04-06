import datetime
import uuid
from enum import Enum
from typing import TYPE_CHECKING, Optional

from sqlmodel import Field, Relationship

from .base import RomulusBase

if TYPE_CHECKING:
    from .sandbox import Sandbox
    from .worker import Worker


class WorkerLeaseStatus(str, Enum):
    active = "active"
    released = "released"
    expired = "expired"
    failed = "failed"


class WorkerLease(RomulusBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    workspace_id: uuid.UUID = Field(foreign_key="workspace.id", index=True, nullable=False)
    sandbox_id: uuid.UUID = Field(foreign_key="sandbox.id", index=True, nullable=False)
    worker_id: uuid.UUID = Field(foreign_key="worker.id", index=True, nullable=False)
    status: WorkerLeaseStatus = Field(default=WorkerLeaseStatus.active, index=True)
    leased_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)
    heartbeat_expires_at: Optional[datetime.datetime] = Field(default=None, index=True)
    released_at: Optional[datetime.datetime] = Field(default=None)
    failure_reason: Optional[str] = Field(default=None)

    sandbox: Optional["Sandbox"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[WorkerLease.sandbox_id]"}
    )
    worker: Optional["Worker"] = Relationship(back_populates="leases")
