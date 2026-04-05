import datetime
import uuid

from sqlmodel import Session, select

from app.models.sandbox import Sandbox
from app.models.worker import Worker
from app.services import workers as worker_svc


def list_sandboxes(session: Session, workspace_id: uuid.UUID) -> list[Sandbox]:
    return list(
        session.exec(select(Sandbox).where(Sandbox.workspace_id == workspace_id)).all()
    )


def get_sandbox(
    session: Session, workspace_id: uuid.UUID, sandbox_id: uuid.UUID
) -> Sandbox | None:
    sandbox = session.get(Sandbox, sandbox_id)
    if sandbox is None or sandbox.workspace_id != workspace_id:
        return None
    return sandbox


def create_sandbox(
    session: Session, workspace_id: uuid.UUID, name: str
) -> tuple[Sandbox, Worker]:
    sandbox = Sandbox(workspace_id=workspace_id, name=name)
    session.add(sandbox)
    session.commit()
    session.refresh(sandbox)

    worker = worker_svc.create_worker(session)

    sandbox.worker_id = worker.id
    sandbox.updated_at = datetime.datetime.utcnow()
    session.add(sandbox)
    session.commit()
    session.refresh(sandbox)

    return sandbox, worker


def delete_sandbox(
    session: Session, workspace_id: uuid.UUID, sandbox_id: uuid.UUID
) -> bool:
    sandbox = get_sandbox(session, workspace_id, sandbox_id)
    if sandbox is None:
        return False

    if sandbox.worker_id is not None:
        worker_svc.delete_worker(session, sandbox.worker_id)

    session.delete(sandbox)
    session.commit()
    return True
