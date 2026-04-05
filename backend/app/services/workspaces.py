import uuid

from sqlmodel import Session, select

from app.models.workspace import Workspace


def list_workspaces(session: Session) -> list[Workspace]:
    return list(session.exec(select(Workspace)).all())


def create_workspace(session: Session, name: str) -> Workspace:
    workspace = Workspace(name=name)
    session.add(workspace)
    session.commit()
    session.refresh(workspace)
    return workspace


def delete_workspace(session: Session, id: uuid.UUID) -> bool:
    workspace = session.get(Workspace, id)
    if workspace is None:
        return False
    session.delete(workspace)
    session.commit()
    return True
