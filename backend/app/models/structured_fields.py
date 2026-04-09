from typing import Any, TypeAlias

from .agent import ImageAttachment

ArgumentBindings: TypeAlias = dict[str, str]
# Runtime-validated; primitives ("string", "number", "boolean", "image"),
# container types ("list:<base>", "map:<base>"), and custom schema references
# ("schema:<uuid>") are all encoded as plain strings.
# TODO: renderable type registry — when adding new renderable types (e.g. "html",
# "markdown"), add them to SUPPORTED_OUTPUT_TYPES in output_schema.py.
OutputSchemaFieldType = str
OutputSchemaDefinition: TypeAlias = dict[str, OutputSchemaFieldType]
NodeOutputPayload: TypeAlias = dict[str, Any]
ImagePayload: TypeAlias = dict[str, Any]
ImagePayloadList: TypeAlias = list[ImagePayload]
ImageAttachmentSchema: TypeAlias = list[ImageAttachment]
