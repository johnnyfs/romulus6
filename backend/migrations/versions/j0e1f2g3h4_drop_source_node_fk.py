"""drop source_node_id foreign key

Revision ID: j0e1f2g3h4
Revises: i9d0e1f2g3
Create Date: 2026-04-05 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = "j0e1f2g3h4"
down_revision: Union[str, None] = "i9d0e1f2g3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_constraint(
        "graphrunnode_source_node_id_fkey", "graphrunnode", type_="foreignkey"
    )


def downgrade() -> None:
    op.create_foreign_key(
        "graphrunnode_source_node_id_fkey",
        "graphrunnode",
        "graphnode",
        ["source_node_id"],
        ["id"],
    )
