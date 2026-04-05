from abc import ABC, abstractmethod
from collections.abc import AsyncGenerator
from app.models import Event

class AgentRunner(ABC):
    @abstractmethod
    async def start(
        self,
        prompt: str,
        workspace_dir: str,
        model: str,
        opencode_session_id: str | None = None,
    ) -> None: ...

    @abstractmethod
    async def events(self) -> AsyncGenerator[Event, None]: ...  # type: ignore[override]

    @abstractmethod
    async def interrupt(self) -> None: ...

    @property
    @abstractmethod
    def is_running(self) -> bool: ...
