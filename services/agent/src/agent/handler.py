"""Telegram update → bot → reply. Shared by the Cloud Run entry (main.py) and polling (poll.py)."""

from __future__ import annotations

import logging
from typing import Any, Protocol

import httpx

from agent.bot import Bot
from agent.format import split
from agent.llm import build_model
from agent.settings import Settings
from agent.sheet_client import SheetClient
from agent.telegram import TelegramClient

log = logging.getLogger(__name__)

# Every reply is sent as Telegram HTML; these templates hold no <, > or &.
HELP = (
    "Me conte o dia em texto livre, por exemplo:\n"
    "• peso 82,4, dormi 7h30, 8k passos, muay sim\n"
    "• upper: supino inclinado 60x8 62x8 rir 2, puxada aberta 50x10 50x9\n"
    "• ontem fome 3 cansaço 4\n"
    "• como foi meu supino inclinado nas últimas semanas?\n"
    "Eu gravo na planilha e confirmo o que foi gravado."
)
FAILURE = "⚠ Não consegui processar agora. Confira a planilha antes de reenviar."


class Replier(Protocol):
    async def reply(self, text: str, user_id: str = "telegram") -> str: ...


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


class Handler:
    def __init__(self, allowed_chat_ids: frozenset[int] | set[int], bot: Replier, telegram: Sender) -> None:
        self._allowed = allowed_chat_ids
        self._bot = bot
        self._telegram = telegram

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
            try:
                reply = await self._bot.reply(text, user_id=str(chat_id))
            except Exception:
                log.exception("bot failed on update %s", update.get("update_id"))
                reply = FAILURE
        try:
            await self._send(chat_id, reply)
        except Exception:
            log.exception("could not send the reply to chat %s", chat_id)

    async def _send(self, chat_id: int, html_text: str, reply_markup: dict[str, Any] | None = None) -> None:
        """Sends an HTML reply in as many messages as it needs; only the last one gets the markup."""
        chunks = split(html_text)
        for i, chunk in enumerate(chunks):
            markup = reply_markup if i == len(chunks) - 1 else None
            await self._telegram.send_message(chat_id, chunk, html=True, reply_markup=markup)


def build_handler(settings: Settings, http: httpx.AsyncClient) -> Handler:
    sheet = SheetClient(settings.SHEET_API_URL, settings.SHEET_API_KEY.get_secret_value(), http)
    bot = Bot(sheet, build_model(settings), timezone=settings.TIMEZONE, max_llm_calls=settings.MAX_LLM_CALLS)
    telegram = TelegramClient(settings.TELEGRAM_BOT_TOKEN.get_secret_value(), http)
    return Handler(settings.ALLOWED_CHAT_IDS, bot, telegram)
