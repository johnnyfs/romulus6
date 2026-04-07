import asyncio
from pydantic import BaseModel
from pydantic_ai import Agent
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIResponsesModel

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
    async def run(self, *, model: str, prompt: str, schema_id: str) -> BaseModel:
        output_model = schema_model_for_id(schema_id)
        agent = Agent(
            _build_model(model),
            output_type=output_model,
        )
        result = await asyncio.to_thread(agent.run_sync, prompt)
        return result.output
