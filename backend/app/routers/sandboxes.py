import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session

from app.database import get_session
from app.models.sandbox import Sandbox
from app.models.worker import Worker
from app.models.workspace import Workspace
from app.services import sandboxes as svc

router = APIRouter(
    prefix="/workspaces/{workspace_id}/sandboxes",
    tags=["sandboxes"],
)

SessionDep = Annotated[Session, Depends(get_session)]


class CreateSandboxRequest(BaseModel):
    name: str


class SandboxResponse(BaseModel):
    sandbox: Sandbox
    worker: Worker

    model_config = {"arbitrary_types_allowed": True}


def _require_workspace(workspace_id: uuid.UUID, session: Session) -> Workspace:
    workspace = session.get(Workspace, workspace_id)
    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found"
        )
    return workspace


@router.get("", response_model=list[Sandbox])
def list_sandboxes(workspace_id: uuid.UUID, session: SessionDep) -> Any:
    _require_workspace(workspace_id, session)
    return svc.list_sandboxes(session, workspace_id)


@router.post("", response_model=SandboxResponse, status_code=status.HTTP_201_CREATED)
def create_sandbox(
    workspace_id: uuid.UUID, body: CreateSandboxRequest, session: SessionDep
) -> Any:
    _require_workspace(workspace_id, session)
    try:
        sandbox, worker = svc.create_sandbox(session, workspace_id, body.name)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        )
    return SandboxResponse(sandbox=sandbox, worker=worker)


@router.get("/{sandbox_id}", response_model=SandboxResponse)
def get_sandbox(
    workspace_id: uuid.UUID, sandbox_id: uuid.UUID, session: SessionDep
) -> Any:
    _require_workspace(workspace_id, session)
    sandbox = svc.get_sandbox(session, workspace_id, sandbox_id)
    if sandbox is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Sandbox not found"
        )
    worker = session.get(Worker, sandbox.worker_id)
    return SandboxResponse(sandbox=sandbox, worker=worker)


@router.delete("/{sandbox_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_sandbox(
    workspace_id: uuid.UUID, sandbox_id: uuid.UUID, session: SessionDep
) -> None:
    _require_workspace(workspace_id, session)
    if not svc.delete_sandbox(session, workspace_id, sandbox_id):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Sandbox not found"
        )
