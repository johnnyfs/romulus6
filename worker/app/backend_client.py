import asyncio
import logging
import os
import socket
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class BackendClient:
    def __init__(self) -> None:
        self._client = httpx.AsyncClient(timeout=10.0)
        self.worker_id: str | None = None
        self._heartbeat_task: asyncio.Task | None = None
        self._stopped = False

    @property
    def worker_url(self) -> str:
        if settings.advertise_url:
            return settings.advertise_url
        if settings.pod_ip:
            return f"http://{settings.pod_ip}:{settings.port}"
        return f"http://localhost:{settings.port}"

    async def start(self) -> None:
        await self._register_until_ready()
        self._heartbeat_task = asyncio.create_task(self._heartbeat_loop())

    async def stop(self) -> None:
        self._stopped = True
        if self._heartbeat_task is not None:
            self._heartbeat_task.cancel()
            try:
                await self._heartbeat_task
            except asyncio.CancelledError:
                pass
        await self._client.aclose()

    async def send_event(self, event: dict[str, Any]) -> None:
        if not self.worker_id:
            return
        try:
            await self._client.post(
                f"{settings.romulus_backend_url}/workers/{self.worker_id}/events",
                json={"event": event},
            )
        except Exception:
            logger.exception("failed to forward worker event")

    async def _register_until_ready(self) -> None:
        while not self._stopped and self.worker_id is None:
            try:
                resp = await self._client.post(
                    f"{settings.romulus_backend_url}/workers/register",
                    json={
                        "worker_url": self.worker_url,
                        "pod_name": settings.pod_name or socket.gethostname(),
                        "pod_ip": settings.pod_ip,
                        "registration_key": settings.registration_key,
                        "metadata": {"hostname": socket.gethostname(), "pid": os.getpid()},
                    },
                )
                resp.raise_for_status()
                self.worker_id = resp.json()["id"]
                return
            except Exception:
                logger.exception("worker registration failed, retrying")
                await asyncio.sleep(settings.register_retry_seconds)

    async def _heartbeat_loop(self) -> None:
        while not self._stopped:
            if self.worker_id:
                try:
                    await self._client.post(
                        f"{settings.romulus_backend_url}/workers/{self.worker_id}/heartbeat",
                        json={
                            "worker_url": self.worker_url,
                            "pod_ip": settings.pod_ip,
                            "metadata": {"hostname": socket.gethostname()},
                        },
                    )
                except Exception:
                    logger.exception("worker heartbeat failed")
            await asyncio.sleep(settings.heartbeat_interval_seconds)
