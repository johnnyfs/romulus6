"""add codex agent type

Revision ID: c8d9e0f1a2b3
Revises: b7c8d9e0f1a2
Create Date: 2026-04-08 20:00:00.000000

"""

from typing import Sequence, Union

from alembic import op


revision: str = "c8d9e0f1a2b3"
down_revision: Union[str, None] = "b7c8d9e0f1a2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE agenttype ADD VALUE IF NOT EXISTS 'codex'")


def downgrade() -> None:
    # PostgreSQL enums cannot remove values without rebuilding the type.
    pass
