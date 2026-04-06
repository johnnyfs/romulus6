"""create template tables

Revision ID: g7a8b9c0d1e2
Revises: m3a4b5c6d7e8
Create Date: 2026-04-05 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "g7a8b9c0d1e2"
down_revision: Union[str, None] = "m3a4b5c6d7e8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- Enums ---
    templateargtype = postgresql.ENUM("string", "model_type", name="templateargtype", create_type=True)
    templateargtype.create(op.get_bind(), checkfirst=True)

    subgraphtemplatenodetype = postgresql.ENUM(
        "task_template",
        "subgraph_template",
        name="subgraphtemplatenodetype",
        create_type=True,
    )
    subgraphtemplatenodetype.create(op.get_bind(), checkfirst=True)
    nodetype = postgresql.ENUM("agent", "command", name="nodetype", create_type=False)
    templateargtype_ref = postgresql.ENUM("string", "model_type", name="templateargtype", create_type=False)
    subgraphtemplatenodetype_ref = postgresql.ENUM(
        "task_template",
        "subgraph_template",
        name="subgraphtemplatenodetype",
        create_type=False,
    )

    # --- Task Template ---
    op.create_table(
        "tasktemplate",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("name", sqlmodel.AutoString(), nullable=False),
        sa.Column("task_type", nodetype, nullable=False),
        sa.Column("agent_type", sqlmodel.AutoString(), nullable=True),
        sa.Column("model", sqlmodel.AutoString(), nullable=True),
        sa.Column("prompt", sqlmodel.AutoString(), nullable=True),
        sa.Column("command", sqlmodel.AutoString(), nullable=True),
        sa.Column("graph_tools", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default="false"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspace.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_tasktemplate_workspace_id"), "tasktemplate", ["workspace_id"])
    op.create_index(
        "ix_tasktemplate_workspace_name_unique",
        "tasktemplate",
        ["workspace_id", "name"],
        unique=True,
        postgresql_where=sa.text("deleted = false"),
    )

    # --- Task Template Argument ---
    op.create_table(
        "tasktemplateargument",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("task_template_id", sa.Uuid(), nullable=False),
        sa.Column("name", sqlmodel.AutoString(), nullable=False),
        sa.Column("arg_type", templateargtype_ref, nullable=False, server_default="string"),
        sa.Column("default_value", sqlmodel.AutoString(), nullable=True),
        sa.Column("model_constraint", sqlmodel.AutoString(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default="false"),
        sa.ForeignKeyConstraint(["task_template_id"], ["tasktemplate.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_tasktemplateargument_task_template_id"), "tasktemplateargument", ["task_template_id"])
    op.create_index(
        "ix_tasktemplateargument_template_name_unique",
        "tasktemplateargument",
        ["task_template_id", "name"],
        unique=True,
        postgresql_where=sa.text("deleted = false"),
    )

    # --- Subgraph Template ---
    op.create_table(
        "subgraphtemplate",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("name", sqlmodel.AutoString(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default="false"),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspace.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_subgraphtemplate_workspace_id"), "subgraphtemplate", ["workspace_id"])
    op.create_index(
        "ix_subgraphtemplate_workspace_name_unique",
        "subgraphtemplate",
        ["workspace_id", "name"],
        unique=True,
        postgresql_where=sa.text("deleted = false"),
    )

    # --- Subgraph Template Argument ---
    op.create_table(
        "subgraphtemplateargument",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("subgraph_template_id", sa.Uuid(), nullable=False),
        sa.Column("name", sqlmodel.AutoString(), nullable=False),
        sa.Column("arg_type", templateargtype_ref, nullable=False, server_default="string"),
        sa.Column("default_value", sqlmodel.AutoString(), nullable=True),
        sa.Column("model_constraint", sqlmodel.AutoString(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default="false"),
        sa.ForeignKeyConstraint(["subgraph_template_id"], ["subgraphtemplate.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_subgraphtemplateargument_subgraph_template_id"), "subgraphtemplateargument", ["subgraph_template_id"])
    op.create_index(
        "ix_subgraphtemplateargument_template_name_unique",
        "subgraphtemplateargument",
        ["subgraph_template_id", "name"],
        unique=True,
        postgresql_where=sa.text("deleted = false"),
    )

    # --- Subgraph Template Node ---
    op.create_table(
        "subgraphtemplatenode",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("subgraph_template_id", sa.Uuid(), nullable=False),
        sa.Column("node_type", subgraphtemplatenodetype_ref, nullable=False),
        sa.Column("name", sqlmodel.AutoString(), nullable=True),
        sa.Column("task_template_id", sa.Uuid(), nullable=True),
        sa.Column("ref_subgraph_template_id", sa.Uuid(), nullable=True),
        sa.Column("argument_bindings", sqlmodel.AutoString(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default="false"),
        sa.ForeignKeyConstraint(["subgraph_template_id"], ["subgraphtemplate.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["task_template_id"], ["tasktemplate.id"]),
        sa.ForeignKeyConstraint(["ref_subgraph_template_id"], ["subgraphtemplate.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_subgraphtemplatenode_subgraph_template_id"), "subgraphtemplatenode", ["subgraph_template_id"])
    op.create_index(
        "ix_subgraphtemplatenode_template_name_unique",
        "subgraphtemplatenode",
        ["subgraph_template_id", "name"],
        unique=True,
        postgresql_where=sa.text("deleted = false"),
    )

    # --- Subgraph Template Edge ---
    op.create_table(
        "subgraphtemplateedge",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("subgraph_template_id", sa.Uuid(), nullable=False),
        sa.Column("from_node_id", sa.Uuid(), nullable=False),
        sa.Column("to_node_id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default="false"),
        sa.ForeignKeyConstraint(["subgraph_template_id"], ["subgraphtemplate.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["from_node_id"], ["subgraphtemplatenode.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["to_node_id"], ["subgraphtemplatenode.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_subgraphtemplateedge_subgraph_template_id"), "subgraphtemplateedge", ["subgraph_template_id"])


def downgrade() -> None:
    op.drop_index(op.f("ix_subgraphtemplateedge_subgraph_template_id"), table_name="subgraphtemplateedge")
    op.drop_table("subgraphtemplateedge")

    op.drop_index("ix_subgraphtemplatenode_template_name_unique", table_name="subgraphtemplatenode")
    op.drop_index(op.f("ix_subgraphtemplatenode_subgraph_template_id"), table_name="subgraphtemplatenode")
    op.drop_table("subgraphtemplatenode")

    op.drop_index("ix_subgraphtemplateargument_template_name_unique", table_name="subgraphtemplateargument")
    op.drop_index(op.f("ix_subgraphtemplateargument_subgraph_template_id"), table_name="subgraphtemplateargument")
    op.drop_table("subgraphtemplateargument")

    op.drop_index("ix_subgraphtemplate_workspace_name_unique", table_name="subgraphtemplate")
    op.drop_index(op.f("ix_subgraphtemplate_workspace_id"), table_name="subgraphtemplate")
    op.drop_table("subgraphtemplate")

    op.drop_index("ix_tasktemplateargument_template_name_unique", table_name="tasktemplateargument")
    op.drop_index(op.f("ix_tasktemplateargument_task_template_id"), table_name="tasktemplateargument")
    op.drop_table("tasktemplateargument")

    op.drop_index("ix_tasktemplate_workspace_name_unique", table_name="tasktemplate")
    op.drop_index(op.f("ix_tasktemplate_workspace_id"), table_name="tasktemplate")
    op.drop_table("tasktemplate")

    op.execute("DROP TYPE IF EXISTS subgraphtemplatenodetype")
    op.execute("DROP TYPE IF EXISTS templateargtype")
