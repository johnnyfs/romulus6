FROM python:3.14-slim AS final

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app

COPY pyproject.toml uv.lock alembic.ini ./
RUN uv sync --no-dev --frozen

COPY app/ app/
COPY migrations/ migrations/

EXPOSE 8000

CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
