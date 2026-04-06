"""add event.source_name and agent.graph_run_id

Revision ID: k1f2g3h4i5
Revises: j0e1f2g3h4
Create Date: 2026-04-05 00:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "k1f2g3h4i5"
down_revision: Union[str, None] = "j0e1f2g3h4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("event", sa.Column("source_name", sa.String(), nullable=True))
    op.add_column("agent", sa.Column("graph_run_id", sa.Uuid(), nullable=True))
    op.create_index("ix_agent_graph_run_id", "agent", ["graph_run_id"])

    # Backfill source_name for existing agent events
    op.execute(
        """
        UPDATE event
        SET source_name = agent.name
        FROM agent
        WHERE event.type = 'agent'
          AND event.source_id = agent.id::text
        """
    )

    # Backfill source_name for existing run events (from run nodes)
    op.execute(
        """
        UPDATE event
        SET source_name = graphrunnode.name
        FROM graphrunnode
        WHERE event.type = 'run'
          AND event.source_id = graphrunnode.id::text
        """
    )


def downgrade() -> None:
    op.drop_index("ix_agent_graph_run_id", table_name="agent")
    op.drop_column("agent", "graph_run_id")
    op.drop_column("event", "source_name")
