"""Pre-flight diagnostic CLI (`uv run agent-doctor`) for bot, sheet, Telegram and Mini App voice.

Verifies local `.env` / environment configuration and live connectivity in a few seconds while
strictly guaranteeing zero secret, deployment-ID, chat-ID, or client-catalog leakage on stdout,
stderr, logs, and `--json` output.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, TextIO
from urllib.parse import urlsplit

import httpx
import yaml
from dotenv import dotenv_values
from pydantic import ValidationError

from agent import logs
from agent.auth import MIN_SECRET_BYTES, derive_keys
from agent.settings import (
    PROVIDER_KEY_VARIABLES,
    ConfigError,
    Settings,
    _provider,
    _sdk_gemini_key_in_environment,
    _valid_https_origin,
    _valid_https_url,
    check_no_secrets,
    settings_file,
    validation_problems,
)
from agent.sheet_client import SheetClient
from agent.voice_api import HEALTHZ_PATH, TRANSCRIPTIONS_PATH
from agent.voice_settings import _normalize_origin

CheckStatus = Literal["ok", "warn", "fail"]
DoctorMode = Literal["auto", "poll", "webhook"]

_BOT_USERNAME_RE = re.compile(r"[A-Za-z0-9_]{3,64}")
_CLASS_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,60}")
_APPS_SCRIPT_EXEC_RE = re.compile(r"^/macros/s/([^/\s]+)/exec$")
_APPS_SCRIPT_DEV_RE = re.compile(r"^/macros/s/([^/\s]+)/dev$")
_APPS_SCRIPT_DEPLOYMENT_RE = re.compile(r"/macros/s/([^/?#\s]+)")
_SHEET_HTTP_STATUS_RE = re.compile(r"^planilha respondeu HTTP ([1-5][0-9]{2})$")
_SHEET_NET_ERR_RE = re.compile(r"^falha de rede ao chamar a planilha: ([A-Za-z_][A-Za-z0-9_]{0,60})\(")

_PROVIDER_ENV_VARS: dict[str, tuple[str, ...]] = {
    "gemini": ("GEMINI_API_KEY", "GOOGLE_API_KEY"),
    "openai": ("OPENAI_API_KEY",),
    "anthropic": ("ANTHROPIC_API_KEY",),
    "mistral": ("MISTRAL_API_KEY",),
    "groq": ("GROQ_API_KEY",),
    "openrouter": ("OPENROUTER_API_KEY",),
}
_KEYLESS_PROVIDERS = frozenset({"vertex_ai", "ollama"})
_VOICE_CONFIG_FIELDS = frozenset({"MINIAPP_URL", "VOICE_API_URL", "APP_AUTH_SECRET", "settings"})


@dataclass(frozen=True)
class CheckResult:
    name: str
    status: CheckStatus
    detail: str

    def to_dict(self) -> dict[str, str]:
        return {"name": self.name, "status": self.status, "detail": self.detail}


@dataclass(frozen=True)
class DoctorReport:
    checks: tuple[CheckResult, ...]

    @property
    def ok(self) -> bool:
        return all(check.status != "fail" for check in self.checks)

    @property
    def exit_code(self) -> int:
        return 0 if self.ok else 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "checks": [check.to_dict() for check in self.checks],
        }


class _Sanitizer:
    """Defense-in-depth scrubber for secret values and deployment identifiers."""

    def __init__(self, forbidden: list[str]) -> None:
        cleaned = {item.strip() for item in forbidden if item and len(item.strip()) >= 4}
        self._needles = sorted(cleaned, key=len, reverse=True)

    def scrub(self, text: str) -> str:
        out = logs.mask(text)
        for needle in self._needles:
            out = out.replace(needle, logs.MASK)
        return out


def _configure_doctor_logging() -> None:
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logs.install()


def _valid_local_http_origin(value: str) -> bool:
    """True only for `http://127.0.0.1[:port]` or `http://localhost[:port]` without path/query."""
    if "#" in value or any(c.isspace() for c in value):
        return False
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return False
    if port is not None and not (1 <= port <= 65535):
        return False
    host = (parts.hostname or "").lower()
    return (
        parts.scheme == "http"
        and host in ("127.0.0.1", "localhost")
        and parts.username is None
        and parts.password is None
        and not parts.netloc.endswith(":")
        and parts.path == ""
        and parts.query == ""
        and parts.fragment == ""
    )


def _extract_https_origin(url: str) -> str | None:
    candidate = url.strip()
    if not candidate or not _valid_https_url(candidate):
        return None
    parts = urlsplit(candidate)
    host = (parts.hostname or "").lower()
    port = parts.port
    if not host:
        return None
    return f"https://{host}:{port}" if port not in (None, 443) else f"https://{host}"


def _describe_sheet_url(raw_url: str) -> tuple[CheckStatus, str]:
    """Validates `SHEET_API_URL` and returns `(status, safe_label)` without exposing deployment IDs."""
    candidate = raw_url.strip()
    if not candidate or "#" in candidate or any(c.isspace() for c in candidate):
        return "fail", "invalid SHEET_API_URL (must be an https:// URL)"
    try:
        parts = urlsplit(candidate)
        port = parts.port
    except ValueError:
        return "fail", "invalid SHEET_API_URL (malformed URL)"
    if port is not None and not (1 <= port <= 65535):
        return "fail", "invalid SHEET_API_URL (bad port)"
    if parts.username is not None or parts.password is not None:
        return "fail", "invalid SHEET_API_URL (credentials in URL are not allowed)"

    host = (parts.hostname or "").lower()
    if parts.scheme == "https" and _valid_https_url(candidate):
        if host == "script.google.com":
            if _APPS_SCRIPT_EXEC_RE.fullmatch(parts.path):
                return "ok", "script.google.com (/macros/s/.../exec)"
            if _APPS_SCRIPT_DEV_RE.fullmatch(parts.path):
                return "warn", "script.google.com (/macros/s/.../dev — expected /exec)"
            return "fail", "script.google.com (expected /macros/s/<deploymentId>/exec)"
        return "ok", f"{host}:{port}" if port not in (None, 443) else host

    if parts.scheme == "http" and host in ("127.0.0.1", "localhost"):
        label = f"{host}:{port}" if port is not None else host
        return "warn", f"{label} (local http)"

    return "fail", "SHEET_API_URL must be a valid https:// URL"


def _collect_raw_sources(
    env_file: str | Path | None,
) -> tuple[Path, dict[str, Any], _Sanitizer, str | None]:
    """Reads merged raw config (`os.environ` > `.env` > `settings.yaml`) and builds a sanitizer."""
    dotenv_path = Path(env_file) if env_file is not None else Path(os.environ.get("ENV_FILE") or ".env")
    missing_explicit_env = env_file is not None and not dotenv_path.is_file()

    dotenv_map: dict[str, str] = {}
    if dotenv_path.is_file():
        loaded_dotenv = dotenv_values(dotenv_path, encoding="utf-8")
        dotenv_map = {str(k): v for k, v in loaded_dotenv.items() if k and v is not None}

    yaml_path = settings_file()
    yaml_error: str | None = None
    yaml_map: dict[str, Any] = {}
    try:
        check_no_secrets(yaml_path, Settings.SECRETS)
        if yaml_path.is_file():
            raw_yaml = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}
            if isinstance(raw_yaml, dict):
                yaml_map = {str(k): v for k, v in raw_yaml.items()}
            else:
                yaml_error = "YAML root must be a mapping"
    except ConfigError as err:
        msg = str(err)
        if "must not contain secrets;" in msg:
            tail = msg.partition("must not contain secrets;")[2].strip()
            yaml_error = f"settings YAML must not contain secrets; {tail}"
        elif "YAML root must be a mapping" in msg:
            yaml_error = "settings YAML root must be a mapping"
        else:
            yaml_error = "invalid YAML in settings file"

    merged: dict[str, Any] = dict(yaml_map)
    for key, val in dotenv_map.items():
        merged[key] = val
    for key, val in os.environ.items():
        merged[key] = val

    secret_names = Settings.SECRETS | frozenset(PROVIDER_KEY_VARIABLES)
    secret_values: list[str] = []
    for name in secret_names:
        for source in (os.environ, dotenv_map):
            raw_val = source.get(name)
            if isinstance(raw_val, str) and raw_val.strip():
                secret_values.append(raw_val.strip())

    logs.register_secrets(secret_values)
    _configure_doctor_logging()

    forbidden = list(secret_values)
    for source in (os.environ, dotenv_map, yaml_map):
        raw_sheet = source.get("SHEET_API_URL")
        if isinstance(raw_sheet, str) and raw_sheet.strip():
            cleaned_sheet = raw_sheet.strip()
            forbidden.append(cleaned_sheet)
            if m := _APPS_SCRIPT_DEPLOYMENT_RE.search(cleaned_sheet):
                forbidden.append(m.group(1))

    if missing_explicit_env:
        return dotenv_path, merged, _Sanitizer(forbidden), "--env file does not exist"
    return dotenv_path, merged, _Sanitizer(forbidden), yaml_error


def _has_llm_key(settings: Settings) -> bool:
    if settings.LLM_API_KEY is not None:
        return True
    provider = _provider(settings.LLM_MODEL)
    if provider in _KEYLESS_PROVIDERS:
        return True
    env_vars = _PROVIDER_ENV_VARS.get(provider, ())
    if any((os.environ.get(var) or "").strip() for var in env_vars):
        return True
    return bool(settings.LLM_API_BASE and not env_vars and not provider)


def _has_transcribe_key(settings: Settings) -> bool:
    if not settings.MEDIA_ENABLED:
        return True
    if _provider(settings.TRANSCRIBE_MODEL) == "vertex_ai":
        return True
    return settings.transcribe_api_key() is not None or _sdk_gemini_key_in_environment()


def _check_settings(
    dotenv_path: Path,
    raw: dict[str, Any],
    pre_error: str | None,
) -> tuple[CheckResult, Settings | None]:
    if pre_error is not None:
        return CheckResult("settings", "fail", pre_error), None

    raw_voice_url = str(raw.get("VOICE_API_URL") or "").strip()
    raw_auth_secret = str(raw.get("APP_AUTH_SECRET") or "").strip()
    local_http_voice = bool(raw_voice_url) and _valid_local_http_origin(raw_voice_url)

    loaded: Settings | None = None
    validation_errors: list[str] = []

    try:
        if local_http_voice and len(raw_auth_secret.encode("utf-8")) >= MIN_SECRET_BYTES:
            loaded = Settings(_env_file=dotenv_path, VOICE_API_URL="", APP_AUTH_SECRET=None)  # type: ignore[call-arg]
        else:
            loaded = Settings(_env_file=dotenv_path)  # type: ignore[call-arg]
    except ValidationError as err:
        problems = validation_problems(err)
        validation_errors.extend(problems)
        # Try loading core bot fields without Mini App / Voice pair so core settings and network
        # checks can still be diagnosed in the same run if only Mini App / Voice config is broken.
        error_locs = {str(p["loc"][0]) if p["loc"] else "settings" for p in err.errors(include_input=False)}
        if error_locs <= _VOICE_CONFIG_FIELDS:
            try:
                loaded = Settings(  # type: ignore[call-arg]
                    _env_file=dotenv_path,
                    MINIAPP_URL="",
                    VOICE_API_URL="",
                    APP_AUTH_SECRET=None,
                )
            except ValidationError:
                loaded = None

    if loaded is not None:
        logs.register_secrets(loaded.secret_values())

    if loaded is None:
        detail = "; ".join(validation_errors) if validation_errors else "invalid settings"
        return CheckResult("settings", "fail", detail), None

    issues: list[str] = list(validation_errors)
    warnings: list[str] = []

    chat_count = len(loaded.ALLOWED_CHAT_IDS)
    if chat_count == 0:
        issues.append("ALLOWED_CHAT_IDS must contain at least 1 chat_id (count=0)")

    if not _has_llm_key(loaded):
        provider = _provider(loaded.LLM_MODEL) or "configured"
        hint = " or GEMINI_API_KEY" if provider == "gemini" else ""
        issues.append(f"missing LLM key for model {loaded.LLM_MODEL} (set LLM_API_KEY{hint})")

    if not _has_transcribe_key(loaded):
        issues.append(
            f"MEDIA_ENABLED=true requires TRANSCRIBE_API_KEY, GEMINI_API_KEY, or compatible LLM_API_KEY "
            f"for {loaded.TRANSCRIBE_MODEL}"
        )

    sheet_status, sheet_label = _describe_sheet_url(loaded.SHEET_API_URL)
    if sheet_status == "fail":
        issues.append(sheet_label)
    elif sheet_status == "warn":
        warnings.append(sheet_label)

    if issues:
        return CheckResult("settings", "fail", "; ".join(issues)), loaded

    summary = (
        f"model={loaded.LLM_MODEL}, media={str(loaded.MEDIA_ENABLED).lower()}, "
        f"allowed_chats=count={chat_count}, sheet={sheet_label}"
    )
    if warnings:
        return CheckResult("settings", "warn", f"{summary} ({'; '.join(warnings)})"), loaded
    return CheckResult("settings", "ok", summary), loaded


def _check_miniapp_voice_config(raw: dict[str, Any]) -> tuple[CheckResult | None, str | None, str | None]:
    """Validates `MINIAPP_URL`, `VOICE_API_URL`, `APP_AUTH_SECRET` and `VOICE_ALLOWED_ORIGINS`.

    Returns `(check_result_or_none, validated_miniapp_origin, validated_voice_base_url)`.
    """
    raw_miniapp = str(raw.get("MINIAPP_URL") or "").strip()
    raw_voice = str(raw.get("VOICE_API_URL") or "").strip()
    raw_secret = str(raw.get("APP_AUTH_SECRET") or "").strip()
    raw_origins = raw.get("VOICE_ALLOWED_ORIGINS")

    has_origins = (
        bool(raw_origins.strip())
        if isinstance(raw_origins, str)
        else bool(raw_origins)
        if isinstance(raw_origins, (list, tuple, set, frozenset))
        else False
    )

    if not raw_miniapp and not raw_voice:
        return None, None, None

    failures: list[str] = []
    warnings: list[str] = []
    notes: list[str] = []

    miniapp_origin: str | None = None
    if raw_miniapp:
        if not raw_miniapp.startswith("https://") or not _valid_https_url(raw_miniapp):
            failures.append("MINIAPP_URL must start with https:// and be a valid URL without '#' or spaces")
        else:
            miniapp_origin = _extract_https_origin(raw_miniapp)
            if miniapp_origin is None:
                failures.append("MINIAPP_URL has no valid https:// origin")
            else:
                notes.append(f"miniapp_origin={miniapp_origin}")

    voice_base_url: str | None = None
    if raw_voice:
        if _valid_https_origin(raw_voice):
            voice_base_url = raw_voice.rstrip("/")
            notes.append(f"voice_api={voice_base_url}")
        elif _valid_local_http_origin(raw_voice):
            voice_base_url = raw_voice.rstrip("/")
            warnings.append(
                f"VOICE_API_URL ({voice_base_url}) uses local http:// (dev only; production requires https://)"
            )
            notes.append(f"voice_api={voice_base_url}")
        else:
            failures.append(
                "VOICE_API_URL must be an https://host[:port] origin without path or query "
                "(or http://127.0.0.1 / http://localhost in local dev)"
            )

        if not raw_secret:
            failures.append("APP_AUTH_SECRET is missing (required when VOICE_API_URL is set)")
        elif len(raw_secret) < MIN_SECRET_BYTES or len(raw_secret.encode("utf-8")) < MIN_SECRET_BYTES:
            failures.append(f"APP_AUTH_SECRET must be at least {MIN_SECRET_BYTES} characters/bytes")
        else:
            try:
                derive_keys(raw_secret)
            except ValueError:
                failures.append(f"APP_AUTH_SECRET must be at least {MIN_SECRET_BYTES} bytes")
            else:
                notes.append("auth_secret=ok")

    if has_origins:
        items: list[str] = []
        invalid_origin = False
        if isinstance(raw_origins, str):
            items = [part.strip() for part in raw_origins.split(",") if part.strip()]
        elif isinstance(raw_origins, (list, tuple, set, frozenset)):
            for item in raw_origins:
                if isinstance(item, str) and item.strip():
                    items.append(item.strip())
                else:
                    invalid_origin = True
        else:
            invalid_origin = True

        normalized_origins: list[str] = []
        for item in items:
            norm = _normalize_origin(item)
            if norm is None:
                invalid_origin = True
            elif norm not in normalized_origins:
                normalized_origins.append(norm)

        if invalid_origin or not normalized_origins:
            failures.append(
                "VOICE_ALLOWED_ORIGINS must be a comma-separated list of https://host[:port] origins "
                "without paths ('/...'), wildcards or queries"
            )
        else:
            if miniapp_origin is not None and miniapp_origin not in normalized_origins:
                failures.append(
                    f"MINIAPP_URL origin ({miniapp_origin}) is not included in VOICE_ALLOWED_ORIGINS"
                )
            else:
                notes.append(f"allowed_origins={len(normalized_origins)}")

    if failures:
        return (
            CheckResult("miniapp_voice_config", "fail", "; ".join(failures)),
            miniapp_origin,
            voice_base_url,
        )
    if warnings:
        detail = "; ".join([*notes, *warnings])
        return CheckResult("miniapp_voice_config", "warn", detail), miniapp_origin, voice_base_url
    return CheckResult("miniapp_voice_config", "ok", ", ".join(notes)), miniapp_origin, voice_base_url


def _format_sheet_failure(response: dict[str, Any], latency_ms: int) -> str:
    errors = response.get("errors")
    first = errors[0] if isinstance(errors, list) and errors and isinstance(errors[0], dict) else {}
    code = logs.safe_code(first.get("code"))
    msg = first.get("message")

    extra = ""
    if isinstance(msg, str):
        if m_http := _SHEET_HTTP_STATUS_RE.match(msg):
            extra = f" status={m_http.group(1)}"
        elif m_net := _SHEET_NET_ERR_RE.match(msg):
            extra = f" error={m_net.group(1)}"
        elif msg.startswith("resposta da planilha não é JSON"):
            extra = " reason=non_json_response"
        elif msg.startswith("resposta da planilha fora do formato"):
            extra = " reason=invalid_envelope"

    return f"code={code}{extra} ({latency_ms}ms)"


async def _check_sheet_api(
    settings: Settings,
    client: httpx.AsyncClient,
    timeout_s: float,
) -> CheckResult:
    sheet_status, sheet_label = _describe_sheet_url(settings.SHEET_API_URL)
    if sheet_status == "fail":
        return CheckResult("sheet_api", "fail", f"skipped: {sheet_label}")

    sheet = SheetClient(
        settings.SHEET_API_URL.strip(),
        settings.SHEET_API_KEY.get_secret_value(),
        client,
    )
    started = time.perf_counter()
    try:
        async with asyncio.timeout(timeout_s):
            response = await sheet.catalog()
    except TimeoutError:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return CheckResult("sheet_api", "fail", f"code=timeout after {timeout_s:g}s ({elapsed_ms}ms)")
    except Exception as err:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return CheckResult("sheet_api", "fail", f"error={logs.describe(err)} ({elapsed_ms}ms)")

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    if response.get("ok") is not True:
        return CheckResult("sheet_api", "fail", _format_sheet_failure(response, elapsed_ms))

    result = response.get("result")
    if not isinstance(result, dict):
        return CheckResult("sheet_api", "fail", f"code=other reason=invalid_result ({elapsed_ms}ms)")

    sessions = result.get("sessions")
    exercises = result.get("exercises")
    foods = result.get("foods")
    phase = result.get("phase")

    n_sessions = len(sessions) if isinstance(sessions, list) else 0
    n_exercises = len(exercises) if isinstance(exercises, list) else 0
    n_foods = len(foods) if isinstance(foods, list) else 0
    has_plan = bool(isinstance(phase, dict) and phase.get("plan"))

    detail = (
        f"{sheet_label} · exercises={n_exercises}, foods={n_foods}, sessions={n_sessions}, "
        f"phase.plan={str(has_plan).lower()} ({elapsed_ms}ms)"
    )
    return CheckResult("sheet_api", "ok", detail)


def _safe_exc_type(err: BaseException) -> str:
    name = type(err).__name__
    return name if _CLASS_IDENT_RE.fullmatch(name) else "HTTPError"


async def _telegram_get(
    client: httpx.AsyncClient,
    token: str,
    method: str,
    timeout_s: float,
) -> tuple[dict[str, Any] | None, str | None]:
    """Calls a read-only Telegram Bot API method without ever exposing the token or URL."""
    url = f"https://api.telegram.org/bot{token}/{method}"
    try:
        async with asyncio.timeout(timeout_s):
            response = await client.get(url, timeout=timeout_s)
    except TimeoutError:
        return None, f"{method}: TimeoutError"
    except httpx.HTTPError as err:
        return None, f"{method}: {_safe_exc_type(err)}"
    except Exception as err:
        return None, f"{method}: {logs.describe(err)}"

    try:
        body = response.json()
    except ValueError:
        body = {}
    if not isinstance(body, dict):
        body = {}

    if response.status_code != 200 or body.get("ok") is not True:
        raw_code = body.get("error_code")
        code = raw_code if type(raw_code) is int and 100 <= raw_code <= 599 else None
        status = response.status_code if 100 <= response.status_code <= 599 else 0
        hint = " (check TELEGRAM_BOT_TOKEN)" if status in (401, 404) or code in (401, 404) else ""
        code_part = f" error_code={code}" if code is not None and code != status else ""
        return None, f"{method}: HTTP {status}{code_part}{hint}"

    result = body.get("result")
    if not isinstance(result, dict):
        return None, f"{method}: invalid_result"
    return result, None


async def _check_telegram_api(
    settings: Settings,
    client: httpx.AsyncClient,
    *,
    mode: DoctorMode,
    timeout_s: float,
    now: Callable[[], float],
) -> CheckResult:
    token = settings.TELEGRAM_BOT_TOKEN.get_secret_value().strip()
    started = time.perf_counter()

    me, err = await _telegram_get(client, token, "getMe", timeout_s)
    if err is not None or me is None:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return CheckResult("telegram_api", "fail", f"{err} ({elapsed_ms}ms)")

    wh, err = await _telegram_get(client, token, "getWebhookInfo", timeout_s)
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    if err is not None or wh is None:
        return CheckResult("telegram_api", "fail", f"{err} ({elapsed_ms}ms)")

    raw_username = me.get("username")
    bot_label = (
        f"@{raw_username}"
        if isinstance(raw_username, str) and _BOT_USERNAME_RE.fullmatch(raw_username)
        else "bot=ok"
    )

    raw_wh_url = wh.get("url")
    webhook_set = bool(isinstance(raw_wh_url, str) and raw_wh_url.strip())

    raw_pending = wh.get("pending_update_count", 0)
    pending = raw_pending if type(raw_pending) is int and raw_pending >= 0 else 0

    parts = [
        bot_label,
        f"webhook_set={str(webhook_set).lower()}",
        f"pending_update_count={pending}",
    ]

    last_error_date = wh.get("last_error_date")
    has_recent_webhook_error = False
    if type(last_error_date) is int and last_error_date > 0:
        age_s = max(0, int(now()) - last_error_date)
        parts.append(f"last_error_age_s={age_s}")
        has_recent_webhook_error = True

    has_webhook_secret = settings.TELEGRAM_WEBHOOK_SECRET is not None

    if mode == "poll" and webhook_set:
        parts.append(
            "mode=poll conflicts with active webhook (getUpdates -> 409 Conflict); "
            "run `make webhook-delete` (`scripts/set-webhook.sh delete`)"
        )
        return CheckResult("telegram_api", "fail", f"{', '.join(parts)} ({elapsed_ms}ms)")

    if mode == "webhook" and not webhook_set:
        parts.append("mode=webhook requires an active webhook; run `make webhook-set`")
        return CheckResult("telegram_api", "fail", f"{', '.join(parts)} ({elapsed_ms}ms)")

    if mode == "auto" and has_webhook_secret and not webhook_set:
        parts.append(
            "TELEGRAM_WEBHOOK_SECRET is set (webhook mode) but webhook_set=false; run `make webhook-set`"
        )
        return CheckResult("telegram_api", "fail", f"{', '.join(parts)} ({elapsed_ms}ms)")

    warnings: list[str] = []
    if mode == "auto" and not has_webhook_secret and webhook_set:
        warnings.append(
            "webhook is active (local polling would fail with 409 Conflict; "
            "run `make webhook-delete` / `scripts/set-webhook.sh delete` before polling)"
        )
    if mode == "webhook" and not has_webhook_secret:
        warnings.append("TELEGRAM_WEBHOOK_SECRET is not set locally")
    if has_recent_webhook_error and (webhook_set or mode == "webhook"):
        warnings.append("Telegram reported a previous webhook delivery error")

    if warnings:
        detail = f"{', '.join(parts)} — {'; '.join(warnings)} ({elapsed_ms}ms)"
        return CheckResult("telegram_api", "warn", detail)

    return CheckResult("telegram_api", "ok", f"{', '.join(parts)} ({elapsed_ms}ms)")


async def _check_voice_service(
    voice_base_url: str | None,
    miniapp_origin: str | None,
    client: httpx.AsyncClient,
    timeout_s: float,
) -> CheckResult:
    if not voice_base_url:
        return CheckResult(
            "voice_service",
            "fail",
            "VOICE_API_URL is missing or invalid (cannot probe standalone voice service)",
        )

    started = time.perf_counter()
    health_url = f"{voice_base_url}{HEALTHZ_PATH}"
    try:
        async with asyncio.timeout(timeout_s):
            health_resp = await client.get(health_url, timeout=timeout_s)
    except TimeoutError:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return CheckResult("voice_service", "fail", f"healthz: TimeoutError ({elapsed_ms}ms)")
    except httpx.HTTPError as err:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return CheckResult("voice_service", "fail", f"healthz: {_safe_exc_type(err)} ({elapsed_ms}ms)")
    except Exception as err:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return CheckResult("voice_service", "fail", f"healthz: {logs.describe(err)} ({elapsed_ms}ms)")

    if health_resp.status_code != 200:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return CheckResult(
            "voice_service",
            "fail",
            f"healthz: HTTP {health_resp.status_code} (expected 200) ({elapsed_ms}ms)",
        )

    if miniapp_origin is None:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return CheckResult(
            "voice_service", "ok", f"healthz=200, cors=skipped (no MINIAPP_URL) ({elapsed_ms}ms)"
        )

    preflight_url = f"{voice_base_url}{TRANSCRIPTIONS_PATH}"
    headers = {
        "Origin": miniapp_origin,
        "Access-Control-Request-Method": "POST",
    }
    try:
        async with asyncio.timeout(timeout_s):
            cors_resp = await client.options(preflight_url, headers=headers, timeout=timeout_s)
    except TimeoutError:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return CheckResult("voice_service", "fail", f"cors preflight: TimeoutError ({elapsed_ms}ms)")
    except httpx.HTTPError as err:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return CheckResult("voice_service", "fail", f"cors preflight: {_safe_exc_type(err)} ({elapsed_ms}ms)")
    except Exception as err:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        return CheckResult("voice_service", "fail", f"cors preflight: {logs.describe(err)} ({elapsed_ms}ms)")

    elapsed_ms = int((time.perf_counter() - started) * 1000)
    allow_origin = (cors_resp.headers.get("access-control-allow-origin") or "").strip()
    if not (200 <= cors_resp.status_code < 300) or allow_origin != miniapp_origin:
        shown_origin = (
            allow_origin if allow_origin and _normalize_origin(allow_origin) else "missing/mismatch"
        )
        return CheckResult(
            "voice_service",
            "fail",
            f"healthz=200, cors=fail (HTTP {cors_resp.status_code}, "
            f"Access-Control-Allow-Origin={shown_origin}, expected {miniapp_origin}; "
            f"check VOICE_ALLOWED_ORIGINS on voice service) ({elapsed_ms}ms)",
        )

    return CheckResult(
        "voice_service",
        "ok",
        f"healthz=200, cors=ok (Origin={miniapp_origin}) ({elapsed_ms}ms)",
    )


async def run_doctor(
    *,
    env_file: str | Path | None = None,
    mode: DoctorMode = "auto",
    voice: bool = False,
    timeout: float = 10.0,  # noqa: ASYNC109
    http: httpx.AsyncClient | None = None,
    now: Callable[[], float] = time.time,
) -> DoctorReport:
    """Runs all pre-flight checks and returns a sanitized `DoctorReport`."""
    dotenv_path, raw, sanitizer, pre_error = _collect_raw_sources(env_file)

    checks: list[CheckResult] = []
    settings_check, loaded_settings = _check_settings(dotenv_path, raw, pre_error)
    checks.append(settings_check)

    miniapp_check, miniapp_origin, voice_base_url = _check_miniapp_voice_config(raw)
    if miniapp_check is not None:
        checks.append(miniapp_check)

    raw_voice_configured = bool(str(raw.get("VOICE_API_URL") or "").strip())
    should_probe_voice = voice or raw_voice_configured

    async def _run_network_checks(client: httpx.AsyncClient) -> None:
        if loaded_settings is not None:
            checks.append(await _check_sheet_api(loaded_settings, client, timeout))
            checks.append(
                await _check_telegram_api(
                    loaded_settings,
                    client,
                    mode=mode,
                    timeout_s=timeout,
                    now=now,
                )
            )
        if should_probe_voice:
            checks.append(await _check_voice_service(voice_base_url, miniapp_origin, client, timeout))

    if loaded_settings is not None or should_probe_voice:
        if http is not None:
            await _run_network_checks(http)
        else:
            async with httpx.AsyncClient(timeout=timeout) as owned_client:
                await _run_network_checks(owned_client)

    sanitized_checks = tuple(
        CheckResult(name=c.name, status=c.status, detail=sanitizer.scrub(c.detail)) for c in checks
    )
    return DoctorReport(checks=sanitized_checks)


def format_text(report: DoctorReport) -> str:
    badges: dict[CheckStatus, str] = {"ok": "[OK]  ", "warn": "[WARN]", "fail": "[FAIL]"}
    lines = [f"{badges[c.status]} {c.name}: {c.detail}" for c in report.checks]
    n_warn = sum(1 for c in report.checks if c.status == "warn")
    n_fail = sum(1 for c in report.checks if c.status == "fail")
    verdict = "PASS" if report.ok else "FAIL"
    lines.append(f"Result: {verdict} ({len(report.checks)} checks, {n_warn} warnings, {n_fail} failures)")
    return "\n".join(lines)


def format_json(report: DoctorReport) -> str:
    return json.dumps(report.to_dict(), ensure_ascii=False, indent=2)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agent-doctor",
        description="Run fast pre-flight checks against configured .env, Sheet API, Telegram and Voice API.",
    )
    parser.add_argument(
        "--env",
        dest="env_file",
        default=None,
        help="Path to .env file (default: ENV_FILE or .env)",
    )
    parser.add_argument(
        "--mode",
        choices=("auto", "poll", "webhook"),
        default="auto",
        help="Deployment readiness mode to validate (default: auto)",
    )
    parser.add_argument(
        "--voice",
        action="store_true",
        help="Force standalone VOICE_API_URL /healthz and CORS preflight checks",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="Per-request network timeout in seconds (default: 10.0)",
    )
    parser.add_argument(
        "--json",
        dest="as_json",
        action="store_true",
        help="Output structured JSON report",
    )
    return parser


def _positive_timeout(value: float) -> float:
    if value <= 0:
        raise ValueError("--timeout must be greater than 0")
    return value


async def run_cli(
    argv: list[str] | None = None,
    *,
    http: httpx.AsyncClient | None = None,
    stdout: TextIO | None = None,
) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        timeout = _positive_timeout(args.timeout)
    except ValueError as err:
        parser.error(str(err))

    report = await run_doctor(
        env_file=args.env_file,
        mode=args.mode,
        voice=args.voice,
        timeout=timeout,
        http=http,
    )
    out = stdout if stdout is not None else sys.stdout
    rendered = format_json(report) if args.as_json else format_text(report)
    out.write(rendered + "\n")
    return report.exit_code


def main(argv: list[str] | None = None) -> int:
    _configure_doctor_logging()
    return asyncio.run(run_cli(argv))


if __name__ == "__main__":
    raise SystemExit(main())
