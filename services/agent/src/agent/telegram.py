"""The few Telegram Bot API calls the bot needs, over httpx."""

from __future__ import annotations

from typing import Any

import httpx


class TelegramError(RuntimeError):
    pass


class TelegramClient:
    def __init__(self, token: str, http: httpx.AsyncClient) -> None:
        self._base = f"https://api.telegram.org/bot{token}"
        self._files = f"https://api.telegram.org/file/bot{token}"
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

    async def get_file(self, file_id: str) -> dict[str, Any]:
        """The File object (`file_path`, `file_size`) of a file sent to the bot, for download_file."""
        return await self._call("getFile", {"file_id": file_id})

    async def download_file(self, file_path: str) -> bytes:
        """Downloads a file from its `file_path` (valid for about an hour after getFile).

        The URL holds the bot token, so errors name only the status or the error type, never the URL.
        """
        try:
            response = await self._http.get(f"{self._files}/{file_path}", timeout=60.0)
        except httpx.HTTPError as error:
            raise TelegramError(f"download_file: {type(error).__name__}") from None
        if response.status_code != 200:
            raise TelegramError(f"download_file: HTTP {response.status_code}")
        return response.content

    async def get_updates(self, offset: int | None = None, wait: int = 50) -> list[dict[str, Any]]:
        payload: dict[str, Any] = {"timeout": wait, "allowed_updates": ["message"]}
        if offset is not None:
            payload = {"offset": offset, **payload}
        return await self._call("getUpdates", payload, seconds=wait + 10)
