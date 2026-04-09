import uuid

from sqlmodel import Session

from app.models.template import SubgraphTemplate, TaskTemplate


def require_workspace_task_template(
    session: Session,
    workspace_id: uuid.UUID,
    template_id: uuid.UUID | None,
) -> TaskTemplate:
    if template_id is None:
        raise ValueError("task template reference is required")
    template = session.get(TaskTemplate, template_id)
    if template is None or template.deleted:
        raise ValueError(f"task template {template_id} not found or deleted")
    if template.workspace_id != workspace_id:
        raise ValueError(
            f"task template {template_id} does not belong to workspace {workspace_id}"
        )
    return template


def require_workspace_subgraph_template(
    session: Session,
    workspace_id: uuid.UUID,
    template_id: uuid.UUID | None,
) -> SubgraphTemplate:
    if template_id is None:
        raise ValueError("subgraph template reference is required")
    template = session.get(SubgraphTemplate, template_id)
    if template is None or template.deleted:
        raise ValueError(f"subgraph template {template_id} not found or deleted")
    if template.workspace_id != workspace_id:
        raise ValueError(
            f"subgraph template {template_id} does not belong to workspace {workspace_id}"
        )
    return template


def validate_workspace_template_refs(
    session: Session,
    workspace_id: uuid.UUID,
    *,
    task_template_id: uuid.UUID | None = None,
    subgraph_template_id: uuid.UUID | None = None,
    ref_subgraph_template_id: uuid.UUID | None = None,
) -> None:
    if task_template_id is not None:
        require_workspace_task_template(session, workspace_id, task_template_id)
    if subgraph_template_id is not None:
        require_workspace_subgraph_template(session, workspace_id, subgraph_template_id)
    if ref_subgraph_template_id is not None:
        require_workspace_subgraph_template(
            session,
            workspace_id,
            ref_subgraph_template_id,
        )
