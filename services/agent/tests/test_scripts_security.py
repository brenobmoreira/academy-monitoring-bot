from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.unit

REPO_ROOT = Path(__file__).resolve().parents[3]
SET_WEBHOOK_SCRIPT = REPO_ROOT / "scripts" / "set-webhook.sh"


def _find_bash() -> str | None:
    found = shutil.which("bash")
    if found:
        return found
    git_bash = Path(r"C:\Program Files\Git\bin\bash.exe")
    if git_bash.is_file():
        return str(git_bash)
    return None


def test_set_webhook_exists_and_uses_strict_lf_line_endings() -> None:
    assert SET_WEBHOOK_SCRIPT.is_file(), f"Missing {SET_WEBHOOK_SCRIPT}"
    raw = SET_WEBHOOK_SCRIPT.read_bytes()
    assert len(raw) > 0
    assert b"\r" not in raw, (
        "scripts/set-webhook.sh contains carriage return (CRLF/CR); strict LF is required"
    )
    assert raw.endswith(b"\n"), "scripts/set-webhook.sh must end with a newline"


def test_set_webhook_has_strict_shell_safety_flags() -> None:
    text = SET_WEBHOOK_SCRIPT.read_text(encoding="utf-8")
    lines = text.splitlines()
    assert lines[0] == "#!/usr/bin/env bash", "First line must be '#!/usr/bin/env bash'"
    assert any(re.match(r"^set\s+-[a-z]*e[a-z]*u[a-z]*o\s+pipefail", line) for line in lines), (
        "Script must enable strict error handling with 'set -euo pipefail'"
    )


def test_set_webhook_validates_required_env_vars_without_echoing() -> None:
    text = SET_WEBHOOK_SCRIPT.read_text(encoding="utf-8")
    assert ': "${TELEGRAM_BOT_TOKEN:?set TELEGRAM_BOT_TOKEN}"' in text
    assert ': "${AGENT_URL:?set AGENT_URL}"' in text
    assert ': "${TELEGRAM_WEBHOOK_SECRET:?set TELEGRAM_WEBHOOK_SECRET}"' in text
    # Ensure tokens are never echoed to stdout or stderr
    assert "echo" not in [line for line in text.splitlines() if "TELEGRAM_BOT_TOKEN" in line]
    assert "echo" not in [line for line in text.splitlines() if "TELEGRAM_WEBHOOK_SECRET" in line]


def test_set_webhook_does_not_pass_tokens_in_curl_cli_arguments() -> None:
    text = SET_WEBHOOK_SCRIPT.read_text(encoding="utf-8")

    # Find all curl command blocks before stdin redirection (<<EOF)
    # E.g. `curl -sS --fail-with-body --config - ... <<EOF`
    curl_invocations = re.findall(r"(curl\s+[^<]+?)(?:<<|\n\s*;;)", text, re.DOTALL)
    assert len(curl_invocations) >= 4, (
        f"Expected at least 4 curl commands in set-webhook.sh, found {len(curl_invocations)}"
    )

    for inv in curl_invocations:
        single_line = " ".join(inv.split())
        # The URL containing the token must NOT be in the CLI arguments
        assert "TELEGRAM_BOT_TOKEN" not in single_line, (
            f"TELEGRAM_BOT_TOKEN found in curl CLI arguments (exposing to ps): {single_line}"
        )
        assert "TELEGRAM_WEBHOOK_SECRET" not in single_line, (
            f"TELEGRAM_WEBHOOK_SECRET found in curl CLI arguments (exposing to ps): {single_line}"
        )
        assert "api.telegram.org" not in single_line, (
            f"Telegram API URL found in curl CLI arguments: {single_line}"
        )
        assert "--config -" in single_line, (
            f"curl must read sensitive config from stdin via '--config -': {single_line}"
        )
        assert "--fail-with-body" in single_line, (
            f"curl must specify '--fail-with-body' to handle HTTP errors safely: {single_line}"
        )

    # Verify that the secrets are supplied strictly through stdin config lines
    assert re.search(r'url\s*=\s*"https://api\.telegram\.org/bot\$\{TELEGRAM_BOT_TOKEN\}/setWebhook"', text)
    assert re.search(
        r'url\s*=\s*"https://api\.telegram\.org/bot\$\{TELEGRAM_BOT_TOKEN\}/setMyCommands"', text
    )
    assert re.search(
        r'url\s*=\s*"https://api\.telegram\.org/bot\$\{TELEGRAM_BOT_TOKEN\}/getWebhookInfo"', text
    )
    assert re.search(
        r'url\s*=\s*"https://api\.telegram\.org/bot\$\{TELEGRAM_BOT_TOKEN\}/deleteWebhook"', text
    )
    assert re.search(r'data-urlencode\s*=\s*"secret_token=\$\{TELEGRAM_WEBHOOK_SECRET\}"', text)


def test_set_webhook_execution_verifies_ps_argv_isolation(tmp_path: Path) -> None:
    bash = _find_bash()
    if not bash:
        pytest.skip("bash executable not found")

    # Syntax check via bash -n
    syntax = subprocess.run([bash, "-n", str(SET_WEBHOOK_SCRIPT)], capture_output=True, text=True)
    assert syntax.returncode == 0, f"bash -n failed: {syntax.stderr}"

    log_file = tmp_path / "curl_calls.log"

    env = os.environ.copy()
    env["TELEGRAM_BOT_TOKEN"] = "SUPER_SECRET_BOT_TOKEN_12345"
    env["TELEGRAM_WEBHOOK_SECRET"] = "SUPER_SECRET_WEBHOOK_67890"
    env["AGENT_URL"] = "https://agent-test-run.app"

    # Define a mock curl function exported to the child script
    runner_script = f"""
curl() {{
    echo "--- ARGV ---" >> "{log_file.as_posix()}"
    printf '%s\\n' "$@" >> "{log_file.as_posix()}"
    echo "--- STDIN ---" >> "{log_file.as_posix()}"
    cat >> "{log_file.as_posix()}"
    echo '{{"ok": true, "result": true}}'
}}
export -f curl
exec "{SET_WEBHOOK_SCRIPT.as_posix()}" "$1"
"""

    # Test all actions: set, info, delete
    for action in ["set", "info", "delete"]:
        res = subprocess.run(
            [bash, "-c", runner_script, "runner", action],
            capture_output=True,
            text=True,
            env=env,
        )
        assert res.returncode == 0, f"Failed running action {action}: {res.stderr}\n{res.stdout}"

    logged = log_file.read_text(encoding="utf-8")
    assert logged, "Mock curl was never called"

    sections = logged.split("--- ARGV ---")[1:]
    for section in sections:
        argv_part, stdin_part = section.split("--- STDIN ---")
        # In argv, neither token must EVER appear!
        assert "SUPER_SECRET_BOT_TOKEN_12345" not in argv_part, (
            f"Token leaked into curl process argv:\n{argv_part}"
        )
        assert "SUPER_SECRET_WEBHOOK_67890" not in argv_part, (
            f"Secret leaked into curl process argv:\n{argv_part}"
        )
        assert "--config" in argv_part
        assert "-" in argv_part

    # And verify that stdin received the parameters
    assert "SUPER_SECRET_BOT_TOKEN_12345" in logged
    assert "SUPER_SECRET_WEBHOOK_67890" in logged
