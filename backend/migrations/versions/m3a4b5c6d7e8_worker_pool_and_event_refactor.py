"""worker pool and event refactor

Revision ID: m3a4b5c6d7e8
Revises: l2g3h4i5j6
Create Date: 2026-04-05 19:30:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "m3a4b5c6d7e8"
down_revision: Union[str, None] = "l2g3h4i5j6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("worker", sa.Column("registration_key", sa.String(), nullable=True))
    op.add_column("worker", sa.Column("pod_name", sa.String(), nullable=True))
    op.add_column("worker", sa.Column("pod_ip", sa.String(), nullable=True))
    op.add_column("worker", sa.Column("registered_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")))
    op.add_column("worker", sa.Column("last_heartbeat_at", sa.DateTime(), nullable=True))
    op.add_column("worker", sa.Column("metadata", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")))
    op.create_index("ix_worker_registration_key", "worker", ["registration_key"], unique=False)
    op.create_index("ix_worker_pod_name", "worker", ["pod_name"], unique=False)
    op.create_index("ix_worker_last_heartbeat_at", "worker", ["last_heartbeat_at"], unique=False)

    op.create_table(
        "workerlease",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("workspace_id", sa.Uuid(), nullable=False),
        sa.Column("sandbox_id", sa.Uuid(), nullable=False),
        sa.Column("worker_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.Enum("active", "released", "expired", "failed", name="workerleasestatus"), nullable=False),
        sa.Column("leased_at", sa.DateTime(), nullable=False),
        sa.Column("heartbeat_expires_at", sa.DateTime(), nullable=True),
        sa.Column("released_at", sa.DateTime(), nullable=True),
        sa.Column("failure_reason", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.ForeignKeyConstraint(["sandbox_id"], ["sandbox.id"]),
        sa.ForeignKeyConstraint(["worker_id"], ["worker.id"]),
        sa.ForeignKeyConstraint(["workspace_id"], ["workspace.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_workerlease_workspace_id", "workerlease", ["workspace_id"])
    op.create_index("ix_workerlease_sandbox_id", "workerlease", ["sandbox_id"])
    op.create_index("ix_workerlease_worker_id", "workerlease", ["worker_id"])
    op.create_index("ix_workerlease_status", "workerlease", ["status"])
    op.create_index("ix_workerlease_heartbeat_expires_at", "workerlease", ["heartbeat_expires_at"])

    op.add_column("sandbox", sa.Column("current_lease_id", sa.Uuid(), nullable=True))
    op.create_foreign_key("fk_sandbox_current_lease_id", "sandbox", "workerlease", ["current_lease_id"], ["id"])

    op.add_column("event", sa.Column("session_id", sa.String(), nullable=True))
    op.add_column("event", sa.Column("agent_id", sa.Uuid(), nullable=True))
    op.add_column("event", sa.Column("run_id", sa.Uuid(), nullable=True))
    op.add_column("event", sa.Column("node_id", sa.Uuid(), nullable=True))
    op.add_column("event", sa.Column("sandbox_id", sa.Uuid(), nullable=True))
    op.add_column("event", sa.Column("worker_id", sa.Uuid(), nullable=True))
    op.add_column("event", sa.Column("received_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")))
    op.create_index("ix_event_session_id", "event", ["session_id"])
    op.create_index("ix_event_agent_id", "event", ["agent_id"])
    op.create_index("ix_event_run_id", "event", ["run_id"])
    op.create_index("ix_event_node_id", "event", ["node_id"])
    op.create_index("ix_event_sandbox_id", "event", ["sandbox_id"])
    op.create_index("ix_event_worker_id", "event", ["worker_id"])
    op.create_index("ix_event_workspace_received_at", "event", ["workspace_id", "received_at"])
    op.execute("UPDATE event SET received_at = persisted_at")

    op.create_table(
        "runreconcile",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("next_attempt_at", sa.DateTime(), nullable=False, server_default=sa.text("now()")),
        sa.Column("reason", sa.String(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("deleted", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.ForeignKeyConstraint(["run_id"], ["graphrun.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("run_id"),
    )
    op.create_index("ix_runreconcile_run_id", "runreconcile", ["run_id"])
    op.create_index("ix_runreconcile_next_attempt_at", "runreconcile", ["next_attempt_at"])


def downgrade() -> None:
    op.drop_index("ix_runreconcile_next_attempt_at", table_name="runreconcile")
    op.drop_index("ix_runreconcile_run_id", table_name="runreconcile")
    op.drop_table("runreconcile")

    op.drop_index("ix_event_workspace_received_at", table_name="event")
    op.drop_index("ix_event_worker_id", table_name="event")
    op.drop_index("ix_event_sandbox_id", table_name="event")
    op.drop_index("ix_event_node_id", table_name="event")
    op.drop_index("ix_event_run_id", table_name="event")
    op.drop_index("ix_event_agent_id", table_name="event")
    op.drop_index("ix_event_session_id", table_name="event")
    op.drop_column("event", "received_at")
    op.drop_column("event", "worker_id")
    op.drop_column("event", "sandbox_id")
    op.drop_column("event", "node_id")
    op.drop_column("event", "run_id")
    op.drop_column("event", "agent_id")
    op.drop_column("event", "session_id")

    op.drop_constraint("fk_sandbox_current_lease_id", "sandbox", type_="foreignkey")
    op.drop_column("sandbox", "current_lease_id")

    op.drop_index("ix_workerlease_heartbeat_expires_at", table_name="workerlease")
    op.drop_index("ix_workerlease_status", table_name="workerlease")
    op.drop_index("ix_workerlease_worker_id", table_name="workerlease")
    op.drop_index("ix_workerlease_sandbox_id", table_name="workerlease")
    op.drop_index("ix_workerlease_workspace_id", table_name="workerlease")
    op.drop_table("workerlease")
    op.execute("DROP TYPE IF EXISTS workerleasestatus")

    op.drop_index("ix_worker_last_heartbeat_at", table_name="worker")
    op.drop_index("ix_worker_pod_name", table_name="worker")
    op.drop_index("ix_worker_registration_key", table_name="worker")
    op.drop_column("worker", "metadata")
    op.drop_column("worker", "last_heartbeat_at")
    op.drop_column("worker", "registered_at")
    op.drop_column("worker", "pod_ip")
    op.drop_column("worker", "pod_name")
    op.drop_column("worker", "registration_key")
