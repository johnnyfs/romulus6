import uuid

from sqlmodel import Session, select

from app.models.agent import Agent
from app.models.graph import Graph
from app.models.sandbox import Sandbox
from app.models.workspace import Workspace
from app.services import sandboxes as sandbox_svc


def list_workspaces(session: Session) -> list[Workspace]:
    return list(session.exec(select(Workspace)).all())


def create_workspace(session: Session, name: str) -> Workspace:
    workspace = Workspace(name=name)
    session.add(workspace)
    session.commit()
    session.refresh(workspace)
    return workspace


def get_workspace(session: Session, id: uuid.UUID) -> Workspace | None:
    return session.get(Workspace, id)


def delete_workspace(session: Session, id: uuid.UUID) -> bool:
    workspace = session.get(Workspace, id)
    if workspace is None:
        return False

    # Agents FK → sandbox, so delete them before sandboxes
    for agent in session.exec(select(Agent).where(Agent.workspace_id == id)).all():
        session.delete(agent)
    session.flush()

    # Sandboxes tear down k8s workers synchronously; delete_sandbox commits internally
    for sandbox in session.exec(select(Sandbox).where(Sandbox.workspace_id == id)).all():
        sandbox_svc.delete_sandbox(session, id, sandbox.id)

    # Graphs: DB cascades nodes + edges
    for graph in session.exec(select(Graph).where(Graph.workspace_id == id)).all():
        session.delete(graph)
    session.flush()

    session.delete(workspace)
    session.commit()
    return True
