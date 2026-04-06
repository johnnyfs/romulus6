import uuid
import datetime
from enum import Enum
from typing import TYPE_CHECKING, List, Optional

from sqlalchemy import Column
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, Relationship

from .base import RomulusBase

if TYPE_CHECKING:
    from .lease import WorkerLease
    from .sandbox import Sandbox


class WorkerStatus(str, Enum):
    pending = "pending"
    running = "running"
    failed = "failed"
    terminating = "terminating"
    terminated = "terminated"


class Worker(RomulusBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    status: WorkerStatus = Field(default=WorkerStatus.pending)
    worker_url: Optional[str] = Field(default=None)
    registration_key: Optional[str] = Field(default=None, index=True)
    pod_name: Optional[str] = Field(default=None, index=True)
    pod_ip: Optional[str] = Field(default=None)
    registered_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)
    last_heartbeat_at: Optional[datetime.datetime] = Field(default=None, index=True)
    worker_metadata: dict = Field(default_factory=dict, sa_column=Column("metadata", JSONB, nullable=False))
    deployment_name: Optional[str] = Field(default=None)
    service_name: Optional[str] = Field(default=None)
    nodeport_service_name: Optional[str] = Field(default=None)
    node_port: Optional[int] = Field(default=None)

    sandboxes: List["Sandbox"] = Relationship(back_populates="worker")
    leases: List["WorkerLease"] = Relationship(back_populates="worker")
