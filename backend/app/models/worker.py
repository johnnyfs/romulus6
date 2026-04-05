import datetime
import uuid
from enum import Enum
from typing import Optional

from sqlmodel import Field, SQLModel


class WorkerStatus(str, Enum):
    pending = "pending"
    running = "running"
    failed = "failed"
    terminating = "terminating"
    terminated = "terminated"


class Worker(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    status: WorkerStatus = Field(default=WorkerStatus.pending)
    worker_url: Optional[str] = Field(default=None)
    deployment_name: Optional[str] = Field(default=None)
    service_name: Optional[str] = Field(default=None)
    nodeport_service_name: Optional[str] = Field(default=None)
    node_port: Optional[int] = Field(default=None)
    created_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)
    updated_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)
