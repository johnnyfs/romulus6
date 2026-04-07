"""add template output_schema columns

Revision ID: w2j3k4l5m6n7
Revises: v1i2j3k4l5m6
Create Date: 2026-04-07 22:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "w2j3k4l5m6n7"
down_revision: Union[str, None] = "v1i2j3k4l5m6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "tasktemplate",
        sa.Column("output_schema", sqlmodel.AutoString(), nullable=True),
    )
    op.add_column(
        "subgraphtemplate",
        sa.Column("output_schema", sqlmodel.AutoString(), nullable=True),
    )
    op.add_column(
        "subgraphtemplatenode",
        sa.Column("output_schema", sqlmodel.AutoString(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("subgraphtemplatenode", "output_schema")
    op.drop_column("subgraphtemplate", "output_schema")
    op.drop_column("tasktemplate", "output_schema")
