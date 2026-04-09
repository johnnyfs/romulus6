import json
from typing import Any

from app.models.agent import ImageAttachment


def normalized_json_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str):
        return json.loads(value)
    return value


def normalized_json_object(value: Any) -> dict[str, Any] | None:
    normalized = normalized_json_value(value)
    if normalized is None:
        return None
    if not isinstance(normalized, dict):
        raise TypeError(f"expected JSON object, got {type(normalized).__name__}")
    return normalized


def normalized_string_map(value: Any) -> dict[str, str] | None:
    normalized = normalized_json_object(value)
    if normalized is None:
        return None
    return {str(key): str(item) for key, item in normalized.items()}


def image_attachments(value: Any) -> list[ImageAttachment] | None:
    normalized = normalized_json_value(value)
    if normalized is None:
        return None
    if not isinstance(normalized, list):
        raise TypeError(f"expected JSON array, got {type(normalized).__name__}")
    return [
        item if isinstance(item, ImageAttachment) else ImageAttachment(**item)
        for item in normalized
    ]


def decoded_json_string(value: str | None) -> Any:
    if value is None:
        return None
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return None
