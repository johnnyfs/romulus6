import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.database import get_session
from app.models.worker import Worker
from app.services import events as event_svc
from app.services import workers as worker_svc

router = APIRouter(prefix="/workers", tags=["workers"])

SessionDep = Annotated[Session, Depends(get_session)]


class RegisterWorkerRequest(BaseModel):
    worker_url: str
    pod_name: str | None = None
    pod_ip: str | None = None
    registration_key: str | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class HeartbeatWorkerRequest(BaseModel):
    worker_url: str | None = None
    pod_ip: str | None = None
    metadata: dict[str, Any] | None = None


class IngestWorkerEventRequest(BaseModel):
    event: dict[str, Any]


@router.post("/register", response_model=Worker, status_code=status.HTTP_201_CREATED)
def register_worker(body: RegisterWorkerRequest, session: SessionDep) -> Any:
    return worker_svc.register_worker(
        session,
        worker_url=body.worker_url,
        pod_name=body.pod_name,
        pod_ip=body.pod_ip,
        registration_key=body.registration_key,
        metadata=body.metadata,
    )


@router.post("/{worker_id}/heartbeat", response_model=Worker)
def heartbeat_worker(worker_id: uuid.UUID, body: HeartbeatWorkerRequest, session: SessionDep) -> Any:
    worker = worker_svc.heartbeat_worker(
        session,
        worker_id,
        worker_url=body.worker_url,
        pod_ip=body.pod_ip,
        metadata=body.metadata,
    )
    if worker is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Worker not found")
    return worker


@router.delete("/{worker_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_worker(worker_id: uuid.UUID, session: SessionDep) -> None:
    try:
        deleted = worker_svc.delete_worker(session, worker_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
    if not deleted:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Worker not found")


@router.post("/{worker_id}/events", status_code=status.HTTP_202_ACCEPTED)
def ingest_worker_event(worker_id: uuid.UUID, body: IngestWorkerEventRequest, session: SessionDep) -> Any:
    worker = worker_svc.get_worker(session, worker_id)
    if worker is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Worker not found")
    try:
        event = event_svc.ingest_worker_event(session, worker_id=worker_id, payload=body.event)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc))
    return {"accepted": True, "event_id": event.id if event is not None else None}
