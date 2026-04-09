"""remove view node type and rename images to image_attachments

Revision ID: e0f1a2b3c4d5
Revises: d9e0f1a2b3c4
Create Date: 2026-04-08 22:00:00.000000

"""

from typing import Sequence, Union

from alembic import op

revision: str = "e0f1a2b3c4d5"
down_revision: Union[str, None] = "d9e0f1a2b3c4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # -- 1. Convert any existing 'view' rows before removing the enum value --
    # graphnode and subgraphtemplatenode use Postgres enums; graphrunnode uses String
    op.execute(
        "UPDATE graphnode SET node_type = 'command', deleted = true "
        "WHERE node_type = 'view'"
    )
    op.execute(
        "UPDATE tasktemplate SET task_type = 'command', deleted = true "
        "WHERE task_type = 'view'"
    )
    op.execute(
        "UPDATE subgraphtemplatenode SET node_type = 'command', deleted = true "
        "WHERE node_type = 'view'"
    )
    op.execute(
        "UPDATE graphrunnode SET node_type = 'command' "
        "WHERE node_type = 'view'"
    )

    # -- 2. Recreate nodetype enum without 'view' --
    # Both graphnode.node_type and tasktemplate.task_type use this enum
    op.execute("ALTER TYPE nodetype RENAME TO nodetype_old")
    op.execute(
        "CREATE TYPE nodetype AS ENUM "
        "('agent', 'command', 'task_template', 'subgraph_template')"
    )
    op.execute(
        "ALTER TABLE graphnode ALTER COLUMN node_type TYPE nodetype "
        "USING node_type::text::nodetype"
    )
    op.execute(
        "ALTER TABLE tasktemplate ALTER COLUMN task_type TYPE nodetype "
        "USING task_type::text::nodetype"
    )
    op.execute("DROP TYPE nodetype_old")

    # -- 3. Recreate subgraphtemplatenodetype enum without 'view' --
    op.execute("ALTER TYPE subgraphtemplatenodetype RENAME TO subgraphtemplatenodetype_old")
    op.execute(
        "CREATE TYPE subgraphtemplatenodetype AS ENUM "
        "('agent', 'command', 'task_template', 'subgraph_template')"
    )
    op.execute(
        "ALTER TABLE subgraphtemplatenode "
        "ALTER COLUMN node_type TYPE subgraphtemplatenodetype "
        "USING node_type::text::subgraphtemplatenodetype"
    )
    op.execute("DROP TYPE subgraphtemplatenodetype_old")

    # -- 4. Rename images -> image_attachments on all tables --
    op.alter_column("graphnode", "images", new_column_name="image_attachments")
    op.alter_column("graphrunnode", "images", new_column_name="image_attachments")
    op.alter_column("subgraphtemplatenode", "images", new_column_name="image_attachments")
    op.alter_column("tasktemplate", "images", new_column_name="image_attachments")


def downgrade() -> None:
    # -- Reverse rename --
    op.alter_column("tasktemplate", "image_attachments", new_column_name="images")
    op.alter_column("subgraphtemplatenode", "image_attachments", new_column_name="images")
    op.alter_column("graphrunnode", "image_attachments", new_column_name="images")
    op.alter_column("graphnode", "image_attachments", new_column_name="images")

    # -- Re-add 'view' to enums --
    op.execute("ALTER TYPE nodetype ADD VALUE IF NOT EXISTS 'view'")
    op.execute("ALTER TYPE subgraphtemplatenodetype ADD VALUE IF NOT EXISTS 'view'")
