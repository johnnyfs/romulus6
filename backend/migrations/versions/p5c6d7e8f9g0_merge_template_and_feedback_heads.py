"""merge template and feedback heads

Revision ID: p5c6d7e8f9g0
Revises: g7a8b9c0d1e2, n4b5c6d7e8f9
Create Date: 2026-04-05 20:05:00.000000
"""

from collections.abc import Sequence

# revision identifiers, used by Alembic.
revision: str = "p5c6d7e8f9g0"
down_revision: str | Sequence[str] | None = ("g7a8b9c0d1e2", "n4b5c6d7e8f9")
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
