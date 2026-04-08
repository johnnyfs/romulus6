from typing import Any

from pydantic import TypeAdapter
from sqlalchemy import Column
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.types import TypeDecorator


class ValidatedJSON(TypeDecorator):
    """Persist JSON values after validating them against a shared schema."""

    impl = JSONB
    cache_ok = False

    def __init__(self, schema: Any):
        super().__init__()
        self._schema = schema
        self._adapter = TypeAdapter(schema)

    def copy(self, **kw: Any) -> "ValidatedJSON":
        return type(self)(self._schema)

    def _normalize(self, value: Any) -> Any:
        validated = self._adapter.validate_python(value)
        return self._adapter.dump_python(validated, mode="json")

    def process_bind_param(self, value: Any, dialect: Any) -> Any:
        if value is None:
            return None
        return self._normalize(value)

    def process_result_value(self, value: Any, dialect: Any) -> Any:
        if value is None:
            return None
        return self._normalize(value)


def validated_json_column(schema: Any, *, nullable: bool) -> Column[Any]:
    return Column(ValidatedJSON(schema), nullable=nullable)
