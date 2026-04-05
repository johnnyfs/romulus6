"""persist events

Revision ID: b2c3d4e5f6a1
Revises: a1b2c3d4e5f6
Create Date: 2026-04-05 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b2c3d4e5f6a1"
down_revision: Union[str, None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Make agent.sandbox_id nullable so the sandbox can be torn down while the
    # agent row persists (for soft-delete / event replay).
    op.alter_column("agent", "sandbox_id", existing_type=sa.Uuid(), nullable=True)

    # Add soft-delete column to agent.
    op.add_column("agent", sa.Column("deleted_at", sa.DateTime(), nullable=True))

    # Create the generic event table.  source_type discriminates the source
    # ("agent" today, "command" etc. later); source_id is the UUID of that
    # source stored as text so no FK constraint is needed.
    op.create_table(
        "event",
        sa.Column("id", sqlmodel.AutoString(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("type", sqlmodel.AutoString(), nullable=False),
        sa.Column("source_id", sqlmodel.AutoString(), nullable=False),
        sa.Column("event_type", sqlmodel.AutoString(), nullable=False),
        sa.Column("timestamp", sqlmodel.AutoString(), nullable=False),
        sa.Column("data", postgresql.JSONB(), nullable=False),
        sa.Column("persisted_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspace.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_event_workspace_id", "event", ["workspace_id"])
    op.create_index("ix_event_type", "event", ["type"])
    op.create_index("ix_event_source_id", "event", ["source_id"])
    op.create_index(
        "ix_event_workspace_type_source",
        "event",
        ["workspace_id", "type", "source_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_event_workspace_type_source", table_name="event")
    op.drop_index("ix_event_source_id", table_name="event")
    op.drop_index("ix_event_type", table_name="event")
    op.drop_index("ix_event_workspace_id", table_name="event")
    op.drop_table("event")
    op.drop_column("agent", "deleted_at")
    op.alter_column("agent", "sandbox_id", existing_type=sa.Uuid(), nullable=False)
