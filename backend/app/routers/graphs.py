import datetime
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session

from app.database import get_session
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


class EdgeInputSchema(BaseModel):
    from_index: int
    to_index: int


class CreateGraphRequest(BaseModel):
    name: str
    nodes: list[NodeInputSchema] = []
    edges: list[EdgeInputSchema] = []


class AddNodeRequest(BaseModel):
    node_type: NodeType = NodeType.nop


class AddEdgeRequest(BaseModel):
    from_node_id: uuid.UUID
    to_node_id: uuid.UUID


# --- Response schemas ---

class GraphNodeResponse(BaseModel):
    id: uuid.UUID
    graph_id: uuid.UUID
    node_type: NodeType
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


def _to_detail(graph: Any) -> GraphDetailResponse:
    return GraphDetailResponse(
        id=graph.id,
        workspace_id=graph.workspace_id,
        name=graph.name,
        created_at=graph.created_at,
        updated_at=graph.updated_at,
        nodes=[GraphNodeResponse.model_validate(n) for n in graph.nodes],
        edges=[GraphEdgeResponse.model_validate(e) for e in graph.edges],
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
            nodes=[NodeInput(node_type=n.node_type) for n in body.nodes],
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
            nodes=[NodeInput(node_type=n.node_type) for n in body.nodes],
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
    node = svc.add_node(session, graph=graph, node_type=body.node_type)
    return GraphNodeResponse.model_validate(node)


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
