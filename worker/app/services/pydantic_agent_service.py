import asyncio
import base64
from typing import Any

from pydantic import BaseModel, Field, create_model
from pydantic_ai import Agent
from pydantic_ai.messages import BinaryContent, ImageUrl, UserContent
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIResponsesModel

from app.output_schema import validate_output_against_schema, validate_output_schema_definition
from app.pydantic_schema_registry import schema_model_for_id


def _build_model(model: str) -> AnthropicModel | GoogleModel | OpenAIResponsesModel:
    provider, model_name = model.split("/", 1)
    if provider == "anthropic":
        return AnthropicModel(model_name)
    if provider == "google":
        return GoogleModel(model_name)
    if provider == "openai":
        return OpenAIResponsesModel(model_name)
    raise ValueError(f"Unsupported model provider: {provider}")


class PydanticAgentService:
    # TODO: renderable type registry — when adding new renderable types,
    # add their Python type mapping here.
    _PRIMITIVE_TYPE_MAP: dict[str, type] = {
        "string": str,
        "number": float,
        "boolean": bool,
        "image": str,
    }

    def _resolve_field_type(
        self, type_spec: str | dict[str, Any], model_name_prefix: str = "Nested"
    ) -> type:
        """Resolve a (possibly expanded) type spec to a Python type.

        Primitive strings ("string", "number", etc.) map directly.
        Expanded dicts represent complex types from the backend:
          {"_type": "object", "fields": {...}}
          {"_type": "list", "items": ...}
          {"_type": "map", "values": ...}
        """
        if isinstance(type_spec, str):
            py_type = self._PRIMITIVE_TYPE_MAP.get(type_spec)
            if py_type is None:
                raise ValueError(f"Unsupported output schema type: {type_spec}")
            return py_type

        if isinstance(type_spec, dict):
            t = type_spec.get("_type")
            if t == "object":
                nested_fields = type_spec.get("fields", {})
                field_defs: dict[str, tuple[type[Any], Any]] = {}
                for k, v in nested_fields.items():
                    field_defs[k] = (self._resolve_field_type(v, f"{model_name_prefix}_{k}"), Field(...))
                return create_model(f"{model_name_prefix}Model", **field_defs)
            elif t == "list":
                inner = self._resolve_field_type(type_spec.get("items", "string"), model_name_prefix)
                return list[inner]  # type: ignore[valid-type]
            elif t == "map":
                inner = self._resolve_field_type(type_spec.get("values", "string"), model_name_prefix)
                return dict[str, inner]  # type: ignore[valid-type]

        raise ValueError(f"Unsupported output schema type spec: {type_spec}")

    def _build_output_model(
        self,
        *,
        schema_id: str | None,
        output_schema: dict[str, Any] | None,
    ) -> type[BaseModel]:
        if output_schema is not None:
            # Skip full definition validation for expanded schemas (dicts have
            # already been expanded by the backend). Only validate if all values
            # are plain strings (the original primitive-only format).
            if all(isinstance(v, str) for v in output_schema.values()):
                validate_output_schema_definition(output_schema)
            fields: dict[str, tuple[type[Any], Any]] = {}
            for key, value in output_schema.items():
                fields[key] = (self._resolve_field_type(value, f"Field_{key}"), Field(...))
            return create_model("GraphOutputModel", **fields)
        if schema_id is None:
            raise ValueError("schema_id or output_schema is required")
        return schema_model_for_id(schema_id)

    def _build_user_prompt(
        self, prompt: str, images: list[dict[str, str]] | None
    ) -> str | list[UserContent]:
        if not images:
            return prompt
        parts: list[UserContent] = [prompt]
        for img in images:
            if img["type"] == "url":
                parts.append(ImageUrl(url=img["url"]))
            elif img["type"] == "base64":
                raw_bytes = base64.b64decode(img["data"])
                parts.append(BinaryContent(
                    data=raw_bytes,
                    media_type=img.get("media_type", "image/png"),
                ))
        return parts

    async def run(
        self,
        *,
        model: str,
        prompt: str,
        schema_id: str | None = None,
        output_schema: dict[str, str] | None = None,
        images: list[dict[str, str]] | None = None,
    ) -> BaseModel:
        output_model = self._build_output_model(schema_id=schema_id, output_schema=output_schema)
        agent = Agent(
            _build_model(model),
            output_type=output_model,
        )
        user_prompt = self._build_user_prompt(prompt, images)
        result = await asyncio.to_thread(agent.run_sync, user_prompt)
        if output_schema is not None:
            validate_output_against_schema(result.output.model_dump(mode="json"), output_schema)
        return result.output
