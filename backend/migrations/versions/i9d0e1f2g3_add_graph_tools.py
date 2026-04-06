"""add graph_tools toggle

Revision ID: i9d0e1f2g3
Revises: h8c9d0e1f2
Create Date: 2026-04-05 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "i9d0e1f2g3"
down_revision: Union[str, None] = "h8c9d0e1f2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("agent", sa.Column("graph_tools", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("graphnode", sa.Column("graph_tools", sa.Boolean(), nullable=False, server_default=sa.text("false")))
    op.add_column("graphrunnode", sa.Column("graph_tools", sa.Boolean(), nullable=False, server_default=sa.text("false")))


def downgrade() -> None:
    op.drop_column("graphrunnode", "graph_tools")
    op.drop_column("graphnode", "graph_tools")
    op.drop_column("agent", "graph_tools")
