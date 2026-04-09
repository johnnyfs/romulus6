import re
from typing import Any, Callable

# TODO: renderable type registry — when adding new renderable types (e.g.
# "html", "markdown", "audio"), add them here and update the validation in
# _validate_primitive_value and the type-map in the worker's
# pydantic_agent_service._build_output_model.
SUPPORTED_OUTPUT_TYPES = {"string", "number", "boolean", "image"}

_UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)


def _is_valid_base_type(value: str) -> bool:
    """Check whether *value* is a recognized base output-schema type.

    Accepts primitives ("string", "number", "boolean", "image") and custom
    schema references ("schema:<uuid>").
    """
    if value in SUPPORTED_OUTPUT_TYPES:
        return True
    if value.startswith("schema:"):
        uuid_part = value[len("schema:"):]
        return bool(_UUID_RE.match(uuid_part))
    return False


def _is_valid_field_type(value: str) -> bool:
    """Check whether *value* is a recognized field type string.

    Supports:
    - Bare base types: "string", "number", "boolean", "image", "schema:<uuid>"
    - List containers:  "list:string", "list:schema:<uuid>", etc.
    - Map containers:   "map:string", "map:schema:<uuid>", etc.
    """
    if _is_valid_base_type(value):
        return True
    if value.startswith("list:") or value.startswith("map:"):
        inner = value.split(":", 1)[1]
        return _is_valid_base_type(inner)
    return False


def validate_output_schema_definition(
    schema: dict[str, str] | None,
) -> dict[str, str] | None:
    if schema is None:
        return None
    if not isinstance(schema, dict):
        raise ValueError("output_schema must be an object")
    for key, value in schema.items():
        if not isinstance(key, str) or not key.strip():
            raise ValueError("output_schema keys must be non-empty strings")
        if not _is_valid_field_type(value):
            raise ValueError(
                f"output_schema field '{key}' has unsupported type '{value}'"
            )
    return schema


SchemaResolver = Callable[[str], dict[str, str] | None]
"""Callable that resolves a schema UUID string to its fields dict, or None."""


def _validate_primitive_value(key: str, expected_type: str, value: Any) -> None:
    """Validate a single primitive output value."""
    # TODO: renderable type registry — extend this when new renderable types
    # are added (each new type needs its Python isinstance check).
    if expected_type == "string" and not isinstance(value, str):
        raise ValueError(f"node output field '{key}' must be a string")
    if expected_type == "number" and (
        not isinstance(value, (int, float)) or isinstance(value, bool)
    ):
        raise ValueError(f"node output field '{key}' must be a number")
    if expected_type == "boolean" and not isinstance(value, bool):
        raise ValueError(f"node output field '{key}' must be a boolean")
    if expected_type == "image" and not isinstance(value, str):
        raise ValueError(f"node output field '{key}' must be a string (URL or data URI)")


def _validate_value_for_type(
    key: str,
    field_type: str,
    value: Any,
    schema_resolver: SchemaResolver | None,
) -> None:
    """Recursively validate a single output value against its declared type."""
    # Container types
    if field_type.startswith("list:"):
        if not isinstance(value, list):
            raise ValueError(f"node output field '{key}' must be an array")
        inner_type = field_type[len("list:"):]
        for i, item in enumerate(value):
            _validate_value_for_type(f"{key}[{i}]", inner_type, item, schema_resolver)
        return

    if field_type.startswith("map:"):
        if not isinstance(value, dict):
            raise ValueError(f"node output field '{key}' must be an object (map)")
        inner_type = field_type[len("map:"):]
        for mk, mv in value.items():
            if not isinstance(mk, str):
                raise ValueError(f"node output field '{key}' map keys must be strings")
            _validate_value_for_type(f"{key}.{mk}", inner_type, mv, schema_resolver)
        return

    # Custom schema type
    if field_type.startswith("schema:"):
        if not isinstance(value, dict):
            raise ValueError(f"node output field '{key}' must be an object")
        if schema_resolver is not None:
            schema_id = field_type[len("schema:"):]
            nested_schema = schema_resolver(schema_id)
            if nested_schema is not None:
                _validate_nested_output(value, nested_schema, schema_resolver, prefix=key)
        return

    # Primitive / renderable type
    _validate_primitive_value(key, field_type, value)


def _validate_nested_output(
    output: dict[str, Any],
    schema: dict[str, str],
    schema_resolver: SchemaResolver | None,
    prefix: str = "",
) -> None:
    """Validate an output dict against a schema, with recursive support."""
    dot = f"{prefix}." if prefix else ""
    missing = [key for key in schema if key not in output]
    extra = [key for key in output if key not in schema]
    if missing:
        raise ValueError(
            f"node output is missing required fields: {', '.join(dot + k for k in missing)}"
        )
    if extra:
        raise ValueError(
            f"node output has unexpected fields: {', '.join(dot + k for k in extra)}"
        )
    for key, expected_type in schema.items():
        _validate_value_for_type(f"{dot}{key}", expected_type, output[key], schema_resolver)


def validate_output_against_schema(
    output: dict[str, Any] | None,
    schema: dict[str, str] | None,
    schema_resolver: SchemaResolver | None = None,
) -> dict[str, Any] | None:
    if schema is None:
        return output
    if output is None:
        raise ValueError("node output is required by output_schema")
    if not isinstance(output, dict):
        raise ValueError("node output must be an object")

    _validate_nested_output(output, schema, schema_resolver)
    return output
