"""template materialization

Revision ID: q6d7e8f9g0h1
Revises: p5c6d7e8f9g0
Create Date: 2026-04-05 20:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "q6d7e8f9g0h1"
down_revision: Union[str, None] = "p5c6d7e8f9g0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- Extend nodetype enum (for GraphNode) ---
    op.execute("ALTER TYPE nodetype ADD VALUE IF NOT EXISTS 'task_template'")
    op.execute("ALTER TYPE nodetype ADD VALUE IF NOT EXISTS 'subgraph_template'")

    # --- Extend subgraphtemplatenodetype enum with agent/command ---
    op.execute("ALTER TYPE subgraphtemplatenodetype ADD VALUE IF NOT EXISTS 'agent'")
    op.execute("ALTER TYPE subgraphtemplatenodetype ADD VALUE IF NOT EXISTS 'command'")

    # --- SubgraphTemplateNode: add inline agent/command fields ---
    op.add_column("subgraphtemplatenode", sa.Column("agent_type", sqlmodel.AutoString(), nullable=True))
    op.add_column("subgraphtemplatenode", sa.Column("model", sqlmodel.AutoString(), nullable=True))
    op.add_column("subgraphtemplatenode", sa.Column("prompt", sqlmodel.AutoString(), nullable=True))
    op.add_column("subgraphtemplatenode", sa.Column("command", sqlmodel.AutoString(), nullable=True))
    op.add_column("subgraphtemplatenode", sa.Column("graph_tools", sa.Boolean(), nullable=False, server_default="false"))

    op.add_column("graphnode", sa.Column("task_template_id", sa.Uuid(), nullable=True))
    op.add_column("graphnode", sa.Column("subgraph_template_id", sa.Uuid(), nullable=True))
    op.add_column("graphnode", sa.Column("argument_bindings", sqlmodel.AutoString(), nullable=True))
    op.create_foreign_key(
        "fk_graphnode_task_template_id",
        "graphnode",
        "tasktemplate",
        ["task_template_id"],
        ["id"],
    )
    op.create_foreign_key(
        "fk_graphnode_subgraph_template_id",
        "graphnode",
        "subgraphtemplate",
        ["subgraph_template_id"],
        ["id"],
    )

    op.alter_column("graphrun", "graph_id", existing_type=sa.Uuid(), nullable=True)
    op.add_column("graphrun", sa.Column("parent_run_node_id", sa.Uuid(), nullable=True))
    op.create_index("ix_graphrun_parent_run_node_id", "graphrun", ["parent_run_node_id"])
    op.create_foreign_key(
        "fk_graphrun_parent_run_node_id",
        "graphrun",
        "graphrunnode",
        ["parent_run_node_id"],
        ["id"],
        use_alter=True,
    )

    op.add_column("graphrunnode", sa.Column("child_run_id", sa.Uuid(), nullable=True))
    op.add_column(
        "graphrunnode",
        sa.Column("source_type", sqlmodel.AutoString(), nullable=False, server_default="graph_node"),
    )
    op.alter_column("graphrunnode", "source_node_id", existing_type=sa.Uuid(), nullable=True)
    op.create_foreign_key(
        "fk_graphrunnode_child_run_id",
        "graphrunnode",
        "graphrun",
        ["child_run_id"],
        ["id"],
    )


def downgrade() -> None:
    # --- SubgraphTemplateNode: remove inline agent/command fields ---
    op.drop_column("subgraphtemplatenode", "graph_tools")
    op.drop_column("subgraphtemplatenode", "command")
    op.drop_column("subgraphtemplatenode", "prompt")
    op.drop_column("subgraphtemplatenode", "model")
    op.drop_column("subgraphtemplatenode", "agent_type")

    op.drop_constraint("fk_graphrunnode_child_run_id", "graphrunnode", type_="foreignkey")
    op.alter_column("graphrunnode", "source_node_id", existing_type=sa.Uuid(), nullable=False)
    op.drop_column("graphrunnode", "source_type")
    op.drop_column("graphrunnode", "child_run_id")

    op.drop_constraint("fk_graphrun_parent_run_node_id", "graphrun", type_="foreignkey")
    op.drop_index("ix_graphrun_parent_run_node_id", table_name="graphrun")
    op.drop_column("graphrun", "parent_run_node_id")
    op.alter_column("graphrun", "graph_id", existing_type=sa.Uuid(), nullable=False)

    op.drop_constraint("fk_graphnode_subgraph_template_id", "graphnode", type_="foreignkey")
    op.drop_constraint("fk_graphnode_task_template_id", "graphnode", type_="foreignkey")
    op.drop_column("graphnode", "argument_bindings")
    op.drop_column("graphnode", "subgraph_template_id")
    op.drop_column("graphnode", "task_template_id")

    # PostgreSQL enums cannot drop values in-place.
