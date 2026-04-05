import uuid
from enum import Enum
from typing import TYPE_CHECKING, List, Optional

from sqlmodel import Field, Relationship

from .base import RomulusBase

if TYPE_CHECKING:
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
    deployment_name: Optional[str] = Field(default=None)
    service_name: Optional[str] = Field(default=None)
    nodeport_service_name: Optional[str] = Field(default=None)
    node_port: Optional[int] = Field(default=None)

    sandboxes: List["Sandbox"] = Relationship(back_populates="worker")
