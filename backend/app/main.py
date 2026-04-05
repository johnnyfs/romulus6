import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers.workspaces import router as workspaces_router

app = FastAPI(title="Romulus")

_frontend_port = os.environ.get("FRONTEND_PORT", "5173")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[f"http://localhost:{_frontend_port}"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(workspaces_router, prefix="/api/v1")


@app.get("/health")
def health():
    return {"status": "ok"}
