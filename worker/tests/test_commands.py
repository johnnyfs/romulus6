import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "common"))

from app.routers import commands as command_router
from romulus_common.worker_api import CommandRequest


def test_translate_command_request_maps_canonical_paths_to_local_workspace_root(monkeypatch):
    monkeypatch.setattr(command_router.settings, "workspace_root", "/tmp/romulus-workspaces")

    command, cwd = command_router._translate_command_request(
        CommandRequest(
            command=[
                "bash",
                "-c",
                "mkdir -p '/workspaces/abc' && cat /workspaces/abc/file.txt",
            ],
            cwd="/workspaces/abc",
            timeout=30,
        )
    )

    assert cwd == "/tmp/romulus-workspaces/abc"
    assert command == [
        "bash",
        "-c",
        "mkdir -p '/tmp/romulus-workspaces/abc' && cat /tmp/romulus-workspaces/abc/file.txt",
    ]


def test_translate_command_request_is_noop_for_canonical_workspace_root(monkeypatch):
    monkeypatch.setattr(command_router.settings, "workspace_root", "/workspaces")

    command, cwd = command_router._translate_command_request(
        CommandRequest(
            command=["bash", "-c", "echo hi >/workspaces/abc/out.txt"],
            cwd="/workspaces/abc",
            timeout=30,
        )
    )

    assert cwd == "/workspaces/abc"
    assert command == ["bash", "-c", "echo hi >/workspaces/abc/out.txt"]
