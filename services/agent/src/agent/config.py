"""Settings from environment variables. Nothing account-specific lives in the code."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

REQUIRED = ("TELEGRAM_BOT_TOKEN", "ALLOWED_CHAT_IDS", "SHEET_API_URL", "SHEET_API_KEY")


class ConfigError(RuntimeError):
    pass


@dataclass(frozen=True)
class Settings:
    telegram_bot_token: str
    allowed_chat_ids: frozenset[int]
    sheet_api_url: str
    sheet_api_key: str
    # Only the webhook entry needs it; polling runs without one.
    telegram_webhook_secret: str | None = None
    gemini_model: str = "gemini-2.5-flash"
    timezone: str = "America/Sao_Paulo"

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        missing = [key for key in REQUIRED if not env.get(key, "").strip()]
        if missing:
            raise ConfigError(f"Missing environment variables: {', '.join(missing)}")
        try:
            chat_ids = frozenset(int(i) for i in env["ALLOWED_CHAT_IDS"].split(",") if i.strip())
        except ValueError as err:
            raise ConfigError("ALLOWED_CHAT_IDS must be comma-separated integers") from err
        return cls(
            telegram_bot_token=env["TELEGRAM_BOT_TOKEN"].strip(),
            allowed_chat_ids=chat_ids,
            sheet_api_url=env["SHEET_API_URL"].strip(),
            sheet_api_key=env["SHEET_API_KEY"].strip(),
            telegram_webhook_secret=env.get("TELEGRAM_WEBHOOK_SECRET", "").strip() or None,
            gemini_model=env.get("GEMINI_MODEL", "").strip() or cls.gemini_model,
            timezone=env.get("TIMEZONE", "").strip() or cls.timezone,
        )
