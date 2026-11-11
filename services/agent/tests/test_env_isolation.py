"""LiteLLM must not load a stray .env: the --env file is the only configuration.

`import litellm` calls `dotenv.load_dotenv()` unless LITELLM_MODE says otherwise.
That search starts at the litellm package and walks up, so a `.env` beside the
virtualenv (another client's) lands in os.environ, where it beats the file given
with --env. The bot then runs with the wrong token, sheet and allowed chats.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src"

PROBE = """
import dotenv
calls = []
dotenv.load_dotenv = lambda *a, **k: calls.append(1) or False
import agent.llm
import os
print(len(calls), os.environ.get("LITELLM_MODE"))
"""


def _run(extra_env: dict[str, str]) -> str:
    env = {k: v for k, v in os.environ.items() if k != "LITELLM_MODE"}
    env["PYTHONPATH"] = str(SRC)
    env.update(extra_env)
    done = subprocess.run([sys.executable, "-c", PROBE], env=env, capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr
    return done.stdout.strip()


def test_importing_the_agent_does_not_let_litellm_load_a_dotenv_file() -> None:
    assert _run({}) == "0 PRODUCTION"


def test_an_explicit_litellm_mode_is_left_alone() -> None:
    calls, mode = _run({"LITELLM_MODE": "DEV"}).split()
    assert mode == "DEV"
    assert int(calls) >= 1
