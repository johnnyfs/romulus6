"""add pydantic agent type

Revision ID: t9g0h1i2j3k4
Revises: s8f9g0h1i2j3
Create Date: 2026-04-07 14:50:00.000000

"""

from typing import Sequence, Union

from alembic import op


revision: str = "t9g0h1i2j3k4"
down_revision: Union[str, None] = "s8f9g0h1i2j3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE agenttype ADD VALUE IF NOT EXISTS 'pydantic'")


def downgrade() -> None:
    # PostgreSQL enums cannot remove values without rebuilding the type.
    pass
