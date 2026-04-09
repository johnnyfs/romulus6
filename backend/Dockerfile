FROM python:3.14-slim AS final

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app/backend

COPY backend/pyproject.toml backend/uv.lock backend/alembic.ini ./
RUN uv sync --no-dev --frozen

COPY backend/app/ app/
COPY backend/migrations/ migrations/
COPY common/ /app/common/

ENV PYTHONPATH=/app/common

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
