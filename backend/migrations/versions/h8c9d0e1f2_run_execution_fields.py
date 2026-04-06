"""add run execution fields

Revision ID: h8c9d0e1f2
Revises: g7b8c9d0e1f2
Create Date: 2026-04-05 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "h8c9d0e1f2"
down_revision: Union[str, None] = "g7b8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("graphrun", sa.Column("sandbox_id", sa.Uuid(), nullable=True))
    op.add_column("graphrun", sa.Column("state", sqlmodel.AutoString(), nullable=False, server_default="pending"))
    op.create_foreign_key("fk_graphrun_sandbox_id", "graphrun", "sandbox", ["sandbox_id"], ["id"])

    op.add_column("graphrunnode", sa.Column("agent_id", sa.Uuid(), nullable=True))
    op.add_column("graphrunnode", sa.Column("session_id", sqlmodel.AutoString(), nullable=True))
    op.create_foreign_key("fk_graphrunnode_agent_id", "graphrunnode", "agent", ["agent_id"], ["id"])


def downgrade() -> None:
    op.drop_constraint("fk_graphrunnode_agent_id", "graphrunnode", type_="foreignkey")
    op.drop_column("graphrunnode", "session_id")
    op.drop_column("graphrunnode", "agent_id")

    op.drop_constraint("fk_graphrun_sandbox_id", "graphrun", type_="foreignkey")
    op.drop_column("graphrun", "state")
    op.drop_column("graphrun", "sandbox_id")
