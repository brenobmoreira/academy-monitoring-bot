"""Local development: long-poll Telegram instead of receiving the webhook.

    uv run agent-poll

Settings come from settings.yaml, overridden by services/agent/.env and the environment.
Telegram refuses getUpdates while a webhook is set; delete it first
(scripts/set-webhook.sh delete) and set it again before relying on the deployed function.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

import httpx

from agent.handler import build_handler
from agent.settings import Settings
from agent.telegram import TelegramClient, TelegramError, configure_logging

log = logging.getLogger(__name__)

# Telegram answers that waiting will not fix, by the error_code in Telegram's own JSON answer (an
# HTML 404 from a proxy is retried like any outage): the token was refused (401, or 404 for a
# malformed one), or a webhook is set or another agent-poll is running (409).
NEEDS_ACTION = {
    401: "the bot token was refused: check TELEGRAM_BOT_TOKEN",
    404: "the bot token was refused: check TELEGRAM_BOT_TOKEN",
    409: "a webhook is set (scripts/set-webhook.sh delete) or another agent-poll is running",
}


class Updates(Protocol):
    async def get_updates(self, offset: int | None = None, wait: int = 50) -> list[dict[str, Any]]: ...


class UpdateHandler(Protocol):
    async def handle_update(self, update: dict[str, Any]) -> None: ...


async def poll_once(telegram: Updates, handler: UpdateHandler, offset: int | None) -> int | None:
    for update in await telegram.get_updates(offset=offset):
        offset = update["update_id"] + 1
        await handler.handle_update(update)
    return offset


async def poll_forever(
    telegram: Updates,
    handler: UpdateHandler,
    *,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    max_wait_s: float = 30,
    rounds: int | None = None,
) -> None:
    """Polls until stopped. A network failure or a Telegram error (Wi-Fi drop, 502) is logged and
    retried after 1 s, then 2, 4... up to max_wait_s; a success resets the wait. A Telegram error
    in NEEDS_ACTION is logged with what to do and raised, as is any other exception (a bug).
    `rounds` bounds it in tests."""
    offset: int | None = None
    wait = 1.0
    done = 0
    while rounds is None or done < rounds:
        done += 1
        try:
            offset = await poll_once(telegram, handler, offset)
        except (httpx.TransportError, TelegramError) as err:
            action = NEEDS_ACTION.get(getattr(err, "error_code", None) or 0)
            if action:
                log.error("Telegram refused polling (%s): %s", err, action)
                raise
            log.warning(
                "Telegram unreachable (%s: %s); trying again in %.0f s", type(err).__name__, err, wait
            )
            await sleep(wait)
            wait = min(wait * 2, max_wait_s)
            continue
        wait = 1.0


async def run(settings: Settings) -> None:
    async with httpx.AsyncClient() as http:
        telegram = TelegramClient(settings.TELEGRAM_BOT_TOKEN.get_secret_value(), http)
        handler = build_handler(settings, http)
        log.info("polling Telegram; Ctrl+C to stop")
        await poll_forever(telegram, handler)


def main() -> None:
    configure_logging()
    settings = Settings.load()
    log.info("model %s, up to %s calls per message", settings.LLM_MODEL, settings.MAX_LLM_CALLS)
    try:
        asyncio.run(run(settings))
    except TelegramError as err:
        if getattr(err, "error_code", None) not in NEEDS_ACTION:
            raise
        raise SystemExit(1) from None  # already logged with what to do
