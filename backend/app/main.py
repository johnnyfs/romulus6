import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app import k8s
from app.routers.agents import router as agents_router
from app.routers.graphs import router as graphs_router
from app.routers.sandboxes import router as sandboxes_router
from app.routers.workspaces import router as workspaces_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    k8s.init_k8s()
    yield


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


@app.get("/health")
def health():
    return {"status": "ok"}
