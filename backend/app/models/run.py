import uuid
from typing import List, Optional

from sqlalchemy import Column, String
from sqlmodel import Field, Relationship

from .base import RomulusBase


class GraphRun(RomulusBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    graph_id: uuid.UUID = Field(foreign_key="graph.id", index=True)
    workspace_id: uuid.UUID = Field(foreign_key="workspace.id", index=True)

    run_nodes: List["GraphRunNode"] = Relationship(
        back_populates="run",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )
    run_edges: List["GraphRunEdge"] = Relationship(
        back_populates="run",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )


class GraphRunNode(RomulusBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    run_id: uuid.UUID = Field(foreign_key="graphrun.id", index=True)
    source_node_id: uuid.UUID = Field(foreign_key="graphnode.id")
    node_type: str
    name: Optional[str] = Field(default=None, sa_column=Column("name", String, nullable=True))
    state: str = Field(default="pending")
    agent_type: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    model: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    prompt: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))

    run: Optional[GraphRun] = Relationship(back_populates="run_nodes")


class GraphRunEdge(RomulusBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    run_id: uuid.UUID = Field(foreign_key="graphrun.id", index=True)
    from_run_node_id: uuid.UUID = Field(foreign_key="graphrunnode.id")
    to_run_node_id: uuid.UUID = Field(foreign_key="graphrunnode.id")

    run: Optional[GraphRun] = Relationship(back_populates="run_edges")
