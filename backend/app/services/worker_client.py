import asyncio
from typing import Any

import httpx


async def post_session_with_retry(
    worker_url: str,
    payload: dict[str, Any],
    *,
    max_wait: int = 60,
    interval: float = 2.0,
) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + max_wait
    last_exc: Exception | None = None
    while asyncio.get_running_loop().time() < deadline:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{worker_url}/sessions",
                    json=payload,
                    timeout=10.0,
                )
                resp.raise_for_status()
                return resp.json()
        except (httpx.ConnectError, httpx.TimeoutException) as exc:
            last_exc = exc
            await asyncio.sleep(interval)
    raise RuntimeError(f"Worker did not become ready in time: {last_exc}") from last_exc


async def post_session_message(
    worker_url: str,
    session_id: str,
    prompt: str,
    *,
    timeout: float = 10.0,
) -> None:
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{worker_url}/sessions/{session_id}/messages",
            json={"prompt": prompt},
            timeout=timeout,
        )
        resp.raise_for_status()


async def execute_command(
    worker_url: str,
    *,
    command: list[str],
    cwd: str,
    timeout: int,
    request_timeout: float | None = None,
) -> dict[str, Any]:
    effective_request_timeout = (
        request_timeout
        if request_timeout is not None
        else max(float(timeout) + 5.0, 15.0)
    )
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{worker_url}/commands",
            json={"command": command, "cwd": cwd, "timeout": timeout},
            timeout=effective_request_timeout,
        )
        resp.raise_for_status()
        return resp.json()
