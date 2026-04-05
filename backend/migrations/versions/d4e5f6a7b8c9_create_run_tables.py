"""create run tables

Revision ID: d4e5f6a7b8c9
Revises: c3d4e5f6a7b8
Create Date: 2026-04-05 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "d4e5f6a7b8c9"
down_revision: Union[str, None] = "c3d4e5f6a7b8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "graphrun",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("graph_id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["graph_id"], ["graph.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspace.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_graphrun_graph_id"), "graphrun", ["graph_id"], unique=False)
    op.create_index(op.f("ix_graphrun_workspace_id"), "graphrun", ["workspace_id"], unique=False)

    op.create_table(
        "graphrunnode",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("source_node_id", sa.Uuid(), nullable=False),
        sa.Column("node_type", sqlmodel.AutoString(), nullable=False),
        sa.Column("name", sqlmodel.AutoString(), nullable=True),
        sa.Column("state", sqlmodel.AutoString(), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["run_id"], ["graphrun.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["source_node_id"], ["graphnode.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_graphrunnode_run_id"), "graphrunnode", ["run_id"], unique=False)

    op.create_table(
        "graphrunedge",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("from_run_node_id", sa.Uuid(), nullable=False),
        sa.Column("to_run_node_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["run_id"], ["graphrun.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["from_run_node_id"], ["graphrunnode.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["to_run_node_id"], ["graphrunnode.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_graphrunedge_run_id"), "graphrunedge", ["run_id"], unique=False)


def downgrade() -> None:
    op.drop_index(op.f("ix_graphrunedge_run_id"), table_name="graphrunedge")
    op.drop_table("graphrunedge")
    op.drop_index(op.f("ix_graphrunnode_run_id"), table_name="graphrunnode")
    op.drop_table("graphrunnode")
    op.drop_index(op.f("ix_graphrun_workspace_id"), table_name="graphrun")
    op.drop_index(op.f("ix_graphrun_graph_id"), table_name="graphrun")
    op.drop_table("graphrun")
