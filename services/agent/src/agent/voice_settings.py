"""Settings of the voice service (voice input design, §5.1 and §6.2).

For now only the AuthSettings mixin, shared by the bot (which issues link codes) and the voice
service (which redeems them and issues sessions). VoiceSettings and its loader come with the
service itself.
"""

from __future__ import annotations

from typing import Annotated, Any, ClassVar

from pydantic import Field, SecretStr, ValidationError, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

MIN_AUTH_SECRET_BYTES = 32
_NOT_BEFORE_FORMAT = "must be a comma-separated list of <chat_id>:<unix seconds>"


def validation_problems(err: ValidationError) -> list[str]:
    """`FIELD: what is wrong`, one per error, for a ConfigError or a log line: the field name and
    pydantic's message, never the rejected input, the error context or anything below the field
    (the keys of a mapping can be ids)."""
    problems = err.errors(include_input=False, include_context=False, include_url=False)
    return [
        f"{problem['loc'][0] if problem['loc'] else 'settings'}: {problem['msg']}" for problem in problems
    ]


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
