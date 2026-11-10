"""Fitness bot agent.

LiteLLM loads the nearest `.env` into os.environ on import unless LITELLM_MODE
is something other than "DEV". With one deploy per client, that `.env` can be
another client's, and process environment beats the file passed with --env.
This runs before any module of the package imports litellm.
"""

import os

os.environ.setdefault("LITELLM_MODE", "PRODUCTION")
