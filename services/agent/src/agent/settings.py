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
from pathlib import Path
from typing import Annotated, Any, ClassVar

import yaml
from pydantic import Field, SecretStr, ValidationError, field_validator, model_validator
from pydantic_settings import (
    BaseSettings,
    NoDecode,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    YamlConfigSettingsSource,
)

from agent import logs

DEFAULT_SETTINGS_FILE = Path(__file__).resolve().parents[2] / "settings.yaml"


class ConfigError(RuntimeError):
    pass


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    SECRETS: ClassVar[frozenset[str]] = frozenset(
        {
            "TELEGRAM_BOT_TOKEN",
            "TELEGRAM_WEBHOOK_SECRET",
            "SHEET_API_KEY",
            "LLM_API_KEY",
            "LLM_FALLBACK_API_KEY",
            "REMINDER_TOKEN",
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
    # Seconds the agent may take on one Telegram message (every model call, retry and fallback);
    # with the media download before it and the reply after it, the whole request stays below
    # Cloud Run's 120 s timeout, so the person always gets an answer.
    MESSAGE_DEADLINE_S: float = Field(90.0, ge=10, le=3600)
    TIMEZONE: str = "America/Sao_Paulo"

    # --- Voice and photo messages -------------------------------------------------------------
    # Off: voice, audio and photos get a "send it as text" reply and are never downloaded.
    MEDIA_ENABLED: bool = True
    # Largest file downloaded and sent to the model; the Bot API's getFile stops at 20 MB.
    MEDIA_MAX_BYTES: int = Field(5_000_000, ge=1, le=20_000_000)

    @field_validator("ALLOWED_CHAT_IDS", mode="before")
    @classmethod
    def _split_chat_ids(cls, value: Any) -> Any:
        if isinstance(value, str):
            return frozenset(int(part) for part in value.split(",") if part.strip())
        if isinstance(value, int):
            return frozenset({value})
        return value

    @field_validator("LLM_API_KEY", "LLM_FALLBACK_API_KEY", mode="before")
    @classmethod
    def _blank_key_is_missing(cls, value: Any) -> Any:
        """An empty variable (LLM_FALLBACK_API_KEY=) is no key, for the check below and the client."""
        if isinstance(value, str) and not value.strip():
            return None
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
    def load(cls) -> Settings:
        """Builds the settings, turning missing or invalid values into one readable ConfigError."""
        path = settings_file()
        check_no_secrets(path)
        try:
            settings = cls()
        except ValidationError as err:
            problems = [f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in err.errors()]
            raise ConfigError(f"Invalid settings ({path}): " + "; ".join(problems)) from err
        logs.register_secrets(settings.secret_values())
        # Keys a provider SDK reads from the environment on its own, without LLM_API_KEY.
        logs.register_secrets(os.environ.get(name) for name in PROVIDER_KEY_VARIABLES)
        logs.install()
        return settings


PROVIDER_KEY_VARIABLES = (
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
)


def _provider(model: str) -> str:
    return model.split("/", 1)[0] if "/" in model else ""


def settings_file() -> Path:
    return Path(os.environ.get("SETTINGS_FILE") or DEFAULT_SETTINGS_FILE)


def check_no_secrets(path: Path) -> None:
    if not path.is_file():
        return
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    leaked = sorted(k for k in data if str(k).upper() in Settings.SECRETS)
    if leaked:
        raise ConfigError(f"{path} must not contain secrets; move {', '.join(leaked)} to the environment")
