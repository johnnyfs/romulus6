"""add view to subgraph template node type

Revision ID: z5m6n7o8p9q0
Revises: y4l5m6n7o8p9
Create Date: 2026-04-08 00:00:00.000000

"""

from typing import Sequence, Union

from alembic import op

revision: str = "z5m6n7o8p9q0"
down_revision: Union[str, None] = "y4l5m6n7o8p9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.execute("ALTER TYPE subgraphtemplatenodetype ADD VALUE IF NOT EXISTS 'view'")


def downgrade() -> None:
    # PostgreSQL enums cannot drop values in-place.
    pass
