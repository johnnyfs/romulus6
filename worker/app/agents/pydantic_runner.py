import asyncio
from collections.abc import AsyncIterator

from app.agents.base import AgentRunner
from app.models import Event, EventType, Session
from app.services.pydantic_agent_service import PydanticAgentService


class PydanticRunner(AgentRunner):
    def __init__(self, session_id: str, service: PydanticAgentService):
        self._session_id = session_id
        self._service = service
        self._queue: asyncio.Queue[Event | None] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None

    async def start(self, *, prompt: str, session: Session) -> None:
        if session.schema_id is None and session.output_schema is None:
            raise ValueError("schema_id or output_schema is required for pydantic runner")

        async def _run() -> None:
            try:
                # Follow-up pydantic dispatches are intentionally stateless in v1.
                # We will eventually need to replay prior event history as model input.
                await self._queue.put(Event(session_id=self._session_id, type=EventType.SESSION_BUSY, data={}))
                output = await self._service.run(
                    model=session.model,
                    prompt=prompt,
                    schema_id=session.schema_id,
                    output_schema=session.output_schema,
                    images=session.images,
                )
                await self._queue.put(
                    Event(
                        session_id=self._session_id,
                        type=EventType.TEXT_DELTA,
                        data={
                            "delta": output.model_dump_json(indent=2),
                            "schema_id": session.schema_id,
                            "output_schema": session.output_schema,
                            "structured_output": output.model_dump(mode="json"),
                        },
                    )
                )
                await self._queue.put(Event(session_id=self._session_id, type=EventType.SESSION_IDLE, data={}))
            except Exception as exc:
                await self._queue.put(
                    Event(
                        session_id=self._session_id,
                        type=EventType.SESSION_ERROR,
                        data={"error": str(exc)},
                    )
                )
            finally:
                await self._queue.put(None)

        self._task = asyncio.create_task(_run())

    async def events(self) -> AsyncIterator[Event]:
        while True:
            event = await self._queue.get()
            if event is None:
                return
            yield event

    async def interrupt(self) -> None:
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()
