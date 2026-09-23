"""Cloud Run function entry point: Telegram posts every update here.

Deployed with --function telegram_webhook. The webhook is registered with a secret_token, which
Telegram echoes in the X-Telegram-Bot-Api-Secret-Token header of every request.
"""

from __future__ import annotations

import asyncio
import functools
import hmac
import logging
from typing import Any

import functions_framework
import httpx
from flask import Request

from agent.handler import build_handler
from agent.settings import Settings

logging.basicConfig(level=logging.INFO)


@functools.cache
def _settings() -> Settings:
    settings = Settings.load()
    settings.apply_model_env()
    return settings


async def _handle(settings: Settings, update: dict[str, Any]) -> None:
    async with httpx.AsyncClient() as http:
        await build_handler(settings, http).handle_update(update)


@functions_framework.http
def telegram_webhook(request: Request) -> tuple[str, int]:
    settings = _settings()
    expected = settings.telegram_webhook_secret
    given = request.headers.get("X-Telegram-Bot-Api-Secret-Token", "")
    if not expected or not hmac.compare_digest(given.encode(), expected.get_secret_value().encode()):
        return "forbidden", 403
    update = request.get_json(silent=True)
    if isinstance(update, dict):
        asyncio.run(_handle(settings, update))
    return "ok", 200
