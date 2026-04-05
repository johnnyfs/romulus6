import datetime
from typing import Type, TypeVar

from sqlmodel import Field, SQLModel, select

T = TypeVar("T", bound="RomulusBase")


class RomulusBase(SQLModel):
    created_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)
    updated_at: datetime.datetime = Field(default_factory=datetime.datetime.utcnow)
    deleted: bool = Field(default=False)

    @classmethod
    def active(cls: Type[T]):  # type: ignore[misc]
        return select(cls).where(cls.deleted == False)  # noqa: E712
