import uuid
from enum import Enum
from typing import TYPE_CHECKING, List, Optional

from sqlalchemy import Column, ForeignKey, String
from sqlmodel import Field, Relationship

from .base import RomulusBase
from .json_column import validated_json_column
from .structured_fields import (
    ImageAttachmentSchema,
    ImagePayloadList,
    NodeOutputPayload,
    OutputSchemaDefinition,
)

if TYPE_CHECKING:
    from .sandbox import Sandbox


class RunState(str, Enum):
    pending = "pending"
    running = "running"
    completed = "completed"
    error = "error"


class RunNodeSourceType(str, Enum):
    graph_node = "graph_node"
    template_node = "template_node"


class RunNodeType(str, Enum):
    agent = "agent"
    command = "command"
    subgraph = "subgraph"


class RunNodeState(str, Enum):
    pending = "pending"
    dispatching = "dispatching"
    running = "running"
    completed = "completed"
    error = "error"


class GraphRun(RomulusBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    graph_id: Optional[uuid.UUID] = Field(default=None, foreign_key="graph.id", index=True)
    workspace_id: uuid.UUID = Field(foreign_key="workspace.id", index=True)
    sandbox_id: Optional[uuid.UUID] = Field(default=None, foreign_key="sandbox.id")
    source_template_id: Optional[uuid.UUID] = Field(
        default=None, foreign_key="subgraphtemplate.id"
    )
    state: RunState = Field(
        default=RunState.pending,
        sa_column=Column(String, nullable=False),
    )
    parent_run_node_id: Optional[uuid.UUID] = Field(
        default=None,
        sa_column=Column(
            ForeignKey("graphrunnode.id", use_alter=True),
            index=True,
            nullable=True,
        ),
    )

    sandbox: Optional["Sandbox"] = Relationship()
    run_nodes: List["GraphRunNode"] = Relationship(
        back_populates="run",
        sa_relationship_kwargs={
            "cascade": "all, delete-orphan",
            "foreign_keys": "[GraphRunNode.run_id]",
        },
    )
    run_edges: List["GraphRunEdge"] = Relationship(
        back_populates="run",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )


class GraphRunNode(RomulusBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    run_id: uuid.UUID = Field(foreign_key="graphrun.id", index=True)
    source_node_id: Optional[uuid.UUID] = Field(default=None)
    source_type: RunNodeSourceType = Field(
        default=RunNodeSourceType.graph_node,
        sa_column=Column(String, nullable=False),
    )
    attempt: int = Field(default=1)
    retry_of_run_node_id: Optional[uuid.UUID] = Field(
        default=None,
        sa_column=Column(
            ForeignKey("graphrunnode.id", use_alter=True),
            index=True,
            nullable=True,
        ),
    )
    next_attempt_run_node_id: Optional[uuid.UUID] = Field(
        default=None,
        sa_column=Column(
            ForeignKey("graphrunnode.id", use_alter=True),
            index=True,
            nullable=True,
        ),
    )
    node_type: RunNodeType = Field(sa_column=Column(String, nullable=False))
    name: Optional[str] = Field(default=None, sa_column=Column("name", String, nullable=True))
    state: RunNodeState = Field(
        default=RunNodeState.pending,
        sa_column=Column(String, nullable=False),
    )
    agent_type: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    model: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    prompt: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    command: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    agent_id: Optional[uuid.UUID] = Field(default=None, foreign_key="agent.id")
    session_id: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    graph_tools: bool = Field(default=False)
    sandbox_mode: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    output_schema: Optional[OutputSchemaDefinition] = Field(
        default=None,
        sa_column=validated_json_column(OutputSchemaDefinition, nullable=True),
    )
    output: Optional[NodeOutputPayload] = Field(
        default=None,
        sa_column=validated_json_column(NodeOutputPayload, nullable=True),
    )
    image_attachments: Optional[ImagePayloadList] = Field(
        default=None,
        sa_column=validated_json_column(ImageAttachmentSchema, nullable=True),
    )
    child_run_id: Optional[uuid.UUID] = Field(default=None, foreign_key="graphrun.id")

    run: Optional[GraphRun] = Relationship(
        back_populates="run_nodes",
        sa_relationship_kwargs={"foreign_keys": "[GraphRunNode.run_id]"},
    )
    child_run: Optional[GraphRun] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[GraphRunNode.child_run_id]"},
    )


class GraphRunEdge(RomulusBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    run_id: uuid.UUID = Field(foreign_key="graphrun.id", index=True)
    from_run_node_id: uuid.UUID = Field(foreign_key="graphrunnode.id")
    to_run_node_id: uuid.UUID = Field(foreign_key="graphrunnode.id")

    run: Optional[GraphRun] = Relationship(back_populates="run_edges")
