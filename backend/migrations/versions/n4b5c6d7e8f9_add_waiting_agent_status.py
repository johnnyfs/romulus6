"""add waiting agent status

Revision ID: n4b5c6d7e8f9
Revises: m3a4b5c6d7e8
Create Date: 2026-04-05 19:50:00.000000
"""

from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "n4b5c6d7e8f9"
down_revision: str | Sequence[str] | None = "m3a4b5c6d7e8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("ALTER TYPE agentstatus ADD VALUE IF NOT EXISTS 'waiting'")


def downgrade() -> None:
    # PostgreSQL enums cannot safely remove values in-place.
    pass
