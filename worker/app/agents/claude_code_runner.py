import asyncio
import logging
from collections.abc import AsyncIterator

from claude_code_sdk import (
    AssistantMessage,
    ClaudeCodeOptions,
    ClaudeSDKClient,
    ResultMessage,
    SystemMessage,
    TextBlock,
    ToolUseBlock,
)

from app.agents.base import AgentRunner
from app.graph_tools_mcp import build_graph_tools_mcp_server
from app.models import Event, EventType, Session
from app.recovery import build_recovery_prompt

logger = logging.getLogger(__name__)


class ClaudeCodeRunner(AgentRunner):
    """Agent runner backed by the Claude Code SDK (claude-code-sdk).

    Spawns a Claude Code CLI subprocess per query via ClaudeSDKClient.
    Multi-turn is handled via session resumption (resume=session_id).
    """

    def __init__(self, session_id: str):
        self._session_id = session_id
        self._queue: asyncio.Queue[Event | None] = asyncio.Queue()
        self._task: asyncio.Task[None] | None = None
        self._client: ClaudeSDKClient | None = None

    async def start(self, *, prompt: str, session: Session) -> None:
        effective_prompt = build_recovery_prompt(prompt=prompt, recovery=session.recovery)
        # SDK takes bare model names; strip provider prefix
        model = session.model
        model_name = model.split("/", 1)[1] if "/" in model else model

        claude_session_id = session.runner_state.get("claude_code_session_id")

        mcp_servers = {}
        ws_id = session.runner_state.get("graph_tools_workspace_id", "")
        api_url = session.runner_state.get("graph_tools_backend_url", "")
        if ws_id and api_url and (
            session.runner_state.get("graph_tools")
            or (
                session.runner_state.get("graph_run_id")
                and session.runner_state.get("graph_run_node_id")
            )
        ):
            mcp_servers["romulus-run-tools"] = build_graph_tools_mcp_server(
                ws_id,
                api_url,
                run_id=session.runner_state.get("graph_run_id"),
                node_id=session.runner_state.get("graph_run_node_id"),
                output_schema=session.runner_state.get("output_schema"),
                enable_graph_tools=bool(session.runner_state.get("graph_tools")),
            )

        options = ClaudeCodeOptions(
            cwd=session.workspace_dir,
            allowed_tools=["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
            permission_mode="bypassPermissions",
            model=model_name,
            max_turns=200,
            **({"mcp_servers": mcp_servers} if mcp_servers else {}),
        )
        if claude_session_id:
            options.resume = claude_session_id

        self._task = asyncio.create_task(
            self._run(effective_prompt, options, session)
        )

    async def _run(
        self,
        prompt: str,
        options: ClaudeCodeOptions,
        session: Session,
    ) -> None:
        try:
            await self._queue.put(
                Event(session_id=self._session_id, type=EventType.SESSION_BUSY, data={})
            )
            async with ClaudeSDKClient(options=options) as client:
                self._client = client
                await client.query(prompt)
                async for message in client.receive_response():
                    for event in self._translate(message, session):
                        await self._queue.put(event)
            self._client = None
            await self._queue.put(
                Event(session_id=self._session_id, type=EventType.SESSION_IDLE, data={})
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.exception("claude_code runner error in session %s", self._session_id)
            await self._queue.put(
                Event(
                    session_id=self._session_id,
                    type=EventType.SESSION_ERROR,
                    data={"error": str(exc)},
                )
            )
        finally:
            self._client = None
            await self._queue.put(None)  # sentinel

    async def events(self) -> AsyncIterator[Event]:
        while True:
            event = await self._queue.get()
            if event is None:
                return
            yield event

    async def interrupt(self) -> None:
        if self._client is not None:
            try:
                await self._client.interrupt()
            except Exception as e:
                logger.warning("claude_code interrupt failed: %s", e)
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    def _translate(self, message: object, session: Session) -> list[Event]:
        """Map claude_agent_sdk message types to Romulus events."""
        events: list[Event] = []

        if isinstance(message, SystemMessage) and message.subtype == "init":
            sdk_session_id = message.data.get("session_id")
            if sdk_session_id:
                session.runner_state["claude_code_session_id"] = sdk_session_id
                logger.info(
                    "captured claude_code session_id %s for romulus session %s",
                    sdk_session_id,
                    self._session_id,
                )
            return events

        if isinstance(message, AssistantMessage):
            for block in message.content:
                if isinstance(block, TextBlock):
                    events.append(
                        Event(
                            session_id=self._session_id,
                            type=EventType.TEXT_DELTA,
                            data={"delta": block.text},
                        )
                    )
                elif isinstance(block, ToolUseBlock):
                    events.append(
                        Event(
                            session_id=self._session_id,
                            type=EventType.TOOL_USE,
                            data={
                                "tool": block.name,
                                "tool_name": block.name,
                                "args": block.input if hasattr(block, "input") else {},
                            },
                        )
                    )
            return events

        if isinstance(message, ResultMessage):
            if message.result:
                events.append(
                    Event(
                        session_id=self._session_id,
                        type=EventType.TEXT_DELTA,
                        data={"delta": message.result},
                    )
                )
            return events

        return events
