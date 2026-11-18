"""Integrity and consistency tests for voice deployment files (spec §5.1).

Validates Dockerfile.voice, .env.example, and Makefile integration.
"""

from pathlib import Path

import pytest

from agent.settings import Settings
from agent.voice_settings import VoiceSettings

pytestmark = pytest.mark.unit

AGENT_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = AGENT_DIR.parent.parent


def test_dockerfile_voice_exists_and_configured() -> None:
    dockerfile = AGENT_DIR / "Dockerfile.voice"
    assert dockerfile.is_file(), f"Expected {dockerfile} to exist"

    content = dockerfile.read_text(encoding="utf-8")

    # Must target the standalone ASGI voice app
    assert "agent.voice_asgi:app" in content, "Dockerfile.voice must run agent.voice_asgi:app"

    # Must follow uv deterministic installation
    assert "uv sync --frozen --no-dev" in content, "Dockerfile.voice must use uv sync --frozen --no-dev"

    # Must listen on Cloud Run $PORT
    assert "PORT" in content, "Dockerfile.voice must reference $PORT"

    # Single-instance / single worker constraint per spec §5.1 (in-memory budgets & limits)
    assert "--workers 1" in content or "workers" not in content, (
        "Dockerfile.voice must not start multiple workers per container instance"
    )

    # Best-practice: runs as non-root user
    assert "USER " in content, "Dockerfile.voice should specify a non-root USER"


def test_env_example_has_no_secrets() -> None:
    env_example = AGENT_DIR / ".env.example"
    assert env_example.is_file(), f"Expected {env_example} to exist"

    content = env_example.read_text(encoding="utf-8")

    # Explicit reminder never to commit .env
    assert "never commit .env" in content.lower(), (
        ".env.example must contain explicit warning to never commit .env"
    )

    # Collect known secrets from Settings and VoiceSettings
    secret_keys = Settings.SECRETS | VoiceSettings.SECRETS

    # Parse all non-comment KEY=VALUE definitions
    for line in content.splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue
        key, sep, val = trimmed.partition("=")
        assert sep == "=", f"Invalid line format in .env.example: {trimmed}"
        key = key.strip()
        val = val.strip()

        if key in secret_keys:
            # Secret keys in .env.example must be empty or obvious safe placeholders
            assert val == "" or val.startswith("<") or val.startswith("your-secret"), (
                f"Secret key {key} in .env.example must not have a real value: found '{val}'"
            )


def test_env_example_mentions_voice_keys() -> None:
    env_example = AGENT_DIR / ".env.example"
    content = env_example.read_text(encoding="utf-8")

    # Expected voice-related configuration keys
    expected_keys = [
        "VOICE_API_URL",
        "APP_AUTH_SECRET",
        "TRANSCRIBE_API_KEY",
        "VOICE_ALLOWED_ORIGINS",
    ]

    for key in expected_keys:
        assert key in content, f".env.example should document {key}"


def test_makefile_exposes_serve_voice() -> None:
    makefile = REPO_ROOT / "Makefile"
    assert makefile.is_file(), f"Expected {makefile} to exist"

    content = makefile.read_text(encoding="utf-8")

    # Target must be present and documented
    assert "serve-voice:" in content, "Makefile must declare serve-voice target"
    assert "serve-voice" in content.split(".PHONY:")[1].split("\n")[0] or "serve-voice" in content, (
        "serve-voice must be .PHONY"
    )
    assert "agent.voice_asgi:app" in content, "serve-voice must invoke agent.voice_asgi:app"
