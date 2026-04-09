from typing import Any


SUPPORTED_OUTPUT_TYPES = {"string", "number", "boolean"}


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
        if value not in SUPPORTED_OUTPUT_TYPES:
            allowed = ", ".join(sorted(SUPPORTED_OUTPUT_TYPES))
            raise ValueError(
                f"output_schema field '{key}' has unsupported type '{value}'. "
                f"Allowed: {allowed}"
            )
    return schema


def validate_output_against_schema(
    output: dict[str, Any] | None,
    schema: dict[str, str] | None,
) -> dict[str, Any] | None:
    if schema is None:
        return output
    if output is None:
        raise ValueError("node output is required by output_schema")
    if not isinstance(output, dict):
        raise ValueError("node output must be an object")

    missing = [key for key in schema if key not in output]
    extra = [key for key in output if key not in schema]
    if missing:
        raise ValueError(f"node output is missing required fields: {', '.join(missing)}")
    if extra:
        raise ValueError(f"node output has unexpected fields: {', '.join(extra)}")

    for key, expected_type in schema.items():
        value = output[key]
        if expected_type == "string" and not isinstance(value, str):
            raise ValueError(f"node output field '{key}' must be a string")
        if expected_type == "number" and (
            not isinstance(value, (int, float)) or isinstance(value, bool)
        ):
            raise ValueError(f"node output field '{key}' must be a number")
        if expected_type == "boolean" and not isinstance(value, bool):
            raise ValueError(f"node output field '{key}' must be a boolean")

    return output
