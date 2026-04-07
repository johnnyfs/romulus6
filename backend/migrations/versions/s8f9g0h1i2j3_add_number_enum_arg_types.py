"""add number and enum arg types

Revision ID: s8f9g0h1i2j3
Revises: r7e8f9g0h1i3
Create Date: 2026-04-07 14:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op

revision: str = "s8f9g0h1i2j3"
down_revision: Union[str, None] = "r7e8f9g0h1i3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Extend the templateargtype enum with new values
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE templateargtype ADD VALUE IF NOT EXISTS 'boolean'")
        op.execute("ALTER TYPE templateargtype ADD VALUE IF NOT EXISTS 'number'")
        op.execute("ALTER TYPE templateargtype ADD VALUE IF NOT EXISTS 'enum'")

    # Add columns to tasktemplateargument
    op.add_column("tasktemplateargument", sa.Column("min_value", sqlmodel.AutoString(), nullable=True))
    op.add_column("tasktemplateargument", sa.Column("max_value", sqlmodel.AutoString(), nullable=True))
    op.add_column("tasktemplateargument", sa.Column("enum_options", sqlmodel.AutoString(), nullable=True))

    # Add columns to subgraphtemplateargument
    op.add_column("subgraphtemplateargument", sa.Column("min_value", sqlmodel.AutoString(), nullable=True))
    op.add_column("subgraphtemplateargument", sa.Column("max_value", sqlmodel.AutoString(), nullable=True))
    op.add_column("subgraphtemplateargument", sa.Column("enum_options", sqlmodel.AutoString(), nullable=True))


def downgrade() -> None:
    # Drop columns from subgraphtemplateargument
    op.drop_column("subgraphtemplateargument", "enum_options")
    op.drop_column("subgraphtemplateargument", "max_value")
    op.drop_column("subgraphtemplateargument", "min_value")

    # Drop columns from tasktemplateargument
    op.drop_column("tasktemplateargument", "enum_options")
    op.drop_column("tasktemplateargument", "max_value")
    op.drop_column("tasktemplateargument", "min_value")

    # Note: PostgreSQL does not support removing enum values
