import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session, select

from app.models.agent import Agent
from app.models.lease import WorkerLease, WorkerLeaseStatus
from app.database import get_session
from app.models.sandbox import Sandbox
from app.models.worker import Worker
from app.models.workspace import Workspace
from app.services import sandboxes as svc
from app.services import workers as worker_svc

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


class DebugAgentSummary(BaseModel):
    id: uuid.UUID
    name: str
    agent_type: str
    model: str
    status: str
    dismissed: bool
    sandbox_id: uuid.UUID | None = None
    session_id: str | None = None
    updated_at: str


class DebugSandboxSummary(BaseModel):
    id: uuid.UUID
    name: str
    worker_id: uuid.UUID | None = None
    current_lease_id: uuid.UUID | None = None
    active_agent_count: int
    dismissed_agent_count: int
    agents: list[DebugAgentSummary]


class DebugWorkerSummary(BaseModel):
    id: uuid.UUID
    status: str
    is_healthy: bool
    pod_name: str | None = None
    pod_ip: str | None = None
    worker_url: str | None = None
    last_heartbeat_at: str | None = None
    active_lease_id: uuid.UUID | None = None
    active_lease_workspace_id: uuid.UUID | None = None
    active_lease_sandbox_id: uuid.UUID | None = None
    active_lease_expires_at: str | None = None
    sandbox_name: str | None = None
    live_agent_count: int
    dismissed_agent_count: int


class SandboxDebugSummary(BaseModel):
    workspace_id: uuid.UUID
    active_agent_count: int
    dismissed_agent_count: int
    sandbox_count: int
    worker_count: int
    attached_worker_count: int
    sandboxes: list[DebugSandboxSummary]
    unassigned_agents: list[DebugAgentSummary]
    workers: list[DebugWorkerSummary]


def _require_workspace(workspace_id: uuid.UUID, session: Session) -> Workspace:
    workspace = session.get(Workspace, workspace_id)
    if workspace is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Workspace not found"
        )
    return workspace


def _agent_summary(agent: Agent) -> DebugAgentSummary:
    return DebugAgentSummary(
        id=agent.id,
        name=agent.name,
        agent_type=agent.agent_type.value,
        model=agent.model,
        status=agent.status.value,
        dismissed=agent.dismissed,
        sandbox_id=agent.sandbox_id,
        session_id=agent.session_id,
        updated_at=agent.updated_at.isoformat(),
    )


@router.get("", response_model=list[Sandbox])
def list_sandboxes(workspace_id: uuid.UUID, session: SessionDep) -> Any:
    _require_workspace(workspace_id, session)
    return svc.list_sandboxes(session, workspace_id)


@router.get("/debug", response_model=SandboxDebugSummary)
def get_sandbox_debug_summary(workspace_id: uuid.UUID, session: SessionDep) -> Any:
    _require_workspace(workspace_id, session)

    sandboxes = list(
        session.exec(
            Sandbox.active()
            .where(Sandbox.workspace_id == workspace_id)
            .order_by(Sandbox.created_at.asc())
        ).all()
    )
    agents = list(
        session.exec(
            Agent.active()
            .where(Agent.workspace_id == workspace_id)
            .order_by(Agent.created_at.asc())
        ).all()
    )
    workers = list(
        session.exec(Worker.active().order_by(Worker.created_at.asc())).all()
    )
    active_leases = list(
        session.exec(
            select(WorkerLease)
            .where(WorkerLease.deleted == False)  # noqa: E712
            .where(WorkerLease.status == WorkerLeaseStatus.active)
        ).all()
    )

    agents_by_sandbox: dict[uuid.UUID, list[Agent]] = {}
    unassigned_agents: list[Agent] = []
    for agent in agents:
        if agent.sandbox_id is None:
            unassigned_agents.append(agent)
            continue
        agents_by_sandbox.setdefault(agent.sandbox_id, []).append(agent)

    leases_by_worker = {lease.worker_id: lease for lease in active_leases}
    sandboxes_by_id = {sandbox.id: sandbox for sandbox in sandboxes}

    sandbox_summaries = []
    for sandbox in sandboxes:
        sandbox_agents = agents_by_sandbox.get(sandbox.id, [])
        sandbox_summaries.append(
            DebugSandboxSummary(
                id=sandbox.id,
                name=sandbox.name,
                worker_id=sandbox.worker_id,
                current_lease_id=sandbox.current_lease_id,
                active_agent_count=sum(1 for agent in sandbox_agents if not agent.dismissed),
                dismissed_agent_count=sum(1 for agent in sandbox_agents if agent.dismissed),
                agents=[_agent_summary(agent) for agent in sandbox_agents],
            )
        )

    worker_summaries = []
    for worker in workers:
        lease = leases_by_worker.get(worker.id)
        sandbox = sandboxes_by_id.get(lease.sandbox_id) if lease is not None else None
        sandbox_agents = agents_by_sandbox.get(sandbox.id, []) if sandbox is not None else []
        worker_summaries.append(
            DebugWorkerSummary(
                id=worker.id,
                status=worker.status.value,
                is_healthy=worker_svc.is_worker_healthy(worker),
                pod_name=worker.pod_name,
                pod_ip=worker.pod_ip,
                worker_url=worker.worker_url,
                last_heartbeat_at=(
                    worker.last_heartbeat_at.isoformat()
                    if worker.last_heartbeat_at is not None
                    else None
                ),
                active_lease_id=lease.id if lease is not None else None,
                active_lease_workspace_id=lease.workspace_id if lease is not None else None,
                active_lease_sandbox_id=lease.sandbox_id if lease is not None else None,
                active_lease_expires_at=(
                    lease.heartbeat_expires_at.isoformat()
                    if lease is not None and lease.heartbeat_expires_at is not None
                    else None
                ),
                sandbox_name=sandbox.name if sandbox is not None else None,
                live_agent_count=sum(1 for agent in sandbox_agents if not agent.dismissed),
                dismissed_agent_count=sum(1 for agent in sandbox_agents if agent.dismissed),
            )
        )

    return SandboxDebugSummary(
        workspace_id=workspace_id,
        active_agent_count=sum(1 for agent in agents if not agent.dismissed),
        dismissed_agent_count=sum(1 for agent in agents if agent.dismissed),
        sandbox_count=len(sandboxes),
        worker_count=len(workers),
        attached_worker_count=sum(1 for worker in worker_summaries if worker.active_lease_id is not None),
        sandboxes=sandbox_summaries,
        unassigned_agents=[_agent_summary(agent) for agent in unassigned_agents],
        workers=worker_summaries,
    )


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
