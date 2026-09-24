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
from pydantic import Field, SecretStr, ValidationError, field_validator
from pydantic_settings import (
    BaseSettings,
    NoDecode,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
    YamlConfigSettingsSource,
)

DEFAULT_SETTINGS_FILE = Path(__file__).resolve().parents[2] / "settings.yaml"


class ConfigError(RuntimeError):
    pass


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    SECRETS: ClassVar[frozenset[str]] = frozenset(
        {"TELEGRAM_BOT_TOKEN", "TELEGRAM_WEBHOOK_SECRET", "SHEET_API_KEY", "LLM_API_KEY", "REMINDER_TOKEN"}
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
            return cls()
        except ValidationError as err:
            problems = [f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in err.errors()]
            raise ConfigError(f"Invalid settings ({path}): " + "; ".join(problems)) from err


def settings_file() -> Path:
    return Path(os.environ.get("SETTINGS_FILE") or DEFAULT_SETTINGS_FILE)


def check_no_secrets(path: Path) -> None:
    if not path.is_file():
        return
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    leaked = sorted(k for k in data if str(k).upper() in Settings.SECRETS)
    if leaked:
        raise ConfigError(f"{path} must not contain secrets; move {', '.join(leaked)} to the environment")
