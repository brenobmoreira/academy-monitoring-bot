"""Local development: long-poll Telegram instead of receiving the webhook.

    uv run agent-poll

Settings come from settings.yaml, overridden by services/agent/.env and the environment.
Telegram refuses getUpdates while a webhook is set; delete it first
(scripts/set-webhook.sh delete) and set it again before relying on the deployed function.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Protocol

import httpx

from agent.handler import build_handler
from agent.settings import Settings
from agent.telegram import TelegramClient

log = logging.getLogger(__name__)


class Updates(Protocol):
    async def get_updates(self, offset: int | None = None, wait: int = 50) -> list[dict[str, Any]]: ...


class UpdateHandler(Protocol):
    async def handle_update(self, update: dict[str, Any]) -> None: ...


async def poll_once(telegram: Updates, handler: UpdateHandler, offset: int | None) -> int | None:
    for update in await telegram.get_updates(offset=offset):
        offset = update["update_id"] + 1
        await handler.handle_update(update)
    return offset


async def run(settings: Settings) -> None:
    async with httpx.AsyncClient() as http:
        telegram = TelegramClient(settings.TELEGRAM_BOT_TOKEN.get_secret_value(), http)
        handler = build_handler(settings, http)
        offset = None
        log.info("polling Telegram; Ctrl+C to stop")
        while True:
            offset = await poll_once(telegram, handler, offset)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    settings = Settings.load()
    log.info("model %s, up to %s calls per message", settings.LLM_MODEL, settings.MAX_LLM_CALLS)
    asyncio.run(run(settings))
