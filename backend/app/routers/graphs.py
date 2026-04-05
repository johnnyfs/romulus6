import datetime
import uuid
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session

from app.database import get_session
from app.models.agent import AgentConfig
from app.models.graph import Graph, NodeType
from app.models.workspace import Workspace
from app.services import graphs as svc
from app.services.graphs import EdgeInput, NodeInput

router = APIRouter(
    prefix="/workspaces/{workspace_id}/graphs",
    tags=["graphs"],
)

SessionDep = Annotated[Session, Depends(get_session)]


# --- Request schemas ---

class NodeInputSchema(BaseModel):
    node_type: NodeType = NodeType.nop
    name: Optional[str] = None
    agent_config: Optional[AgentConfig] = None


class EdgeInputSchema(BaseModel):
    from_index: int
    to_index: int


class CreateGraphRequest(BaseModel):
    name: str
    nodes: list[NodeInputSchema] = []
    edges: list[EdgeInputSchema] = []


class AddNodeRequest(BaseModel):
    node_type: NodeType = NodeType.nop
    name: Optional[str] = None
    agent_config: Optional[AgentConfig] = None


class PatchNodeRequest(BaseModel):
    name: Optional[str] = None
    node_type: Optional[NodeType] = None
    agent_config: Optional[AgentConfig] = None


class AddEdgeRequest(BaseModel):
    from_node_id: uuid.UUID
    to_node_id: uuid.UUID


# --- Response schemas ---

class GraphNodeResponse(BaseModel):
    id: uuid.UUID
    graph_id: uuid.UUID
    node_type: NodeType
    name: Optional[str] = None
    agent_config: Optional[AgentConfig] = None
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class GraphEdgeResponse(BaseModel):
    id: uuid.UUID
    graph_id: uuid.UUID
    from_node_id: uuid.UUID
    to_node_id: uuid.UUID
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class GraphDetailResponse(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    created_at: datetime.datetime
    updated_at: datetime.datetime
    nodes: list[GraphNodeResponse]
    edges: list[GraphEdgeResponse]

    model_config = {"from_attributes": True}


class GraphRunNodeResponse(BaseModel):
    id: uuid.UUID
    run_id: uuid.UUID
    source_node_id: uuid.UUID
    node_type: str
    name: Optional[str] = None
    state: str
    agent_config: Optional[AgentConfig] = None
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class GraphRunEdgeResponse(BaseModel):
    id: uuid.UUID
    run_id: uuid.UUID
    from_run_node_id: uuid.UUID
    to_run_node_id: uuid.UUID
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class GraphRunResponse(BaseModel):
    id: uuid.UUID
    graph_id: uuid.UUID
    workspace_id: uuid.UUID
    created_at: datetime.datetime
    run_nodes: list[GraphRunNodeResponse]
    run_edges: list[GraphRunEdgeResponse]

    model_config = {"from_attributes": True}


# --- Helpers ---

def _require_workspace(workspace_id: uuid.UUID, session: Session) -> Workspace:
    workspace = session.get(Workspace, workspace_id)
    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found"
        )
    return workspace


def _require_graph(
    workspace_id: uuid.UUID, graph_id: uuid.UUID, session: Session
) -> Any:
    graph = svc.get_graph(session, workspace_id, graph_id)
    if graph is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Graph not found"
        )
    return graph


def _agent_config_from(obj: Any) -> Optional[AgentConfig]:
    if obj.agent_type is None:
        return None
    return AgentConfig(agent_type=obj.agent_type, model=obj.model, prompt=obj.prompt)


def _node_response(n: Any) -> GraphNodeResponse:
    return GraphNodeResponse(
        id=n.id,
        graph_id=n.graph_id,
        node_type=n.node_type,
        name=n.name,
        agent_config=_agent_config_from(n),
        created_at=n.created_at,
    )


def _run_node_response(rn: Any) -> GraphRunNodeResponse:
    return GraphRunNodeResponse(
        id=rn.id,
        run_id=rn.run_id,
        source_node_id=rn.source_node_id,
        node_type=rn.node_type,
        name=rn.name,
        state=rn.state,
        agent_config=_agent_config_from(rn),
        created_at=rn.created_at,
    )


def _to_detail(graph: Any) -> GraphDetailResponse:
    return GraphDetailResponse(
        id=graph.id,
        workspace_id=graph.workspace_id,
        name=graph.name,
        created_at=graph.created_at,
        updated_at=graph.updated_at,
        nodes=[_node_response(n) for n in graph.nodes],
        edges=[GraphEdgeResponse.model_validate(e) for e in graph.edges],
    )


def _node_input(n: NodeInputSchema) -> NodeInput:
    ac = n.agent_config
    return NodeInput(
        node_type=n.node_type,
        name=n.name,
        agent_type=ac.agent_type if ac else None,
        model=ac.model.value if ac else None,
        prompt=ac.prompt if ac else None,
    )


# --- Endpoints ---

@router.post("", response_model=GraphDetailResponse, status_code=status.HTTP_201_CREATED)
def create_graph(
    workspace_id: uuid.UUID, body: CreateGraphRequest, session: SessionDep
) -> Any:
    _require_workspace(workspace_id, session)
    try:
        graph = svc.create_graph(
            session,
            workspace_id=workspace_id,
            name=body.name,
            nodes=[_node_input(n) for n in body.nodes],
            edges=[EdgeInput(from_index=e.from_index, to_index=e.to_index) for e in body.edges],
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    return _to_detail(graph)


@router.get("", response_model=list[Graph])
def list_graphs(workspace_id: uuid.UUID, session: SessionDep) -> Any:
    _require_workspace(workspace_id, session)
    return svc.list_graphs(session, workspace_id)


@router.get("/{graph_id}", response_model=GraphDetailResponse)
def get_graph(workspace_id: uuid.UUID, graph_id: uuid.UUID, session: SessionDep) -> Any:
    _require_workspace(workspace_id, session)
    graph = _require_graph(workspace_id, graph_id, session)
    return _to_detail(graph)


@router.put("/{graph_id}", response_model=GraphDetailResponse)
def update_graph(
    workspace_id: uuid.UUID,
    graph_id: uuid.UUID,
    body: CreateGraphRequest,
    session: SessionDep,
) -> Any:
    _require_workspace(workspace_id, session)
    graph = _require_graph(workspace_id, graph_id, session)
    try:
        graph = svc.update_graph(
            session,
            graph=graph,
            name=body.name,
            nodes=[_node_input(n) for n in body.nodes],
            edges=[EdgeInput(from_index=e.from_index, to_index=e.to_index) for e in body.edges],
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    return _to_detail(graph)


@router.delete("/{graph_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_graph(workspace_id: uuid.UUID, graph_id: uuid.UUID, session: SessionDep) -> None:
    _require_workspace(workspace_id, session)
    deleted = svc.delete_graph(session, workspace_id, graph_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Graph not found")


@router.post(
    "/{graph_id}/nodes",
    response_model=GraphNodeResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_node(
    workspace_id: uuid.UUID,
    graph_id: uuid.UUID,
    body: AddNodeRequest,
    session: SessionDep,
) -> Any:
    _require_workspace(workspace_id, session)
    graph = _require_graph(workspace_id, graph_id, session)
    ac = body.agent_config
    node = svc.add_node(
        session,
        graph=graph,
        node_type=body.node_type,
        name=body.name,
        agent_type=ac.agent_type if ac else None,
        model=ac.model.value if ac else None,
        prompt=ac.prompt if ac else None,
    )
    return _node_response(node)


@router.delete(
    "/{graph_id}/nodes/{node_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_node(
    workspace_id: uuid.UUID,
    graph_id: uuid.UUID,
    node_id: uuid.UUID,
    session: SessionDep,
) -> None:
    _require_workspace(workspace_id, session)
    graph = _require_graph(workspace_id, graph_id, session)
    deleted = svc.delete_node(session, graph=graph, node_id=node_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Node not found")


@router.patch(
    "/{graph_id}/nodes/{node_id}",
    response_model=GraphNodeResponse,
)
def patch_node(
    workspace_id: uuid.UUID,
    graph_id: uuid.UUID,
    node_id: uuid.UUID,
    body: PatchNodeRequest,
    session: SessionDep,
) -> Any:
    _require_workspace(workspace_id, session)
    graph = _require_graph(workspace_id, graph_id, session)
    ac = body.agent_config
    node = svc.patch_node(
        session,
        graph=graph,
        node_id=node_id,
        name=body.name,
        node_type=body.node_type,
        agent_type=ac.agent_type if ac else None,
        model=ac.model.value if ac else None,
        prompt=ac.prompt if ac else None,
    )
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Node not found")
    return _node_response(node)


@router.post(
    "/{graph_id}/edges",
    response_model=GraphEdgeResponse,
    status_code=status.HTTP_201_CREATED,
)
def add_edge(
    workspace_id: uuid.UUID,
    graph_id: uuid.UUID,
    body: AddEdgeRequest,
    session: SessionDep,
) -> Any:
    _require_workspace(workspace_id, session)
    graph = _require_graph(workspace_id, graph_id, session)
    try:
        edge = svc.add_edge(
            session,
            graph=graph,
            from_node_id=body.from_node_id,
            to_node_id=body.to_node_id,
        )
    except ValueError as e:
        detail = str(e)
        if "not found" in detail:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail)
    return GraphEdgeResponse.model_validate(edge)


@router.delete(
    "/{graph_id}/edges/{edge_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_edge(
    workspace_id: uuid.UUID,
    graph_id: uuid.UUID,
    edge_id: uuid.UUID,
    session: SessionDep,
) -> None:
    _require_workspace(workspace_id, session)
    graph = _require_graph(workspace_id, graph_id, session)
    deleted = svc.delete_edge(session, graph=graph, edge_id=edge_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Edge not found")


@router.post(
    "/{graph_id}/runs",
    response_model=GraphRunResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_run(
    workspace_id: uuid.UUID,
    graph_id: uuid.UUID,
    session: SessionDep,
) -> Any:
    _require_workspace(workspace_id, session)
    graph = _require_graph(workspace_id, graph_id, session)
    run = svc.create_run(session, graph=graph)
    return GraphRunResponse(
        id=run.id,
        graph_id=run.graph_id,
        workspace_id=run.workspace_id,
        created_at=run.created_at,
        run_nodes=[_run_node_response(rn) for rn in run.run_nodes],
        run_edges=[GraphRunEdgeResponse.model_validate(re) for re in run.run_edges],
    )
