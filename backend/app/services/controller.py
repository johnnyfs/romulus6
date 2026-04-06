import asyncio
import datetime
import logging
import os
import uuid

from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.database import engine
from app.models.lease import WorkerLeaseStatus
from app.models.reconcile import RunReconcile
from app.models.run import GraphRun, GraphRunNode
from app.models.sandbox import Sandbox
from app.models.worker import Worker, WorkerStatus
from app.services import workers as worker_svc

logger = logging.getLogger(__name__)

CONTROLLER_INTERVAL_SECONDS = float(os.environ.get("CONTROLLER_INTERVAL_SECONDS", "1.0"))


def enqueue_run_reconcile(session: Session, run_id: uuid.UUID, reason: str | None = None) -> None:
    existing = session.exec(
        select(RunReconcile)
        .where(RunReconcile.run_id == run_id)
    ).first()
    now = datetime.datetime.utcnow()
    if existing is None:
        existing = RunReconcile(run_id=run_id, reason=reason, next_attempt_at=now)
        session.add(existing)
    else:
        existing.deleted = False

    existing.reason = reason
    existing.next_attempt_at = now
    existing.updated_at = now
    session.add(existing)
    try:
        session.commit()
    except IntegrityError:
        session.rollback()
        existing = session.exec(
            select(RunReconcile)
            .where(RunReconcile.run_id == run_id)
        ).first()
        if existing is None:
            raise
        existing.deleted = False
        existing.reason = reason
        existing.next_attempt_at = now
        existing.updated_at = now
        session.add(existing)
        session.commit()


async def run_controller_loop(stop_event: asyncio.Event) -> None:
    from app.services import runs as run_svc

    while not stop_event.is_set():
        try:
            with Session(engine) as session:
                _scan_stale_workers(session)
                due = list(
                    session.exec(
                        select(RunReconcile)
                        .where(RunReconcile.deleted == False)  # noqa: E712
                        .where(RunReconcile.next_attempt_at <= datetime.datetime.utcnow())
                        .order_by(RunReconcile.next_attempt_at.asc(), RunReconcile.created_at.asc())
                    ).all()
                )
                for item in due:
                    run_id = item.run_id
                    item.deleted = True
                    item.updated_at = datetime.datetime.utcnow()
                    session.add(item)
                    session.commit()
                    await run_svc.reconcile_run(run_id)
        except Exception:
            logger.exception("controller loop iteration failed")

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=CONTROLLER_INTERVAL_SECONDS)
        except asyncio.TimeoutError:
            continue


def _scan_stale_workers(session: Session) -> None:
    cutoff = datetime.datetime.utcnow() - datetime.timedelta(seconds=worker_svc.HEARTBEAT_TIMEOUT_SECONDS)
    stale_workers = list(
        session.exec(
            select(Worker)
            .where(Worker.deleted == False)  # noqa: E712
            .where(Worker.status == WorkerStatus.running)
            .where(Worker.last_heartbeat_at.is_not(None))
            .where(Worker.last_heartbeat_at < cutoff)
        ).all()
    )
    for worker in stale_workers:
        worker_svc.mark_worker_failed(session, worker, "worker heartbeat expired")
        leases = worker_svc.expire_worker_leases(session, worker, failure_reason="worker heartbeat expired")
        for lease in leases:
            _fail_active_run_for_sandbox(session, lease.sandbox_id)


def _fail_active_run_for_sandbox(session: Session, sandbox_id: uuid.UUID) -> None:
    from app.services import runs as run_svc

    sandbox = session.get(Sandbox, sandbox_id)
    if sandbox is None:
        return
    runs = list(
        session.exec(
            select(GraphRun)
            .where(GraphRun.sandbox_id == sandbox.id)
            .where(GraphRun.deleted == False)  # noqa: E712
            .where(GraphRun.state.in_(["pending", "running"]))
            .order_by(GraphRun.created_at.desc())
        ).all()
    )
    for run in runs:
        active_nodes = list(
            session.exec(
                select(GraphRunNode)
                .where(GraphRunNode.run_id == run.id)
                .where(GraphRunNode.deleted == False)  # noqa: E712
                .where(GraphRunNode.state.in_(["dispatching", "running"]))
            ).all()
        )
        for node in active_nodes:
            run_svc.fail_node_and_run(
                session,
                run.id,
                node.id,
                "worker heartbeat expired",
                release_lease=False,
            )
        if not active_nodes and run.state != "error":
            run.state = "error"
            run.updated_at = datetime.datetime.utcnow()
            session.add(run)
            session.commit()
