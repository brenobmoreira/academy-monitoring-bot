"""The few Telegram Bot API calls the bot needs, over httpx."""

from __future__ import annotations

from typing import Any

import httpx

# Update kinds the bot handles; scripts/set-webhook.sh registers the same list (a test checks).
ALLOWED_UPDATES = ["message", "callback_query"]


class TelegramError(RuntimeError):
    pass


class TelegramClient:
    def __init__(self, token: str, http: httpx.AsyncClient) -> None:
        self._base = f"https://api.telegram.org/bot{token}"
        self._http = http

    async def _call(self, method: str, payload: dict[str, Any], seconds: float = 30.0) -> Any:
        response = await self._http.post(f"{self._base}/{method}", json=payload, timeout=seconds)
        try:
            body = response.json()
        except ValueError:
            body = {}
        if response.status_code != 200 or not body.get("ok"):
            raise TelegramError(
                f"{method}: HTTP {response.status_code} {body.get('description', '')}".strip()
            )
        return body["result"]

    async def send_message(
        self,
        chat_id: int,
        text: str,
        *,
        html: bool = False,
        reply_markup: dict[str, Any] | None = None,
        reply_to: int | None = None,
    ) -> dict[str, Any]:
        """Returns the sent Message. `text` must fit one message (see format.split)."""
        payload: dict[str, Any] = {"chat_id": chat_id, "text": text}
        if html:
            payload["parse_mode"] = "HTML"
        if reply_markup is not None:
            payload["reply_markup"] = reply_markup
        if reply_to is not None:
            payload["reply_parameters"] = {"message_id": reply_to, "allow_sending_without_reply": True}
        return await self._call("sendMessage", payload)

    async def send_chat_action(self, chat_id: int, action: str = "typing") -> None:
        """Telegram shows the action for about 5 s or until the next message arrives."""
        await self._call("sendChatAction", {"chat_id": chat_id, "action": action}, seconds=10.0)

    async def set_my_commands(self, commands: list[tuple[str, str]]) -> None:
        """Replaces the command menu Telegram shows: (name without the slash, description)."""
        payload = [{"command": name, "description": description} for name, description in commands]
        await self._call("setMyCommands", {"commands": payload})

    async def answer_callback_query(self, callback_query_id: str, text: str | None = None) -> None:
        """Stops the button's loading spinner; `text` shows as a short toast."""
        payload: dict[str, Any] = {"callback_query_id": callback_query_id}
        if text is not None:
            payload["text"] = text
        await self._call("answerCallbackQuery", payload, seconds=10.0)

    async def edit_message_reply_markup(
        self, chat_id: int, message_id: int, reply_markup: dict[str, Any] | None = None
    ) -> None:
        """Replaces a sent message's inline keyboard; None removes it."""
        payload: dict[str, Any] = {"chat_id": chat_id, "message_id": message_id}
        if reply_markup is not None:
            payload["reply_markup"] = reply_markup
        await self._call("editMessageReplyMarkup", payload)

    async def get_updates(self, offset: int | None = None, wait: int = 50) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {"timeout": wait, "allowed_updates": ALLOWED_UPDATES}
        if offset is not None:
            payload = {"offset": offset, **payload}
        return await self._call("getUpdates", payload, seconds=wait + 10)
