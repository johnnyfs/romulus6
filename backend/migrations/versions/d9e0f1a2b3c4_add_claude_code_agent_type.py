"""add claude_code agent type

Revision ID: d9e0f1a2b3c4
Revises: c8d9e0f1a2b3
Create Date: 2026-04-08 21:00:00.000000

"""

from typing import Sequence, Union

from alembic import op


revision: str = "d9e0f1a2b3c4"
down_revision: Union[str, None] = "c8d9e0f1a2b3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE agenttype ADD VALUE IF NOT EXISTS 'claude_code'")


def downgrade() -> None:
    # PostgreSQL enums cannot remove values without rebuilding the type.
    pass
