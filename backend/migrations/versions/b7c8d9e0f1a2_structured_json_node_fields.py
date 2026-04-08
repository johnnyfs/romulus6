"""convert schematized node fields to jsonb

Revision ID: b7c8d9e0f1a2
Revises: a6n7o8p9q0r1
Create Date: 2026-04-08 15:00:00.000000

"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "b7c8d9e0f1a2"
down_revision: Union[str, Sequence[str], None] = "a6n7o8p9q0r1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

JSONB = postgresql.JSONB(astext_type=sa.Text())

TEXT_TO_JSON_COLUMNS = (
    ("graphnode", "argument_bindings"),
    ("graphnode", "output_schema"),
    ("graphnode", "images"),
    ("tasktemplate", "output_schema"),
    ("tasktemplate", "images"),
    ("subgraphtemplate", "output_schema"),
    ("subgraphtemplatenode", "argument_bindings"),
    ("subgraphtemplatenode", "output_schema"),
    ("subgraphtemplatenode", "images"),
    ("graphrunnode", "output_schema"),
    ("graphrunnode", "output"),
    ("graphrunnode", "images"),
)


def _text_to_jsonb(column_name: str) -> str:
    return (
        f"CASE WHEN {column_name} IS NULL OR btrim({column_name}) = '' "
        f"THEN NULL ELSE {column_name}::jsonb END"
    )


def _jsonb_to_text(column_name: str) -> str:
    return f"CASE WHEN {column_name} IS NULL THEN NULL ELSE {column_name}::text END"


def upgrade() -> None:
    for table_name, column_name in TEXT_TO_JSON_COLUMNS:
        op.alter_column(
            table_name,
            column_name,
            existing_type=sa.String(),
            type_=JSONB,
            existing_nullable=True,
            postgresql_using=_text_to_jsonb(column_name),
        )


def downgrade() -> None:
    for table_name, column_name in reversed(TEXT_TO_JSON_COLUMNS):
        op.alter_column(
            table_name,
            column_name,
            existing_type=JSONB,
            type_=sa.String(),
            existing_nullable=True,
            postgresql_using=_jsonb_to_text(column_name),
        )
