import asyncio
from typing import Any

import httpx
from romulus_common.worker_api import (
    CommandRequest,
    CreateSessionRequest,
    SendMessageRequest,
)


async def post_session_with_retry(
    worker_url: str,
    payload: dict[str, Any] | CreateSessionRequest,
    *,
    max_wait: int = 60,
    interval: float = 2.0,
) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + max_wait
    last_exc: Exception | None = None
    request_body = (
        payload
        if isinstance(payload, CreateSessionRequest)
        else CreateSessionRequest.model_validate(payload)
    )
    while asyncio.get_running_loop().time() < deadline:
        try:
            async with httpx.AsyncClient() as client:
                resp = await client.post(
                    f"{worker_url}/sessions",
                    json=request_body.model_dump(mode="json", exclude_none=True),
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
    request_body = SendMessageRequest(prompt=prompt)
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{worker_url}/sessions/{session_id}/messages",
            json=request_body.model_dump(mode="json"),
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
    request_body = CommandRequest(command=command, cwd=cwd, timeout=timeout)
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{worker_url}/commands",
            json=request_body.model_dump(mode="json"),
            timeout=effective_request_timeout,
        )
        resp.raise_for_status()
        return resp.json()
