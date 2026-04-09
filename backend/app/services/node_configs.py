from typing import Any

from app.models.agent import (
    AgentConfig,
    ClaudeCodeAgentConfig,
    CodexAgentConfig,
    CommandConfig,
    ImageAttachment,
    OpenCodeAgentConfig,
    PydanticAgentConfig,
)
from app.services.node_shapes import is_agent_node_type, is_command_node_type


def agent_config_from_node(obj: Any) -> AgentConfig | None:
    if not is_agent_node_type(getattr(obj, "node_type", None)):
        return None
    if obj.agent_type is None:
        return None
    if obj.agent_type == "pydantic":
        images_raw = getattr(obj, "image_attachments", None) or []
        image_attachments = [ImageAttachment(**img) for img in images_raw]
        return PydanticAgentConfig(
            agent_type=obj.agent_type,
            model=obj.model,
            prompt=obj.prompt,
            image_attachments=image_attachments,
        )
    if obj.agent_type == "codex":
        return CodexAgentConfig(
            agent_type=obj.agent_type,
            model=obj.model,
            prompt=obj.prompt,
            graph_tools=getattr(obj, "graph_tools", False),
            sandbox_mode=getattr(obj, "sandbox_mode", None) or "read-only",
        )
    if obj.agent_type == "claude_code":
        return ClaudeCodeAgentConfig(
            agent_type=obj.agent_type,
            model=obj.model,
            prompt=obj.prompt,
            graph_tools=getattr(obj, "graph_tools", False),
        )
    return OpenCodeAgentConfig(
        agent_type=obj.agent_type,
        model=obj.model,
        prompt=obj.prompt,
        graph_tools=getattr(obj, "graph_tools", False),
    )


def command_config_from_node(obj: Any) -> CommandConfig | None:
    if not is_command_node_type(getattr(obj, "node_type", None)):
        return None
    if obj.command is None:
        return None
    return CommandConfig(command=obj.command)


def image_payloads_from_configs(
    agent_config: AgentConfig | None,
) -> list[dict[str, Any]] | None:
    if isinstance(agent_config, PydanticAgentConfig) and agent_config.image_attachments:
        return [img.model_dump(mode="json") for img in agent_config.image_attachments]
    return None
