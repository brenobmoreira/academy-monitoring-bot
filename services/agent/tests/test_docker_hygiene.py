"""Tests for container build context hygiene and security (spec §5.1 / Cloud Run).

Ensures .dockerignore and container specifications prevent leakage of local secrets,
test code, virtual environments, and temporary caches into container images.
"""

from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

AGENT_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = AGENT_DIR.parent.parent


def test_agent_dockerignore_exists() -> None:
    dockerignore = AGENT_DIR / ".dockerignore"
    assert dockerignore.is_file(), f"Expected {dockerignore} to exist"

    content = dockerignore.read_text(encoding="utf-8")
    lines = {
        line.strip() for line in content.splitlines() if line.strip() and not line.strip().startswith("#")
    }

    # Critical secret exclusions
    assert ".env" in lines, ".dockerignore must ignore .env"
    assert any(".env.*" in line or ".env*" in line for line in lines), (
        ".dockerignore must ignore .env.* pattern"
    )

    # Virtual environments & compiler artifacts
    assert any(".venv" in line for line in lines), ".dockerignore must ignore .venv"
    assert any("__pycache__" in line for line in lines), ".dockerignore must ignore __pycache__"

    # Testing & lint caches
    assert any(".pytest_cache" in line for line in lines), ".dockerignore must ignore .pytest_cache"
    assert any(".ruff_cache" in line for line in lines), ".dockerignore must ignore .ruff_cache"

    # Test code exclusion (never bundle test suite into production container)
    assert any("tests" in line for line in lines), ".dockerignore must ignore tests/"


def test_root_dockerignore_exists() -> None:
    root_dockerignore = REPO_ROOT / ".dockerignore"
    assert root_dockerignore.is_file(), f"Expected {root_dockerignore} to exist"

    content = root_dockerignore.read_text(encoding="utf-8")
    lines = {
        line.strip() for line in content.splitlines() if line.strip() and not line.strip().startswith("#")
    }

    assert ".env" in lines, "Root .dockerignore must ignore .env"
    assert any(".venv" in line for line in lines), "Root .dockerignore must ignore .venv"
    assert any("__pycache__" in line for line in lines), "Root .dockerignore must ignore __pycache__"


def test_dockerfile_voice_hygiene_and_runtime_safety() -> None:
    dockerfile = AGENT_DIR / "Dockerfile.voice"
    assert dockerfile.is_file(), f"Expected {dockerfile} to exist"

    content = dockerfile.read_text(encoding="utf-8")

    # PYTHONUNBUFFERED=1 ensures realtime stdout/stderr streaming in Cloud Run
    assert "PYTHONUNBUFFERED=1" in content, (
        "Dockerfile.voice must configure PYTHONUNBUFFERED=1 for log streaming"
    )

    # Must run as non-root
    assert "USER appuser" in content, "Dockerfile.voice must run as non-root user appuser"

    # Must not explicitly copy sensitive or development artifacts
    assert "COPY .env" not in content, "Dockerfile.voice must never explicitly COPY .env"
    assert "COPY tests" not in content, "Dockerfile.voice must never explicitly COPY tests"
