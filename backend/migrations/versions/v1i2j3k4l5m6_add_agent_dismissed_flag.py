"""add agent dismissed flag

Revision ID: v1i2j3k4l5m6
Revises: u0h1i2j3k4l5
Create Date: 2026-04-07 20:20:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "v1i2j3k4l5m6"
down_revision: Union[str, None] = "u0h1i2j3k4l5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "agent",
        sa.Column("dismissed", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.alter_column("agent", "dismissed", server_default=None)


def downgrade() -> None:
    op.drop_column("agent", "dismissed")
