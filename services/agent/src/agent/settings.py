"""Every value the agent reads from outside the code, in one class.

Sources, highest precedence first: environment variables, the .env file of the working
directory, the YAML file at SETTINGS_FILE (default: settings.yaml next to pyproject.toml), and
the defaults below. Values are read once per process, so a restart applies a changed file or
variable without rebuilding the image.

Secrets are accepted only from the environment or .env; a YAML file that contains one is
rejected, so the YAML can be committed or mounted without leaking anything.
"""

from __future__ import annotations

import os
import re
from collections.abc import Iterable
from pathlib import Path
from typing import Annotated, Any, ClassVar, Self
from urllib.parse import urlsplit

import yaml
from pydantic import BaseModel, Field, SecretStr, ValidationError, field_validator, model_validator
from pydantic_settings import (
    BaseSettings,
    NoDecode,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    YamlConfigSettingsSource,
)

from agent import logs

DEFAULT_SETTINGS_FILE = Path(__file__).resolve().parents[2] / "settings.yaml"


_HOST = re.compile(r"(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*")


def _valid_https_url(value: str) -> bool:
    """https, a real host name (no userinfo), a valid port, no fragment and no whitespace."""
    if "#" in value or any(c.isspace() for c in value):
        return False
    try:
        parts = urlsplit(value)
        parts.port  # noqa: B018 - raises ValueError for a bad port
    except ValueError:
        return False
    host = parts.hostname or ""
    return (
        parts.scheme == "https"
        and parts.username is None
        and parts.password is None
        and not parts.netloc.endswith(":")
        and _HOST.fullmatch(host.lower()) is not None
    )


class ConfigError(RuntimeError):
    pass


def validation_problems(err: ValidationError) -> list[str]:
    """`FIELD: what is wrong`, one per error, for a ConfigError or a log line: the field name and
    pydantic's message, never the rejected input, the error context or anything below the field
    (the keys of a mapping can be ids)."""
    problems = err.errors(include_input=False, include_context=False, include_url=False)
    return [
        f"{problem['loc'][0] if problem['loc'] else 'settings'}: {problem['msg']}" for problem in problems
    ]


class TranscribeSettings(BaseModel):
    """Transcription and voice-budget settings (voice spec §3.1, §5.6), shared by the bot's Settings
    and the voice service's VoiceSettings. The host class may define LLM_MODEL, LLM_API_KEY,
    MEDIA_ENABLED and VOICE_API_ENABLED; without LLM_* (the voice service) the key must be given
    explicitly."""

    # Gemini through Google AI Studio or Vertex AI only: the audio-native providers (spec §3.1).
    TRANSCRIBE_MODEL: str = "gemini/gemini-3.8-flash"
    # Optional for vertex_ai (ADC). For gemini it defaults to LLM_API_KEY when LLM_MODEL has the same
    # provider; otherwise it is required (while media is enabled).
    TRANSCRIBE_API_KEY: SecretStr | None = None
    # Primary model only; never inherited from LLM_API_BASE (a proxy for the agent may not take audio).
    TRANSCRIBE_API_BASE: str | None = None
    TRANSCRIBE_FALLBACK_MODEL: str | None = None
    # Defaults to the primary's key when the fallback has the same provider; required otherwise.
    TRANSCRIBE_FALLBACK_API_KEY: SecretStr | None = None
    # Seconds per attempt; must not pass TRANSCRIBE_DEADLINE_S.
    TRANSCRIBE_TIMEOUT_S: float = Field(15.0, gt=0, le=600)
    # Retries per model for transient errors; the first wait doubles each time.
    TRANSCRIBE_RETRIES: int = Field(1, ge=0, le=5)
    TRANSCRIBE_RETRY_WAIT_S: float = Field(1.0, ge=0, le=30)
    # Hard limit for the whole transcription: every attempt, wait and fallback.
    TRANSCRIBE_DEADLINE_S: float = Field(45.0, gt=0, le=600)
    # Longest voice note, in seconds (decision D2).
    VOICE_MAX_SECONDS: int = Field(90, ge=1, le=3600)
    # Token budgets per day (in TIMEZONE) and per process: approximate, in memory (spec §5.6).
    VOICE_DAILY_TOKENS: int = Field(120_000, ge=1)
    VOICE_GLOBAL_DAILY_TOKENS: int = Field(500_000, ge=1)
    # Lowest bitrate an accepted format can have: sizes a reservation from the body when the duration
    # cannot be trusted (6 kbps is Opus's floor).
    VOICE_MIN_BITRATE_BPS: int = Field(6000, ge=1)

    @field_validator("TRANSCRIBE_API_KEY", "TRANSCRIBE_FALLBACK_API_KEY", mode="before")
    @classmethod
    def _blank_transcribe_key_is_missing(cls, value: Any) -> Any:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("TRANSCRIBE_FALLBACK_MODEL", "TRANSCRIBE_API_BASE", mode="before")
    @classmethod
    def _blank_is_unset(cls, value: Any) -> Any:
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator("TRANSCRIBE_API_KEY", "TRANSCRIBE_FALLBACK_API_KEY", mode="after")
    @classmethod
    def _transcribe_key_is_long_enough(cls, value: SecretStr | None) -> SecretStr | None:
        if value is not None and len(value.get_secret_value().strip()) < logs.MIN_SECRET_LEN:
            raise ValueError(f"must be at least {logs.MIN_SECRET_LEN} characters")
        return value

    @field_validator("TRANSCRIBE_MODEL", "TRANSCRIBE_FALLBACK_MODEL", mode="after")
    @classmethod
    def _transcribe_provider_is_gemini_or_vertex(cls, value: str | None) -> str | None:
        if value is not None and _provider(value) not in TRANSCRIBE_PROVIDERS:
            raise ValueError(
                "must be a gemini/<model> or vertex_ai/<model> model "
                "(audio goes only to providers that take it)"
            )
        return value

    def transcribe_api_key(self) -> str | None:
        """The primary's key: its own, else the bot's LLM_API_KEY when both models share a provider."""
        if self.TRANSCRIBE_API_KEY is not None:
            return self.TRANSCRIBE_API_KEY.get_secret_value()
        llm_model = getattr(self, "LLM_MODEL", None)
        llm_key = getattr(self, "LLM_API_KEY", None)
        if (
            isinstance(llm_model, str)
            and isinstance(llm_key, SecretStr)
            and _provider(llm_model) == _provider(self.TRANSCRIBE_MODEL)
        ):
            return llm_key.get_secret_value()
        return None

    def transcribe_fallback_api_key(self) -> str | None:
        """The fallback's key: its own, else the primary's when both share a provider."""
        if self.TRANSCRIBE_FALLBACK_API_KEY is not None:
            return self.TRANSCRIBE_FALLBACK_API_KEY.get_secret_value()
        fallback = self.TRANSCRIBE_FALLBACK_MODEL
        if fallback and _provider(fallback) == _provider(self.TRANSCRIBE_MODEL):
            return self.transcribe_api_key()
        return None

    @model_validator(mode="after")
    def _transcribe_consistency(self) -> TranscribeSettings:
        if self.TRANSCRIBE_TIMEOUT_S > self.TRANSCRIBE_DEADLINE_S:
            raise ValueError("TRANSCRIBE_TIMEOUT_S must not be longer than TRANSCRIBE_DEADLINE_S")
        enabled = getattr(self, "MEDIA_ENABLED", True) and getattr(self, "VOICE_API_ENABLED", True)
        if (
            enabled
            and _provider(self.TRANSCRIBE_MODEL) == "gemini"
            and self.transcribe_api_key() is None
            and not _sdk_gemini_key_in_environment()
        ):
            raise ValueError(
                "TRANSCRIBE_API_KEY is required for a gemini transcription model (or MEDIA_ENABLED=false, "
                "or GEMINI_API_KEY in the environment; LLM_API_KEY is reused only when LLM_MODEL "
                "is also gemini)"
            )
        fallback = self.TRANSCRIBE_FALLBACK_MODEL
        if fallback:
            if (
                _provider(fallback) != _provider(self.TRANSCRIBE_MODEL)
                and self.TRANSCRIBE_FALLBACK_API_KEY is None
            ):
                raise ValueError(
                    "TRANSCRIBE_FALLBACK_MODEL has a different provider from "
                    f"{_provider(self.TRANSCRIBE_MODEL)}: set TRANSCRIBE_FALLBACK_API_KEY for it"
                )
            if self.TRANSCRIBE_API_BASE and self.transcribe_fallback_api_key() is None:
                raise ValueError(
                    "TRANSCRIBE_API_BASE with a fallback that has no key would send the base to the "
                    "fallback: give TRANSCRIBE_FALLBACK_API_KEY or drop TRANSCRIBE_API_BASE"
                )
        return self


class LoadedSettings(BaseSettings):
    """Shared settings loader (YAML + .env + environment, secret guard, log masking)."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        hide_input_in_errors=True,
    )

    SECRETS: ClassVar[frozenset[str]] = frozenset()

    def secret_values(self) -> list[str]:
        values = (getattr(self, name, None) for name in self.SECRETS)
        return [v.get_secret_value() for v in values if isinstance(v, SecretStr)]

    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        yaml_source = YamlConfigSettingsSource(settings_cls, yaml_file=settings_file())
        return init_settings, env_settings, dotenv_settings, yaml_source

    @classmethod
    def load(cls, env_file: str | Path | None = None) -> Self:
        """Builds the settings, turning missing or invalid values into one readable ConfigError."""
        path = settings_file()
        check_no_secrets(path, cls.SECRETS)
        dotenv = Path(env_file or os.environ.get("ENV_FILE") or ".env")
        try:
            settings = cls(_env_file=dotenv)  # type: ignore[call-arg]
        except ValidationError as err:
            problems = validation_problems(err)
            raise ConfigError(f"Invalid settings ({path}): " + "; ".join(problems)) from None
        logs.register_secrets(settings.secret_values())
        # Keys a provider SDK reads from the environment on its own, without LLM_API_KEY.
        logs.register_secrets(os.environ.get(name) for name in PROVIDER_KEY_VARIABLES)
        logs.install()
        return settings


class Settings(LoadedSettings, TranscribeSettings):
    SECRETS: ClassVar[frozenset[str]] = frozenset(
        {
            "TELEGRAM_BOT_TOKEN",
            "TELEGRAM_WEBHOOK_SECRET",
            "SHEET_API_KEY",
            "LLM_API_KEY",
            "LLM_FALLBACK_API_KEY",
            "REMINDER_TOKEN",
            "TRANSCRIBE_API_KEY",
            "TRANSCRIBE_FALLBACK_API_KEY",
        }
    )

    # --- Telegram -----------------------------------------------------------------------------
    TELEGRAM_BOT_TOKEN: SecretStr
    # Only the webhook entry needs it; local polling runs without one.
    TELEGRAM_WEBHOOK_SECRET: SecretStr | None = None
    ALLOWED_CHAT_IDS: Annotated[frozenset[int], NoDecode]
    # Header X-Reminder-Token of POST /remind (Cloud Scheduler); unset = the endpoint answers 404.
    REMINDER_TOKEN: SecretStr | None = None

    # --- Sheet API (Apps Script Web App) -------------------------------------------------------
    SHEET_API_URL: str
    SHEET_API_KEY: SecretStr

    # --- Model (any provider LiteLLM supports) ------------------------------------------------
    # "<provider>/<model>", e.g. gemini/gemini-3.8-flash, anthropic/claude-sonnet-5,
    # openai/gpt-5.6, vertex_ai/gemini-3.8-flash, ollama/llama3.
    LLM_MODEL: str = "gemini/gemini-3.8-flash"
    # Key of that provider. Optional: Vertex AI and local models authenticate otherwise.
    LLM_API_KEY: SecretStr | None = None
    # A LiteLLM proxy or self-hosted endpoint; empty = the provider's public API.
    LLM_API_BASE: str | None = None
    MAX_LLM_CALLS: int = Field(8, ge=1, le=30)
    # Transient provider errors (overloaded 503, rate limit 429, 500) are tried again this many
    # times, waiting LLM_RETRY_WAIT_S, then 2x, 4x...; then LLM_FALLBACK_MODEL gets the same
    # treatment. Without LLM_FALLBACK_API_KEY the fallback uses LLM_API_KEY (same provider); with
    # it, the fallback can be another provider (e.g. anthropic/claude-haiku-5-5), and LLM_API_BASE,
    # which belongs to the main model, is not sent to it.
    LLM_RETRIES: int = Field(2, ge=0, le=5)
    LLM_RETRY_WAIT_S: float = Field(2.0, ge=0, le=30)
    LLM_FALLBACK_MODEL: str | None = None
    LLM_FALLBACK_API_KEY: SecretStr | None = None
    # Seconds one model call may take. LiteLLM's own default is 6000, so a provider that hangs
    # instead of answering 503 froze the bot; a call that times out goes straight to the fallback.
    LLM_TIMEOUT_S: float = Field(30.0, ge=5, le=600)
    # Seconds one Telegram message may take from its arrival: the media download and every model
    # call, retry and fallback. The reply goes out after it, within the rest of Cloud Run's 120 s.
    MESSAGE_DEADLINE_S: float = Field(90.0, ge=10, le=3600)
    TIMEZONE: str = "America/Sao_Paulo"

    # --- Voice and photo messages -------------------------------------------------------------
    # Off: voice, audio and photos get a "send it as text" reply and are never downloaded.
    MEDIA_ENABLED: bool = True
    # Largest file downloaded and sent to the model; the Bot API's getFile stops at 20 MB.
    MEDIA_MAX_BYTES: int = Field(5_000_000, ge=1, le=20_000_000)

    # --- Mini App (treino and refeição forms; see docs/specs/2026-11-09-miniapp-design.md) --------
    # HTTPS address of the static page; empty = /app answers that it is not configured.
    MINIAPP_URL: str = ""

    @field_validator("MINIAPP_URL", mode="after")
    @classmethod
    def _miniapp_url_is_https(cls, value: str) -> str:
        value = value.strip()
        if value and not _valid_https_url(value):
            raise ValueError(
                "must be an https://host/... address without '#' or spaces (or empty to disable)"
            )
        return value

    @field_validator("ALLOWED_CHAT_IDS", mode="before")
    @classmethod
    def _split_chat_ids(cls, value: Any) -> Any:
        if isinstance(value, str):
            try:
                return frozenset(int(part) for part in value.split(",") if part.strip())
            except ValueError:
                raise ValueError("must be a comma-separated list of integers") from None
        if type(value) is int:
            return frozenset({value})
        return value

    @field_validator("LLM_API_KEY", "LLM_FALLBACK_API_KEY", mode="before")
    @classmethod
    def _blank_key_is_missing(cls, value: Any) -> Any:
        """An empty variable (LLM_FALLBACK_API_KEY=) is no key, for the check below and the client."""
        if isinstance(value, str) and not value.strip():
            return None
        return value

    @field_validator(
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_WEBHOOK_SECRET",
        "SHEET_API_KEY",
        "LLM_API_KEY",
        "LLM_FALLBACK_API_KEY",
        "REMINDER_TOKEN",
        mode="after",
    )
    @classmethod
    def _secret_is_long_enough(cls, value: SecretStr | None) -> SecretStr | None:
        """Log masking needs secrets that cannot be mistaken for ordinary text."""
        if value is not None and len(value.get_secret_value().strip()) < logs.MIN_SECRET_LEN:
            raise ValueError(f"must be at least {logs.MIN_SECRET_LEN} characters")
        return value

    @model_validator(mode="after")
    def _fallback_key_matches_provider(self) -> Settings:
        """A fallback of another provider would otherwise receive the main model's key."""
        fallback = self.LLM_FALLBACK_MODEL
        if (
            fallback
            and self.LLM_FALLBACK_API_KEY is None
            and _provider(fallback) != _provider(self.LLM_MODEL)
        ):
            main = _provider(self.LLM_MODEL) or "same-provider"
            raise ValueError(
                f"LLM_FALLBACK_MODEL {fallback} is not a {main} model: set LLM_FALLBACK_API_KEY for it"
            )
        return self


PROVIDER_KEY_VARIABLES = (
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
)


TRANSCRIBE_PROVIDERS = frozenset({"gemini", "vertex_ai"})
_ALL_YAML_SECRETS = Settings.SECRETS | frozenset({"APP_AUTH_SECRET"})


def _sdk_gemini_key_in_environment() -> bool:
    """LiteLLM reads these on its own when no key is passed, so the call needs no explicit one."""
    return any((os.environ.get(name) or "").strip() for name in ("GEMINI_API_KEY", "GOOGLE_API_KEY"))


def _provider(model: str) -> str:
    return model.split("/", 1)[0] if "/" in model else ""


def settings_file() -> Path:
    return Path(os.environ.get("SETTINGS_FILE") or DEFAULT_SETTINGS_FILE)


def parse_env_arg(argv: list[str] | None = None) -> str | None:
    """Parses optional `--env <path>` from CLI arguments for multi-client runs."""
    import argparse

    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("--env", dest="env_file", default=None, help="Path to .env file (or set ENV_FILE)")
    args, _ = parser.parse_known_args(argv)
    return args.env_file


def check_no_secrets(path: Path, extra_secrets: Iterable[str] = ()) -> None:
    if not path.is_file():
        return
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as err:
        raise ConfigError(f"Invalid YAML in {path}") from err
    if not isinstance(data, dict):
        raise ConfigError(f"Invalid settings ({path}): YAML root must be a mapping")
    forbidden = _ALL_YAML_SECRETS | frozenset(s.upper() for s in extra_secrets)
    leaked = sorted(str(k) for k in data if str(k).upper() in forbidden)
    if leaked:
        raise ConfigError(f"{path} must not contain secrets; move {', '.join(leaked)} to the environment")
