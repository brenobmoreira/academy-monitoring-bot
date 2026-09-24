"""Scheduled pushes (`POST /remind`), independent of the HTTP server like webhook.py.

A Cloud Scheduler job per kind calls the agent's URL at /remind with the header
`X-Reminder-Token` and a JSON body `{"kind": "daily" | "weekly"}`:

  - daily:  today's diary lacks weight, sleep or steps → "Faltou registrar hoje: …" to each
            allowed chat; nothing missing → no message.
  - weekly: the /semana summary of the 7 days that end today.

Without REMINDER_TOKEN the endpoint does not exist (404). The sheet being down never turns into
a message: the job runs unattended, so a failure is logged and nothing is sent.
"""

from __future__ import annotations

import hmac
import logging
from collections.abc import Callable, Iterable
from datetime import date, datetime, timedelta
from typing import Any, Protocol
from zoneinfo import ZoneInfo

import httpx

from agent import webhook
from agent.commands import CommandSheet, Reply, week_text
from agent.format import escape, split
from agent.settings import Settings
from agent.sheet_client import SheetClient
from agent.telegram import TelegramClient

log = logging.getLogger(__name__)

TOKEN_HEADER = "X-Reminder-Token"
PATH = "/remind"
KINDS = ("daily", "weekly")
BAD_BODY = 'body must be {"kind": "daily" | "weekly"}'

# Diary field → (word in the reminder, example of how to send it), in the order they are listed.
DAILY_FIELDS = {
    "weightKg": ("peso", "peso 82,4"),
    "sleepH": ("sono", "dormi 7h30"),
    "steps": ("passos", "8k passos"),
}


class Sender(Protocol):
    async def send_message(
        self,
        chat_id: int,
        text: str,
        *,
        html: bool = False,
        reply_markup: dict[str, Any] | None = None,
        reply_to: int | None = None,
    ) -> dict[str, Any]: ...


class SheetDown(RuntimeError):
    """The sheet did not answer (or refused); the reminder sends nothing."""


# ---- what to send --------------------------------------------------------------------------


def missing_fields(diary: dict[str, Any]) -> list[str]:
    """Diary keys of DAILY_FIELDS with no value. Any value the sheet holds counts as recorded,
    a hand-typed text included: the reminder asks for what is absent, not for what is odd."""
    return [key for key in DAILY_FIELDS if _blank(diary.get(key))]


def daily_text(missing: list[str]) -> str:
    words = ", ".join(DAILY_FIELDS[key][0] for key in missing)
    example = ", ".join(DAILY_FIELDS[key][1] for key in missing)
    return f"Faltou registrar hoje: {words}.\nÉ só mandar, por exemplo: {example}"


async def daily(sheet: CommandSheet, today: date) -> Reply | None:
    response = await sheet.day(today.isoformat())
    if not response.get("ok"):
        raise SheetDown(_error(response))
    missing = missing_fields(response["result"].get("diary") or {})
    return Reply(daily_text(missing)) if missing else None


async def weekly(sheet: CommandSheet, today: date) -> Reply:
    reply = await week_text(sheet, today - timedelta(days=6), today)
    # week_text maps a sheet failure to a plain-text warning; its summary is always HTML.
    if not reply.html:
        raise SheetDown(reply.text)
    return reply


# ---- sending -------------------------------------------------------------------------------


async def remind(
    kind: str, sheet: CommandSheet, telegram: Sender, chat_ids: Iterable[int], today: date
) -> tuple[int, int]:
    """(chats reached, chats tried). A chat that fails is logged and the others still get it."""
    try:
        reply = await (daily(sheet, today) if kind == "daily" else weekly(sheet, today))
    except SheetDown as err:
        log.warning("%s reminder skipped, sheet failed: %s", kind, err)
        return 0, 0
    if reply is None:
        return 0, 0
    chunks = split(reply.text if reply.html else escape(reply.text))
    chats = sorted(chat_ids)
    sent = 0
    for chat_id in chats:
        try:
            for chunk in chunks:
                await telegram.send_message(chat_id, chunk, html=True)
            sent += 1
        except Exception:
            log.exception("could not send the %s reminder to chat %s", kind, chat_id)
    return sent, len(chats)


def http_client() -> httpx.AsyncClient:
    """Replaced by e2e/run.py to capture Telegram."""
    return httpx.AsyncClient()


async def deliver(
    settings: Settings, kind: str, clock: Callable[[], datetime] | None = None
) -> tuple[int, int]:
    now = clock() if clock else datetime.now(ZoneInfo(settings.TIMEZONE))
    async with http_client() as http:
        sheet = SheetClient(settings.SHEET_API_URL, settings.SHEET_API_KEY.get_secret_value(), http)
        telegram = TelegramClient(settings.TELEGRAM_BOT_TOKEN.get_secret_value(), http)
        return await remind(kind, sheet, telegram, settings.ALLOWED_CHAT_IDS, now.date())


# ---- HTTP ----------------------------------------------------------------------------------


def is_authorized(settings: Settings, given: str | None) -> bool:
    expected = settings.REMINDER_TOKEN
    if expected is None or not given:
        return False
    return hmac.compare_digest(given.encode(), expected.get_secret_value().encode())


async def process(token: str | None, body: Any) -> tuple[str, int]:
    """Returns (text, status): 404 without REMINDER_TOKEN, 403 for a wrong token, 400 for a bad
    body, 502 when there was something to send and no chat got it, otherwise 200."""
    settings = webhook.get_settings()
    if settings.REMINDER_TOKEN is None:
        return "not found", 404
    if not is_authorized(settings, token):
        return "forbidden", 403
    kind = body.get("kind") if isinstance(body, dict) else None
    if kind not in KINDS:
        return BAD_BODY, 400
    sent, tried = await deliver(settings, kind)
    if tried == 0:
        return "nothing to send", 200
    status = 502 if sent == 0 else 200
    return (f"sent {sent}" if sent == tried else f"sent {sent} of {tried}"), status


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _error(response: dict[str, Any]) -> str:
    error = (response.get("errors") or [{}])[0]
    return f"{error.get('code', '?')}: {error.get('message', '')}"
