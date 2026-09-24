"""Telegram update → bot → reply. Shared by the Cloud Run entry (main.py) and polling (poll.py)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable
from datetime import datetime
from typing import Any, NamedTuple, Protocol
from zoneinfo import ZoneInfo

import httpx

from agent import buttons
from agent.bot import MEDIA_UNREADABLE, Answer, Bot, Media
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
MEDIA_MAX_BYTES = 5_000_000
DOWNLOAD_FAILED = "⚠ Não consegui baixar o arquivo do Telegram. Tente de novo ou envie em texto."


def too_large(max_bytes: int) -> str:
    size = f"{max_bytes / 1_000_000:.1f}".rstrip("0").rstrip(".").replace(".", ",")
    return f"O arquivo passa de {size} MB, o máximo que eu leio; envie em texto ou um arquivo menor."


class Replier(Protocol):
    async def reply(
        self,
        text: str,
        user_id: str = "telegram",
        *,
        context: str | None = None,
        media: list[Media] | None = None,
    ) -> Answer: ...


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

    async def get_file(self, file_id: str) -> dict[str, Any]: ...

    async def download_file(self, file_path: str) -> bytes: ...


class MediaRef(NamedTuple):
    """The file of a voice, audio or photo message, before download."""

    file_id: str
    size: int | None  # as Telegram reports it; may be absent
    mime_type: str

    def fits(self, max_bytes: int) -> bool:
        return self.size is None or self.size <= max_bytes


class TooLarge(Exception):
    pass


def media_ref(message: dict[str, Any], max_bytes: int) -> MediaRef | None:
    """The file to read from a voice, audio or photo message; None for any other message.

    Telegram sends each photo in several sizes (always JPEG): the largest that fits `max_bytes`
    is taken, or the smallest when none does (so the caller sees it is too large).
    """
    for key, default_mime in (("voice", "audio/ogg"), ("audio", "audio/mpeg")):
        item = message.get(key)
        if isinstance(item, dict) and isinstance(item.get("file_id"), str):
            return MediaRef(item["file_id"], _size(item), item.get("mime_type") or default_mime)
    photos = [
        MediaRef(p["file_id"], _size(p), "image/jpeg")
        for p in message.get("photo") or []
        if isinstance(p, dict) and isinstance(p.get("file_id"), str)
    ]
    if not photos:
        return None
    fitting = [p for p in photos if p.fits(max_bytes)]
    if fitting:
        return max(fitting, key=lambda p: p.size or 0)
    return min(photos, key=lambda p: p.size or 0)


def _size(item: dict[str, Any]) -> int | None:
    size = item.get("file_size")
    return size if isinstance(size, int) else None


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
        media_enabled: bool = True,
        media_max_bytes: int = MEDIA_MAX_BYTES,
    ) -> None:
        self._allowed = allowed_chat_ids
        self._bot = bot
        self._telegram = telegram
        self._sheet = sheet  # for the commands; the bot has its own reference
        zone = ZoneInfo(timezone)
        self._clock = clock or (lambda: datetime.now(zone))
        self._typing_every = typing_every
        self._media_enabled = media_enabled
        self._media_max_bytes = media_max_bytes

    async def handle_update(self, update: dict[str, Any]) -> None:
        """Never raises: a webhook that errors makes Telegram resend the same update."""
        if "callback_query" in update:
            await self._callback(update["callback_query"])
            return
        message = update.get("message") or {}
        text = message.get("text")
        chat_id = (message.get("chat") or {}).get("id")
        if chat_id not in self._allowed:
            return
        if not isinstance(text, str) or not text.strip():
            reply = await self._media(message, chat_id, update.get("update_id"))
            if reply is None:
                return
        else:
            parsed = parse_command(text)
            if parsed is not None:
                reply = await self._command(*parsed, chat_id=chat_id)
            else:
                reply = await self._run_bot(text, message, update.get("update_id"))
        try:
            await self._send(chat_id, reply)
        except Exception:
            log.exception("could not send the reply to chat %s", chat_id)

    async def _run_bot(
        self, text: str, message: dict[str, Any], update_id: Any, media: list[Media] | None = None
    ) -> Reply:
        chat_id = message["chat"]["id"]
        typing = asyncio.create_task(self._keep_typing(chat_id))
        await asyncio.sleep(0)  # let the first action go out before the bot starts
        try:
            context = replied_text(message)
            if media:
                answer = await self._bot.reply(text, user_id=str(chat_id), context=context, media=media)
            else:
                answer = await self._bot.reply(text, user_id=str(chat_id), context=context)
            markup = buttons.keyboard(answer.write_ids) if answer.wrote else None
            return Reply(answer.text, html=True, reply_markup=markup)
        except Exception:
            log.exception("bot failed on update %s", update_id)
            return Reply(FAILURE)
        finally:
            typing.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await typing

    async def _media(self, message: dict[str, Any], chat_id: int, update_id: Any) -> Reply | None:
        """Voice, audio and photo messages (caption optional); None for anything else (stickers,
        documents, service messages), which gets no reply."""
        ref = media_ref(message, self._media_max_bytes)
        if ref is None:
            return None
        if not self._media_enabled:
            return Reply(MEDIA_UNREADABLE)
        if not ref.fits(self._media_max_bytes):
            return Reply(too_large(self._media_max_bytes))
        caption = message.get("caption")
        caption = caption if isinstance(caption, str) else ""
        try:
            data = await self._download(ref)
        except TooLarge:
            return Reply(too_large(self._media_max_bytes))
        except Exception:
            log.exception("could not download the file of update %s", update_id)
            return Reply(DOWNLOAD_FAILED)
        return await self._run_bot(caption, message, update_id, media=[Media(ref.mime_type, data)])

    async def _download(self, ref: MediaRef) -> bytes:
        file = await self._telegram.get_file(ref.file_id)
        size = file.get("file_size")
        if isinstance(size, int) and size > self._media_max_bytes:
            raise TooLarge
        path = file.get("file_path")
        if not isinstance(path, str) or not path:
            raise ValueError("getFile returned no file_path")
        data = await self._telegram.download_file(path)
        if len(data) > self._media_max_bytes:
            raise TooLarge
        return data

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
    return Handler(
        settings.ALLOWED_CHAT_IDS,
        bot,
        telegram,
        sheet=sheet,
        timezone=settings.TIMEZONE,
        media_enabled=settings.MEDIA_ENABLED,
        media_max_bytes=settings.MEDIA_MAX_BYTES,
    )
