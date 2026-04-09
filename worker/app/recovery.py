import json

from romulus_common.worker_api import RecoveryContext, RecoveryHistoryEvent


def build_recovery_prompt(
    *,
    prompt: str,
    recovery: RecoveryContext | None,
) -> str:
    if recovery is None:
        return prompt

    sections = [
        "You are resuming an interrupted agent conversation after worker failure.",
        "Important: you are now running on a fresh sandbox. Any prior sandbox-local filesystem state is gone.",
    ]
    if recovery.reason:
        sections.append(f"Recovery reason: {recovery.reason}")

    history_block = _format_history(recovery.history)
    if history_block:
        sections.append(
            "Use the recovered conversation and tool history below as context, then continue naturally.\n\n"
            f"{history_block}"
        )

    sections.append(f"Current user message:\n{prompt}")
    return "\n\n".join(sections)


def _format_history(history: list[RecoveryHistoryEvent]) -> str:
    lines: list[str] = []
    for item in history:
        rendered = _render_history_item(item)
        if rendered:
            lines.append(rendered)
    return "\n\n".join(lines)


def _render_history_item(item: RecoveryHistoryEvent) -> str:
    if item.type == "user_message":
        return f"User: {item.content or ''}".strip()
    if item.type == "assistant_message":
        details = item.content or _json_or_empty(item.data)
        return f"Assistant: {details}".strip()
    if item.type == "tool_call":
        details = item.content or _json_or_empty(item.data)
        label = item.name or "tool"
        return f"Tool call ({label}): {details}".strip()
    if item.type == "tool_result":
        details = item.content or _json_or_empty(item.data)
        label = item.name or "tool"
        return f"Tool result ({label}): {details}".strip()
    if item.type == "structured_output":
        return f"Structured output: {_json_or_empty(item.data)}"
    if item.type == "system_note":
        return f"System: {item.content or _json_or_empty(item.data)}".strip()
    return ""


def _json_or_empty(value: object) -> str:
    if not value:
        return ""
    return json.dumps(value, indent=2, sort_keys=True)
