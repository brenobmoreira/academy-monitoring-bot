"""Local development: long-poll Telegram instead of receiving the webhook.

    uv run agent-poll

Reads services/agent/.env. Telegram refuses getUpdates while a webhook is set; delete it first
(scripts/set-webhook.sh delete) and set it again before relying on the deployed function.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Protocol

import httpx
from dotenv import load_dotenv

from agent.config import Settings
from agent.handler import build_handler
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
        telegram = TelegramClient(settings.telegram_bot_token, http)
        handler = build_handler(settings, http)
        offset = None
        log.info("polling Telegram; Ctrl+C to stop")
        while True:
            offset = await poll_once(telegram, handler, offset)


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    load_dotenv()
    asyncio.run(run(Settings.from_env()))
