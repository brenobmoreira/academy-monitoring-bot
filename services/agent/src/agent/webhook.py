"""What every HTTP entry point does with a Telegram update, independent of the server.

Two ways to serve it, same behaviour:
  - Functions Framework (Cloud Run functions): main.telegram_webhook
  - ASGI (uvicorn, any container):            asgi.app
"""

from __future__ import annotations

import functools
import hmac
import logging
from typing import Any

import httpx

from agent.handler import build_handler
from agent.settings import Settings

log = logging.getLogger(__name__)

SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token"


@functools.cache
def get_settings() -> Settings:
    """Read once per process: a restart is what applies changed settings."""
    return Settings.load()


def is_authorized(settings: Settings, given: str | None) -> bool:
    expected = settings.TELEGRAM_WEBHOOK_SECRET
    if expected is None or not given:
        return False
    return hmac.compare_digest(given.encode(), expected.get_secret_value().encode())


async def handle_update(settings: Settings, update: dict[str, Any]) -> None:
    async with httpx.AsyncClient() as http:
        await build_handler(settings, http).handle_update(update)


async def process(secret: str | None, body: Any) -> tuple[str, int]:
    """Returns (text, status). Unauthorized → 403; anything else → 200, so Telegram never retries
    an update the bot has already seen or cannot use."""
    settings = get_settings()
    if not is_authorized(settings, secret):
        return "forbidden", 403
    if isinstance(body, dict):
        await handle_update(settings, body)
    return "ok", 200
