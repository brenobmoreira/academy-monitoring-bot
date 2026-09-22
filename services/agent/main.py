"""Cloud Run functions entry: the Python buildpack loads main.py from the source root.

The code lives in src/agent (a uv package); this shim puts src on the path so the deployed
function needs only requirements.txt, not an install of the project itself.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "src"))

from agent.main import telegram_webhook  # noqa: E402

__all__ = ["telegram_webhook"]
