import datetime
import json
import uuid
from typing import Annotated, Any, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session

from app.database import get_session
from app.models.agent import AgentConfig, CommandConfig, ImageAttachment, OpenCodeAgentConfig, PydanticAgentConfig
from app.models.graph import NodeType
from app.models.template import (
    SubgraphTemplateNodeType,
    TemplateArgType,
)
from app.models.workspace import Workspace
from app.services import templates as svc
from app.services.templates import ArgumentInput, SubgraphEdgeInput, SubgraphNodeInput

SessionDep = Annotated[Session, Depends(get_session)]


# ── Shared schemas ───────────────────────────────────────────────────────────


class ArgumentSchema(BaseModel):
    name: str
    arg_type: TemplateArgType = TemplateArgType.string
    default_value: Optional[str] = None
    model_constraint: Optional[list[str]] = None
    min_value: Optional[float] = None
    max_value: Optional[float] = None
    enum_options: Optional[list[str]] = None


class ArgumentResponse(BaseModel):
    id: uuid.UUID
    name: str
    arg_type: TemplateArgType
    default_value: Optional[str] = None
    model_constraint: Optional[list[str]] = None
    min_value: Optional[float] = None
    max_value: Optional[float] = None
    enum_options: Optional[list[str]] = None
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


# ── Helpers ──────────────────────────────────────────────────────────────────


def _require_workspace(workspace_id: uuid.UUID, session: Session) -> Workspace:
    workspace = session.get(Workspace, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    return workspace


def _to_arg_inputs(args: list[ArgumentSchema]) -> list[ArgumentInput]:
    return [
        ArgumentInput(
            name=a.name,
            arg_type=a.arg_type,
            default_value=a.default_value,
            model_constraint=a.model_constraint,
            min_value=a.min_value,
            max_value=a.max_value,
            enum_options=a.enum_options,
        )
        for a in args
    ]


def _arg_response(obj: Any) -> ArgumentResponse:
    mc = None
    if obj.model_constraint:
        try:
            mc = json.loads(obj.model_constraint)
        except (json.JSONDecodeError, TypeError):
            mc = None
    eo = None
    if obj.enum_options:
        try:
            eo = json.loads(obj.enum_options)
        except (json.JSONDecodeError, TypeError):
            eo = None
    return ArgumentResponse(
        id=obj.id,
        name=obj.name,
        arg_type=obj.arg_type,
        default_value=obj.default_value,
        model_constraint=mc,
        min_value=float(obj.min_value) if obj.min_value is not None else None,
        max_value=float(obj.max_value) if obj.max_value is not None else None,
        enum_options=eo,
        created_at=obj.created_at,
    )


# ═══════════════════════════════════════════════════════════════════════════════
# Task Templates
# ═══════════════════════════════════════════════════════════════════════════════


task_router = APIRouter(
    prefix="/workspaces/{workspace_id}/task-templates",
    tags=["task-templates"],
)


# --- Request / Response schemas ---

class CreateTaskTemplateRequest(BaseModel):
    name: str
    task_type: NodeType
    agent_type: Optional[str] = None
    model: Optional[str] = None
    prompt: Optional[str] = None
    command: Optional[str] = None
    graph_tools: bool = False
    label: Optional[str] = None
    arguments: list[ArgumentSchema] = []
    output_schema: Optional[dict[str, str]] = None
    images: Optional[list[ImageAttachment]] = None


class TaskTemplateResponse(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    task_type: NodeType
    agent_type: Optional[str] = None
    model: Optional[str] = None
    prompt: Optional[str] = None
    command: Optional[str] = None
    graph_tools: bool
    label: Optional[str] = None
    arguments: list[ArgumentResponse]
    output_schema: Optional[dict[str, str]] = None
    images: Optional[list[ImageAttachment]] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime

    model_config = {"from_attributes": True}


def _parse_json_field(obj: Any, field: str) -> Optional[dict]:
    raw = getattr(obj, field, None)
    if raw is None:
        return None
    if isinstance(raw, dict):
        return raw
    return json.loads(raw)


def _task_tmpl_response(t: Any) -> TaskTemplateResponse:
    return TaskTemplateResponse(
        id=t.id,
        workspace_id=t.workspace_id,
        name=t.name,
        task_type=t.task_type,
        agent_type=t.agent_type,
        model=t.model,
        prompt=t.prompt,
        command=t.command,
        graph_tools=t.graph_tools,
        label=t.label,
        arguments=[_arg_response(a) for a in t.arguments if not a.deleted],
        output_schema=_parse_json_field(t, "output_schema"),
        images=_parse_json_images(t),
        created_at=t.created_at,
        updated_at=t.updated_at,
    )


def _parse_json_images(obj: Any) -> Optional[list[ImageAttachment]]:
    raw = getattr(obj, "images", None)
    if raw is None:
        return None
    if isinstance(raw, str):
        raw = json.loads(raw)
    return [ImageAttachment(**img) for img in raw] if raw else None


# --- Endpoints ---

@task_router.post("", response_model=TaskTemplateResponse, status_code=status.HTTP_201_CREATED)
def create_task_template(
    workspace_id: uuid.UUID, body: CreateTaskTemplateRequest, session: SessionDep
) -> Any:
    _require_workspace(workspace_id, session)
    images = [img.model_dump(mode="json") for img in body.images] if body.images else None
    tmpl = svc.create_task_template(
        session,
        workspace_id=workspace_id,
        name=body.name,
        task_type=body.task_type,
        agent_type=body.agent_type,
        model=body.model,
        prompt=body.prompt,
        command=body.command,
        graph_tools=body.graph_tools,
        label=body.label,
        arguments=_to_arg_inputs(body.arguments),
        output_schema=body.output_schema,
        images=images,
    )
    return _task_tmpl_response(tmpl)


@task_router.get("", response_model=list[TaskTemplateResponse])
def list_task_templates(workspace_id: uuid.UUID, session: SessionDep) -> Any:
    _require_workspace(workspace_id, session)
    return [_task_tmpl_response(t) for t in svc.list_task_templates(session, workspace_id)]


@task_router.get("/{template_id}", response_model=TaskTemplateResponse)
def get_task_template(workspace_id: uuid.UUID, template_id: uuid.UUID, session: SessionDep) -> Any:
    _require_workspace(workspace_id, session)
    tmpl = svc.get_task_template(session, workspace_id, template_id)
    if tmpl is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task template not found")
    return _task_tmpl_response(tmpl)


@task_router.put("/{template_id}", response_model=TaskTemplateResponse)
def update_task_template(
    workspace_id: uuid.UUID,
    template_id: uuid.UUID,
    body: CreateTaskTemplateRequest,
    session: SessionDep,
) -> Any:
    _require_workspace(workspace_id, session)
    tmpl = svc.get_task_template(session, workspace_id, template_id)
    if tmpl is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task template not found")
    images = [img.model_dump(mode="json") for img in body.images] if body.images else None
    tmpl = svc.update_task_template(
        session,
        tmpl=tmpl,
        name=body.name,
        task_type=body.task_type,
        agent_type=body.agent_type,
        model=body.model,
        prompt=body.prompt,
        command=body.command,
        graph_tools=body.graph_tools,
        label=body.label,
        arguments=_to_arg_inputs(body.arguments),
        output_schema=body.output_schema,
        images=images,
    )
    return _task_tmpl_response(tmpl)


@task_router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_task_template(workspace_id: uuid.UUID, template_id: uuid.UUID, session: SessionDep) -> None:
    _require_workspace(workspace_id, session)
    deleted = svc.delete_task_template(session, workspace_id, template_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task template not found")


# ═══════════════════════════════════════════════════════════════════════════════
# Subgraph Templates
# ═══════════════════════════════════════════════════════════════════════════════


sub_router = APIRouter(
    prefix="/workspaces/{workspace_id}/subgraph-templates",
    tags=["subgraph-templates"],
)


# --- Request / Response schemas ---

class SubgraphNodeInputSchema(BaseModel):
    node_type: SubgraphTemplateNodeType
    name: Optional[str] = None
    # For agent/command inline nodes
    agent_config: Optional[AgentConfig] = None
    command_config: Optional[CommandConfig] = None
    # For task_template/subgraph_template reference nodes
    task_template_id: Optional[uuid.UUID] = None
    ref_subgraph_template_id: Optional[uuid.UUID] = None
    argument_bindings: Optional[dict[str, str]] = None
    output_schema: Optional[dict[str, str]] = None


class SubgraphEdgeInputSchema(BaseModel):
    from_index: int
    to_index: int


class CreateSubgraphTemplateRequest(BaseModel):
    name: str
    label: Optional[str] = None
    nodes: list[SubgraphNodeInputSchema] = []
    edges: list[SubgraphEdgeInputSchema] = []
    arguments: list[ArgumentSchema] = []
    output_schema: Optional[dict[str, str]] = None


class ViewConfig(BaseModel):
    images: list[ImageAttachment] = []


class AddSubgraphNodeRequest(BaseModel):
    node_type: SubgraphTemplateNodeType
    name: Optional[str] = None
    agent_config: Optional[AgentConfig] = None
    command_config: Optional[CommandConfig] = None
    view_config: Optional[ViewConfig] = None
    task_template_id: Optional[uuid.UUID] = None
    ref_subgraph_template_id: Optional[uuid.UUID] = None
    argument_bindings: Optional[dict[str, str]] = None
    output_schema: Optional[dict[str, str]] = None


class PatchSubgraphNodeRequest(BaseModel):
    name: Optional[str] = None
    node_type: Optional[SubgraphTemplateNodeType] = None
    agent_config: Optional[AgentConfig] = None
    command_config: Optional[CommandConfig] = None
    view_config: Optional[ViewConfig] = None
    task_template_id: Optional[uuid.UUID] = None
    ref_subgraph_template_id: Optional[uuid.UUID] = None
    argument_bindings: Optional[dict[str, str]] = None
    output_schema: Optional[dict[str, str]] = None


class AddSubgraphEdgeRequest(BaseModel):
    from_node_id: uuid.UUID
    to_node_id: uuid.UUID


class SubgraphNodeResponse(BaseModel):
    id: uuid.UUID
    subgraph_template_id: uuid.UUID
    node_type: SubgraphTemplateNodeType
    name: Optional[str] = None
    agent_config: Optional[AgentConfig] = None
    command_config: Optional[CommandConfig] = None
    view_config: Optional[ViewConfig] = None
    task_template_id: Optional[uuid.UUID] = None
    ref_subgraph_template_id: Optional[uuid.UUID] = None
    argument_bindings: Optional[dict[str, str]] = None
    output_schema: Optional[dict[str, str]] = None
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class SubgraphEdgeResponse(BaseModel):
    id: uuid.UUID
    subgraph_template_id: uuid.UUID
    from_node_id: uuid.UUID
    to_node_id: uuid.UUID
    created_at: datetime.datetime

    model_config = {"from_attributes": True}


class SubgraphTemplateDetailResponse(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    label: Optional[str] = None
    nodes: list[SubgraphNodeResponse]
    edges: list[SubgraphEdgeResponse]
    arguments: list[ArgumentResponse]
    output_schema: Optional[dict[str, str]] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime

    model_config = {"from_attributes": True}


class SubgraphTemplateListResponse(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    name: str
    label: Optional[str] = None
    created_at: datetime.datetime
    updated_at: datetime.datetime

    model_config = {"from_attributes": True}


# --- Helpers ---

def _agent_config_from(obj: Any) -> Optional[AgentConfig]:
    if obj.agent_type is None:
        return None
    if obj.agent_type == "pydantic":
        images_raw = _parse_json_field(obj, "images")
        images = [ImageAttachment(**img) for img in images_raw] if images_raw else []
        return PydanticAgentConfig(
            agent_type=obj.agent_type,
            model=obj.model,
            prompt=obj.prompt,
            images=images,
        )
    return OpenCodeAgentConfig(
        agent_type=obj.agent_type,
        model=obj.model,
        prompt=obj.prompt,
        graph_tools=getattr(obj, "graph_tools", False),
    )


def _command_config_from(obj: Any) -> Optional[CommandConfig]:
    if obj.command is None:
        return None
    return CommandConfig(command=obj.command)


def _view_config_from(obj: Any) -> Optional[ViewConfig]:
    node_type = getattr(obj, "node_type", None)
    if hasattr(node_type, "value"):
        node_type = node_type.value
    if node_type != "view":
        return None
    images_raw = _parse_json_field(obj, "images")
    images = [ImageAttachment(**img) for img in images_raw] if images_raw else []
    return ViewConfig(images=images)


def _node_response(n: Any) -> SubgraphNodeResponse:
    bindings = None
    if n.argument_bindings:
        try:
            bindings = json.loads(n.argument_bindings)
        except (json.JSONDecodeError, TypeError):
            bindings = None
    return SubgraphNodeResponse(
        id=n.id,
        subgraph_template_id=n.subgraph_template_id,
        node_type=n.node_type,
        name=n.name,
        agent_config=_agent_config_from(n),
        command_config=_command_config_from(n),
        view_config=_view_config_from(n),
        task_template_id=n.task_template_id,
        ref_subgraph_template_id=n.ref_subgraph_template_id,
        argument_bindings=bindings,
        output_schema=_parse_json_field(n, "output_schema"),
        created_at=n.created_at,
    )


def _require_subgraph_template(workspace_id: uuid.UUID, template_id: uuid.UUID, session: Session) -> Any:
    tmpl = svc.get_subgraph_template(session, workspace_id, template_id)
    if tmpl is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subgraph template not found")
    return tmpl


def _to_detail(t: Any) -> SubgraphTemplateDetailResponse:
    return SubgraphTemplateDetailResponse(
        id=t.id,
        workspace_id=t.workspace_id,
        name=t.name,
        label=t.label,
        nodes=[_node_response(n) for n in t.nodes if not n.deleted],
        edges=[SubgraphEdgeResponse.model_validate(e) for e in t.edges if not e.deleted],
        arguments=[_arg_response(a) for a in t.arguments if not a.deleted],
        output_schema=_parse_json_field(t, "output_schema"),
        created_at=t.created_at,
        updated_at=t.updated_at,
    )


def _to_node_inputs(nodes: list[SubgraphNodeInputSchema]) -> list[SubgraphNodeInput]:
    result = []
    for n in nodes:
        ac = n.agent_config
        cc = n.command_config
        vc = getattr(n, "view_config", None)
        images = None
        if isinstance(ac, PydanticAgentConfig) and ac.images:
            images = [img.model_dump(mode="json") for img in ac.images]
        elif vc and vc.images:
            images = [img.model_dump(mode="json") for img in vc.images]
        result.append(SubgraphNodeInput(
            node_type=n.node_type,
            name=n.name,
            agent_type=ac.agent_type if ac else None,
            model=ac.model.value if ac and ac.model else None,
            prompt=ac.prompt if ac else None,
            command=cc.command if cc else None,
            graph_tools=getattr(ac, "graph_tools", False) if ac else False,
            task_template_id=n.task_template_id,
            ref_subgraph_template_id=n.ref_subgraph_template_id,
            argument_bindings=n.argument_bindings,
            output_schema=n.output_schema,
            images=images,
        ))
    return result


# --- Endpoints ---

@sub_router.post("", response_model=SubgraphTemplateDetailResponse, status_code=status.HTTP_201_CREATED)
def create_subgraph_template(
    workspace_id: uuid.UUID, body: CreateSubgraphTemplateRequest, session: SessionDep
) -> Any:
    _require_workspace(workspace_id, session)
    try:
        tmpl = svc.create_subgraph_template(
            session,
            workspace_id=workspace_id,
            name=body.name,
            nodes=_to_node_inputs(body.nodes),
            edges=[SubgraphEdgeInput(from_index=e.from_index, to_index=e.to_index) for e in body.edges],
            arguments=_to_arg_inputs(body.arguments),
            label=body.label,
            output_schema=body.output_schema,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    return _to_detail(tmpl)


@sub_router.get("", response_model=list[SubgraphTemplateListResponse])
def list_subgraph_templates(workspace_id: uuid.UUID, session: SessionDep) -> Any:
    _require_workspace(workspace_id, session)
    return [
        SubgraphTemplateListResponse.model_validate(t)
        for t in svc.list_subgraph_templates(session, workspace_id)
    ]


@sub_router.get("/{template_id}", response_model=SubgraphTemplateDetailResponse)
def get_subgraph_template(workspace_id: uuid.UUID, template_id: uuid.UUID, session: SessionDep) -> Any:
    _require_workspace(workspace_id, session)
    tmpl = _require_subgraph_template(workspace_id, template_id, session)
    return _to_detail(tmpl)


@sub_router.put("/{template_id}", response_model=SubgraphTemplateDetailResponse)
def update_subgraph_template(
    workspace_id: uuid.UUID,
    template_id: uuid.UUID,
    body: CreateSubgraphTemplateRequest,
    session: SessionDep,
) -> Any:
    _require_workspace(workspace_id, session)
    tmpl = _require_subgraph_template(workspace_id, template_id, session)
    try:
        tmpl = svc.update_subgraph_template(
            session,
            tmpl=tmpl,
            name=body.name,
            nodes=_to_node_inputs(body.nodes),
            edges=[SubgraphEdgeInput(from_index=e.from_index, to_index=e.to_index) for e in body.edges],
            arguments=_to_arg_inputs(body.arguments),
            label=body.label,
            output_schema=body.output_schema,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    return _to_detail(tmpl)


@sub_router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_subgraph_template(workspace_id: uuid.UUID, template_id: uuid.UUID, session: SessionDep) -> None:
    _require_workspace(workspace_id, session)
    deleted = svc.delete_subgraph_template(session, workspace_id, template_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subgraph template not found")


# --- Node sub-resource ---

@sub_router.post("/{template_id}/nodes", response_model=SubgraphNodeResponse, status_code=status.HTTP_201_CREATED)
def add_subgraph_node(
    workspace_id: uuid.UUID,
    template_id: uuid.UUID,
    body: AddSubgraphNodeRequest,
    session: SessionDep,
) -> Any:
    _require_workspace(workspace_id, session)
    tmpl = _require_subgraph_template(workspace_id, template_id, session)
    ac = body.agent_config
    cc = body.command_config
    vc = body.view_config
    images = None
    if isinstance(ac, PydanticAgentConfig) and ac.images:
        images = [img.model_dump(mode="json") for img in ac.images]
    elif vc and vc.images:
        images = [img.model_dump(mode="json") for img in vc.images]
    try:
        node = svc.add_subgraph_template_node(
            session,
            tmpl=tmpl,
            node_type=body.node_type,
            name=body.name,
            agent_type=ac.agent_type if ac else None,
            model=ac.model.value if ac and ac.model else None,
            prompt=ac.prompt if ac else None,
            command=cc.command if cc else None,
            graph_tools=getattr(ac, "graph_tools", False) if ac else False,
            task_template_id=body.task_template_id,
            ref_subgraph_template_id=body.ref_subgraph_template_id,
            argument_bindings=body.argument_bindings,
            output_schema=body.output_schema,
            images=images,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    return _node_response(node)


@sub_router.patch("/{template_id}/nodes/{node_id}", response_model=SubgraphNodeResponse)
def patch_subgraph_node(
    workspace_id: uuid.UUID,
    template_id: uuid.UUID,
    node_id: uuid.UUID,
    body: PatchSubgraphNodeRequest,
    session: SessionDep,
) -> Any:
    _require_workspace(workspace_id, session)
    tmpl = _require_subgraph_template(workspace_id, template_id, session)
    ac = body.agent_config
    cc = body.command_config
    vc = body.view_config
    images = None
    if isinstance(ac, PydanticAgentConfig) and ac.images:
        images = [img.model_dump(mode="json") for img in ac.images]
    elif vc and vc.images:
        images = [img.model_dump(mode="json") for img in vc.images]
    try:
        node = svc.patch_subgraph_template_node(
            session,
            tmpl=tmpl,
            node_id=node_id,
            name=body.name,
            node_type=body.node_type,
            agent_type=ac.agent_type if ac else None,
            model=ac.model.value if ac and ac.model else None,
            prompt=ac.prompt if ac else None,
            command=cc.command if cc else None,
            graph_tools=getattr(ac, "graph_tools", None) if ac else None,
            task_template_id=body.task_template_id,
            ref_subgraph_template_id=body.ref_subgraph_template_id,
            argument_bindings=body.argument_bindings,
            output_schema=body.output_schema,
            images=images,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))
    if node is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Node not found")
    return _node_response(node)


@sub_router.delete("/{template_id}/nodes/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_subgraph_node(
    workspace_id: uuid.UUID,
    template_id: uuid.UUID,
    node_id: uuid.UUID,
    session: SessionDep,
) -> None:
    _require_workspace(workspace_id, session)
    tmpl = _require_subgraph_template(workspace_id, template_id, session)
    deleted = svc.delete_subgraph_template_node(session, tmpl=tmpl, node_id=node_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Node not found")


# --- Edge sub-resource ---

@sub_router.post("/{template_id}/edges", response_model=SubgraphEdgeResponse, status_code=status.HTTP_201_CREATED)
def add_subgraph_edge(
    workspace_id: uuid.UUID,
    template_id: uuid.UUID,
    body: AddSubgraphEdgeRequest,
    session: SessionDep,
) -> Any:
    _require_workspace(workspace_id, session)
    tmpl = _require_subgraph_template(workspace_id, template_id, session)
    try:
        edge = svc.add_subgraph_template_edge(
            session, tmpl=tmpl, from_node_id=body.from_node_id, to_node_id=body.to_node_id,
        )
    except ValueError as e:
        detail = str(e)
        if "not found" in detail:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=detail)
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=detail)
    return SubgraphEdgeResponse.model_validate(edge)


@sub_router.delete("/{template_id}/edges/{edge_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_subgraph_edge(
    workspace_id: uuid.UUID,
    template_id: uuid.UUID,
    edge_id: uuid.UUID,
    session: SessionDep,
) -> None:
    _require_workspace(workspace_id, session)
    tmpl = _require_subgraph_template(workspace_id, template_id, session)
    deleted = svc.delete_subgraph_template_edge(session, tmpl=tmpl, edge_id=edge_id)
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Edge not found")
