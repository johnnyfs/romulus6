"""add schema templates and extend argument types

Revision ID: f1a2b3c4d5e6
Revises: e0f1a2b3c4d5
Create Date: 2026-04-08 23:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f1a2b3c4d5e6"
down_revision: Union[str, None] = "e0f1a2b3c4d5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # -- 1. Add 'schema' value to templateargtype enum --
    op.execute("ALTER TYPE templateargtype ADD VALUE IF NOT EXISTS 'schema'")

    # -- 2. Create schematemplate table --
    op.create_table(
        "schematemplate",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("name", sqlmodel.AutoString(), nullable=False),
        sa.Column("fields", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default="false"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspace.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_schematemplate_workspace_id"),
        "schematemplate",
        ["workspace_id"],
    )
    op.create_index(
        "ix_schematemplate_workspace_name_unique",
        "schematemplate",
        ["workspace_id", "name"],
        unique=True,
        postgresql_where=sa.text("deleted = false"),
    )

    # -- 3. Add schema_template_id and container to argument tables --
    op.add_column(
        "tasktemplateargument",
        sa.Column("schema_template_id", sa.Uuid(), nullable=True),
    )
    op.create_foreign_key(
        "fk_tasktemplateargument_schema_template",
        "tasktemplateargument",
        "schematemplate",
        ["schema_template_id"],
        ["id"],
    )
    op.add_column(
        "tasktemplateargument",
        sa.Column("container", sqlmodel.AutoString(), nullable=True),
    )

    op.add_column(
        "subgraphtemplateargument",
        sa.Column("schema_template_id", sa.Uuid(), nullable=True),
    )
    op.create_foreign_key(
        "fk_subgraphtemplateargument_schema_template",
        "subgraphtemplateargument",
        "schematemplate",
        ["schema_template_id"],
        ["id"],
    )
    op.add_column(
        "subgraphtemplateargument",
        sa.Column("container", sqlmodel.AutoString(), nullable=True),
    )


def downgrade() -> None:
    # -- Drop argument columns --
    op.drop_column("subgraphtemplateargument", "container")
    op.drop_constraint(
        "fk_subgraphtemplateargument_schema_template",
        "subgraphtemplateargument",
        type_="foreignkey",
    )
    op.drop_column("subgraphtemplateargument", "schema_template_id")

    op.drop_column("tasktemplateargument", "container")
    op.drop_constraint(
        "fk_tasktemplateargument_schema_template",
        "tasktemplateargument",
        type_="foreignkey",
    )
    op.drop_column("tasktemplateargument", "schema_template_id")

    # -- Drop schematemplate table --
    op.drop_index("ix_schematemplate_workspace_name_unique", table_name="schematemplate")
    op.drop_index(op.f("ix_schematemplate_workspace_id"), table_name="schematemplate")
    op.drop_table("schematemplate")

    # Note: cannot remove 'schema' from templateargtype enum without recreating it
