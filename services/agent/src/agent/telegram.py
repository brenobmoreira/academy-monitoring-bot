"""The few Telegram Bot API calls the bot needs, over httpx."""

from __future__ import annotations

from typing import Any

import httpx


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

    async def get_updates(self, offset: int | None = None, wait: int = 50) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {"timeout": wait, "allowed_updates": ["message"]}
        if offset is not None:
            payload = {"offset": offset, **payload}
        return await self._call("getUpdates", payload, seconds=wait + 10)
