import uuid
from enum import Enum
from typing import TYPE_CHECKING, List, Optional

from sqlalchemy import Column, Index, String, text
from sqlmodel import Field, Relationship

from .base import RomulusBase
from .graph import NodeType

if TYPE_CHECKING:
    from .workspace import Workspace


class TemplateArgType(str, Enum):
    string = "string"
    model_type = "model_type"
    boolean = "boolean"
    number = "number"
    enum = "enum"


class SubgraphTemplateNodeType(str, Enum):
    agent = "agent"
    command = "command"
    task_template = "task_template"
    subgraph_template = "subgraph_template"


# ── Task Templates ───────────────────────────────────────────────────────────


class TaskTemplate(RomulusBase, table=True):
    __table_args__ = (
        Index(
            "ix_tasktemplate_workspace_name_unique",
            "workspace_id",
            "name",
            unique=True,
            postgresql_where=text("deleted = false"),
        ),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    workspace_id: uuid.UUID = Field(foreign_key="workspace.id", index=True)
    name: str
    task_type: NodeType
    agent_type: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    model: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    prompt: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    command: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    graph_tools: bool = Field(default=False)
    label: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    output_schema: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    images: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))

    workspace: Optional["Workspace"] = Relationship(back_populates="task_templates")
    arguments: List["TaskTemplateArgument"] = Relationship(
        back_populates="task_template",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )


class TaskTemplateArgument(RomulusBase, table=True):
    __table_args__ = (
        Index(
            "ix_tasktemplateargument_template_name_unique",
            "task_template_id",
            "name",
            unique=True,
            postgresql_where=text("deleted = false"),
        ),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    task_template_id: uuid.UUID = Field(foreign_key="tasktemplate.id", index=True)
    name: str
    arg_type: TemplateArgType = Field(default=TemplateArgType.string)
    default_value: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    model_constraint: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    min_value: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    max_value: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    enum_options: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))

    task_template: Optional[TaskTemplate] = Relationship(back_populates="arguments")


# ── Subgraph Templates ───────────────────────────────────────────────────────


class SubgraphTemplate(RomulusBase, table=True):
    __table_args__ = (
        Index(
            "ix_subgraphtemplate_workspace_name_unique",
            "workspace_id",
            "name",
            unique=True,
            postgresql_where=text("deleted = false"),
        ),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    workspace_id: uuid.UUID = Field(foreign_key="workspace.id", index=True)
    name: str
    label: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    output_schema: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))

    workspace: Optional["Workspace"] = Relationship(back_populates="subgraph_templates")
    nodes: List["SubgraphTemplateNode"] = Relationship(
        back_populates="subgraph_template",
        sa_relationship_kwargs={
            "cascade": "all, delete-orphan",
            "foreign_keys": "[SubgraphTemplateNode.subgraph_template_id]",
        },
    )
    edges: List["SubgraphTemplateEdge"] = Relationship(
        back_populates="subgraph_template",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )
    arguments: List["SubgraphTemplateArgument"] = Relationship(
        back_populates="subgraph_template",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"},
    )


class SubgraphTemplateArgument(RomulusBase, table=True):
    __table_args__ = (
        Index(
            "ix_subgraphtemplateargument_template_name_unique",
            "subgraph_template_id",
            "name",
            unique=True,
            postgresql_where=text("deleted = false"),
        ),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    subgraph_template_id: uuid.UUID = Field(foreign_key="subgraphtemplate.id", index=True)
    name: str
    arg_type: TemplateArgType = Field(default=TemplateArgType.string)
    default_value: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    model_constraint: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    min_value: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    max_value: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    enum_options: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))

    subgraph_template: Optional[SubgraphTemplate] = Relationship(back_populates="arguments")


class SubgraphTemplateNode(RomulusBase, table=True):
    __table_args__ = (
        Index(
            "ix_subgraphtemplatenode_template_name_unique",
            "subgraph_template_id",
            "name",
            unique=True,
            postgresql_where=text("deleted = false"),
        ),
    )

    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    subgraph_template_id: uuid.UUID = Field(foreign_key="subgraphtemplate.id", index=True)
    node_type: SubgraphTemplateNodeType
    name: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    # For agent/command inline nodes
    agent_type: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    model: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    prompt: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    command: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))
    graph_tools: bool = Field(default=False)
    # For task_template/subgraph_template reference nodes
    task_template_id: Optional[uuid.UUID] = Field(
        default=None, foreign_key="tasktemplate.id"
    )
    ref_subgraph_template_id: Optional[uuid.UUID] = Field(
        default=None, foreign_key="subgraphtemplate.id"
    )
    argument_bindings: Optional[str] = Field(
        default=None, sa_column=Column(String, nullable=True)
    )
    output_schema: Optional[str] = Field(
        default=None, sa_column=Column(String, nullable=True)
    )
    images: Optional[str] = Field(default=None, sa_column=Column(String, nullable=True))

    subgraph_template: Optional[SubgraphTemplate] = Relationship(
        back_populates="nodes",
        sa_relationship_kwargs={
            "foreign_keys": "[SubgraphTemplateNode.subgraph_template_id]",
        },
    )
    ref_task_template: Optional[TaskTemplate] = Relationship(
        sa_relationship_kwargs={"foreign_keys": "[SubgraphTemplateNode.task_template_id]"},
    )
    ref_subgraph: Optional[SubgraphTemplate] = Relationship(
        sa_relationship_kwargs={
            "foreign_keys": "[SubgraphTemplateNode.ref_subgraph_template_id]",
        },
    )
    outgoing_edges: List["SubgraphTemplateEdge"] = Relationship(
        back_populates="from_node",
        sa_relationship_kwargs={
            "foreign_keys": "[SubgraphTemplateEdge.from_node_id]",
            "passive_deletes": True,
        },
    )
    incoming_edges: List["SubgraphTemplateEdge"] = Relationship(
        back_populates="to_node",
        sa_relationship_kwargs={
            "foreign_keys": "[SubgraphTemplateEdge.to_node_id]",
            "passive_deletes": True,
        },
    )


class SubgraphTemplateEdge(RomulusBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    subgraph_template_id: uuid.UUID = Field(foreign_key="subgraphtemplate.id", index=True)
    from_node_id: uuid.UUID = Field(foreign_key="subgraphtemplatenode.id")
    to_node_id: uuid.UUID = Field(foreign_key="subgraphtemplatenode.id")

    subgraph_template: Optional[SubgraphTemplate] = Relationship(back_populates="edges")
    from_node: Optional[SubgraphTemplateNode] = Relationship(
        back_populates="outgoing_edges",
        sa_relationship_kwargs={"foreign_keys": "[SubgraphTemplateEdge.from_node_id]"},
    )
    to_node: Optional[SubgraphTemplateNode] = Relationship(
        back_populates="incoming_edges",
        sa_relationship_kwargs={"foreign_keys": "[SubgraphTemplateEdge.to_node_id]"},
    )
