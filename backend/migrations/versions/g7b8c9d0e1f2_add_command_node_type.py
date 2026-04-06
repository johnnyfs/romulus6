"""add command node type

Revision ID: g7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-04-05 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "g7b8c9d0e1f2"
down_revision: Union[str, None] = "f6a7b8c9d0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE nodetype ADD VALUE IF NOT EXISTS 'command'")

    op.add_column("graphnode", sa.Column("command", sqlmodel.AutoString(), nullable=True))
    op.add_column("graphrunnode", sa.Column("command", sqlmodel.AutoString(), nullable=True))


def downgrade() -> None:
    op.drop_column("graphrunnode", "command")
    op.drop_column("graphnode", "command")

    # Note: PostgreSQL does not support removing values from an enum type.
    # The 'command' value will remain in the nodetype enum after downgrade.
