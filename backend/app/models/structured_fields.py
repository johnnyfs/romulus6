from typing import Any, Literal, TypeAlias

from pydantic import BaseModel
from pydantic import Field as PydanticField

from .agent import ImageAttachment

ArgumentBindings: TypeAlias = dict[str, str]
OutputSchemaFieldType = Literal["string", "number", "boolean"]
OutputSchemaDefinition: TypeAlias = dict[str, OutputSchemaFieldType]
NodeOutputPayload: TypeAlias = dict[str, Any]
ImagePayload: TypeAlias = dict[str, Any]
ImagePayloadList: TypeAlias = list[ImagePayload]
ImageAttachmentSchema: TypeAlias = list[ImageAttachment]


class ViewConfig(BaseModel):
    images: list[ImageAttachment] = PydanticField(default_factory=list)
