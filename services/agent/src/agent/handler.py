"""Telegram update → bot → reply. Shared by the Cloud Run entry (main.py) and polling (poll.py)."""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo

import httpx

from agent.bot import Bot
from agent.commands import COMMANDS, CommandSheet, Context, Reply, parse_command
from agent.llm import build_model
from agent.settings import Settings
from agent.sheet_client import SheetClient
from agent.telegram import TelegramClient

log = logging.getLogger(__name__)

FAILURE = "⚠ Não consegui processar agora. Confira a planilha antes de reenviar."


class Replier(Protocol):
    async def reply(self, text: str, user_id: str = "telegram") -> str: ...


class Sender(Protocol):
    async def send_message(self, chat_id: int, text: str) -> None: ...


class Handler:
    def __init__(
        self,
        allowed_chat_ids: frozenset[int] | set[int],
        bot: Replier,
        telegram: Sender,
        sheet: CommandSheet | None = None,
        timezone: str = "America/Sao_Paulo",
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._allowed = allowed_chat_ids
        self._bot = bot
        self._telegram = telegram
        self._sheet = sheet  # for the commands; the bot has its own reference
        zone = ZoneInfo(timezone)
        self._clock = clock or (lambda: datetime.now(zone))

    async def handle_update(self, update: dict[str, Any]) -> None:
        """Never raises: a webhook that errors makes Telegram resend the same update."""
        message = update.get("message") or {}
        text = message.get("text")
        chat_id = (message.get("chat") or {}).get("id")
        if not isinstance(text, str) or not text.strip() or chat_id not in self._allowed:
            return
        parsed = parse_command(text)
        if parsed is not None:
            reply = await self._command(*parsed, chat_id=chat_id)
        else:
            try:
                reply = Reply(await self._bot.reply(text, user_id=str(chat_id)))
            except Exception:
                log.exception("bot failed on update %s", update.get("update_id"))
                reply = Reply(FAILURE)
        try:
            await self._telegram.send_message(chat_id, reply.text)
        except Exception:
            log.exception("could not send the reply to chat %s", chat_id)

    async def _command(self, name: str, args: str, chat_id: int) -> Reply:
        """Registered commands answer from the sheet alone; they never reach the model."""
        ctx = Context(sheet=self._sheet, today=self._clock().date(), chat_id=chat_id)
        try:
            return await COMMANDS[name].run(ctx, args)
        except Exception:
            log.exception("command /%s failed", name)
            return Reply(FAILURE)


def build_handler(settings: Settings, http: httpx.AsyncClient) -> Handler:
    sheet = SheetClient(settings.SHEET_API_URL, settings.SHEET_API_KEY.get_secret_value(), http)
    bot = Bot(sheet, build_model(settings), timezone=settings.TIMEZONE, max_llm_calls=settings.MAX_LLM_CALLS)
    telegram = TelegramClient(settings.TELEGRAM_BOT_TOKEN.get_secret_value(), http)
    return Handler(settings.ALLOWED_CHAT_IDS, bot, telegram, sheet=sheet, timezone=settings.TIMEZONE)
