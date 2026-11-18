"""Settings of the voice service (voice input design, §5.1, §5.5–5.7 and §6.2).

`AuthSettings` is shared by the bot (which issues link codes) and the voice service (which redeems
them and issues sessions). `VoiceSettings` uses the shared `LoadedSettings` base from `settings.py`
without pulling in sheet, bot or Telegram webhook settings.
"""

from __future__ import annotations

from typing import Annotated, Any, ClassVar
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from agent import logs
from agent.settings import (
    LoadedSettings,
    TranscribeSettings,
    _valid_https_url,
    validation_problems,
)
from agent.voice_limits import (
    EXCHANGE_RATE_PER_DAY,
    EXCHANGE_RATE_PER_MIN,
    IDEMPOTENCY_TTL_S,
    VOICE_MAX_CONCURRENT,
    VOICE_RATE_PER_DAY,
    VOICE_RATE_PER_MIN,
)

__all__ = ["AUTH_SECRETS", "MIN_AUTH_SECRET_BYTES", "AuthSettings", "VoiceSettings", "validation_problems"]

MIN_AUTH_SECRET_BYTES = 32
DEFAULT_VOICE_MAX_BYTES = 1_500_000
_NOT_BEFORE_FORMAT = "must be a comma-separated list of <chat_id>:<unix seconds>"
_CHAT_IDS_FORMAT = "must be a comma-separated list of integers"
_ORIGINS_FORMAT = "must be a comma-separated list of https://host[:port] origins without path or query"


def _normalize_origin(raw: str) -> str | None:
    candidate = raw.strip()
    if not candidate or not _valid_https_url(candidate):
        return None
    parts = urlsplit(candidate)
    port = parts.port
    if parts.path or parts.query or parts.fragment or (port is not None and port < 1):
        return None
    host = (parts.hostname or "").lower()
    return f"https://{host}:{port}" if port is not None else f"https://{host}"


class AuthSettings(BaseSettings):
    """Mixin: a settings class that inherits it gains the sign-in fields.

    A validation error of these fields never shows a value: `hide_input_in_errors` keeps the
    rejected input (a secret that is too short, a revocation list with chat ids) out of str() and
    repr() of the ValidationError, and the validators below raise fixed messages. The setting is
    inherited by a class that declares its own model_config. `ValidationError.errors()` still
    carries the input unless asked not to: report with validation_problems()."""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", hide_input_in_errors=True
    )

    # Names a loader must accept only from the environment and register for log masking.
    AUTH_SECRETS: ClassVar[frozenset[str]] = frozenset({"APP_AUTH_SECRET"})

    # One secret for the bot and the voice service; every key is derived from it (agent.auth).
    # Rotating it revokes every code and every session. Unset = no Mini App voice.
    APP_AUTH_SECRET: SecretStr | None = None
    # Life of the one-time code in the Mini App link.
    APP_CODE_TTL_S: int = Field(900, ge=1, le=86_400)
    # Life of a session; there is no refresh.
    APP_SESSION_TTL_S: int = Field(43_200, ge=1, le=604_800)
    # Oldest Telegram initData accepted by the exchange.
    INITDATA_MAX_AGE_S: int = Field(300, ge=1, le=3_600)
    # Per-person revocation, "<chat_id>:<unix seconds>,...": that person's sessions issued before
    # that time are over. Private configuration: it holds chat ids, so it never goes in the
    # repository.
    APP_SESSION_NOT_BEFORE: Annotated[dict[int, int], NoDecode] = Field(default_factory=dict)

    @field_validator("APP_AUTH_SECRET", mode="before")
    @classmethod
    def _blank_secret_is_missing(cls, value: Any) -> Any:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("APP_AUTH_SECRET", mode="after")
    @classmethod
    def _secret_is_long_enough(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value().encode("utf-8")) < MIN_AUTH_SECRET_BYTES:
            raise ValueError(f"must be at least {MIN_AUTH_SECRET_BYTES} bytes")
        return value

    @field_validator("APP_SESSION_NOT_BEFORE", mode="before")
    @classmethod
    def _split_not_before(cls, value: Any) -> Any:
        """A malformed entry is an error, never skipped: a revocation that silently does not apply
        is worse than a service that does not start. The message does not repeat the value."""
        if isinstance(value, dict):
            # Already parsed (a YAML mapping). Checked here and not by pydantic, which would name
            # the offending key, a chat id, as the location of its error.
            if not all(type(k) is int and type(v) is int and v >= 0 for k, v in value.items()):
                raise ValueError(_NOT_BEFORE_FORMAT)
            return value
        if not isinstance(value, str):
            raise ValueError(_NOT_BEFORE_FORMAT)
        parsed: dict[int, int] = {}
        for part in value.split(","):
            if not part.strip():
                continue
            chat, separator, moment = part.strip().partition(":")
            try:
                chat_id, not_before = int(chat), int(moment)
            except ValueError:
                chat_id, not_before = 0, -1
            if not separator or not_before < 0:
                raise ValueError(_NOT_BEFORE_FORMAT)
            parsed[chat_id] = max(not_before, parsed.get(chat_id, 0))
        return parsed


AUTH_SECRETS = AuthSettings.AUTH_SECRETS


class VoiceSettings(LoadedSettings, AuthSettings, TranscribeSettings):
    """Configuration of the standalone voice service (`agent.voice_asgi:app`, spec §5.1)."""

    SECRETS: ClassVar[frozenset[str]] = AuthSettings.AUTH_SECRETS | frozenset(
        {
            "TELEGRAM_BOT_TOKEN",
            "TRANSCRIBE_API_KEY",
            "TRANSCRIBE_FALLBACK_API_KEY",
        }
    )

    VOICE_API_ENABLED: bool = True
    TIMEZONE: str = "America/Sao_Paulo"
    ALLOWED_CHAT_IDS: Annotated[frozenset[int], NoDecode]
    # Needed only by the tg_init_data sign-in provider; absent -> that provider is disabled (§5.1).
    TELEGRAM_BOT_TOKEN: SecretStr | None = None
    # Explicit HTTPS origins allowed by CORSMiddleware; required while VOICE_API_ENABLED is true (§5.7).
    VOICE_ALLOWED_ORIGINS: Annotated[tuple[str, ...], NoDecode] = ()

    # --- Request, concurrency and idempotency limits (§5.5, §5.6, §6.7) ------------------------
    VOICE_MAX_BYTES: int = Field(DEFAULT_VOICE_MAX_BYTES, ge=1, le=20_000_000)
    VOICE_RATE_PER_MIN: int = Field(VOICE_RATE_PER_MIN, ge=1)
    VOICE_RATE_PER_DAY: int = Field(VOICE_RATE_PER_DAY, ge=1)
    VOICE_MAX_CONCURRENT: int = Field(VOICE_MAX_CONCURRENT, ge=1)
    VOICE_IDEMPOTENCY_TTL_S: float = Field(IDEMPOTENCY_TTL_S, gt=0)
    EXCHANGE_RATE_PER_MIN: int = Field(EXCHANGE_RATE_PER_MIN, ge=1)
    EXCHANGE_RATE_PER_DAY: int = Field(EXCHANGE_RATE_PER_DAY, ge=1)

    @field_validator("TELEGRAM_BOT_TOKEN", mode="before")
    @classmethod
    def _blank_bot_token_is_missing(cls, value: Any) -> Any:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("TELEGRAM_BOT_TOKEN", mode="after")
    @classmethod
    def _bot_token_is_long_enough(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value().strip()) < logs.MIN_SECRET_LEN:
            raise ValueError(f"must be at least {logs.MIN_SECRET_LEN} characters")
        return value

    @field_validator("TIMEZONE", mode="after")
    @classmethod
    def _timezone_is_valid(cls, value: str) -> str:
        candidate = value.strip()
        if not candidate:
            raise ValueError("must be a valid IANA time zone")
        try:
            ZoneInfo(candidate)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("must be a valid IANA time zone") from None
        return candidate

    @field_validator("ALLOWED_CHAT_IDS", mode="before")
    @classmethod
    def _split_chat_ids(cls, value: Any) -> Any:
        if isinstance(value, str):
            try:
                return frozenset(int(part) for part in value.split(",") if part.strip())
            except ValueError:
                raise ValueError(_CHAT_IDS_FORMAT) from None
        if type(value) is int:
            return frozenset({value})
        if isinstance(value, (list, tuple, set, frozenset)):
            if not all(type(item) is int for item in value):
                raise ValueError(_CHAT_IDS_FORMAT)
            return frozenset(value)
        raise ValueError(_CHAT_IDS_FORMAT)

    @field_validator("VOICE_ALLOWED_ORIGINS", mode="before")
    @classmethod
    def _split_allowed_origins(cls, value: Any) -> Any:
        if isinstance(value, str):
            raw_items = [part for part in value.split(",") if part.strip()]
        elif isinstance(value, (list, tuple, set, frozenset)):
            if not all(isinstance(item, str) and item.strip() for item in value):
                raise ValueError(_ORIGINS_FORMAT)
            raw_items = list(value)
        else:
            raise ValueError(_ORIGINS_FORMAT)

        normalized: list[str] = []
        for item in raw_items:
            origin = _normalize_origin(item)
            if origin is None:
                raise ValueError(_ORIGINS_FORMAT)
            if origin not in normalized:
                normalized.append(origin)
        return tuple(normalized)

    @model_validator(mode="after")
    def _voice_service_consistency(self) -> VoiceSettings:
        if self.VOICE_API_ENABLED:
            if self.APP_AUTH_SECRET is None:
                raise ValueError("APP_AUTH_SECRET is required when VOICE_API_ENABLED is true")
            if not self.VOICE_ALLOWED_ORIGINS:
                raise ValueError("VOICE_ALLOWED_ORIGINS is required when VOICE_API_ENABLED is true")
        return self
