"""Telegram update → bot → reply. Shared by the Cloud Run entry (main.py) and polling (poll.py)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from datetime import datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo

import httpx

from agent import buttons
from agent.bot import Answer, Bot
from agent.commands import COMMANDS, CommandSheet, Context, Reply, parse_command
from agent.format import escape, split
from agent.llm import build_model
from agent.settings import Settings
from agent.sheet_client import SheetClient
from agent.telegram import TelegramClient
from agent.undo import undo_writes

log = logging.getLogger(__name__)

FAILURE = "⚠ Não consegui processar agora. Confira a planilha antes de reenviar."
TYPING_EVERY = 4.0  # seconds; Telegram clears the "typing…" status after about 5 s


class Replier(Protocol):
    async def reply(self, text: str, user_id: str = "telegram", *, context: str | None = None) -> Answer: ...


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

    async def send_chat_action(self, chat_id: int, action: str = "typing") -> None: ...

    async def answer_callback_query(self, callback_query_id: str, text: str | None = None) -> None: ...

    async def edit_message_reply_markup(
        self, chat_id: int, message_id: int, reply_markup: dict[str, Any] | None = None
    ) -> None: ...


class Handler:
    def __init__(
        self,
        allowed_chat_ids: frozenset[int] | set[int],
        bot: Replier,
        telegram: Sender,
        sheet: CommandSheet | None = None,
        timezone: str = "America/Sao_Paulo",
        clock: Callable[[], datetime] | None = None,
        typing_every: float = TYPING_EVERY,
    ) -> None:
        self._allowed = allowed_chat_ids
        self._bot = bot
        self._telegram = telegram
        self._sheet = sheet  # for the commands; the bot has its own reference
        zone = ZoneInfo(timezone)
        self._clock = clock or (lambda: datetime.now(zone))
        self._typing_every = typing_every

    async def handle_update(self, update: dict[str, Any]) -> None:
        """Never raises: a webhook that errors makes Telegram resend the same update."""
        if "callback_query" in update:
            await self._callback(update["callback_query"])
            return
        message = update.get("message") or {}
        text = message.get("text")
        chat_id = (message.get("chat") or {}).get("id")
        if not isinstance(text, str) or not text.strip() or chat_id not in self._allowed:
            return
        parsed = parse_command(text)
        if parsed is not None:
            reply = await self._command(*parsed, chat_id=chat_id)
        else:
            typing = asyncio.create_task(self._keep_typing(chat_id))
            await asyncio.sleep(0)  # let the first action go out before the bot starts
            try:
                answer = await self._bot.reply(text, user_id=str(chat_id), context=replied_text(message))
                markup = buttons.keyboard(answer.write_ids) if answer.wrote else None
                reply = Reply(answer.text, html=True, reply_markup=markup)
            except Exception:
                log.exception("bot failed on update %s", update.get("update_id"))
                reply = Reply(FAILURE)
            finally:
                typing.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await typing
        try:
            await self._send(chat_id, reply)
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

    async def _callback(self, query: dict[str, Any]) -> None:
        """A tap on an inline button. Always answered (Telegram shows a spinner until then), even
        when the chat is not allowed or the action fails; the failure shows as a toast."""
        message = query.get("message") or {}
        chat_id = (message.get("chat") or {}).get("id")
        message_id = message.get("message_id")
        toast = None
        try:
            if chat_id in self._allowed and isinstance(message_id, int):
                await self._button(str(query.get("data") or ""), chat_id, message_id, message)
        except Exception:
            log.exception("button %r failed", query.get("data"))
            toast = FAILURE
        try:
            await self._telegram.answer_callback_query(str(query.get("id", "")), toast)
        except Exception:
            log.exception("could not answer callback query %s", query.get("id"))

    async def _button(self, data: str, chat_id: int, message_id: int, message: dict[str, Any]) -> None:
        verb, ids = buttons.parse(data)
        if verb == buttons.OK:
            await self._remove_keyboard(chat_id, message_id)
        elif verb == buttons.UNDO:
            if self._sheet is None:
                raise RuntimeError("this handler has no sheet API")
            text, sheet_down = await undo_writes(self._sheet, ids)
            if not sheet_down:  # otherwise keep the button for another try
                await self._remove_keyboard(chat_id, message_id)
            await self._send(chat_id, Reply(text), reply_to=message_id)
        elif verb == buttons.FIX:
            text, markup = buttons.fix_prompt(message.get("text"))
            await self._send(chat_id, Reply(text, reply_markup=markup), reply_to=message_id)
        else:
            log.warning("unknown button data %r", data)

    async def _remove_keyboard(self, chat_id: int, message_id: int) -> None:
        """Cosmetic: a message already edited (double tap) or too old to edit keeps its buttons."""
        try:
            await self._telegram.edit_message_reply_markup(chat_id, message_id)
        except Exception as error:
            log.warning("could not remove the buttons of message %s: %s", message_id, error)

    async def _keep_typing(self, chat_id: int) -> None:
        """Shows "typing…" until cancelled. Cosmetic: the first failure stops it, the reply is unaffected."""
        while True:
            try:
                await self._telegram.send_chat_action(chat_id)
            except Exception as error:
                log.warning("could not send the typing action to chat %s: %s", chat_id, error)
                return
            await asyncio.sleep(self._typing_every)

    async def _send(self, chat_id: int, reply: Reply, reply_to: int | None = None) -> None:
        """Sends the reply as Telegram HTML (plain text is escaped first) in as many messages as it
        needs; only the last one gets the markup, only the first quotes `reply_to`."""
        chunks = split(reply.text if reply.html else escape(reply.text))
        for i, chunk in enumerate(chunks):
            markup = reply.reply_markup if i == len(chunks) - 1 else None
            quote = reply_to if i == 0 else None
            await self._telegram.send_message(chat_id, chunk, html=True, reply_markup=markup, reply_to=quote)


def replied_text(message: dict[str, Any]) -> str | None:
    """The text of the bot message this one replies to (swipe-reply or ✏️ Corrigir), the only
    context the agent gets from earlier messages besides the sheet's recent writes. A reply to
    the user's own message, or to one without text, gives none."""
    replied = message.get("reply_to_message") or {}
    if not (replied.get("from") or {}).get("is_bot"):
        return None
    text = replied.get("text")
    return text if isinstance(text, str) and text.strip() else None


def build_handler(settings: Settings, http: httpx.AsyncClient) -> Handler:
    sheet = SheetClient(settings.SHEET_API_URL, settings.SHEET_API_KEY.get_secret_value(), http)
    bot = Bot(sheet, build_model(settings), timezone=settings.TIMEZONE, max_llm_calls=settings.MAX_LLM_CALLS)
    telegram = TelegramClient(settings.TELEGRAM_BOT_TOKEN.get_secret_value(), http)
    return Handler(settings.ALLOWED_CHAT_IDS, bot, telegram, sheet=sheet, timezone=settings.TIMEZONE)
