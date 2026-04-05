import datetime
import uuid
from enum import Enum
from typing import List, Optional

from sqlmodel import Field, Relationship, SQLModel


class NodeType(str, Enum):
    nop = "nop"


class Graph(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    workspace_id: uuid.UUID = Field(foreign_key="workspace.id", index=True)
    name: str
    created_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)
    updated_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)

    nodes: List["GraphNode"] = Relationship(back_populates="graph")
    edges: List["GraphEdge"] = Relationship(back_populates="graph")


class GraphNode(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    graph_id: uuid.UUID = Field(foreign_key="graph.id", index=True)
    node_type: NodeType = Field(default=NodeType.nop)
    created_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)

    graph: Optional[Graph] = Relationship(back_populates="nodes")
    outgoing_edges: List["GraphEdge"] = Relationship(
        back_populates="from_node",
        sa_relationship_kwargs={"foreign_keys": "[GraphEdge.from_node_id]"},
    )
    incoming_edges: List["GraphEdge"] = Relationship(
        back_populates="to_node",
        sa_relationship_kwargs={"foreign_keys": "[GraphEdge.to_node_id]"},
    )


class GraphEdge(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    graph_id: uuid.UUID = Field(foreign_key="graph.id", index=True)
    from_node_id: uuid.UUID = Field(foreign_key="graphnode.id")
    to_node_id: uuid.UUID = Field(foreign_key="graphnode.id")
    created_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)

    graph: Optional[Graph] = Relationship(back_populates="edges")
    from_node: Optional[GraphNode] = Relationship(
        back_populates="outgoing_edges",
        sa_relationship_kwargs={"foreign_keys": "[GraphEdge.from_node_id]"},
    )
    to_node: Optional[GraphNode] = Relationship(
        back_populates="incoming_edges",
        sa_relationship_kwargs={"foreign_keys": "[GraphEdge.to_node_id]"},
    )
