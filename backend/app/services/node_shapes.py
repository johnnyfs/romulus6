"""Shared node-shape rules used by graph, template, and run code paths.

Keep this file in sync with:
- graph/template ORM fields
- request/response serializers
- run materialization

When a node changes type, incompatible fields must be cleared here so stale
data cannot leak into later serializers or run snapshots.
"""

from __future__ import annotations

from typing import Any

from romulus_common.sandbox_modes import normalize_codex_sandbox_mode

from app.models.graph import NodeType

UNSET = object()

INLINE_NODE_TYPES = frozenset({NodeType.agent, NodeType.command})
TEMPLATE_REFERENCE_NODE_TYPES = frozenset({NodeType.task_template, NodeType.subgraph_template})
TASK_TEMPLATE_ALLOWED_TYPES = frozenset({NodeType.agent, NodeType.command})


def coerce_node_type(node_type: NodeType | str | None) -> NodeType | None:
    if node_type is None or isinstance(node_type, NodeType):
        return node_type
    try:
        return NodeType(node_type)
    except ValueError:
        return None


def is_agent_node_type(node_type: NodeType | str | None) -> bool:
    return coerce_node_type(node_type) == NodeType.agent


def is_command_node_type(node_type: NodeType | str | None) -> bool:
    return coerce_node_type(node_type) == NodeType.command


def validate_task_template_type(task_type: NodeType) -> None:
    if task_type not in TASK_TEMPLATE_ALLOWED_TYPES:
        allowed = ", ".join(sorted(item.value for item in TASK_TEMPLATE_ALLOWED_TYPES))
        raise ValueError(
            f"task templates may only realize concrete node types ({allowed}); "
            f"got '{task_type.value}'"
        )


def _current_value(current: Any | None, field: str) -> Any:
    return getattr(current, field, None) if current is not None else None


def _pick(current: Any | None, field: str, value: Any) -> Any:
    if value is not UNSET:
        return value
    return _current_value(current, field)


def normalized_node_field_values(
    node_type: NodeType,
    *,
    current: Any | None = None,
    subgraph_ref_field: str,
    agent_type: Any = UNSET,
    model: Any = UNSET,
    prompt: Any = UNSET,
    command: Any = UNSET,
    graph_tools: Any = UNSET,
    sandbox_mode: Any = UNSET,
    task_template_id: Any = UNSET,
    subgraph_template_id: Any = UNSET,
    ref_subgraph_template_id: Any = UNSET,
    argument_bindings: Any = UNSET,
    image_attachments: Any = UNSET,
) -> dict[str, Any]:
    values: dict[str, Any] = {}

    if is_agent_node_type(node_type):
        values["agent_type"] = _pick(current, "agent_type", agent_type)
        values["model"] = _pick(current, "model", model)
        values["prompt"] = _pick(current, "prompt", prompt)
        picked_graph_tools = _pick(current, "graph_tools", graph_tools)
        values["graph_tools"] = bool(picked_graph_tools) if picked_graph_tools is not None else False
        values["sandbox_mode"] = normalize_codex_sandbox_mode(
            agent_type=values["agent_type"],
            sandbox_mode=_pick(current, "sandbox_mode", sandbox_mode),
        )
    else:
        values["agent_type"] = None
        values["model"] = None
        values["prompt"] = None
        values["graph_tools"] = False
        values["sandbox_mode"] = None

    if is_command_node_type(node_type):
        values["command"] = _pick(current, "command", command)
    else:
        values["command"] = None

    if node_type == NodeType.task_template:
        values["task_template_id"] = _pick(current, "task_template_id", task_template_id)
    else:
        values["task_template_id"] = None

    if node_type == NodeType.subgraph_template:
        chosen_subgraph_ref = ref_subgraph_template_id if subgraph_ref_field == "ref_subgraph_template_id" else subgraph_template_id
        values[subgraph_ref_field] = _pick(current, subgraph_ref_field, chosen_subgraph_ref)
    else:
        values[subgraph_ref_field] = None

    if node_type in TEMPLATE_REFERENCE_NODE_TYPES:
        values["argument_bindings"] = _pick(current, "argument_bindings", argument_bindings)
    else:
        values["argument_bindings"] = None

    if is_agent_node_type(node_type):
        values["image_attachments"] = _pick(current, "image_attachments", image_attachments)
    else:
        values["image_attachments"] = None

    return values
