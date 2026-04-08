"""add view to nodetype

Revision ID: a6n7o8p9q0r1
Revises: z5m6n7o8p9q0
Create Date: 2026-04-08 00:30:00.000000

"""

from typing import Sequence, Union

from alembic import op

revision: str = "a6n7o8p9q0r1"
down_revision: Union[str, None] = "z5m6n7o8p9q0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TYPE nodetype ADD VALUE IF NOT EXISTS 'view'")


def downgrade() -> None:
    # PostgreSQL enums cannot drop values in-place.
    pass
