"""base model consistency

Revision ID: e5f6a7b8c9d0
Revises: d4e5f6a7b8c9
Create Date: 2026-04-05 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, None] = "d4e5f6a7b8c9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- workspace: add timestamps and deleted ---
    op.add_column("workspace", sa.Column("created_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")))
    op.add_column("workspace", sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")))
    op.add_column("workspace", sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.create_index(
        "ix_workspace_name_unique", "workspace", ["name"], unique=True,
        postgresql_where=sa.text("deleted = false"),
    )

    # --- worker: add deleted ---
    op.add_column("worker", sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")))

    # --- sandbox: add deleted + unique constraint ---
    op.add_column("sandbox", sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.create_index(
        "ix_sandbox_workspace_name_unique", "sandbox", ["workspace_id", "name"], unique=True,
        postgresql_where=sa.text("deleted = false"),
    )

    # --- agent: replace deleted_at with deleted bool + unique constraint ---
    op.drop_column("agent", "deleted_at")
    op.add_column("agent", sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.create_index(
        "ix_agent_workspace_name_unique", "agent", ["workspace_id", "name"], unique=True,
        postgresql_where=sa.text("deleted = false"),
    )

    # --- graph: add deleted + unique constraint ---
    op.add_column("graph", sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.create_index(
        "ix_graph_workspace_name_unique", "graph", ["workspace_id", "name"], unique=True,
        postgresql_where=sa.text("deleted = false"),
    )

    # --- graphnode: add updated_at, deleted + unique constraint ---
    op.add_column("graphnode", sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")))
    op.add_column("graphnode", sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.create_index(
        "ix_graphnode_graph_name_unique", "graphnode", ["graph_id", "name"], unique=True,
        postgresql_where=sa.text("deleted = false"),
    )

    # --- graphedge: add updated_at, deleted ---
    op.add_column("graphedge", sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")))
    op.add_column("graphedge", sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")))

    # --- graphrun: add updated_at, deleted ---
    op.add_column("graphrun", sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")))
    op.add_column("graphrun", sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")))

    # --- graphrunnode: add updated_at, deleted ---
    op.add_column("graphrunnode", sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")))
    op.add_column("graphrunnode", sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")))

    # --- graphrunedge: add updated_at, deleted ---
    op.add_column("graphrunedge", sa.Column("updated_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")))
    op.add_column("graphrunedge", sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")))


def downgrade() -> None:
    op.drop_column("graphrunedge", "deleted")
    op.drop_column("graphrunedge", "updated_at")

    op.drop_column("graphrunnode", "deleted")
    op.drop_column("graphrunnode", "updated_at")

    op.drop_column("graphrun", "deleted")
    op.drop_column("graphrun", "updated_at")

    op.drop_column("graphedge", "deleted")
    op.drop_column("graphedge", "updated_at")

    op.drop_index("ix_graphnode_graph_name_unique", table_name="graphnode")
    op.drop_column("graphnode", "deleted")
    op.drop_column("graphnode", "updated_at")

    op.drop_index("ix_graph_workspace_name_unique", table_name="graph")
    op.drop_column("graph", "deleted")

    op.drop_index("ix_agent_workspace_name_unique", table_name="agent")
    op.drop_column("agent", "deleted")
    op.add_column("agent", sa.Column("deleted_at", sa.DateTime(), nullable=True))

    op.drop_index("ix_sandbox_workspace_name_unique", table_name="sandbox")
    op.drop_column("sandbox", "deleted")

    op.drop_column("worker", "deleted")

    op.drop_index("ix_workspace_name_unique", table_name="workspace")
    op.drop_column("workspace", "deleted")
    op.drop_column("workspace", "updated_at")
    op.drop_column("workspace", "created_at")
