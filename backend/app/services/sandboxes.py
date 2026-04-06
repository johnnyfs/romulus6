import datetime
import uuid

from sqlmodel import Session

from app.models.sandbox import Sandbox
from app.models.worker import Worker
from app.services import workers as worker_svc


def list_sandboxes(session: Session, workspace_id: uuid.UUID) -> list[Sandbox]:
    return list(
        session.exec(Sandbox.active().where(Sandbox.workspace_id == workspace_id)).all()
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

    _, worker = worker_svc.lease_worker_for_sandbox(
        session,
        workspace_id=workspace_id,
        sandbox=sandbox,
    )
    return sandbox, worker


def delete_sandbox(
    session: Session, workspace_id: uuid.UUID, sandbox_id: uuid.UUID
) -> bool:
    sandbox = get_sandbox(session, workspace_id, sandbox_id)
    if sandbox is None:
        return False

    worker_svc.release_sandbox_lease(session, sandbox)

    sandbox.deleted = True
    sandbox.worker_id = None
    sandbox.current_lease_id = None
    sandbox.updated_at = datetime.datetime.utcnow()
    session.add(sandbox)
    session.commit()
    return True
