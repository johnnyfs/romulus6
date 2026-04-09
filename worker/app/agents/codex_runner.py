import asyncio
import logging
import os
import uuid
from collections.abc import AsyncIterator

from app.agents.base import AgentRunner
from app.config import settings
from app.models import Event, EventType, Session
from app.recovery import build_recovery_prompt

logger = logging.getLogger(__name__)


class CodexRunner(AgentRunner):
    """Runs an OpenAI Agents SDK agent with the experimental codex_tool.

    Uses lazy imports so the worker can start even when the ``openai-agents``
    package is not installed — a clear error is raised only when a codex
    session is actually created.
    """

    def __init__(self, session_id: str):
        self._session_id = session_id
        self._queue: asyncio.Queue[Event | None] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None

    async def start(self, *, prompt: str, session: Session) -> None:
        effective_prompt = build_recovery_prompt(prompt=prompt, recovery=session.recovery)
        sandbox_mode = session.sandbox_mode or "read-only"
        # The SupportedModel values use "openai/gpt-5.3-codex" format;
        # the SDK expects the bare model name like "gpt-5.3-codex".
        model = session.model
        if "/" in model:
            model = model.split("/", 1)[1]

        workspace_dir = session.workspace_dir

        # Reuse codex thread from previous turn for multi-turn continuity.
        thread_id = session.runner_state.get("codex_thread_id")

        # Graph tools info passed via runner_state by session_manager.
        graph_tools_instructions = _build_graph_tools_instructions(session.runner_state)

        async def _run() -> None:
            # Ensure OPENAI_API_KEY is in os.environ for the OpenAI SDK.
            # settings.openai_api_key reads WORKER_OPENAI_API_KEY (due to env prefix);
            # the SDK reads OPENAI_API_KEY directly from os.environ.
            if not os.environ.get("OPENAI_API_KEY") and settings.openai_api_key:
                os.environ["OPENAI_API_KEY"] = settings.openai_api_key

            try:
                from agents import Agent, Runner  # type: ignore[import-untyped]
                from agents.extensions.experimental.codex import (  # type: ignore[import-untyped]
                    CodexToolStreamEvent,
                    CommandExecutionItem,
                    FileChangeItem,
                    ItemCompletedEvent,
                    ItemStartedEvent,
                    ItemUpdatedEvent,
                    ReasoningItem,
                    ThreadErrorEvent,
                    ThreadStartedEvent,
                    TurnCompletedEvent,
                    TurnFailedEvent,
                    AgentMessageItem,
                    ErrorItem,
                    ThreadOptions,
                    TurnOptions,
                    codex_tool,
                )
                from agents.extensions.experimental.codex.codex_options import (  # type: ignore[import-untyped]
                    CodexOptions,
                )
            except ImportError as exc:
                logger.error("openai-agents SDK not installed: %s", exc)
                await self._queue.put(
                    Event(
                        session_id=self._session_id,
                        type=EventType.SESSION_ERROR,
                        data={"error": f"openai-agents SDK not available: {exc}"},
                    )
                )
                return

            await self._queue.put(
                Event(session_id=self._session_id, type=EventType.SESSION_BUSY, data={})
            )

            # --- stream callback --------------------------------------------------
            async def on_stream(payload: CodexToolStreamEvent) -> None:
                event = payload.event
                logger.info("codex on_stream: %s", type(event).__name__)

                if isinstance(event, ThreadStartedEvent):
                    # Persist thread ID for multi-turn reuse.
                    session.runner_state["codex_thread_id"] = event.thread_id
                    logger.debug("codex thread started: %s", event.thread_id)
                    return

                if isinstance(event, TurnCompletedEvent):
                    logger.debug("codex turn completed, usage=%s", event.usage)
                    return

                if isinstance(event, TurnFailedEvent):
                    await self._queue.put(
                        Event(
                            session_id=self._session_id,
                            type=EventType.SESSION_ERROR,
                            data={"error": event.error.message},
                        )
                    )
                    return

                if isinstance(event, ThreadErrorEvent):
                    await self._queue.put(
                        Event(
                            session_id=self._session_id,
                            type=EventType.SESSION_ERROR,
                            data={"error": event.message},
                        )
                    )
                    return

                if not isinstance(event, (ItemStartedEvent, ItemUpdatedEvent, ItemCompletedEvent)):
                    return

                item = event.item

                if isinstance(item, (ReasoningItem, AgentMessageItem)):
                    # Don't emit these as TEXT_DELTA — the outer agent's
                    # final_output already includes the full response text.
                    # Emitting both causes duplicate messages.
                    pass
                elif isinstance(item, CommandExecutionItem):
                    await self._queue.put(
                        Event(
                            session_id=self._session_id,
                            type=EventType.TOOL_USE,
                            data={
                                "tool": "command",
                                "tool_name": "command",
                                "args": {"command": item.command},
                                "state": item.status,
                                "stdout": item.aggregated_output,
                            },
                        )
                    )
                elif isinstance(item, FileChangeItem):
                    for change in item.changes:
                        await self._queue.put(
                            Event(
                                session_id=self._session_id,
                                type=EventType.FILE_EDIT,
                                data={"path": change.path, "kind": change.kind},
                            )
                        )
                elif isinstance(item, ErrorItem):
                    await self._queue.put(
                        Event(
                            session_id=self._session_id,
                            type=EventType.SESSION_ERROR,
                            data={"error": item.message},
                        )
                    )

            # --- build and run the agent -----------------------------------------
            codex_options_kwargs: dict = {}
            if settings.codex_binary and settings.codex_binary != "codex":
                codex_options_kwargs["codex_path_override"] = settings.codex_binary
            if settings.openai_api_key:
                codex_options_kwargs["api_key"] = settings.openai_api_key

            tool = codex_tool(
                sandbox_mode=sandbox_mode,
                working_directory=workspace_dir,
                skip_git_repo_check=True,
                default_thread_options=ThreadOptions(
                    model=model,
                    approval_policy="never",
                ),
                default_turn_options=TurnOptions(idle_timeout_seconds=120),
                codex_options=CodexOptions(**codex_options_kwargs) if codex_options_kwargs else None,
                on_stream=on_stream,
                persist_session=True,
                thread_id=thread_id,
            )

            instructions = (
                "You are a coding agent. Use the codex tool to work in the "
                "sandbox workspace and complete the task described below."
            )
            if graph_tools_instructions:
                instructions += "\n\n" + graph_tools_instructions

            agent = Agent(
                name=f"codex-{self._session_id[:8]}",
                instructions=instructions,
                tools=[tool],
            )

            try:
                result = await Runner.run(agent, effective_prompt)
                if result.final_output:
                    await self._queue.put(
                        Event(
                            session_id=self._session_id,
                            type=EventType.TEXT_DELTA,
                            data={
                                "delta": result.final_output,
                                "message_id": str(uuid.uuid4()),
                            },
                        )
                    )
                await self._queue.put(
                    Event(session_id=self._session_id, type=EventType.SESSION_IDLE, data={})
                )
            except Exception as exc:
                logger.exception("codex agent error in session %s", self._session_id)
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


def _build_graph_tools_instructions(runner_state: dict) -> str:
    """Build graph tool instructions from runner_state if present."""
    if not runner_state.get("graph_tools"):
        return ""

    workspace_id = runner_state.get("graph_tools_workspace_id", "")
    backend_url = runner_state.get("graph_tools_backend_url", "")

    return (
        "You have access to graph tools via the Romulus backend API.\n"
        f"Workspace ID: {workspace_id}\n"
        f"Backend URL: {backend_url}\n\n"
        "Available graph operations:\n"
        "- GET {backend_url}/workspaces/{workspace_id}/graphs — list graphs\n"
        "- POST {backend_url}/workspaces/{workspace_id}/graphs — create a graph\n"
        "- GET {backend_url}/workspaces/{workspace_id}/graphs/{{graph_id}} — get graph detail\n"
        "- POST {backend_url}/workspaces/{workspace_id}/graphs/{{graph_id}}/nodes — add node\n"
        "- PATCH {backend_url}/workspaces/{workspace_id}/graphs/{{graph_id}}/nodes/{{node_id}} — update node\n"
        "- DELETE {backend_url}/workspaces/{workspace_id}/graphs/{{graph_id}}/nodes/{{node_id}} — delete node\n"
        "- POST {backend_url}/workspaces/{workspace_id}/graphs/{{graph_id}}/edges — add edge\n"
        "- DELETE {backend_url}/workspaces/{workspace_id}/graphs/{{graph_id}}/edges/{{edge_id}} — delete edge\n\n"
        "Use the codex tool to make HTTP requests (e.g., via curl) to these endpoints."
    )
