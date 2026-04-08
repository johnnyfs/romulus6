import datetime
import json
import uuid
from dataclasses import dataclass
from typing import Optional

from sqlmodel import Session, select

from app.models.graph import NodeType
from app.models.template import (
    SubgraphTemplate,
    SubgraphTemplateArgument,
    SubgraphTemplateEdge,
    SubgraphTemplateNode,
    SubgraphTemplateNodeType,
    TaskTemplate,
    TaskTemplateArgument,
    TemplateArgType,
)
from app.services.graphs import _has_cycle
from app.services.node_references import (
    require_workspace_subgraph_template,
    validate_workspace_template_refs,
)
from app.services.node_shapes import (
    UNSET,
    normalized_node_field_values,
    validate_task_template_type,
)
from app.utils.output_schema import validate_output_schema_definition

# ── Data classes ─────────────────────────────────────────────────────────────


@dataclass
class ArgumentInput:
    name: str
    arg_type: TemplateArgType = TemplateArgType.string
    default_value: Optional[str] = None
    model_constraint: Optional[list[str]] = None
    min_value: Optional[float] = None
    max_value: Optional[float] = None
    enum_options: Optional[list[str]] = None


@dataclass
class SubgraphNodeInput:
    node_type: SubgraphTemplateNodeType
    name: Optional[str] = None
    # For agent/command inline nodes
    agent_type: Optional[str] = None
    model: Optional[str] = None
    prompt: Optional[str] = None
    command: Optional[str] = None
    graph_tools: bool = False
    # For task_template/subgraph_template reference nodes
    task_template_id: Optional[uuid.UUID] = None
    ref_subgraph_template_id: Optional[uuid.UUID] = None
    argument_bindings: Optional[dict[str, str]] = None
    output_schema: Optional[dict[str, str]] = None
    images: Optional[list[dict]] = None


@dataclass
class SubgraphEdgeInput:
    from_index: int
    to_index: int


# ── Helpers ──────────────────────────────────────────────────────────────────


def _validate_no_cycle_by_index(node_count: int, edges: list[SubgraphEdgeInput]) -> None:
    node_ids = [uuid.uuid4() for _ in range(node_count)]
    edge_pairs = [(node_ids[e.from_index], node_ids[e.to_index]) for e in edges]
    if _has_cycle(node_ids, edge_pairs):
        raise ValueError("cycle detected")


def _has_subgraph_cycle(
    session: Session,
    template_id: uuid.UUID,
    referenced_ids: list[uuid.UUID],
) -> bool:
    """Check if referencing any of the given subgraph template IDs from
    template_id would create a recursive containment cycle."""
    visited: set[uuid.UUID] = set()
    stack = list(referenced_ids)

    while stack:
        current = stack.pop()
        if current == template_id:
            return True
        if current in visited:
            continue
        visited.add(current)

        nodes = session.exec(
            select(SubgraphTemplateNode).where(
                SubgraphTemplateNode.subgraph_template_id == current,
                SubgraphTemplateNode.node_type == SubgraphTemplateNodeType.subgraph_template,
                SubgraphTemplateNode.deleted == False,  # noqa: E712
            )
        ).all()
        for node in nodes:
            if node.ref_subgraph_template_id:
                stack.append(node.ref_subgraph_template_id)

    return False


def _build_subgraph_node(
    tmpl_id: uuid.UUID, node_input: SubgraphNodeInput
) -> SubgraphTemplateNode:
    """Build a SubgraphTemplateNode from input, including inline agent/command fields."""
    validate_output_schema_definition(node_input.output_schema)
    return SubgraphTemplateNode(
        subgraph_template_id=tmpl_id,
        node_type=node_input.node_type,
        name=node_input.name,
        agent_type=node_input.agent_type,
        model=node_input.model,
        prompt=node_input.prompt,
        command=node_input.command,
        graph_tools=node_input.graph_tools,
        task_template_id=node_input.task_template_id,
        ref_subgraph_template_id=node_input.ref_subgraph_template_id,
        argument_bindings=node_input.argument_bindings,
        output_schema=node_input.output_schema,
        images=node_input.images,
    )


def _validate_subgraph_node_refs(
    session: Session,
    workspace_id: uuid.UUID,
    node_input: SubgraphNodeInput,
) -> None:
    validate_workspace_template_refs(
        session,
        workspace_id,
        task_template_id=node_input.task_template_id,
        ref_subgraph_template_id=node_input.ref_subgraph_template_id,
    )


def _validate_arguments(arguments: list[ArgumentInput]) -> None:
    for arg in arguments:
        if arg.arg_type == TemplateArgType.boolean:
            if arg.model_constraint is not None:
                raise ValueError(f"boolean argument '{arg.name}' cannot have model_constraint")
            if arg.default_value is not None and arg.default_value not in ("true", "false"):
                raise ValueError(
                    f"boolean argument '{arg.name}' default_value must be 'true' or 'false'"
                )
        elif arg.arg_type == TemplateArgType.number:
            if arg.model_constraint is not None:
                raise ValueError(f"number argument '{arg.name}' cannot have model_constraint")
            if arg.enum_options is not None:
                raise ValueError(f"number argument '{arg.name}' cannot have enum_options")
            if arg.min_value is not None and arg.max_value is not None:
                if arg.min_value > arg.max_value:
                    raise ValueError(
                        f"number argument '{arg.name}' min_value must be <= max_value"
                    )
            if arg.default_value is not None:
                try:
                    val = float(arg.default_value)
                except ValueError:
                    raise ValueError(
                        f"number argument '{arg.name}' default_value must be a valid number"
                    )
                if arg.min_value is not None and val < arg.min_value:
                    raise ValueError(
                        f"number argument '{arg.name}' default_value is below min_value"
                    )
                if arg.max_value is not None and val > arg.max_value:
                    raise ValueError(
                        f"number argument '{arg.name}' default_value is above max_value"
                    )
        elif arg.arg_type == TemplateArgType.enum:
            if arg.model_constraint is not None:
                raise ValueError(f"enum argument '{arg.name}' cannot have model_constraint")
            if arg.min_value is not None or arg.max_value is not None:
                raise ValueError(f"enum argument '{arg.name}' cannot have min/max_value")
            if not arg.enum_options:
                raise ValueError(f"enum argument '{arg.name}' must have enum_options")
            if arg.default_value is not None and arg.default_value not in arg.enum_options:
                raise ValueError(
                    f"enum argument '{arg.name}' default_value must be one of the enum_options"
                )


def _create_arguments(
    session: Session,
    arguments: list[ArgumentInput],
    *,
    task_template_id: Optional[uuid.UUID] = None,
    subgraph_template_id: Optional[uuid.UUID] = None,
) -> None:
    _validate_arguments(arguments)
    for arg_input in arguments:
        constraint_json = (
            json.dumps(arg_input.model_constraint)
            if arg_input.model_constraint
            else None
        )
        enum_options_json = (
            json.dumps(arg_input.enum_options)
            if arg_input.enum_options
            else None
        )
        min_val_str = str(arg_input.min_value) if arg_input.min_value is not None else None
        max_val_str = str(arg_input.max_value) if arg_input.max_value is not None else None
        if task_template_id is not None:
            session.add(TaskTemplateArgument(
                task_template_id=task_template_id,
                name=arg_input.name,
                arg_type=arg_input.arg_type,
                default_value=arg_input.default_value,
                model_constraint=constraint_json,
                min_value=min_val_str,
                max_value=max_val_str,
                enum_options=enum_options_json,
            ))
        elif subgraph_template_id is not None:
            session.add(SubgraphTemplateArgument(
                subgraph_template_id=subgraph_template_id,
                name=arg_input.name,
                arg_type=arg_input.arg_type,
                default_value=arg_input.default_value,
                model_constraint=constraint_json,
                min_value=min_val_str,
                max_value=max_val_str,
                enum_options=enum_options_json,
            ))


# ── Task Template CRUD ───────────────────────────────────────────────────────


def create_task_template(
    session: Session,
    workspace_id: uuid.UUID,
    name: str,
    task_type: NodeType,
    agent_type: Optional[str] = None,
    model: Optional[str] = None,
    prompt: Optional[str] = None,
    command: Optional[str] = None,
    graph_tools: bool = False,
    label: Optional[str] = None,
    arguments: Optional[list[ArgumentInput]] = None,
    output_schema: Optional[dict[str, str]] = None,
    images: Optional[list[dict]] = None,
) -> TaskTemplate:
    validate_task_template_type(task_type)
    validate_output_schema_definition(output_schema)
    tmpl = TaskTemplate(
        workspace_id=workspace_id,
        name=name,
        task_type=task_type,
        agent_type=agent_type,
        model=model,
        prompt=prompt,
        command=command,
        graph_tools=graph_tools,
        label=label,
        output_schema=output_schema,
        images=images,
    )
    session.add(tmpl)
    session.flush()

    if arguments:
        _create_arguments(session, arguments, task_template_id=tmpl.id)

    session.commit()
    session.refresh(tmpl)
    return tmpl


def list_task_templates(
    session: Session, workspace_id: uuid.UUID
) -> list[TaskTemplate]:
    return list(
        session.exec(
            TaskTemplate.active().where(TaskTemplate.workspace_id == workspace_id)
        ).all()
    )


def get_task_template(
    session: Session, workspace_id: uuid.UUID, template_id: uuid.UUID
) -> Optional[TaskTemplate]:
    tmpl = session.get(TaskTemplate, template_id)
    if tmpl is None or tmpl.workspace_id != workspace_id or tmpl.deleted:
        return None
    return tmpl


def update_task_template(
    session: Session,
    tmpl: TaskTemplate,
    name: str,
    task_type: NodeType,
    agent_type: Optional[str] = None,
    model: Optional[str] = None,
    prompt: Optional[str] = None,
    command: Optional[str] = None,
    graph_tools: bool = False,
    label: Optional[str] = None,
    arguments: Optional[list[ArgumentInput]] = None,
    output_schema: Optional[dict[str, str]] = None,
    images: Optional[list[dict]] = None,
) -> TaskTemplate:
    validate_task_template_type(task_type)
    # Delete existing arguments
    existing_args = session.exec(
        select(TaskTemplateArgument).where(
            TaskTemplateArgument.task_template_id == tmpl.id
        )
    ).all()
    for arg in existing_args:
        session.delete(arg)
    session.flush()

    validate_output_schema_definition(output_schema)
    tmpl.name = name
    tmpl.task_type = task_type
    tmpl.agent_type = agent_type
    tmpl.model = model
    tmpl.prompt = prompt
    tmpl.command = command
    tmpl.graph_tools = graph_tools
    tmpl.label = label
    tmpl.output_schema = output_schema
    tmpl.images = images
    tmpl.updated_at = datetime.datetime.utcnow()
    session.add(tmpl)
    session.flush()

    if arguments:
        _create_arguments(session, arguments, task_template_id=tmpl.id)

    session.commit()
    session.refresh(tmpl)
    return tmpl


def delete_task_template(
    session: Session, workspace_id: uuid.UUID, template_id: uuid.UUID
) -> bool:
    tmpl = get_task_template(session, workspace_id, template_id)
    if tmpl is None:
        return False
    now = datetime.datetime.utcnow()
    for arg in session.exec(
        select(TaskTemplateArgument).where(
            TaskTemplateArgument.task_template_id == tmpl.id
        )
    ).all():
        arg.deleted = True
        arg.updated_at = now
        session.add(arg)
    tmpl.deleted = True
    tmpl.updated_at = now
    session.add(tmpl)
    session.commit()
    return True


# ── Subgraph Template CRUD ───────────────────────────────────────────────────


def create_subgraph_template(
    session: Session,
    workspace_id: uuid.UUID,
    name: str,
    nodes: Optional[list[SubgraphNodeInput]] = None,
    edges: Optional[list[SubgraphEdgeInput]] = None,
    arguments: Optional[list[ArgumentInput]] = None,
    label: Optional[str] = None,
    output_schema: Optional[dict[str, str]] = None,
) -> SubgraphTemplate:
    nodes = nodes or []
    edges = edges or []

    _validate_no_cycle_by_index(len(nodes), edges)
    validate_output_schema_definition(output_schema)

    tmpl = SubgraphTemplate(
        workspace_id=workspace_id,
        name=name,
        label=label,
        output_schema=output_schema,
    )
    session.add(tmpl)
    session.flush()

    # Check for recursive subgraph references
    ref_ids = [
        n.ref_subgraph_template_id
        for n in nodes
        if n.node_type == SubgraphTemplateNodeType.subgraph_template
        and n.ref_subgraph_template_id is not None
    ]
    if _has_subgraph_cycle(session, tmpl.id, ref_ids):
        raise ValueError("recursive subgraph template detected")

    db_nodes = []
    for node_input in nodes:
        _validate_subgraph_node_refs(session, workspace_id, node_input)
        node = _build_subgraph_node(tmpl.id, node_input)
        session.add(node)
        db_nodes.append(node)
    session.flush()

    for edge_input in edges:
        session.add(SubgraphTemplateEdge(
            subgraph_template_id=tmpl.id,
            from_node_id=db_nodes[edge_input.from_index].id,
            to_node_id=db_nodes[edge_input.to_index].id,
        ))

    if arguments:
        _create_arguments(session, arguments, subgraph_template_id=tmpl.id)

    session.commit()
    session.refresh(tmpl)
    return tmpl


def list_subgraph_templates(
    session: Session, workspace_id: uuid.UUID
) -> list[SubgraphTemplate]:
    return list(
        session.exec(
            SubgraphTemplate.active().where(
                SubgraphTemplate.workspace_id == workspace_id
            )
        ).all()
    )


def get_subgraph_template(
    session: Session, workspace_id: uuid.UUID, template_id: uuid.UUID
) -> Optional[SubgraphTemplate]:
    tmpl = session.get(SubgraphTemplate, template_id)
    if tmpl is None or tmpl.workspace_id != workspace_id or tmpl.deleted:
        return None
    return tmpl


def update_subgraph_template(
    session: Session,
    tmpl: SubgraphTemplate,
    name: str,
    nodes: Optional[list[SubgraphNodeInput]] = None,
    edges: Optional[list[SubgraphEdgeInput]] = None,
    arguments: Optional[list[ArgumentInput]] = None,
    label: Optional[str] = None,
    output_schema: Optional[dict[str, str]] = None,
) -> SubgraphTemplate:
    nodes = nodes or []
    edges = edges or []

    _validate_no_cycle_by_index(len(nodes), edges)
    validate_output_schema_definition(output_schema)

    # Check for recursive subgraph references
    ref_ids = [
        n.ref_subgraph_template_id
        for n in nodes
        if n.node_type == SubgraphTemplateNodeType.subgraph_template
        and n.ref_subgraph_template_id is not None
    ]
    if _has_subgraph_cycle(session, tmpl.id, ref_ids):
        raise ValueError("recursive subgraph template detected")

    # Delete existing edges first
    for edge in session.exec(
        select(SubgraphTemplateEdge).where(
            SubgraphTemplateEdge.subgraph_template_id == tmpl.id
        )
    ).all():
        session.delete(edge)
    session.flush()

    for node in session.exec(
        select(SubgraphTemplateNode).where(
            SubgraphTemplateNode.subgraph_template_id == tmpl.id
        )
    ).all():
        session.delete(node)
    session.flush()

    for arg in session.exec(
        select(SubgraphTemplateArgument).where(
            SubgraphTemplateArgument.subgraph_template_id == tmpl.id
        )
    ).all():
        session.delete(arg)
    session.flush()

    db_nodes = []
    for node_input in nodes:
        _validate_subgraph_node_refs(session, tmpl.workspace_id, node_input)
        node = _build_subgraph_node(tmpl.id, node_input)
        session.add(node)
        db_nodes.append(node)
    session.flush()

    for edge_input in edges:
        session.add(SubgraphTemplateEdge(
            subgraph_template_id=tmpl.id,
            from_node_id=db_nodes[edge_input.from_index].id,
            to_node_id=db_nodes[edge_input.to_index].id,
        ))

    if arguments:
        _create_arguments(session, arguments, subgraph_template_id=tmpl.id)

    tmpl.name = name
    tmpl.label = label
    tmpl.output_schema = output_schema
    tmpl.updated_at = datetime.datetime.utcnow()
    session.add(tmpl)
    session.commit()
    session.refresh(tmpl)
    return tmpl


def delete_subgraph_template(
    session: Session, workspace_id: uuid.UUID, template_id: uuid.UUID
) -> bool:
    tmpl = get_subgraph_template(session, workspace_id, template_id)
    if tmpl is None:
        return False
    now = datetime.datetime.utcnow()
    for edge in session.exec(
        select(SubgraphTemplateEdge).where(
            SubgraphTemplateEdge.subgraph_template_id == tmpl.id
        )
    ).all():
        edge.deleted = True
        edge.updated_at = now
        session.add(edge)
    for node in session.exec(
        select(SubgraphTemplateNode).where(
            SubgraphTemplateNode.subgraph_template_id == tmpl.id
        )
    ).all():
        node.deleted = True
        node.updated_at = now
        session.add(node)
    for arg in session.exec(
        select(SubgraphTemplateArgument).where(
            SubgraphTemplateArgument.subgraph_template_id == tmpl.id
        )
    ).all():
        arg.deleted = True
        arg.updated_at = now
        session.add(arg)
    tmpl.deleted = True
    tmpl.updated_at = now
    session.add(tmpl)
    session.commit()
    return True


# ── Subgraph Template Node sub-resource ──────────────────────────────────────


def add_subgraph_template_node(
    session: Session,
    tmpl: SubgraphTemplate,
    node_type: SubgraphTemplateNodeType,
    name: Optional[str] = None,
    agent_type: Optional[str] = None,
    model: Optional[str] = None,
    prompt: Optional[str] = None,
    command: Optional[str] = None,
    graph_tools: bool = False,
    task_template_id: Optional[uuid.UUID] = None,
    ref_subgraph_template_id: Optional[uuid.UUID] = None,
    argument_bindings: Optional[dict[str, str]] = None,
    output_schema: Optional[dict[str, str]] = None,
    images: Optional[list[dict]] = None,
) -> SubgraphTemplateNode:
    if (
        node_type == SubgraphTemplateNodeType.subgraph_template
        and ref_subgraph_template_id is not None
    ):
        require_workspace_subgraph_template(
            session,
            tmpl.workspace_id,
            ref_subgraph_template_id,
        )
        if _has_subgraph_cycle(session, tmpl.id, [ref_subgraph_template_id]):
            raise ValueError("recursive subgraph template detected")

    validate_workspace_template_refs(
        session,
        tmpl.workspace_id,
        task_template_id=task_template_id,
        ref_subgraph_template_id=ref_subgraph_template_id,
    )

    validate_output_schema_definition(output_schema)
    normalized = normalized_node_field_values(
        node_type,
        subgraph_ref_field="ref_subgraph_template_id",
        agent_type=agent_type,
        model=model,
        prompt=prompt,
        command=command,
        graph_tools=graph_tools,
        task_template_id=task_template_id,
        ref_subgraph_template_id=ref_subgraph_template_id,
        argument_bindings=argument_bindings,
        images=images,
    )
    node = SubgraphTemplateNode(
        subgraph_template_id=tmpl.id,
        node_type=node_type,
        name=name,
        agent_type=normalized["agent_type"],
        model=normalized["model"],
        prompt=normalized["prompt"],
        command=normalized["command"],
        graph_tools=normalized["graph_tools"],
        task_template_id=normalized["task_template_id"],
        ref_subgraph_template_id=normalized["ref_subgraph_template_id"],
        argument_bindings=normalized["argument_bindings"],
        output_schema=output_schema,
        images=normalized["images"],
    )
    session.add(node)
    session.commit()
    session.refresh(node)
    return node


def patch_subgraph_template_node(
    session: Session,
    tmpl: SubgraphTemplate,
    node_id: uuid.UUID,
    name: Optional[str] = None,
    node_type: Optional[SubgraphTemplateNodeType] = None,
    agent_type: Optional[str] = None,
    model: Optional[str] = None,
    prompt: Optional[str] = None,
    command: Optional[str] = None,
    graph_tools: Optional[bool] = None,
    task_template_id: Optional[uuid.UUID] = None,
    ref_subgraph_template_id: Optional[uuid.UUID] = None,
    argument_bindings: Optional[dict[str, str]] = None,
    output_schema: Optional[dict[str, str]] = None,
    images: Optional[list[dict]] = None,
) -> Optional[SubgraphTemplateNode]:
    node = session.get(SubgraphTemplateNode, node_id)
    if node is None or node.subgraph_template_id != tmpl.id:
        return None

    effective_type = node_type if node_type is not None else node.node_type
    effective_ref = (
        ref_subgraph_template_id
        if ref_subgraph_template_id is not None
        else node.ref_subgraph_template_id
    )
    if (
        effective_type == SubgraphTemplateNodeType.subgraph_template
        and effective_ref is not None
    ):
        require_workspace_subgraph_template(
            session,
            tmpl.workspace_id,
            effective_ref,
        )
        if _has_subgraph_cycle(session, tmpl.id, [effective_ref]):
            raise ValueError("recursive subgraph template detected")

    effective_task_template_id = (
        task_template_id
        if task_template_id is not UNSET
        else node.task_template_id
    )
    if effective_type == SubgraphTemplateNodeType.task_template:
        validate_workspace_template_refs(
            session,
            tmpl.workspace_id,
            task_template_id=effective_task_template_id,
        )
    elif effective_type == SubgraphTemplateNodeType.subgraph_template:
        validate_workspace_template_refs(
            session,
            tmpl.workspace_id,
            ref_subgraph_template_id=effective_ref,
        )

    if name is not None:
        node.name = name
    if node_type is not None:
        node.node_type = node_type
    normalized = normalized_node_field_values(
        effective_type,
        current=node,
        subgraph_ref_field="ref_subgraph_template_id",
        agent_type=agent_type,
        model=model,
        prompt=prompt,
        command=command,
        graph_tools=graph_tools,
        task_template_id=task_template_id,
        ref_subgraph_template_id=ref_subgraph_template_id,
        argument_bindings=argument_bindings,
        images=images,
    )
    node.agent_type = normalized["agent_type"]
    node.model = normalized["model"]
    node.prompt = normalized["prompt"]
    node.command = normalized["command"]
    node.graph_tools = normalized["graph_tools"]
    node.task_template_id = normalized["task_template_id"]
    node.ref_subgraph_template_id = normalized["ref_subgraph_template_id"]
    node.argument_bindings = normalized["argument_bindings"]
    if output_schema is not None:
        validate_output_schema_definition(output_schema)
        node.output_schema = output_schema
    node.images = normalized["images"]
    node.updated_at = datetime.datetime.utcnow()
    session.add(node)
    session.commit()
    session.refresh(node)
    return node


def delete_subgraph_template_node(
    session: Session, tmpl: SubgraphTemplate, node_id: uuid.UUID
) -> bool:
    node = session.get(SubgraphTemplateNode, node_id)
    if node is None or node.subgraph_template_id != tmpl.id:
        return False

    # Delete connected edges
    edges = session.exec(
        select(SubgraphTemplateEdge).where(
            (SubgraphTemplateEdge.from_node_id == node_id)
            | (SubgraphTemplateEdge.to_node_id == node_id)
        )
    ).all()
    for edge in edges:
        session.delete(edge)
    session.flush()

    session.delete(node)
    session.commit()
    return True


# ── Subgraph Template Edge sub-resource ──────────────────────────────────────


def add_subgraph_template_edge(
    session: Session,
    tmpl: SubgraphTemplate,
    from_node_id: uuid.UUID,
    to_node_id: uuid.UUID,
) -> SubgraphTemplateEdge:
    from_node = session.get(SubgraphTemplateNode, from_node_id)
    if from_node is None or from_node.subgraph_template_id != tmpl.id:
        raise ValueError(f"node {from_node_id} not found in subgraph template")

    to_node = session.get(SubgraphTemplateNode, to_node_id)
    if to_node is None or to_node.subgraph_template_id != tmpl.id:
        raise ValueError(f"node {to_node_id} not found in subgraph template")

    # Check for DAG cycle
    all_nodes = session.exec(
        select(SubgraphTemplateNode).where(
            SubgraphTemplateNode.subgraph_template_id == tmpl.id
        )
    ).all()
    existing_edges = session.exec(
        select(SubgraphTemplateEdge).where(
            SubgraphTemplateEdge.subgraph_template_id == tmpl.id
        )
    ).all()

    node_ids = [n.id for n in all_nodes]
    edge_pairs = [(e.from_node_id, e.to_node_id) for e in existing_edges]
    edge_pairs.append((from_node_id, to_node_id))

    if _has_cycle(node_ids, edge_pairs):
        raise ValueError("cycle detected")

    edge = SubgraphTemplateEdge(
        subgraph_template_id=tmpl.id,
        from_node_id=from_node_id,
        to_node_id=to_node_id,
    )
    session.add(edge)
    session.commit()
    session.refresh(edge)
    return edge


def delete_subgraph_template_edge(
    session: Session, tmpl: SubgraphTemplate, edge_id: uuid.UUID
) -> bool:
    edge = session.get(SubgraphTemplateEdge, edge_id)
    if edge is None or edge.subgraph_template_id != tmpl.id:
        return False
    session.delete(edge)
    session.commit()
    return True
