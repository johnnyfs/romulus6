import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.backend_client import BackendClient
from app.config import settings
from app.agents.opencode import OpenCodeServer
from app.routers import sessions, commands
from app.session_manager import SessionManager

@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.getLogger().setLevel(settings.log_level)
    server = OpenCodeServer()
    await server.start(workdir=settings.workspace_root)
    backend_client = BackendClient()
    await backend_client.start()
    app.state.session_manager = SessionManager(server, backend_client)
    app.state.backend_client = backend_client
    yield
    mgr: SessionManager = app.state.session_manager
    for runner in list(mgr._runners.values()):
        await runner.interrupt()
    await backend_client.stop()
    await server.stop()

app = FastAPI(title="Worker", lifespan=lifespan)
app.include_router(sessions.router)
app.include_router(commands.router)

@app.get("/health")
def health():
    return {"status": "ok"}
