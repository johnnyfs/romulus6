"""remove nop node type

Revision ID: l2g3h4i5j6
Revises: k1f2g3h4i5
Create Date: 2026-04-05 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "l2g3h4i5j6"
down_revision: Union[str, None] = "k1f2g3h4i5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Convert existing nop nodes to agent
    op.execute("UPDATE graphnode SET node_type = 'agent' WHERE node_type = 'nop'")
    op.execute("UPDATE graphrunnode SET node_type = 'agent' WHERE node_type = 'nop'")

    # Replace the nodetype enum: create new without nop, swap, drop old
    op.execute("ALTER TYPE nodetype RENAME TO nodetype_old")
    op.execute("CREATE TYPE nodetype AS ENUM ('agent', 'command')")
    op.execute(
        "ALTER TABLE graphnode ALTER COLUMN node_type TYPE nodetype "
        "USING node_type::text::nodetype"
    )
    op.execute("DROP TYPE nodetype_old")


def downgrade() -> None:
    op.execute("ALTER TYPE nodetype RENAME TO nodetype_old")
    op.execute("CREATE TYPE nodetype AS ENUM ('nop', 'agent', 'command')")
    op.execute(
        "ALTER TABLE graphnode ALTER COLUMN node_type TYPE nodetype "
        "USING node_type::text::nodetype"
    )
    op.execute("DROP TYPE nodetype_old")
