"""Telegram update → bot → reply. Shared by the Cloud Run entry (main.py) and polling (poll.py)."""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any, Protocol

import httpx

from agent.bot import Bot
from agent.llm import build_model
from agent.settings import Settings
from agent.sheet_client import SheetClient
from agent.telegram import TelegramClient

log = logging.getLogger(__name__)

HELP = (
    "Me conte o dia em texto livre, por exemplo:\n"
    "• peso 82,4, dormi 7h30, 8k passos, muay sim\n"
    "• upper: supino inclinado 60x8 62x8 rir 2, puxada aberta 50x10 50x9\n"
    "• ontem fome 3 cansaço 4\n"
    "• como foi meu supino inclinado nas últimas semanas?\n"
    "Eu gravo na planilha e confirmo o que foi gravado."
)
FAILURE = "⚠ Não consegui processar agora. Confira a planilha antes de reenviar."
TYPING_EVERY = 4.0  # seconds; Telegram clears the "typing…" status after about 5 s


class Replier(Protocol):
    async def reply(self, text: str, user_id: str = "telegram") -> str: ...


class Sender(Protocol):
    async def send_message(self, chat_id: int, text: str) -> None: ...

    async def send_chat_action(self, chat_id: int, action: str = "typing") -> None: ...


class Handler:
    def __init__(
        self,
        allowed_chat_ids: frozenset[int] | set[int],
        bot: Replier,
        telegram: Sender,
        typing_every: float = TYPING_EVERY,
    ) -> None:
        self._allowed = allowed_chat_ids
        self._bot = bot
        self._telegram = telegram
        self._typing_every = typing_every

    async def handle_update(self, update: dict[str, Any]) -> None:
        """Never raises: a webhook that errors makes Telegram resend the same update."""
        message = update.get("message") or {}
        text = message.get("text")
        chat_id = (message.get("chat") or {}).get("id")
        if not isinstance(text, str) or not text.strip() or chat_id not in self._allowed:
            return
        if text.split()[0].split("@")[0] in ("/start", "/help"):
            reply = HELP
        else:
            typing = asyncio.create_task(self._keep_typing(chat_id))
            await asyncio.sleep(0)  # let the first action go out before the bot starts
            try:
                reply = await self._bot.reply(text, user_id=str(chat_id))
            except Exception:
                log.exception("bot failed on update %s", update.get("update_id"))
                reply = FAILURE
            finally:
                typing.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await typing
        try:
            await self._telegram.send_message(chat_id, reply)
        except Exception:
            log.exception("could not send the reply to chat %s", chat_id)

    async def _keep_typing(self, chat_id: int) -> None:
        """Shows "typing…" until cancelled. Cosmetic: the first failure stops it, the reply is unaffected."""
        while True:
            try:
                await self._telegram.send_chat_action(chat_id)
            except Exception as error:
                log.warning("could not send the typing action to chat %s: %s", chat_id, error)
                return
            await asyncio.sleep(self._typing_every)


def build_handler(settings: Settings, http: httpx.AsyncClient) -> Handler:
    sheet = SheetClient(settings.SHEET_API_URL, settings.SHEET_API_KEY.get_secret_value(), http)
    bot = Bot(sheet, build_model(settings), timezone=settings.TIMEZONE, max_llm_calls=settings.MAX_LLM_CALLS)
    telegram = TelegramClient(settings.TELEGRAM_BOT_TOKEN.get_secret_value(), http)
    return Handler(settings.ALLOWED_CHAT_IDS, bot, telegram)
