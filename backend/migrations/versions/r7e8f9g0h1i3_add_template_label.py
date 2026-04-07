"""add template label

Revision ID: r7e8f9g0h1i3
Revises: r7e8f9g0h1i2
Create Date: 2026-04-07 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "r7e8f9g0h1i3"
down_revision: Union[str, None] = "r7e8f9g0h1i2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tasktemplate", sa.Column("label", sqlmodel.AutoString(), nullable=True))
    op.add_column("subgraphtemplate", sa.Column("label", sqlmodel.AutoString(), nullable=True))


def downgrade() -> None:
    op.drop_column("subgraphtemplate", "label")
    op.drop_column("tasktemplate", "label")
