"""add image attachments column

Revision ID: x3k4l5m6n7o8
Revises: w2j3k4l5m6n7
Create Date: 2026-04-07 23:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "x3k4l5m6n7o8"
down_revision: Union[str, None] = "w2j3k4l5m6n7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tasktemplate",
        sa.Column("images", sqlmodel.AutoString(), nullable=True),
    )
    op.add_column(
        "graphnode",
        sa.Column("images", sqlmodel.AutoString(), nullable=True),
    )
    op.add_column(
        "subgraphtemplatenode",
        sa.Column("images", sqlmodel.AutoString(), nullable=True),
    )
    op.add_column(
        "graphrunnode",
        sa.Column("images", sqlmodel.AutoString(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("graphrunnode", "images")
    op.drop_column("subgraphtemplatenode", "images")
    op.drop_column("graphnode", "images")
    op.drop_column("tasktemplate", "images")
