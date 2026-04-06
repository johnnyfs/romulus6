import uuid
from enum import Enum
from typing import TYPE_CHECKING, List, Optional

from sqlalchemy import Column, Index, String, text
from sqlmodel import Field, Relationship

from .base import RomulusBase

if TYPE_CHECKING:
    from .workspace import Workspace


class NodeType(str, Enum):
    agent = "agent"
    command = "command"


class Graph(RomulusBase, table=True):
    __table_args__ = (
        Index(
            "ix_graph_workspace_name_unique",
            "workspace_id",
            "name",
            unique=True,
            postgresql_where=text("deleted = false"),
        ),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    workspace_id: uuid.UUID = Field(foreign_key="workspace.id", index=True)
    name: str

    workspace: Optional["Workspace"] = Relationship(back_populates="graphs")
    nodes: List["GraphNode"] = Relationship(
        back_populates="graph",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )
    edges: List["GraphEdge"] = Relationship(
        back_populates="graph",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )


class GraphNode(RomulusBase, table=True):
    __table_args__ = (
        Index(
            "ix_graphnode_graph_name_unique",
            "graph_id",
            "name",
            unique=True,
            postgresql_where=text("deleted = false"),
        ),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    graph_id: uuid.UUID = Field(foreign_key="graph.id", index=True)
    node_type: NodeType
    name: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    agent_type: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    model: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    prompt: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    command: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    graph_tools: bool = Field(default=False)

    graph: Optional[Graph] = Relationship(back_populates="nodes")
    outgoing_edges: List["GraphEdge"] = Relationship(
        back_populates="from_node",
        sa_relationship_kwargs={
            "foreign_keys": "[GraphEdge.from_node_id]",
            "passive_deletes": True,
        },
    )
    incoming_edges: List["GraphEdge"] = Relationship(
        back_populates="to_node",
        sa_relationship_kwargs={
            "foreign_keys": "[GraphEdge.to_node_id]",
            "passive_deletes": True,
        },
    )


class GraphEdge(RomulusBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    graph_id: uuid.UUID = Field(foreign_key="graph.id", index=True)
    from_node_id: uuid.UUID = Field(foreign_key="graphnode.id")
    to_node_id: uuid.UUID = Field(foreign_key="graphnode.id")

    graph: Optional[Graph] = Relationship(back_populates="edges")
    from_node: Optional[GraphNode] = Relationship(
        back_populates="outgoing_edges",
        sa_relationship_kwargs={"foreign_keys": "[GraphEdge.from_node_id]"},
    )
    to_node: Optional[GraphNode] = Relationship(
        back_populates="incoming_edges",
        sa_relationship_kwargs={"foreign_keys": "[GraphEdge.to_node_id]"},
    )
