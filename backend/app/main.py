import os
import asyncio
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import k8s
from app.database import engine
from app.routers.events import router as events_router
from app.routers.agents import router as agents_router
from app.routers.graphs import router as graphs_router
from app.routers.graphs import runs_router
from app.routers.sandboxes import router as sandboxes_router
from app.routers.templates import schema_router as schema_templates_router
from app.routers.templates import sub_router as subgraph_templates_router
from app.routers.templates import task_router as task_templates_router
from app.routers.workers import router as workers_router
from app.routers.workspaces import router as workspaces_router
from app.services.controller import run_controller_loop
from app.services import events as event_svc
from sqlmodel import Session


@asynccontextmanager
async def lifespan(app: FastAPI):
    if os.environ.get("ENABLE_K8S", "1").lower() not in {"0", "false", "no"}:
        k8s.init_k8s()
    event_svc.start_event_listener(lambda: Session(engine))
    stop_event = asyncio.Event()
    controller_task = asyncio.create_task(run_controller_loop(stop_event))
    yield
    stop_event.set()
    await controller_task
    event_svc.stop_event_listener()


app = FastAPI(title="Romulus", lifespan=lifespan)

_frontend_port = os.environ.get("FRONTEND_PORT", "5173")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"http://localhost:{_frontend_port}"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(workspaces_router, prefix="/api/v1")
app.include_router(sandboxes_router, prefix="/api/v1")
app.include_router(agents_router, prefix="/api/v1")
app.include_router(graphs_router, prefix="/api/v1")
app.include_router(runs_router, prefix="/api/v1")
app.include_router(events_router, prefix="/api/v1")
app.include_router(workers_router, prefix="/api/v1")
app.include_router(task_templates_router, prefix="/api/v1")
app.include_router(schema_templates_router, prefix="/api/v1")
app.include_router(subgraph_templates_router, prefix="/api/v1")


@app.get("/health")
def health():
    return {
        "status": "ok",
        "deploy_mode": os.environ.get("DEPLOY_MODE", "local"),
    }
