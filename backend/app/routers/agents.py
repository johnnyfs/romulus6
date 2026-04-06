import uuid
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlmodel import Session

from app.database import get_session
from app.models.agent import Agent, AgentConfig, AgentType
from app.models.workspace import Workspace
from app.services import agents as svc

router = APIRouter(
    prefix="/workspaces/{workspace_id}/agents",
    tags=["agents"],
)

SessionDep = Annotated[Session, Depends(get_session)]


class CreateOpenCodeAgentRequest(AgentConfig):
    name: str


# To add more agent types later, convert to:
#   CreateAgentRequest = Annotated[
#       CreateOpenCodeAgentRequest | CreateFooAgentRequest,
#       Field(discriminator="agent_type")
#   ]
CreateAgentRequest = CreateOpenCodeAgentRequest


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
            graph_tools=body.graph_tools,
        )
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(e))
    except httpx.HTTPStatusError as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))
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
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e)
        )
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
