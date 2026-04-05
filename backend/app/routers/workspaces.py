import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session

from app.database import get_session
from app.models.workspace import Workspace
from app.services import workspaces as svc

router = APIRouter(prefix="/workspaces", tags=["workspaces"])

SessionDep = Annotated[Session, Depends(get_session)]


class CreateWorkspaceRequest(BaseModel):
    name: str


@router.get("", response_model=list[Workspace])
def list_workspaces(session: SessionDep):
    return svc.list_workspaces(session)


@router.post("", response_model=Workspace, status_code=status.HTTP_201_CREATED)
def create_workspace(body: CreateWorkspaceRequest, session: SessionDep):
    return svc.create_workspace(session, body.name)


@router.get("/{id}", response_model=Workspace)
def get_workspace(id: uuid.UUID, session: SessionDep):
    workspace = svc.get_workspace(session, id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    return workspace


@router.delete("/{id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_workspace(id: uuid.UUID, session: SessionDep):
    if not svc.delete_workspace(session, id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
