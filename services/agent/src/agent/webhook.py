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

from agent.budget import MemoryBudget
from agent.handler import UpdateDeduplicator, build_handler, strict_int
from agent.logs import describe
from agent.miniapp import FoodDraftStore, PendingStore
from agent.settings import Settings
from agent.text_submissions import TextSubmissions
from agent.voice_confirm import VoiceConfirmations

log = logging.getLogger(__name__)

SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token"
_DEDUPLICATOR = UpdateDeduplicator()
_CONFIRMATIONS = VoiceConfirmations()
_TEXT_SUBMISSIONS = TextSubmissions()
# One handler per request: what a later button tap needs must outlive it.
_FOOD_DRAFTS = FoodDraftStore()
_PENDING = PendingStore()


@functools.cache
def get_settings() -> Settings:
    """Read once per process: a restart is what applies changed settings."""
    return Settings.load()


@functools.cache
def _get_budget(principal_daily: int, global_daily: int, timezone: str) -> MemoryBudget:
    """Process-wide voice token budget (§5.6), shared across webhook requests."""
    return MemoryBudget(principal_daily=principal_daily, global_daily=global_daily, timezone=timezone)


def is_authorized(settings: Settings, given: str | None) -> bool:
    expected = settings.TELEGRAM_WEBHOOK_SECRET
    if expected is None or not given:
        return False
    return hmac.compare_digest(given.encode(), expected.get_secret_value().encode())


class HandlerNotBuilt(Exception):
    """The handler could not be set up (settings, clients, the model): no update can be processed
    until that is fixed, unlike a failure on one update. The cause is chained."""


async def handle_update(settings: Settings, update: dict[str, Any]) -> None:
    async with httpx.AsyncClient() as http:
        try:
            budget = _get_budget(
                settings.VOICE_DAILY_TOKENS,
                settings.VOICE_GLOBAL_DAILY_TOKENS,
                settings.TIMEZONE,
            )
            handler = build_handler(
                settings,
                http,
                deduplicator=_DEDUPLICATOR,
                confirmations=_CONFIRMATIONS,
                text_submissions=_TEXT_SUBMISSIONS,
                budget=budget,
                food_drafts=_FOOD_DRAFTS,
                pending=_PENDING,
            )
        except Exception as error:
            raise HandlerNotBuilt from error
        await handler.handle_update(update)


async def process(secret: str | None, body: Any) -> tuple[str, int]:
    """Returns (text, status). Unauthorized → 403; anything else → 200, so Telegram never retries
    an update the bot has already seen or cannot use.

    The handler ignores a malformed update by itself; the `except` is the net under it, for a
    failure nobody foresaw. It covers the processing only, never the check of the secret, and logs
    the class of the error and the update id: the body and the traceback can carry content. The
    line also names the phase, a fixed word: `phase=build` repeats on every update until the
    service is fixed, `phase=handle` is about this update."""
    settings = get_settings()
    if not is_authorized(settings, secret):
        return "forbidden", 403
    if isinstance(body, dict):
        try:
            await handle_update(settings, body)
        except Exception as error:
            built = not isinstance(error, HandlerNotBuilt)
            cause = error if built else (error.__cause__ or error)
            log.error(
                "update %s failed: phase=%s %s",
                strict_int(body.get("update_id")),
                "handle" if built else "build",
                describe(cause),
            )
    return "ok", 200
