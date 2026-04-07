import uuid
from typing import Annotated, Any, Literal

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, model_validator
from sqlmodel import Session

from app.database import get_session
from app.models.agent import Agent, AgentType
from app.models.pydantic_agent import PydanticSchemaId
from app.models.supported_models import SupportedModel, validate_supported_model_for_agent_type
from app.models.workspace import Workspace
from app.services import agents as svc

router = APIRouter(
    prefix="/workspaces/{workspace_id}/agents",
    tags=["agents"],
)

SessionDep = Annotated[Session, Depends(get_session)]


def _raise_upstream_http_error(exc: httpx.HTTPStatusError) -> None:
    response = exc.response
    detail = response.text or str(exc)
    if 400 <= response.status_code < 500:
        raise HTTPException(status_code=response.status_code, detail=detail)
    raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=detail)


class CreateOpenCodeAgentRequest(BaseModel):
    agent_type: Literal["opencode"] = "opencode"
    model: SupportedModel
    prompt: str
    name: str | None = None
    graph_tools: bool = False

    @model_validator(mode="after")
    def validate_model(self) -> "CreateOpenCodeAgentRequest":
        validate_supported_model_for_agent_type(self.agent_type, self.model.value)
        return self


class CreatePydanticAgentRequest(BaseModel):
    agent_type: Literal["pydantic"] = "pydantic"
    model: SupportedModel
    prompt: str
    name: str | None = None
    schema_id: PydanticSchemaId

    @model_validator(mode="after")
    def validate_model(self) -> "CreatePydanticAgentRequest":
        validate_supported_model_for_agent_type(self.agent_type, self.model.value)
        return self


CreateAgentRequest = Annotated[
    CreateOpenCodeAgentRequest | CreatePydanticAgentRequest,
    Field(discriminator="agent_type"),
]


def _require_workspace(workspace_id: uuid.UUID, session: Session) -> Workspace:
    workspace = session.get(Workspace, workspace_id)
    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found"
        )
    return workspace


@router.post("", response_model=Agent, status_code=status.HTTP_201_CREATED)
async def create_agent(
    workspace_id: uuid.UUID, body: CreateAgentRequest, session: SessionDep
) -> Any:
    _require_workspace(workspace_id, session)
    try:
        return await svc.create_agent(
            session,
            workspace_id=workspace_id,
            agent_type=AgentType(body.agent_type),
            model=body.model.value,
            prompt=body.prompt,
            name=body.name,
            graph_tools=body.graph_tools if body.agent_type == "opencode" else False,
            schema_id=body.schema_id.value if body.agent_type == "pydantic" else None,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))
    except httpx.HTTPStatusError as e:
        _raise_upstream_http_error(e)
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))


@router.get("", response_model=list[Agent])
def list_agents(workspace_id: uuid.UUID, session: SessionDep) -> Any:
    _require_workspace(workspace_id, session)
    return svc.list_agents(session, workspace_id)


@router.get("/{agent_id}", response_model=Agent)
def get_agent(workspace_id: uuid.UUID, agent_id: uuid.UUID, session: SessionDep) -> Any:
    _require_workspace(workspace_id, session)
    agent = svc.get_agent(session, workspace_id, agent_id)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
    return agent


class SendMessageRequest(BaseModel):
    prompt: str


@router.post("/{agent_id}/messages", status_code=status.HTTP_202_ACCEPTED)
async def send_message(
    workspace_id: uuid.UUID,
    agent_id: uuid.UUID,
    body: SendMessageRequest,
    session: SessionDep,
) -> Any:
    _require_workspace(workspace_id, session)
    agent = svc.get_agent(session, workspace_id, agent_id)
    if agent is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found"
        )
    try:
        await svc.send_message(session, agent, body.prompt)
    except RuntimeError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e)
        )
    except httpx.TransportError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e)
        )
    except httpx.HTTPStatusError as e:
        _raise_upstream_http_error(e)
    return {"accepted": True}


class SendFeedbackRequest(BaseModel):
    feedback_id: str
    feedback_type: str
    response: str


@router.post("/{agent_id}/feedback", status_code=status.HTTP_202_ACCEPTED)
async def send_feedback(
    workspace_id: uuid.UUID,
    agent_id: uuid.UUID,
    body: SendFeedbackRequest,
    session: SessionDep,
) -> Any:
    _require_workspace(workspace_id, session)
    agent = svc.get_agent(session, workspace_id, agent_id)
    if agent is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found"
        )
    try:
        await svc.send_feedback(
            session, agent, body.feedback_id, body.feedback_type, body.response
        )
    except RuntimeError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e)
        )
    except httpx.TransportError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e)
        )
    except httpx.HTTPStatusError as e:
        _raise_upstream_http_error(e)
    return {"accepted": True}


@router.delete("/{agent_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_agent(workspace_id: uuid.UUID, agent_id: uuid.UUID, session: SessionDep) -> None:
    _require_workspace(workspace_id, session)
    if not svc.delete_agent(session, workspace_id, agent_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")


@router.get("/{agent_id}/events")
async def get_agent_events(
    workspace_id: uuid.UUID,
    agent_id: uuid.UUID,
    session: SessionDep,
    since: int = 0,
) -> Any:
    _require_workspace(workspace_id, session)
    agent = svc.get_agent(session, workspace_id, agent_id, include_deleted=True)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
    return await svc.get_agent_events(session, agent, since=since)


@router.get("/{agent_id}/events/stream")
async def stream_agent_events(
    workspace_id: uuid.UUID,
    agent_id: uuid.UUID,
    session: SessionDep,
    since: int = 0,
) -> StreamingResponse:
    _require_workspace(workspace_id, session)
    agent = svc.get_agent(session, workspace_id, agent_id, include_deleted=True)
    if agent is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Agent not found")
    return StreamingResponse(
        svc.stream_agent_events(session, agent, since=since),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
