"""create graph tables

Revision ID: a1b2c3d4e5f6
Revises: 8cb461029959
Create Date: 2026-04-04 21:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


# revision identifiers, used by Alembic.
revision: str = 'a1b2c3d4e5f6'
down_revision: Union[str, Sequence[str], None] = '8cb461029959'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        'graph',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('workspace_id', sa.Uuid(), nullable=False),
        sa.Column('name', sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['workspace_id'], ['workspace.id']),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_graph_workspace_id'), 'graph', ['workspace_id'], unique=False)

    op.create_table(
        'graphnode',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('graph_id', sa.Uuid(), nullable=False),
        sa.Column('node_type', sa.Enum('nop', name='nodetype'), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['graph_id'], ['graph.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_graphnode_graph_id'), 'graphnode', ['graph_id'], unique=False)

    op.create_table(
        'graphedge',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('graph_id', sa.Uuid(), nullable=False),
        sa.Column('from_node_id', sa.Uuid(), nullable=False),
        sa.Column('to_node_id', sa.Uuid(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['graph_id'], ['graph.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['from_node_id'], ['graphnode.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['to_node_id'], ['graphnode.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(op.f('ix_graphedge_graph_id'), 'graphedge', ['graph_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_graphedge_graph_id'), table_name='graphedge')
    op.drop_table('graphedge')
    op.drop_index(op.f('ix_graphnode_graph_id'), table_name='graphnode')
    op.drop_table('graphnode')
    op.drop_index(op.f('ix_graph_workspace_id'), table_name='graph')
    op.drop_table('graph')
    op.execute("DROP TYPE IF EXISTS nodetype")
