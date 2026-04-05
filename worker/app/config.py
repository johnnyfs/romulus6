from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    workspace_root: str = "/workspaces"
    opencode_binary: str = "/usr/bin/opencode"
    default_model: str = "anthropic/claude-sonnet-4-5"
    default_agent_type: str = "opencode"
    host: str = "0.0.0.0"
    port: int = 8080
    log_level: str = "INFO"

    model_config = SettingsConfigDict(env_prefix="WORKER_")

settings = Settings()
