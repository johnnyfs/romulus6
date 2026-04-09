from typing import Any

from app.models.agent import (
    AgentConfig,
    CodexAgentConfig,
    CommandConfig,
    ImageAttachment,
    OpenCodeAgentConfig,
    PydanticAgentConfig,
)
from app.models.structured_fields import ViewConfig
from app.services.node_shapes import is_agent_node_type, is_command_node_type


def agent_config_from_node(obj: Any) -> AgentConfig | None:
    if not is_agent_node_type(getattr(obj, "node_type", None)):
        return None
    if obj.agent_type is None:
        return None
    if obj.agent_type == "pydantic":
        images_raw = getattr(obj, "images", None) or []
        images = [ImageAttachment(**img) for img in images_raw]
        return PydanticAgentConfig(
            agent_type=obj.agent_type,
            model=obj.model,
            prompt=obj.prompt,
            images=images,
        )
    if obj.agent_type == "codex":
        return CodexAgentConfig(
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


def view_config_from_node(obj: Any) -> ViewConfig | None:
    node_type = getattr(obj, "node_type", None)
    if hasattr(node_type, "value"):
        node_type = node_type.value
    if node_type != "view":
        return None
    images_raw = getattr(obj, "images", None) or []
    images = [ImageAttachment(**img) for img in images_raw]
    return ViewConfig(images=images)


def image_payloads_from_configs(
    agent_config: AgentConfig | None,
    view_config: ViewConfig | None,
) -> list[dict[str, Any]] | None:
    if isinstance(agent_config, PydanticAgentConfig) and agent_config.images:
        return [img.model_dump(mode="json") for img in agent_config.images]
    if view_config and view_config.images:
        return [img.model_dump(mode="json") for img in view_config.images]
    return None
