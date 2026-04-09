from dataclasses import dataclass
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


@dataclass(frozen=True)
class _WorkspaceDeletionContext:
    session: Session
    workspace_id: uuid.UUID


def _run_delete_depth(
    run_by_id: dict[uuid.UUID, GraphRun],
    node_by_id: dict[uuid.UUID, GraphRunNode],
    run: GraphRun,
) -> int:
    depth = 0
    current = run
    seen: set[uuid.UUID] = set()
    while current.parent_run_node_id is not None and current.id not in seen:
        seen.add(current.id)
        parent_node = node_by_id.get(current.parent_run_node_id)
        if parent_node is None:
            break
        parent_run = run_by_id.get(parent_node.run_id)
        if parent_run is None:
            break
        depth += 1
        current = parent_run
    return depth


def _clear_run_delete_links(session: Session, runs: list[GraphRun], run_nodes: list[GraphRunNode]) -> None:
    for node in run_nodes:
        changed = False
        if node.child_run_id is not None:
            node.child_run_id = None
            changed = True
        if node.retry_of_run_node_id is not None:
            node.retry_of_run_node_id = None
            changed = True
        if node.next_attempt_run_node_id is not None:
            node.next_attempt_run_node_id = None
            changed = True
        if changed:
            session.add(node)

    for run in runs:
        if run.parent_run_node_id is not None:
            run.parent_run_node_id = None
            session.add(run)

    session.flush()


def _delete_workspace_events(ctx: _WorkspaceDeletionContext) -> None:
    for event in ctx.session.exec(
        select(Event).where(Event.workspace_id == ctx.workspace_id)
    ).all():
        ctx.session.delete(event)
    ctx.session.flush()


def _delete_workspace_reconcile_rows(ctx: _WorkspaceDeletionContext) -> None:
    for reconcile in ctx.session.exec(
        select(RunReconcile)
        .join(GraphRun, RunReconcile.run_id == GraphRun.id)
        .where(GraphRun.workspace_id == ctx.workspace_id)
    ).all():
        ctx.session.delete(reconcile)
    ctx.session.flush()


def _delete_workspace_runs(ctx: _WorkspaceDeletionContext) -> None:
    runs = list(
        ctx.session.exec(
            select(GraphRun).where(GraphRun.workspace_id == ctx.workspace_id)
        ).all()
    )
    run_ids = [run.id for run in runs]
    run_nodes = (
        list(
            ctx.session.exec(
                select(GraphRunNode).where(GraphRunNode.run_id.in_(run_ids))
            ).all()
        )
        if run_ids
        else []
    )

    _clear_run_delete_links(ctx.session, runs, run_nodes)

    run_by_id = {run.id: run for run in runs}
    node_by_id = {node.id: node for node in run_nodes}
    for run in sorted(
        runs,
        key=lambda candidate: _run_delete_depth(run_by_id, node_by_id, candidate),
        reverse=True,
    ):
        ctx.session.delete(run)
    ctx.session.flush()


def _delete_workspace_agents(ctx: _WorkspaceDeletionContext) -> None:
    for agent in ctx.session.exec(
        select(Agent).where(Agent.workspace_id == ctx.workspace_id)
    ).all():
        ctx.session.delete(agent)
    ctx.session.flush()


def _release_workspace_sandbox_leases(ctx: _WorkspaceDeletionContext) -> None:
    for sandbox in ctx.session.exec(
        select(Sandbox).where(Sandbox.workspace_id == ctx.workspace_id)
    ).all():
        worker_svc.release_sandbox_lease(ctx.session, sandbox)
    ctx.session.flush()


def _delete_workspace_leases(ctx: _WorkspaceDeletionContext) -> None:
    for lease in ctx.session.exec(
        select(WorkerLease).where(WorkerLease.workspace_id == ctx.workspace_id)
    ).all():
        ctx.session.delete(lease)
    ctx.session.flush()


def _delete_workspace_sandboxes(ctx: _WorkspaceDeletionContext) -> None:
    for sandbox in ctx.session.exec(
        select(Sandbox).where(Sandbox.workspace_id == ctx.workspace_id)
    ).all():
        ctx.session.delete(sandbox)
    ctx.session.flush()


def _delete_workspace_graphs(ctx: _WorkspaceDeletionContext) -> None:
    for graph in ctx.session.exec(
        select(Graph).where(Graph.workspace_id == ctx.workspace_id)
    ).all():
        ctx.session.delete(graph)
    ctx.session.flush()


def _clear_workspace_template_refs(ctx: _WorkspaceDeletionContext) -> None:
    for template_node in ctx.session.exec(
        select(SubgraphTemplateNode)
        .join(
            SubgraphTemplate,
            SubgraphTemplateNode.subgraph_template_id == SubgraphTemplate.id,
        )
        .where(SubgraphTemplate.workspace_id == ctx.workspace_id)
    ).all():
        if template_node.task_template_id is not None:
            template_node.task_template_id = None
        if template_node.ref_subgraph_template_id is not None:
            template_node.ref_subgraph_template_id = None
        ctx.session.add(template_node)
    ctx.session.flush()


def _delete_workspace_templates(ctx: _WorkspaceDeletionContext) -> None:
    _clear_workspace_template_refs(ctx)
    for subgraph_template in ctx.session.exec(
        select(SubgraphTemplate).where(SubgraphTemplate.workspace_id == ctx.workspace_id)
    ).all():
        ctx.session.delete(subgraph_template)
    for task_template in ctx.session.exec(
        select(TaskTemplate).where(TaskTemplate.workspace_id == ctx.workspace_id)
    ).all():
        ctx.session.delete(task_template)
    ctx.session.flush()


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

    ctx = _WorkspaceDeletionContext(session=session, workspace_id=id)

    _delete_workspace_events(ctx)
    _delete_workspace_reconcile_rows(ctx)
    _delete_workspace_runs(ctx)
    _delete_workspace_agents(ctx)
    _release_workspace_sandbox_leases(ctx)
    _delete_workspace_leases(ctx)
    _delete_workspace_sandboxes(ctx)
    _delete_workspace_graphs(ctx)
    _delete_workspace_templates(ctx)

    session.delete(workspace)
    session.commit()
    return True
