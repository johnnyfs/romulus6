import uuid
from typing import TYPE_CHECKING, List, Optional

from sqlalchemy import Index, text
from sqlmodel import Field, Relationship

from .base import RomulusBase

if TYPE_CHECKING:
    from .agent import Agent
    from .lease import WorkerLease
    from .worker import Worker
    from .workspace import Workspace


class Sandbox(RomulusBase, table=True):
    __table_args__ = (
        Index(
            "ix_sandbox_workspace_name_unique",
            "workspace_id",
            "name",
            unique=True,
            postgresql_where=text("deleted = false"),
        ),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    workspace_id: uuid.UUID = Field(foreign_key="workspace.id", index=True, nullable=False)
    name: str
    worker_id: Optional[uuid.UUID] = Field(default=None, foreign_key="worker.id")
    current_lease_id: Optional[uuid.UUID] = Field(default=None, foreign_key="workerlease.id")

    workspace: Optional["Workspace"] = Relationship(back_populates="sandboxes")
    worker: Optional["Worker"] = Relationship(back_populates="sandboxes")
    current_lease: Optional["WorkerLease"] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[Sandbox.current_lease_id]"}
    )
    agents: List["Agent"] = Relationship(back_populates="sandbox")
