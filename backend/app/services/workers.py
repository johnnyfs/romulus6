import datetime
import os
import uuid
from typing import Any

from sqlmodel import Session, select

from app.models.lease import WorkerLease, WorkerLeaseStatus
from app.models.sandbox import Sandbox
from app.models.worker import Worker, WorkerStatus

HEARTBEAT_TIMEOUT_SECONDS = int(os.environ.get("WORKER_HEARTBEAT_TIMEOUT_SECONDS", "30"))


def _utcnow() -> datetime.datetime:
    return datetime.datetime.utcnow()


def heartbeat_expiry(now: datetime.datetime | None = None) -> datetime.datetime:
    now = now or _utcnow()
    return now + datetime.timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)


def register_worker(
    session: Session,
    *,
    worker_url: str,
    pod_name: str | None = None,
    pod_ip: str | None = None,
    registration_key: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> Worker:
    worker: Worker | None = None
    if registration_key:
        worker = session.exec(
            select(Worker).where(Worker.registration_key == registration_key).where(Worker.deleted == False)  # noqa: E712
        ).first()
    if worker is None and pod_name:
        worker = session.exec(
            select(Worker).where(Worker.pod_name == pod_name).where(Worker.deleted == False)  # noqa: E712
        ).first()

    if worker is None:
        worker = Worker()

    now = _utcnow()
    worker.status = WorkerStatus.running
    worker.worker_url = worker_url
    worker.registration_key = registration_key
    worker.pod_name = pod_name
    worker.pod_ip = pod_ip
    worker.worker_metadata = metadata or {}
    worker.last_heartbeat_at = now
    worker.registered_at = worker.registered_at or now
    worker.updated_at = now
    session.add(worker)
    session.commit()
    session.refresh(worker)
    return worker


def heartbeat_worker(
    session: Session,
    worker_id: uuid.UUID,
    *,
    worker_url: str | None = None,
    pod_ip: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> Worker | None:
    worker = session.get(Worker, worker_id)
    if worker is None or worker.deleted:
        return None

    worker.status = WorkerStatus.running
    worker.last_heartbeat_at = _utcnow()
    if worker_url:
        worker.worker_url = worker_url
    if pod_ip:
        worker.pod_ip = pod_ip
    if metadata is not None:
        worker.worker_metadata = metadata
    worker.updated_at = _utcnow()
    session.add(worker)
    session.commit()
    session.refresh(worker)
    return worker


def get_worker(session: Session, worker_id: uuid.UUID) -> Worker | None:
    worker = session.get(Worker, worker_id)
    if worker is None or worker.deleted:
        return None
    return worker


def list_workers(session: Session) -> list[Worker]:
    return list(session.exec(Worker.active().order_by(Worker.created_at.asc())).all())


def get_active_lease_for_sandbox(session: Session, sandbox: Sandbox) -> WorkerLease | None:
    if sandbox.current_lease_id is not None:
        lease = session.get(WorkerLease, sandbox.current_lease_id)
        if lease is not None and lease.status == WorkerLeaseStatus.active and not lease.deleted:
            return lease
    return session.exec(
        select(WorkerLease)
        .where(WorkerLease.sandbox_id == sandbox.id)
        .where(WorkerLease.status == WorkerLeaseStatus.active)
        .where(WorkerLease.deleted == False)  # noqa: E712
        .order_by(WorkerLease.created_at.desc())
    ).first()


def get_worker_for_sandbox(session: Session, sandbox: Sandbox | None) -> Worker | None:
    if sandbox is None:
        return None
    lease = get_active_lease_for_sandbox(session, sandbox)
    if lease is not None:
        return get_worker(session, lease.worker_id)
    if sandbox.worker_id is not None:
        return get_worker(session, sandbox.worker_id)
    return None


def _active_worker_ids(session: Session) -> set[uuid.UUID]:
    return {
        lease.worker_id
        for lease in session.exec(
            select(WorkerLease).where(WorkerLease.status == WorkerLeaseStatus.active).where(WorkerLease.deleted == False)  # noqa: E712
        ).all()
    }


def lease_worker_for_sandbox(
    session: Session,
    *,
    workspace_id: uuid.UUID,
    sandbox: Sandbox,
) -> tuple[WorkerLease, Worker]:
    active_worker_ids = _active_worker_ids(session)
    cutoff = _utcnow() - datetime.timedelta(seconds=HEARTBEAT_TIMEOUT_SECONDS)
    candidates = session.exec(
        select(Worker)
        .where(Worker.deleted == False)  # noqa: E712
        .where(Worker.status == WorkerStatus.running)
        .where(Worker.last_heartbeat_at.is_not(None))
        .where(Worker.last_heartbeat_at >= cutoff)
        .order_by(Worker.last_heartbeat_at.desc(), Worker.created_at.asc())
    ).all()

    worker = next((w for w in candidates if w.id not in active_worker_ids and w.worker_url), None)
    if worker is None:
        raise RuntimeError("No healthy idle workers available")

    now = _utcnow()
    lease = WorkerLease(
        workspace_id=workspace_id,
        sandbox_id=sandbox.id,
        worker_id=worker.id,
        status=WorkerLeaseStatus.active,
        leased_at=now,
        heartbeat_expires_at=heartbeat_expiry(now),
    )
    session.add(lease)
    session.flush()

    sandbox.worker_id = worker.id
    sandbox.current_lease_id = lease.id
    sandbox.updated_at = now
    session.add(sandbox)
    session.commit()
    session.refresh(lease)
    session.refresh(worker)
    session.refresh(sandbox)
    return lease, worker


def release_sandbox_lease(
    session: Session,
    sandbox: Sandbox,
    *,
    status: WorkerLeaseStatus = WorkerLeaseStatus.released,
    failure_reason: str | None = None,
) -> None:
    lease = get_active_lease_for_sandbox(session, sandbox)
    if lease is None:
        sandbox.current_lease_id = None
        sandbox.updated_at = _utcnow()
        session.add(sandbox)
        session.commit()
        return

    now = _utcnow()
    lease.status = status
    lease.failure_reason = failure_reason
    lease.released_at = now
    lease.updated_at = now
    sandbox.current_lease_id = None
    sandbox.updated_at = now
    session.add(lease)
    session.add(sandbox)
    session.commit()


def expire_worker_leases(
    session: Session,
    worker: Worker,
    *,
    failure_reason: str = "worker heartbeat expired",
) -> list[WorkerLease]:
    leases = list(
        session.exec(
            select(WorkerLease)
            .where(WorkerLease.worker_id == worker.id)
            .where(WorkerLease.status == WorkerLeaseStatus.active)
            .where(WorkerLease.deleted == False)  # noqa: E712
        ).all()
    )
    now = _utcnow()
    for lease in leases:
        lease.status = WorkerLeaseStatus.failed
        lease.failure_reason = failure_reason
        lease.released_at = now
        lease.updated_at = now
        sandbox = session.get(Sandbox, lease.sandbox_id)
        if sandbox is not None:
            sandbox.current_lease_id = None
            sandbox.updated_at = now
            session.add(sandbox)
        session.add(lease)
    session.commit()
    return leases


def mark_worker_failed(session: Session, worker: Worker, reason: str) -> Worker:
    worker.status = WorkerStatus.failed
    meta = dict(worker.worker_metadata or {})
    meta["failure_reason"] = reason
    worker.worker_metadata = meta
    worker.updated_at = _utcnow()
    session.add(worker)
    session.commit()
    session.refresh(worker)
    return worker
