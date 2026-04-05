import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.config import settings
from app.agents.opencode import OpenCodeServer
from app.routers import sessions, commands
from app.session_manager import SessionManager

@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.getLogger().setLevel(settings.log_level)
    server = OpenCodeServer()
    await server.start(workdir=settings.workspace_root)
    app.state.session_manager = SessionManager(server)
    yield
    mgr: SessionManager = app.state.session_manager
    for runner in list(mgr._runners.values()):
        await runner.interrupt()
    await server.stop()

app = FastAPI(title="Worker", lifespan=lifespan)
app.include_router(sessions.router)
app.include_router(commands.router)

@app.get("/health")
def health():
    return {"status": "ok"}
