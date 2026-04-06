FROM python:3.12-slim AS final

RUN apt-get update && apt-get install -y --no-install-recommends \
    ripgrep tar libicu76 \
    && rm -rf /var/lib/apt/lists/*

COPY opencode /usr/bin/opencode
RUN chmod +x /usr/bin/opencode

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
COPY pyproject.toml .
RUN uv sync --no-dev

COPY app/ app/

RUN mkdir -p /data/.local/share/opencode /workspaces/.opencode/tools
COPY tools/ /workspaces/.opencode/tools/
ENV XDG_DATA_HOME=/data/.local/share
ENV HOME=/data
ENV WORKER_WORKSPACE_ROOT=/workspaces

EXPOSE 8080
CMD ["uv", "run", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
