from enum import StrEnum


class SupportedModel(StrEnum):
    claude_sonnet_46 = "anthropic/claude-sonnet-4-6"
    claude_opus_46 = "anthropic/claude-opus-4-6"
    claude_haiku_45 = "anthropic/claude-haiku-4-5"
    gpt_4o = "openai/gpt-4o"
    gpt_4o_mini = "openai/gpt-4o-mini"
    o3_mini = "openai/o3-mini"
    gemini_25_pro = "google/gemini-2.5-pro"
    gemini_25_flash = "google/gemini-2.5-flash"


SUPPORTED_MODELS_BY_AGENT_TYPE: dict[str, tuple[SupportedModel, ...]] = {
    "opencode": (
        SupportedModel.claude_sonnet_46,
        SupportedModel.claude_opus_46,
        SupportedModel.claude_haiku_45,
        SupportedModel.gpt_4o,
        SupportedModel.gpt_4o_mini,
        SupportedModel.o3_mini,
    ),
    "pydantic": (
        SupportedModel.gemini_25_pro,
        SupportedModel.gemini_25_flash,
    ),
}


def is_supported_model_for_agent_type(agent_type: str, model: str) -> bool:
    return model in {
        supported.value
        for supported in SUPPORTED_MODELS_BY_AGENT_TYPE.get(agent_type, ())
    }


def validate_supported_model_for_agent_type(agent_type: str, model: str) -> str:
    if not is_supported_model_for_agent_type(agent_type, model):
        allowed = ", ".join(
            item.value for item in SUPPORTED_MODELS_BY_AGENT_TYPE.get(agent_type, ())
        )
        raise ValueError(
            f"Model '{model}' is not supported for agent type '{agent_type}'. "
            f"Allowed: {allowed}"
        )
    return model
