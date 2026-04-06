import datetime
import uuid
from dataclasses import dataclass
from typing import Optional

from sqlmodel import Session, select

from app.models.graph import Graph, GraphEdge, GraphNode, NodeType
from app.models.run import GraphRun, GraphRunEdge, GraphRunNode


@dataclass
class NodeInput:
    node_type: NodeType
    name: Optional[str] = None
    agent_type: Optional[str] = None
    model: Optional[str] = None
    prompt: Optional[str] = None
    command: Optional[str] = None
    graph_tools: bool = False


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


def _validate_no_cycle_by_index(
    node_count: int, edges: list[EdgeInput]
) -> None:
    """Validate edges (by index) form a DAG. Raises ValueError if cycle detected."""
    node_ids = [uuid.uuid4() for _ in range(node_count)]
    edge_pairs = [(node_ids[e.from_index], node_ids[e.to_index]) for e in edges]
    if _has_cycle(node_ids, edge_pairs):
        raise ValueError("cycle detected")


def create_graph(
    session: Session,
    workspace_id: uuid.UUID,
    name: str,
    nodes: list[NodeInput],
    edges: list[EdgeInput],
) -> Graph:
    _validate_no_cycle_by_index(len(nodes), edges)

    graph = Graph(workspace_id=workspace_id, name=name)
    session.add(graph)
    session.flush()

    db_nodes = []
    for node_input in nodes:
        node = GraphNode(
            graph_id=graph.id,
            node_type=node_input.node_type,
            name=node_input.name,
            agent_type=node_input.agent_type,
            model=node_input.model,
            prompt=node_input.prompt,
            command=node_input.command,
            graph_tools=node_input.graph_tools,
        )
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
        node = GraphNode(
            graph_id=graph.id,
            node_type=node_input.node_type,
            name=node_input.name,
            agent_type=node_input.agent_type,
            model=node_input.model,
            prompt=node_input.prompt,
            command=node_input.command,
            graph_tools=node_input.graph_tools,
        )
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
) -> GraphNode:
    node = GraphNode(
        graph_id=graph.id,
        node_type=node_type,
        name=name,
        agent_type=agent_type,
        model=model,
        prompt=prompt,
        command=command,
        graph_tools=graph_tools,
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
) -> Optional[GraphNode]:
    node = session.get(GraphNode, node_id)
    if node is None or node.graph_id != graph.id:
        return None
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


def create_run(session: Session, graph: Graph) -> GraphRun:
    run = GraphRun(graph_id=graph.id, workspace_id=graph.workspace_id)
    session.add(run)
    session.flush()

    # Pass 1: snapshot nodes, record old→new ID mapping
    run_nodes: list[tuple[uuid.UUID, GraphRunNode]] = []
    for node in graph.nodes:
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
        .where(GraphRun.workspace_id == workspace_id, GraphRun.graph_id == graph_id)
        .order_by(GraphRun.created_at.desc())
    )
    return list(session.exec(statement).all())
