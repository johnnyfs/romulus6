import uuid
from typing import TYPE_CHECKING, List

from sqlalchemy import Index, text
from sqlmodel import Field, Relationship

from .base import RomulusBase

if TYPE_CHECKING:
    from .agent import Agent
    from .graph import Graph
    from .sandbox import Sandbox
    from .template import SchemaTemplate, SubgraphTemplate, TaskTemplate


class Workspace(RomulusBase, table=True):
    __table_args__ = (
        Index(
            "ix_workspace_name_unique",
            "name",
            unique=True,
            postgresql_where=text("deleted = false"),
        ),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    name: str

    sandboxes: List["Sandbox"] = Relationship(back_populates="workspace")
    agents: List["Agent"] = Relationship(back_populates="workspace")
    graphs: List["Graph"] = Relationship(back_populates="workspace")
    schema_templates: List["SchemaTemplate"] = Relationship(back_populates="workspace")
    task_templates: List["TaskTemplate"] = Relationship(back_populates="workspace")
    subgraph_templates: List["SubgraphTemplate"] = Relationship(back_populates="workspace")
