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
    def _build_output_model(
        self,
        *,
        schema_id: str | None,
        output_schema: dict[str, str] | None,
    ) -> type[BaseModel]:
        if output_schema is not None:
            validate_output_schema_definition(output_schema)
            fields: dict[str, tuple[type[Any], Any]] = {}
            for key, value in output_schema.items():
                if value == "string":
                    fields[key] = (str, Field(...))
                elif value == "number":
                    fields[key] = (float, Field(...))
                elif value == "boolean":
                    fields[key] = (bool, Field(...))
                else:
                    raise ValueError(f"Unsupported output schema type: {value}")
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
