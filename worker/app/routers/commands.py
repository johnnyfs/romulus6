import asyncio
from fastapi import APIRouter, HTTPException
from app.models import CommandRequest, CommandResponse

router = APIRouter(prefix="/commands", tags=["commands"])

@router.post("", response_model=CommandResponse)
async def run_command(body: CommandRequest):
    try:
        proc = await asyncio.create_subprocess_exec(
            *body.command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=body.cwd,
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
        raise HTTPException(status_code=400, detail=f"Command not found: {body.command[0]}")
