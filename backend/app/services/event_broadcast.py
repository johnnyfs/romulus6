import asyncio
import itertools
import threading
import uuid
from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class _Subscriber:
    queue: asyncio.Queue[dict[str, Any]]
    loop: asyncio.AbstractEventLoop


class EventBroadcaster:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscriptions: dict[str, dict[int, _Subscriber]] = {}
        self._token_counter = itertools.count(1)

    @staticmethod
    def workspace_channel(workspace_id: uuid.UUID | str) -> str:
        return f"workspace:{workspace_id}"

    @staticmethod
    def agent_channel(agent_id: uuid.UUID | str) -> str:
        return f"agent:{agent_id}"

    def subscribe(self, *channels: str) -> tuple[int, asyncio.Queue[dict[str, Any]]]:
        queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        subscriber = _Subscriber(queue=queue, loop=asyncio.get_running_loop())
        token = next(self._token_counter)
        with self._lock:
            for channel in channels:
                self._subscriptions.setdefault(channel, {})[token] = subscriber
        return token, queue

    def unsubscribe(self, token: int, *channels: str) -> None:
        with self._lock:
            for channel in channels:
                subscribers = self._subscriptions.get(channel)
                if subscribers is None:
                    continue
                subscribers.pop(token, None)
                if not subscribers:
                    self._subscriptions.pop(channel, None)

    def publish(self, event: dict[str, Any]) -> None:
        channels = [self.workspace_channel(event["workspace_id"])]
        agent_id = event.get("agent_id")
        if agent_id:
            channels.append(self.agent_channel(agent_id))

        subscribers: dict[int, _Subscriber] = {}
        with self._lock:
            for channel in channels:
                subscribers.update(self._subscriptions.get(channel, {}))

        stale_tokens: list[int] = []
        for token, subscriber in subscribers.items():
            try:
                subscriber.loop.call_soon_threadsafe(subscriber.queue.put_nowait, event)
            except RuntimeError:
                stale_tokens.append(token)

        if stale_tokens:
            with self._lock:
                for channel in channels:
                    registered = self._subscriptions.get(channel)
                    if registered is None:
                        continue
                    for token in stale_tokens:
                        registered.pop(token, None)
                    if not registered:
                        self._subscriptions.pop(channel, None)


event_broadcaster = EventBroadcaster()
