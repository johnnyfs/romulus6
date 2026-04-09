"""add sandbox_mode fields to codex-capable durable models

Revision ID: g6h7i8j9k0l1
Revises: f1a2b3c4d5e6
Create Date: 2026-04-09 11:30:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "g6h7i8j9k0l1"
down_revision: Union[str, None] = "f1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("agent", sa.Column("sandbox_mode", sa.String(), nullable=True))
    op.add_column("graphnode", sa.Column("sandbox_mode", sa.String(), nullable=True))
    op.add_column("tasktemplate", sa.Column("sandbox_mode", sa.String(), nullable=True))
    op.add_column(
        "subgraphtemplatenode",
        sa.Column("sandbox_mode", sa.String(), nullable=True),
    )
    op.add_column("graphrunnode", sa.Column("sandbox_mode", sa.String(), nullable=True))


def downgrade() -> None:
    op.drop_column("graphrunnode", "sandbox_mode")
    op.drop_column("subgraphtemplatenode", "sandbox_mode")
    op.drop_column("tasktemplate", "sandbox_mode")
    op.drop_column("graphnode", "sandbox_mode")
    op.drop_column("agent", "sandbox_mode")
