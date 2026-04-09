FROM python:3.12-slim AS final

RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm ripgrep tar libicu76 \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app/worker
COPY worker/pyproject.toml worker/uv.lock ./
RUN uv sync --no-dev

COPY worker/app/ app/
COPY common/ /app/common/

RUN mkdir -p /data/.local/share/opencode /workspaces/.opencode/tools
COPY worker/tools/ /workspaces/.opencode/tools/
ENV XDG_DATA_HOME=/data/.local/share
ENV HOME=/data
ENV WORKER_WORKSPACE_ROOT=/workspaces
ENV PYTHONPATH=/app/common

EXPOSE 8080
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
