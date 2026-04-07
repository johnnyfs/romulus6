"""add run node retry lineage

Revision ID: y4l5m6n7o8p9
Revises: x3k4l5m6n7o8
Create Date: 2026-04-07 23:40:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "y4l5m6n7o8p9"
down_revision: Union[str, None] = "x3k4l5m6n7o8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "graphrunnode",
        sa.Column("attempt", sa.Integer(), nullable=False, server_default="1"),
    )
    op.add_column(
        "graphrunnode",
        sa.Column("retry_of_run_node_id", sa.Uuid(), nullable=True),
    )
    op.add_column(
        "graphrunnode",
        sa.Column("next_attempt_run_node_id", sa.Uuid(), nullable=True),
    )
    op.create_index(
        op.f("ix_graphrunnode_retry_of_run_node_id"),
        "graphrunnode",
        ["retry_of_run_node_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_graphrunnode_next_attempt_run_node_id"),
        "graphrunnode",
        ["next_attempt_run_node_id"],
        unique=False,
    )
    op.create_foreign_key(
        "fk_graphrunnode_retry_of_run_node_id",
        "graphrunnode",
        "graphrunnode",
        ["retry_of_run_node_id"],
        ["id"],
        use_alter=True,
    )
    op.create_foreign_key(
        "fk_graphrunnode_next_attempt_run_node_id",
        "graphrunnode",
        "graphrunnode",
        ["next_attempt_run_node_id"],
        ["id"],
        use_alter=True,
    )
    op.alter_column("graphrunnode", "attempt", server_default=None)


def downgrade() -> None:
    op.drop_constraint("fk_graphrunnode_next_attempt_run_node_id", "graphrunnode", type_="foreignkey")
    op.drop_constraint("fk_graphrunnode_retry_of_run_node_id", "graphrunnode", type_="foreignkey")
    op.drop_index(op.f("ix_graphrunnode_next_attempt_run_node_id"), table_name="graphrunnode")
    op.drop_index(op.f("ix_graphrunnode_retry_of_run_node_id"), table_name="graphrunnode")
    op.drop_column("graphrunnode", "next_attempt_run_node_id")
    op.drop_column("graphrunnode", "retry_of_run_node_id")
    op.drop_column("graphrunnode", "attempt")
