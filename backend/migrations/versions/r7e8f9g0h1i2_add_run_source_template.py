"""add source_template_id to graphrun

Revision ID: r7e8f9g0h1i2
Revises: q6d7e8f9g0h1
Create Date: 2026-04-07 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "r7e8f9g0h1i2"
down_revision: Union[str, None] = "q6d7e8f9g0h1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "graphrun",
        sa.Column("source_template_id", sa.Uuid(), nullable=True),
    )
    op.create_foreign_key(
        "fk_graphrun_source_template_id",
        "graphrun",
        "subgraphtemplate",
        ["source_template_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_graphrun_source_template_id", "graphrun", type_="foreignkey")
    op.drop_column("graphrun", "source_template_id")
