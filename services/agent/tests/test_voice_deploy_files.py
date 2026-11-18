"""Integrity and consistency tests for voice deployment files (spec §5.1).

Validates Dockerfile.voice, cloudbuild.voice.yaml, .env.example, Makefile integration,
and deployment documentation in docs/setup/README.md.
"""

from pathlib import Path

import pytest
import yaml

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

    # Best-practice: runs as non-root user and avoids large recursive chown layers
    assert "USER appuser" in content, "Dockerfile.voice should run as non-root USER appuser"
    assert "chown -R appuser:appuser /app" not in content, (
        "Dockerfile.voice must avoid recursive chown layer over virtualenv (m3)"
    )


def test_cloudbuild_voice_yaml_valid() -> None:
    cloudbuild = AGENT_DIR / "cloudbuild.voice.yaml"
    assert cloudbuild.is_file(), f"Expected {cloudbuild} to exist"

    content = cloudbuild.read_text(encoding="utf-8")
    parsed = yaml.safe_load(content)
    assert isinstance(parsed, dict), "cloudbuild.voice.yaml must be a valid YAML mapping"

    assert "steps" in parsed, "cloudbuild.voice.yaml must contain steps"
    assert "images" in parsed, "cloudbuild.voice.yaml must contain images list"

    # Must push $_IMAGE
    assert "$_IMAGE" in parsed["images"], "cloudbuild.voice.yaml must list $_IMAGE in images"

    # Must build from Dockerfile.voice targeting $_IMAGE
    dockerfile_referenced = False
    image_tagged = False
    for step in parsed["steps"]:
        args = step.get("args", [])
        if "Dockerfile.voice" in args:
            dockerfile_referenced = True
        if "$_IMAGE" in args:
            image_tagged = True

    assert dockerfile_referenced, "cloudbuild.voice.yaml step must reference Dockerfile.voice"
    assert image_tagged, "cloudbuild.voice.yaml step must tag $_IMAGE"


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

    # m1: VOICE_MAX_SECONDS must be documented as audio duration (D2), not network timeout
    max_seconds_line = next(
        (line for line in content.splitlines() if "VOICE_MAX_SECONDS" in line),
        "",
    )
    assert max_seconds_line, "VOICE_MAX_SECONDS must be documented in .env.example"
    lower_line = max_seconds_line.lower()
    assert "duração" in lower_line or "duracao" in lower_line or "d2" in lower_line, (
        "VOICE_MAX_SECONDS comment must clarify that it is audio duration (D2)"
    )
    assert "timeout" in lower_line, "VOICE_MAX_SECONDS comment must clarify that it is not network timeout"

    # m2: TRANSCRIBE_API_KEY (or GEMINI_API_KEY) must appear in the standalone voice section
    standalone_section = content.partition("Standalone voice service")[2]
    assert "TRANSCRIBE_API_KEY" in standalone_section, (
        "Standalone voice section must mention TRANSCRIBE_API_KEY (m2)"
    )


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

    # I2: serve-voice must guarantee single-worker execution
    serve_voice_block = content.partition("serve-voice:")[2].partition("\n\n")[0]
    assert "--workers 1" in serve_voice_block, (
        "Makefile serve-voice target must pass --workers 1 to guarantee single-worker execution (I2)"
    )


def test_makefile_sync_reqs_and_test_miniapp() -> None:
    makefile = REPO_ROOT / "Makefile"
    assert makefile.is_file(), f"Expected {makefile} to exist"

    content = makefile.read_text(encoding="utf-8")

    # Both targets registered in .PHONY
    phony_lines = []
    in_phony = False
    for line in content.splitlines():
        if line.startswith(".PHONY:"):
            in_phony = True
            phony_lines.append(line.partition(".PHONY:")[2])
        elif in_phony:
            if line.startswith("\t"):
                phony_lines.append(line)
            else:
                break
    phony_targets = " ".join(phony_lines).split()
    assert "sync-reqs" in phony_targets, "sync-reqs must be registered in .PHONY"
    assert "test-miniapp" in phony_targets, "test-miniapp must be registered in .PHONY"

    # Target definitions exist
    assert "sync-reqs:" in content, "Makefile must declare sync-reqs target"
    assert "test-miniapp:" in content, "Makefile must declare test-miniapp target"

    # Recipes must use real TAB indentation
    lines = content.splitlines()
    for target in ("sync-reqs", "test-miniapp"):
        target_indices = [i for i, line in enumerate(lines) if line.startswith(f"{target}:")]
        assert target_indices, f"Target {target}: not found in Makefile"
        idx = target_indices[0]
        recipe_lines = []
        for line in lines[idx + 1 :]:
            if not line.strip():
                break
            recipe_lines.append(line)
        assert recipe_lines, f"Recipe for {target} must contain command lines"
        for rline in recipe_lines:
            assert rline.startswith("\t"), f"Recipe for {target} must start with real TAB: {repr(rline)}"

    # test-miniapp recipe checks
    miniapp_block = content.partition("test-miniapp:")[2].partition("\n\n")[0]
    assert "node --test apps/miniapp/test/*.test.js" in miniapp_block, (
        "test-miniapp recipe must execute node --test apps/miniapp/test/*.test.js"
    )

    # sync-reqs recipe checks: must preserve the first 2 comment lines and invoke uv export
    sync_block = content.partition("sync-reqs:")[2].partition("\n\n")[0]
    assert (
        "uv export --locked --no-dev --no-emit-project --no-hashes --no-header --format requirements-txt"
        in sync_block
    ), "sync-reqs must run uv export with locked flags matching CI"

    # Verify that the 2 header lines generated/preserved match services/agent/requirements.txt
    requirements_file = AGENT_DIR / "requirements.txt"
    assert requirements_file.is_file(), f"Expected {requirements_file} to exist"
    req_lines = requirements_file.read_text(encoding="utf-8").splitlines()
    assert len(req_lines) >= 2, "requirements.txt must have at least 2 header lines"
    expected_header_line2 = (
        "#    uv export --no-dev --no-emit-project --no-hashes"
        + " --format requirements-txt -o requirements.txt"
    )
    assert req_lines[1] == expected_header_line2


def test_readme_voice_deploy_docs() -> None:
    readme = REPO_ROOT / "docs" / "setup" / "README.md"
    assert readme.is_file(), f"Expected {readme} to exist"

    content = readme.read_text(encoding="utf-8")

    # B1: Non-existent --dockerfile flag must not be present in README
    assert "--dockerfile" not in content, (
        "README must not use non-existent --dockerfile flag in gcloud run deploy"
    )

    # B1: Must document cloudbuild.voice.yaml and gcloud builds submit
    assert "cloudbuild.voice.yaml" in content, (
        "README must document building the voice image using cloudbuild.voice.yaml"
    )
    assert "gcloud builds submit" in content, "README must document gcloud builds submit"

    # I1: Must include all checklist items of spec §5.1, especially Billing Budget alert
    assert "Billing Budget" in content or "billing budget" in content.lower(), (
        "README must explicitly mention Billing Budget with email alert below spend cap (I1)"
    )
    assert "spend cap" in content.lower(), "README must reference Gemini spend cap"
    assert "Secret Manager" in content, "README must mention Secret Manager"
    assert "Scale to zero" in content or "escala a zero" in content.lower(), (
        "README must document scale to zero"
    )
