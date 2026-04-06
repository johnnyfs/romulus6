import uuid

from sqlmodel import Session, select

from app.models.agent import Agent
from app.models.event import Event
from app.models.graph import Graph
from app.models.run import GraphRun
from app.models.sandbox import Sandbox
from app.models.workspace import Workspace
from app.services import workers as worker_svc


def list_workspaces(session: Session) -> list[Workspace]:
    return list(session.exec(Workspace.active()).all())


def create_workspace(session: Session, name: str) -> Workspace:
    workspace = Workspace(name=name)
    session.add(workspace)
    session.commit()
    session.refresh(workspace)
    return workspace


def get_workspace(session: Session, id: uuid.UUID) -> Workspace | None:
    workspace = session.get(Workspace, id)
    if workspace is None or workspace.deleted:
        return None
    return workspace


def delete_workspace(session: Session, id: uuid.UUID) -> bool:
    workspace = session.get(Workspace, id)
    if workspace is None:
        return False

    # Hard-delete events first (they FK → workspace).
    for event in session.exec(select(Event).where(Event.workspace_id == id)).all():
        session.delete(event)
    session.flush()

    # Delete graph runs before agents and sandboxes:
    # graphrunnode.agent_id FK → agent (NO ACTION),
    # graphrun.sandbox_id FK → sandbox (NO ACTION).
    for run in session.exec(select(GraphRun).where(GraphRun.workspace_id == id)).all():
        session.delete(run)
    session.flush()

    # Hard-delete agents (they FK → sandbox).
    for agent in session.exec(select(Agent).where(Agent.workspace_id == id)).all():
        session.delete(agent)
    session.flush()

    # Tear down k8s workers and hard-delete sandboxes.
    for sandbox in session.exec(select(Sandbox).where(Sandbox.workspace_id == id)).all():
        if sandbox.worker_id is not None:
            worker_svc.delete_worker(session, sandbox.worker_id)
        session.delete(sandbox)
        session.commit()

    # Hard-delete graphs; ORM cascade (all, delete-orphan) handles nodes + edges.
    for graph in session.exec(select(Graph).where(Graph.workspace_id == id)).all():
        session.delete(graph)
    session.flush()

    session.delete(workspace)
    session.commit()
    return True
