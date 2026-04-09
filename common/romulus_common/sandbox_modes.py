from typing import Literal, TypeAlias

SandboxMode: TypeAlias = Literal[
    "read-only",
    "workspace-write",
    "danger-full-access",
]

DEFAULT_SANDBOX_MODE: SandboxMode = "read-only"
SANDBOX_MODE_VALUES: tuple[SandboxMode, ...] = (
    "read-only",
    "workspace-write",
    "danger-full-access",
)


def validate_sandbox_mode(value: str) -> SandboxMode:
    if value not in SANDBOX_MODE_VALUES:
        allowed = ", ".join(SANDBOX_MODE_VALUES)
        raise ValueError(f"unsupported sandbox_mode '{value}'; expected one of: {allowed}")
    return value  # type: ignore[return-value]


def normalize_codex_sandbox_mode(
    *,
    agent_type: str | None,
    sandbox_mode: str | None,
) -> SandboxMode | None:
    if agent_type != "codex":
        return None
    if sandbox_mode is None:
        return DEFAULT_SANDBOX_MODE
    return validate_sandbox_mode(sandbox_mode)
