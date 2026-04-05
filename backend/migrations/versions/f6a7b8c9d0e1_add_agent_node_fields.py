"""add agent node fields

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-04-05 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, None] = "e5f6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE nodetype ADD VALUE IF NOT EXISTS 'agent'")

    op.add_column("graphnode", sa.Column("agent_type", sqlmodel.AutoString(), nullable=True))
    op.add_column("graphnode", sa.Column("model", sqlmodel.AutoString(), nullable=True))
    op.add_column("graphnode", sa.Column("prompt", sqlmodel.AutoString(), nullable=True))

    op.add_column("graphrunnode", sa.Column("agent_type", sqlmodel.AutoString(), nullable=True))
    op.add_column("graphrunnode", sa.Column("model", sqlmodel.AutoString(), nullable=True))
    op.add_column("graphrunnode", sa.Column("prompt", sqlmodel.AutoString(), nullable=True))


def downgrade() -> None:
    op.drop_column("graphrunnode", "prompt")
    op.drop_column("graphrunnode", "model")
    op.drop_column("graphrunnode", "agent_type")

    op.drop_column("graphnode", "prompt")
    op.drop_column("graphnode", "model")
    op.drop_column("graphnode", "agent_type")

    # Note: PostgreSQL does not support removing values from an enum type.
    # The 'agent' value will remain in the nodetype enum after downgrade.
