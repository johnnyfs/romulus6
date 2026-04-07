"""add node output_schema and output fields

Revision ID: u0h1i2j3k4l5
Revises: t9g0h1i2j3k4
Create Date: 2026-04-07 18:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "u0h1i2j3k4l5"
down_revision: Union[str, None] = "t9g0h1i2j3k4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("graphnode", sa.Column("output_schema", sqlmodel.AutoString(), nullable=True))
    op.add_column("graphrunnode", sa.Column("output_schema", sqlmodel.AutoString(), nullable=True))
    op.add_column("graphrunnode", sa.Column("output", sqlmodel.AutoString(), nullable=True))


def downgrade() -> None:
    op.drop_column("graphrunnode", "output")
    op.drop_column("graphrunnode", "output_schema")
    op.drop_column("graphnode", "output_schema")
