import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlmodel import Session

from app.database import engine, get_session
from app.models.workspace import Workspace
from app.services import events as event_svc

router = APIRouter(prefix="/workspaces/{workspace_id}/events", tags=["events"])

SessionDep = Annotated[Session, Depends(get_session)]


def _require_workspace(workspace_id: uuid.UUID, session: Session) -> Workspace:
    workspace = session.get(Workspace, workspace_id)
    if workspace is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found")
    return workspace


@router.get("")
def list_workspace_events(
    workspace_id: uuid.UUID,
    session: SessionDep,
    since: int = 0,
    limit: int = 200,
) -> Any:
    _require_workspace(workspace_id, session)
    return event_svc.list_workspace_events(session, workspace_id, since=since, limit=limit)


@router.get("/stream")
def stream_workspace_events(
    workspace_id: uuid.UUID,
    session: SessionDep,
    since: int = 0,
) -> StreamingResponse:
    _require_workspace(workspace_id, session)
    return StreamingResponse(
        event_svc.stream_workspace_events(lambda: Session(engine), workspace_id, since=since),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
