import asyncio

from fastapi import APIRouter, HTTPException

from app.config import settings
from app.models import CommandRequest, CommandResponse

router = APIRouter(prefix="/commands", tags=["commands"])

_CANONICAL_WORKSPACE_ROOT = "/workspaces"


def _translate_workspace_path(value: str | None) -> str | None:
    """Map canonical backend sandbox paths onto the worker's actual local root."""
    if value is None:
        return None

    actual_root = settings.workspace_root.rstrip("/")
    canonical_root = _CANONICAL_WORKSPACE_ROOT
    if not actual_root or actual_root == canonical_root:
        return value

    translated = value.replace(f"{canonical_root}/", f"{actual_root}/")
    if translated == canonical_root:
        return actual_root
    if value.startswith(canonical_root) and translated == value:
        suffix = value[len(canonical_root):]
        return f"{actual_root}{suffix}"
    return translated


def _translate_command_request(body: CommandRequest) -> tuple[list[str], str | None]:
    command = [_translate_workspace_path(part) or part for part in body.command]
    cwd = _translate_workspace_path(body.cwd)
    return command, cwd


@router.post("", response_model=CommandResponse)
async def run_command(body: CommandRequest):
    command, cwd = _translate_command_request(body)
    try:
        proc = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=body.timeout)
        return CommandResponse(
            exit_code=proc.returncode,
            stdout=stdout.decode("utf-8", errors="replace"),
            stderr=stderr.decode("utf-8", errors="replace"),
        )
    except asyncio.TimeoutError:
        proc.kill()
        raise HTTPException(status_code=408, detail="Command timed out")
    except FileNotFoundError:
        raise HTTPException(status_code=400, detail=f"Command not found: {command[0]}")
