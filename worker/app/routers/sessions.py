import json
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from app.models import (
    CreateSessionRequest, CreateSessionResponse,
    SendMessageRequest, InterruptRequest, Session,
)
from app.session_manager import SessionManager

router = APIRouter(prefix="/sessions", tags=["sessions"])

def get_manager(request: Request) -> SessionManager:
    return request.app.state.session_manager

@router.post("", response_model=CreateSessionResponse, status_code=status.HTTP_201_CREATED)
async def create_session(body: CreateSessionRequest, mgr: SessionManager = Depends(get_manager)):
    session = await mgr.create_session(
        prompt=body.prompt,
        agent_type=body.agent_type,
        model=body.model,
        workspace_name=body.workspace_name,
        graph_tools=body.graph_tools,
        workspace_id=body.workspace_id,
        sandbox_id=body.sandbox_id,
    )
    return CreateSessionResponse(session=session)

@router.get("/{session_id}", response_model=Session)
def get_session(session_id: str, mgr: SessionManager = Depends(get_manager)):
    try:
        return mgr.get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

@router.post("/{session_id}/messages", status_code=status.HTTP_202_ACCEPTED)
async def send_message(session_id: str, body: SendMessageRequest, mgr: SessionManager = Depends(get_manager)):
    try:
        await mgr.send_message(session_id, body.prompt)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return {"accepted": True}

@router.post("/{session_id}/interrupt", status_code=status.HTTP_202_ACCEPTED)
async def interrupt_session(session_id: str, body: InterruptRequest, mgr: SessionManager = Depends(get_manager)):
    try:
        await mgr.interrupt(session_id, reason=body.reason)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")
    return {"accepted": True}

@router.get("/{session_id}/events")
async def get_events(
    session_id: str,
    since: int = 0,
    stream: bool = True,
    mgr: SessionManager = Depends(get_manager),
):
    try:
        mgr.get_session(session_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Session not found")

    if not stream:
        events = mgr.get_events(session_id, since=since)
        return [e.model_dump(mode="json") for e in events]

    async def event_generator():
        async for event in mgr.stream_events(session_id, since=since):
            if event is None:
                yield ": keepalive\n\n"
            else:
                data = json.dumps(event.model_dump(mode="json"))
                yield f"id: {event.id}\ndata: {data}\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
