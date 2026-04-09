from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    workspace_root: str = "/workspaces"
    opencode_binary: str = "opencode"
    default_model: str = "anthropic/claude-sonnet-4-5"
    default_agent_type: str = "opencode"
    host: str = "0.0.0.0"
    port: int = 8080
    log_level: str = "INFO"
    romulus_backend_url: str = "http://romulus-backend:8000/api/v1"
    registration_key: str | None = None
    pod_name: str | None = None
    pod_ip: str | None = None
    advertise_url: str | None = None
    heartbeat_interval_seconds: float = 5.0
    register_retry_seconds: float = 2.0
    codex_binary: str = "codex"
    openai_api_key: str | None = None

    model_config = SettingsConfigDict(env_prefix="WORKER_")

settings = Settings()
