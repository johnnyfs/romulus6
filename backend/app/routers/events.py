import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, HTTPException, status
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
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Workspace not found",
        )
    return workspace


@router.get("")
def list_workspace_events(
    workspace_id: uuid.UUID,
    session: SessionDep,
    since: int = 0,
    after: str | None = None,
    limit: int = 200,
) -> Any:
    _require_workspace(workspace_id, session)
    try:
        return event_svc.list_workspace_events(
            session,
            workspace_id,
            since=since,
            after=after,
            limit=limit,
        )
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        )


@router.get("/stream")
def stream_workspace_events(
    workspace_id: uuid.UUID,
    session: SessionDep,
    since: int = 0,
    after: str | None = None,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
) -> StreamingResponse:
    _require_workspace(workspace_id, session)
    cursor = after or last_event_id
    if cursor is not None:
        try:
            event_svc.decode_event_cursor(cursor)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=str(exc),
            )
    return StreamingResponse(
        event_svc.stream_workspace_events(
            lambda: Session(engine),
            workspace_id,
            since=since,
            after=cursor,
        ),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
