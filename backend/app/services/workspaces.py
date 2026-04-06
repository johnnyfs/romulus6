import uuid

from sqlmodel import Session, select

from app.models.agent import Agent
from app.models.event import Event
from app.models.graph import Graph
from app.models.lease import WorkerLease
from app.models.reconcile import RunReconcile
from app.models.run import GraphRun, GraphRunNode
from app.models.sandbox import Sandbox
from app.models.template import SubgraphTemplate, SubgraphTemplateNode, TaskTemplate
from app.models.workspace import Workspace
from app.services import workers as worker_svc


def _run_delete_depth(run_by_id: dict[uuid.UUID, GraphRun], run: GraphRun) -> int:
    depth = 0
    current = run
    seen: set[uuid.UUID] = set()
    while current.parent_run_node_id is not None and current.id not in seen:
        seen.add(current.id)
        parent_node = next(
            (node for candidate in run_by_id.values() for node in candidate.run_nodes if node.id == current.parent_run_node_id),
            None,
        )
        if parent_node is None:
            break
        parent_run = run_by_id.get(parent_node.run_id)
        if parent_run is None:
            break
        depth += 1
        current = parent_run
    return depth


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

    # Hard-delete controller queue rows before runs they reference.
    for reconcile in session.exec(
        select(RunReconcile).join(GraphRun, RunReconcile.run_id == GraphRun.id).where(GraphRun.workspace_id == id)
    ).all():
        session.delete(reconcile)
    session.flush()

    # Delete graph runs before agents and sandboxes:
    # graphrunnode.agent_id FK → agent (NO ACTION),
    # graphrun.sandbox_id FK → sandbox (NO ACTION).
    runs = list(session.exec(select(GraphRun).where(GraphRun.workspace_id == id)).all())
    run_ids = [run.id for run in runs]
    run_nodes = list(
        session.exec(select(GraphRunNode).where(GraphRunNode.run_id.in_(run_ids))).all()
    ) if run_ids else []

    for node in run_nodes:
        if node.child_run_id is not None:
            node.child_run_id = None
            session.add(node)
    for run in runs:
        if run.parent_run_node_id is not None:
            run.parent_run_node_id = None
            session.add(run)
    session.flush()

    run_by_id = {run.id: run for run in runs}
    for run in sorted(runs, key=lambda candidate: _run_delete_depth(run_by_id, candidate), reverse=True):
        session.delete(run)
    session.flush()

    # Hard-delete agents (they FK → sandbox).
    for agent in session.exec(select(Agent).where(Agent.workspace_id == id)).all():
        session.delete(agent)
    session.flush()

    # Release and then hard-delete lease rows before sandboxes.
    for sandbox in session.exec(select(Sandbox).where(Sandbox.workspace_id == id)).all():
        worker_svc.release_sandbox_lease(session, sandbox)
    session.flush()
    for lease in session.exec(select(WorkerLease).where(WorkerLease.workspace_id == id)).all():
        session.delete(lease)
    session.flush()

    # Hard-delete sandboxes once lease rows are gone.
    for sandbox in session.exec(select(Sandbox).where(Sandbox.workspace_id == id)).all():
        session.delete(sandbox)
    session.flush()

    # Hard-delete graphs; ORM cascade (all, delete-orphan) handles nodes + edges.
    for graph in session.exec(select(Graph).where(Graph.workspace_id == id)).all():
        session.delete(graph)
    session.flush()

    # Hard-delete templates and their children before deleting the workspace.
    for template_node in session.exec(
        select(SubgraphTemplateNode)
        .join(SubgraphTemplate, SubgraphTemplateNode.subgraph_template_id == SubgraphTemplate.id)
        .where(SubgraphTemplate.workspace_id == id)
    ).all():
        if template_node.task_template_id is not None:
            template_node.task_template_id = None
        if template_node.ref_subgraph_template_id is not None:
            template_node.ref_subgraph_template_id = None
        session.add(template_node)
    session.flush()

    for subgraph_template in session.exec(select(SubgraphTemplate).where(SubgraphTemplate.workspace_id == id)).all():
        session.delete(subgraph_template)
    for task_template in session.exec(select(TaskTemplate).where(TaskTemplate.workspace_id == id)).all():
        session.delete(task_template)
    session.flush()

    session.delete(workspace)
    session.commit()
    return True
