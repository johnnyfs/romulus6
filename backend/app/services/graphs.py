import datetime
import json
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

import jinja2
from sqlmodel import Session, select

from app.models.graph import Graph, GraphEdge, GraphNode, NodeType
from app.models.run import GraphRun, GraphRunEdge, GraphRunNode
from app.models.template import (
    SubgraphTemplate,
    SubgraphTemplateEdge,
    SubgraphTemplateNode,
    SubgraphTemplateNodeType,
    TaskTemplate,
    TaskTemplateArgument,
    TemplateArgType,
)
from app.utils.output_schema import validate_output_schema_definition


@dataclass
class NodeInput:
    node_type: NodeType
    name: Optional[str] = None
    agent_type: Optional[str] = None
    model: Optional[str] = None
    prompt: Optional[str] = None
    command: Optional[str] = None
    graph_tools: bool = False
    task_template_id: Optional[uuid.UUID] = None
    subgraph_template_id: Optional[uuid.UUID] = None
    argument_bindings: Optional[dict[str, str]] = None
    output_schema: Optional[dict[str, str]] = None
    images: Optional[list[dict]] = None


@dataclass
class EdgeInput:
    from_index: int
    to_index: int


def _has_cycle(
    node_ids: list[uuid.UUID], edges: list[tuple[uuid.UUID, uuid.UUID]]
) -> bool:
    """Return True if the directed graph contains a cycle. Iterative DFS."""
    adj: dict[uuid.UUID, list[uuid.UUID]] = {n: [] for n in node_ids}
    for src, dst in edges:
        adj[src].append(dst)

    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[uuid.UUID, int] = {n: WHITE for n in node_ids}

    for start in node_ids:
        if color[start] != WHITE:
            continue
        stack = [(start, iter(adj[start]))]
        color[start] = GRAY
        while stack:
            node, children = stack[-1]
            try:
                child = next(children)
                if color[child] == GRAY:
                    return True
                if color[child] == WHITE:
                    color[child] = GRAY
                    stack.append((child, iter(adj[child])))
            except StopIteration:
                color[node] = BLACK
                stack.pop()
    return False


class _PreserveUndefined(jinja2.Undefined):
    """Render unresolved variables back as {{ name }} instead of raising."""

    def __str__(self) -> str:
        return "{{ " + self._undefined_name + " }}"

    def __bool__(self) -> bool:
        return False


_jinja_env = jinja2.Environment(
    loader=jinja2.BaseLoader(),
    undefined=_PreserveUndefined,
    trim_blocks=True,
    lstrip_blocks=True,
    keep_trailing_newline=True,
)


def _substitute_args(text: Optional[str], bindings: dict[str, Any]) -> Optional[str]:
    """Render Jinja2 template text with the given bindings."""
    if text is None:
        return None
    return _jinja_env.from_string(text).render(bindings)


def _coerce_boolean_bindings(
    bindings: dict[str, Any], template_args: list
) -> None:
    """Convert string 'true'/'false' to Python bool for boolean-typed args (in-place)."""
    for arg in template_args:
        if arg.arg_type == TemplateArgType.boolean and arg.name in bindings:
            val = bindings[arg.name]
            if isinstance(val, str):
                bindings[arg.name] = val.lower() == "true"


def _coerce_number_bindings(
    bindings: dict[str, Any], template_args: list
) -> None:
    """Convert string numeric values to Python float for number-typed args (in-place).

    Also validates against min_value/max_value bounds when defined.
    """
    for arg in template_args:
        if arg.arg_type == TemplateArgType.number and arg.name in bindings:
            val = bindings[arg.name]
            if isinstance(val, str):
                try:
                    val = float(val)
                    bindings[arg.name] = val
                except ValueError:
                    raise ValueError(
                        f"argument '{arg.name}' value '{val}' is not a valid number"
                    )
            if isinstance(val, (int, float)):
                if arg.min_value is not None and val < float(arg.min_value):
                    raise ValueError(
                        f"argument '{arg.name}' value {val} is below minimum {float(arg.min_value)}"
                    )
                if arg.max_value is not None and val > float(arg.max_value):
                    raise ValueError(
                        f"argument '{arg.name}' value {val} is above maximum {float(arg.max_value)}"
                    )


def _validate_enum_bindings(
    bindings: dict[str, Any], template_args: list
) -> None:
    """Validate that enum-typed arg values are within allowed options."""
    for arg in template_args:
        if arg.arg_type == TemplateArgType.enum and arg.name in bindings:
            val = bindings[arg.name]
            if arg.enum_options:
                allowed = json.loads(arg.enum_options)
                if val not in allowed:
                    raise ValueError(
                        f"argument '{arg.name}' value '{val}' not in allowed options: {allowed}"
                    )


def _resolve_bindings(
    node_bindings: dict[str, str],
    parent_bindings: dict[str, Any],
    template_args: list,
) -> dict[str, Any]:
    """Resolve argument bindings for a template node.

    node_bindings may reference parent args via {{ parent_arg }}.
    Unbound args fall back to template argument defaults.
    """
    resolved: dict[str, Any] = {}
    # First, substitute parent bindings into node-level binding values
    for key, value in node_bindings.items():
        resolved[key] = _substitute_args(value, parent_bindings) or value

    # Fill in defaults for any args not provided
    for arg in template_args:
        if arg.name not in resolved and arg.default_value is not None:
            resolved[arg.name] = arg.default_value

    _coerce_boolean_bindings(resolved, template_args)
    _coerce_number_bindings(resolved, template_args)
    _validate_enum_bindings(resolved, template_args)
    return resolved


def _validate_no_subgraph_cycle_in_graph(
    session: Session,
    nodes: list,
) -> None:
    """Validate that subgraph_template nodes in a graph don't reference cyclic templates.

    Graph nodes aren't themselves templates, so there's no self-reference to check.
    We just verify each referenced subgraph template is internally cycle-free
    by running the materialization cycle check.
    """
    for node in nodes:
        node_type = node.node_type if hasattr(node, "node_type") else node.get("node_type")
        sg_id = node.subgraph_template_id if hasattr(node, "subgraph_template_id") else node.get("subgraph_template_id")
        if node_type == NodeType.subgraph_template and sg_id is not None:
            _validate_no_materialization_cycle(session, sg_id, set())


def _validate_no_cycle_by_index(
    node_count: int, edges: list[EdgeInput]
) -> None:
    """Validate edges (by index) form a DAG. Raises ValueError if cycle detected."""
    node_ids = [uuid.uuid4() for _ in range(node_count)]
    edge_pairs = [(node_ids[e.from_index], node_ids[e.to_index]) for e in edges]
    if _has_cycle(node_ids, edge_pairs):
        raise ValueError("cycle detected")


def _build_graph_node(graph_id: uuid.UUID, node_input: NodeInput) -> GraphNode:
    """Build a GraphNode from a NodeInput, including template fields."""
    validate_output_schema_definition(node_input.output_schema)
    bindings_json = (
        json.dumps(node_input.argument_bindings)
        if node_input.argument_bindings
        else None
    )
    output_schema_json = (
        json.dumps(node_input.output_schema)
        if node_input.output_schema
        else None
    )
    images_json = (
        json.dumps(node_input.images)
        if node_input.images
        else None
    )
    return GraphNode(
        graph_id=graph_id,
        node_type=node_input.node_type,
        name=node_input.name,
        agent_type=node_input.agent_type,
        model=node_input.model,
        prompt=node_input.prompt,
        command=node_input.command,
        graph_tools=node_input.graph_tools,
        task_template_id=node_input.task_template_id,
        subgraph_template_id=node_input.subgraph_template_id,
        argument_bindings=bindings_json,
        output_schema=output_schema_json,
        images=images_json,
    )


def create_graph(
    session: Session,
    workspace_id: uuid.UUID,
    name: str,
    nodes: list[NodeInput],
    edges: list[EdgeInput],
) -> Graph:
    _validate_no_cycle_by_index(len(nodes), edges)
    _validate_no_subgraph_cycle_in_graph(session, nodes)

    graph = Graph(workspace_id=workspace_id, name=name)
    session.add(graph)
    session.flush()

    db_nodes = []
    for node_input in nodes:
        node = _build_graph_node(graph.id, node_input)
        session.add(node)
        db_nodes.append(node)
    session.flush()

    for edge_input in edges:
        edge = GraphEdge(
            graph_id=graph.id,
            from_node_id=db_nodes[edge_input.from_index].id,
            to_node_id=db_nodes[edge_input.to_index].id,
        )
        session.add(edge)

    session.commit()
    session.refresh(graph)
    return graph


def list_graphs(session: Session, workspace_id: uuid.UUID) -> list[Graph]:
    return list(session.exec(Graph.active().where(Graph.workspace_id == workspace_id)).all())


def get_graph(
    session: Session, workspace_id: uuid.UUID, graph_id: uuid.UUID
) -> Optional[Graph]:
    graph = session.get(Graph, graph_id)
    if graph is None or graph.workspace_id != workspace_id or graph.deleted:
        return None
    return graph


def update_graph(
    session: Session,
    graph: Graph,
    name: str,
    nodes: list[NodeInput],
    edges: list[EdgeInput],
) -> Graph:
    _validate_no_cycle_by_index(len(nodes), edges)
    _validate_no_subgraph_cycle_in_graph(session, nodes)

    # Delete existing edges first (FK constraint: edges reference nodes)
    existing_edges = session.exec(
        select(GraphEdge).where(GraphEdge.graph_id == graph.id)
    ).all()
    for edge in existing_edges:
        session.delete(edge)
    session.flush()

    existing_nodes = session.exec(
        select(GraphNode).where(GraphNode.graph_id == graph.id)
    ).all()
    for node in existing_nodes:
        session.delete(node)
    session.flush()

    db_nodes = []
    for node_input in nodes:
        node = _build_graph_node(graph.id, node_input)
        session.add(node)
        db_nodes.append(node)
    session.flush()

    for edge_input in edges:
        edge = GraphEdge(
            graph_id=graph.id,
            from_node_id=db_nodes[edge_input.from_index].id,
            to_node_id=db_nodes[edge_input.to_index].id,
        )
        session.add(edge)

    graph.name = name
    graph.updated_at = datetime.datetime.utcnow()
    session.add(graph)
    session.commit()
    session.refresh(graph)
    return graph


def delete_graph(
    session: Session, workspace_id: uuid.UUID, graph_id: uuid.UUID
) -> bool:
    graph = get_graph(session, workspace_id, graph_id)
    if graph is None:
        return False
    now = datetime.datetime.utcnow()
    for edge in session.exec(select(GraphEdge).where(GraphEdge.graph_id == graph.id)).all():
        edge.deleted = True
        edge.updated_at = now
        session.add(edge)
    for node in session.exec(select(GraphNode).where(GraphNode.graph_id == graph.id)).all():
        node.deleted = True
        node.updated_at = now
        session.add(node)
    graph.deleted = True
    graph.updated_at = now
    session.add(graph)
    session.commit()
    return True


def add_node(
    session: Session,
    graph: Graph,
    node_type: NodeType,
    name: Optional[str] = None,
    agent_type: Optional[str] = None,
    model: Optional[str] = None,
    prompt: Optional[str] = None,
    command: Optional[str] = None,
    graph_tools: bool = False,
    task_template_id: Optional[uuid.UUID] = None,
    subgraph_template_id: Optional[uuid.UUID] = None,
    argument_bindings: Optional[dict[str, str]] = None,
    output_schema: Optional[dict[str, str]] = None,
    images: Optional[list[dict]] = None,
) -> GraphNode:
    if node_type == NodeType.subgraph_template and subgraph_template_id is not None:
        _validate_no_materialization_cycle(session, subgraph_template_id, set())

    validate_output_schema_definition(output_schema)
    bindings_json = json.dumps(argument_bindings) if argument_bindings else None
    output_schema_json = json.dumps(output_schema) if output_schema else None
    images_json = json.dumps(images) if images else None
    node = GraphNode(
        graph_id=graph.id,
        node_type=node_type,
        name=name,
        agent_type=agent_type,
        model=model,
        prompt=prompt,
        command=command,
        graph_tools=graph_tools,
        task_template_id=task_template_id,
        subgraph_template_id=subgraph_template_id,
        argument_bindings=bindings_json,
        output_schema=output_schema_json,
        images=images_json,
    )
    session.add(node)
    session.commit()
    session.refresh(node)
    return node


def patch_node(
    session: Session,
    graph: Graph,
    node_id: uuid.UUID,
    name: Optional[str],
    node_type: Optional[NodeType],
    agent_type: Optional[str] = None,
    model: Optional[str] = None,
    prompt: Optional[str] = None,
    command: Optional[str] = None,
    graph_tools: Optional[bool] = None,
    task_template_id: Optional[uuid.UUID] = None,
    subgraph_template_id: Optional[uuid.UUID] = None,
    argument_bindings: Optional[dict[str, str]] = None,
    output_schema: Optional[dict[str, str]] = None,
    images: Optional[list[dict]] = None,
) -> Optional[GraphNode]:
    node = session.get(GraphNode, node_id)
    if node is None or node.graph_id != graph.id:
        return None

    effective_type = node_type if node_type is not None else node.node_type
    effective_sg_id = (
        subgraph_template_id
        if subgraph_template_id is not None
        else node.subgraph_template_id
    )
    if effective_type == NodeType.subgraph_template and effective_sg_id is not None:
        _validate_no_materialization_cycle(session, effective_sg_id, set())

    validate_output_schema_definition(output_schema)

    if name is not None:
        node.name = name
    if node_type is not None:
        node.node_type = node_type
    if agent_type is not None:
        node.agent_type = agent_type
    if model is not None:
        node.model = model
    if prompt is not None:
        node.prompt = prompt
    if command is not None:
        node.command = command
    if graph_tools is not None:
        node.graph_tools = graph_tools
    if task_template_id is not None:
        node.task_template_id = task_template_id
    if subgraph_template_id is not None:
        node.subgraph_template_id = subgraph_template_id
    if argument_bindings is not None:
        node.argument_bindings = json.dumps(argument_bindings)
    if output_schema is not None:
        node.output_schema = json.dumps(output_schema)
    if images is not None:
        node.images = json.dumps(images)
    session.add(node)
    session.commit()
    session.refresh(node)
    return node


def delete_node(
    session: Session, graph: Graph, node_id: uuid.UUID
) -> bool:
    node = session.get(GraphNode, node_id)
    if node is None or node.graph_id != graph.id:
        return False

    # Delete connected edges explicitly
    edges = session.exec(
        select(GraphEdge).where(
            (GraphEdge.from_node_id == node_id) | (GraphEdge.to_node_id == node_id)
        )
    ).all()
    for edge in edges:
        session.delete(edge)
    session.flush()

    session.delete(node)
    session.commit()
    return True


def add_edge(
    session: Session,
    graph: Graph,
    from_node_id: uuid.UUID,
    to_node_id: uuid.UUID,
) -> GraphEdge:
    # Validate both nodes belong to this graph
    from_node = session.get(GraphNode, from_node_id)
    if from_node is None or from_node.graph_id != graph.id:
        raise ValueError(f"node {from_node_id} not found in graph")

    to_node = session.get(GraphNode, to_node_id)
    if to_node is None or to_node.graph_id != graph.id:
        raise ValueError(f"node {to_node_id} not found in graph")

    # Load all nodes and existing edges to check for cycle
    all_nodes = session.exec(
        select(GraphNode).where(GraphNode.graph_id == graph.id)
    ).all()
    existing_edges = session.exec(
        select(GraphEdge).where(GraphEdge.graph_id == graph.id)
    ).all()

    node_ids = [n.id for n in all_nodes]
    edge_pairs = [(e.from_node_id, e.to_node_id) for e in existing_edges]
    edge_pairs.append((from_node_id, to_node_id))

    if _has_cycle(node_ids, edge_pairs):
        raise ValueError("cycle detected")

    edge = GraphEdge(
        graph_id=graph.id,
        from_node_id=from_node_id,
        to_node_id=to_node_id,
    )
    session.add(edge)
    session.commit()
    session.refresh(edge)
    return edge


def delete_edge(
    session: Session, graph: Graph, edge_id: uuid.UUID
) -> bool:
    edge = session.get(GraphEdge, edge_id)
    if edge is None or edge.graph_id != graph.id:
        return False
    session.delete(edge)
    session.commit()
    return True


def _materialize_task_template(
    session: Session,
    run: GraphRun,
    task_template: TaskTemplate,
    bindings: dict[str, Any],
    source_node_id: Optional[uuid.UUID] = None,
) -> GraphRunNode:
    """Resolve a TaskTemplate into a concrete GraphRunNode."""
    # Merge bindings with defaults
    for arg in task_template.arguments:
        if arg.name not in bindings and arg.default_value is not None:
            bindings[arg.name] = arg.default_value
    _coerce_boolean_bindings(bindings, task_template.arguments)

    rn = GraphRunNode(
        run_id=run.id,
        source_node_id=source_node_id or task_template.id,
        source_type="template_node",
        node_type=task_template.task_type.value,
        name=_substitute_args(task_template.label or task_template.name, bindings),
        state="pending",
        agent_type=_substitute_args(task_template.agent_type, bindings),
        model=_substitute_args(task_template.model, bindings),
        prompt=_substitute_args(task_template.prompt, bindings),
        command=_substitute_args(task_template.command, bindings),
        graph_tools=task_template.graph_tools,
        output_schema=task_template.output_schema,
        images=task_template.images,
    )
    session.add(rn)
    return rn


def _validate_no_materialization_cycle(
    session: Session,
    template_id: uuid.UUID,
    seen: set[uuid.UUID],
) -> None:
    """Re-validate that no recursive cycle exists at materialization time."""
    if template_id in seen:
        raise ValueError("subgraph cycle detected during materialization")
    seen.add(template_id)

    nodes = session.exec(
        select(SubgraphTemplateNode).where(
            SubgraphTemplateNode.subgraph_template_id == template_id,
            SubgraphTemplateNode.node_type == SubgraphTemplateNodeType.subgraph_template,
            SubgraphTemplateNode.deleted == False,  # noqa: E712
        )
    ).all()
    for node in nodes:
        if node.ref_subgraph_template_id:
            _validate_no_materialization_cycle(session, node.ref_subgraph_template_id, seen)


def _materialize_subgraph(
    session: Session,
    parent_run: GraphRun,
    subgraph_template: SubgraphTemplate,
    bindings: dict[str, Any],
    seen: set[uuid.UUID],
) -> GraphRun:
    """Recursively materialize a SubgraphTemplate into a child GraphRun."""
    child_run = GraphRun(
        graph_id=None,
        workspace_id=parent_run.workspace_id,
        sandbox_id=parent_run.sandbox_id,
        source_template_id=subgraph_template.id,
    )
    session.add(child_run)
    session.flush()

    active_nodes = [n for n in subgraph_template.nodes if not n.deleted]
    active_edges = [e for e in subgraph_template.edges if not e.deleted]

    # Materialize nodes
    template_node_to_run_node: dict[uuid.UUID, GraphRunNode] = {}
    for tmpl_node in active_nodes:
        if tmpl_node.node_type in (
            SubgraphTemplateNodeType.agent,
            SubgraphTemplateNodeType.command,
            SubgraphTemplateNodeType.view,
        ):
            # Inline agent/command/view node — snapshot directly with arg substitution
            rn = GraphRunNode(
                run_id=child_run.id,
                source_node_id=tmpl_node.id,
                source_type="template_node",
                node_type=tmpl_node.node_type.value,
                name=tmpl_node.name,
                state="pending",
                agent_type=_substitute_args(tmpl_node.agent_type, bindings),
                model=_substitute_args(tmpl_node.model, bindings),
                prompt=_substitute_args(tmpl_node.prompt, bindings),
                command=_substitute_args(tmpl_node.command, bindings),
                graph_tools=tmpl_node.graph_tools,
                output_schema=tmpl_node.output_schema,
                images=tmpl_node.images,
            )
            session.add(rn)
            template_node_to_run_node[tmpl_node.id] = rn

        elif tmpl_node.node_type == SubgraphTemplateNodeType.task_template:
            task_tmpl = session.get(TaskTemplate, tmpl_node.task_template_id)
            if task_tmpl is None or task_tmpl.deleted:
                raise ValueError(
                    f"task template {tmpl_node.task_template_id} not found or deleted"
                )
            # Resolve this node's bindings against parent bindings
            node_bindings_raw = (
                json.loads(tmpl_node.argument_bindings)
                if tmpl_node.argument_bindings
                else {}
            )
            resolved = _resolve_bindings(node_bindings_raw, bindings, task_tmpl.arguments)
            rn = _materialize_task_template(
                session, child_run, task_tmpl, resolved, source_node_id=tmpl_node.id
            )
            if tmpl_node.name:
                rn.name = tmpl_node.name
            # Subgraph template node output_schema overrides task template's
            if tmpl_node.output_schema:
                rn.output_schema = tmpl_node.output_schema
            template_node_to_run_node[tmpl_node.id] = rn

        elif tmpl_node.node_type == SubgraphTemplateNodeType.subgraph_template:
            ref_sg = session.get(SubgraphTemplate, tmpl_node.ref_subgraph_template_id)
            if ref_sg is None or ref_sg.deleted:
                raise ValueError(
                    f"subgraph template {tmpl_node.ref_subgraph_template_id} not found or deleted"
                )
            _validate_no_materialization_cycle(session, ref_sg.id, set(seen))

            node_bindings_raw = (
                json.loads(tmpl_node.argument_bindings)
                if tmpl_node.argument_bindings
                else {}
            )
            resolved = _resolve_bindings(node_bindings_raw, bindings, ref_sg.arguments)

            # Create the subgraph run node
            rn = GraphRunNode(
                run_id=child_run.id,
                source_node_id=tmpl_node.id,
                source_type="template_node",
                node_type="subgraph",
                name=tmpl_node.name or _substitute_args(ref_sg.label, bindings) or ref_sg.name,
                state="pending",
                output_schema=tmpl_node.output_schema or ref_sg.output_schema,
            )
            session.add(rn)
            session.flush()

            # Recurse
            nested_child = _materialize_subgraph(
                session, child_run, ref_sg, resolved, seen
            )
            rn.child_run_id = nested_child.id
            nested_child.parent_run_node_id = rn.id
            session.add(rn)
            session.add(nested_child)
            template_node_to_run_node[tmpl_node.id] = rn

    session.flush()

    # Materialize edges
    for edge in active_edges:
        from_rn = template_node_to_run_node.get(edge.from_node_id)
        to_rn = template_node_to_run_node.get(edge.to_node_id)
        if from_rn and to_rn:
            session.add(GraphRunEdge(
                run_id=child_run.id,
                from_run_node_id=from_rn.id,
                to_run_node_id=to_rn.id,
            ))

    session.flush()
    session.refresh(child_run)
    return child_run


def create_run(session: Session, graph: Graph) -> GraphRun:
    run = GraphRun(graph_id=graph.id, workspace_id=graph.workspace_id)
    session.add(run)
    session.flush()

    # Pass 1: snapshot nodes, record old→new ID mapping
    run_nodes: list[tuple[uuid.UUID, GraphRunNode]] = []
    for node in graph.nodes:
        if node.node_type == NodeType.task_template:
            # Materialize task template into concrete run node
            task_tmpl = session.get(TaskTemplate, node.task_template_id)
            if task_tmpl is None or task_tmpl.deleted:
                raise ValueError(
                    f"task template {node.task_template_id} not found or deleted"
                )
            bindings = json.loads(node.argument_bindings) if node.argument_bindings else {}
            rn = _materialize_task_template(
                session, run, task_tmpl, bindings, source_node_id=node.id
            )
            # Override name from graph node if set
            if node.name:
                rn.name = node.name
            # Graph node output_schema overrides template's
            if node.output_schema:
                rn.output_schema = node.output_schema
            run_nodes.append((node.id, rn))

        elif node.node_type == NodeType.subgraph_template:
            # Materialize subgraph template into subgraph run node + child run
            sg_tmpl = session.get(SubgraphTemplate, node.subgraph_template_id)
            if sg_tmpl is None or sg_tmpl.deleted:
                raise ValueError(
                    f"subgraph template {node.subgraph_template_id} not found or deleted"
                )
            _validate_no_materialization_cycle(session, sg_tmpl.id, set())

            bindings = json.loads(node.argument_bindings) if node.argument_bindings else {}
            # Fill in defaults from template arguments
            for arg in sg_tmpl.arguments:
                if arg.name not in bindings and arg.default_value is not None:
                    bindings[arg.name] = arg.default_value
            _coerce_boolean_bindings(bindings, sg_tmpl.arguments)

            rn = GraphRunNode(
                run_id=run.id,
                source_node_id=node.id,
                source_type="graph_node",
                node_type="subgraph",
                name=node.name or _substitute_args(sg_tmpl.label, bindings) or sg_tmpl.name,
                state="pending",
                output_schema=node.output_schema or sg_tmpl.output_schema,
            )
            session.add(rn)
            session.flush()

            child_run = _materialize_subgraph(
                session, run, sg_tmpl, bindings, {sg_tmpl.id}
            )
            rn.child_run_id = child_run.id
            child_run.parent_run_node_id = rn.id
            session.add(rn)
            session.add(child_run)
            run_nodes.append((node.id, rn))

        else:
            # agent / command: snapshot as before
            rn = GraphRunNode(
                run_id=run.id,
                source_node_id=node.id,
                node_type=node.node_type.value,
                name=node.name,
                state="pending",
                agent_type=node.agent_type,
                model=node.model,
                prompt=node.prompt,
                command=node.command,
                graph_tools=node.graph_tools,
                output_schema=node.output_schema,
                images=node.images,
            )
            session.add(rn)
            run_nodes.append((node.id, rn))

    session.flush()

    node_id_map = {orig: rn.id for orig, rn in run_nodes}

    # Pass 2: snapshot edges using remapped IDs
    for edge in graph.edges:
        session.add(GraphRunEdge(
            run_id=run.id,
            from_run_node_id=node_id_map[edge.from_node_id],
            to_run_node_id=node_id_map[edge.to_node_id],
        ))

    session.commit()
    session.refresh(run)
    return run


def list_runs(session: Session, workspace_id: uuid.UUID, graph_id: uuid.UUID) -> list[GraphRun]:
    statement = (
        select(GraphRun)
        .where(
            GraphRun.workspace_id == workspace_id,
            GraphRun.graph_id == graph_id,
            GraphRun.parent_run_node_id.is_(None),  # type: ignore[union-attr]
        )
        .order_by(GraphRun.created_at.desc())
    )
    return list(session.exec(statement).all())
