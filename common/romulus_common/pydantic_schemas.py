from enum import StrEnum

from pydantic import BaseModel, Field


class PydanticSchemaId(StrEnum):
    structured_response_v1 = "structured_response_v1"


class StructuredResponseV1(BaseModel):
    title: str = Field(description="Short title for the result.")
    summary: str = Field(description="A concise summary of the result.")
    completed: bool = Field(
        description="Whether the task described in the prompt is complete."
    )


def schema_model_for_id(schema_id: str) -> type[BaseModel]:
    if schema_id == PydanticSchemaId.structured_response_v1.value:
        return StructuredResponseV1
    raise ValueError(f"Unsupported schema_id: {schema_id}")
