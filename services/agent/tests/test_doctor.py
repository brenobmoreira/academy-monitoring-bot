"""Unit and P0 output-safety tests for `agent.doctor` (`uv run agent-doctor`)."""

from __future__ import annotations

import argparse
import io
import json
import logging
import tomllib
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pytest
from pydantic import SecretStr

from agent import logs
from agent.doctor import _check_settings, _positive_timeout, format_json, format_text, run_cli, run_doctor
from agent.voice_api import HEALTHZ_PATH, TRANSCRIPTIONS_PATH
from agent.voice_asgi import CORS_ALLOW_HEADERS, build_voice_service
from agent.voice_settings import VoiceSettings

from .voice_fakes import FakeTranscriber

pytestmark = pytest.mark.unit

AGENT_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = AGENT_DIR.parents[1]

# --- P0 Canary values (must NEVER appear in text, --json, stdout, stderr or logs) ---
CANARY_BOT_TOKEN = "tok-SECRET-CANARY-123456"
CANARY_SHEET_KEY = "sheet-SECRET-CANARY-123456"
CANARY_DEPLOYMENT_ID = "deployment-SECRET-CANARY"
CANARY_SHEET_URL = f"https://script.google.com/macros/s/{CANARY_DEPLOYMENT_ID}/exec"
CANARY_LLM_KEY = "llm-SECRET-CANARY-123456"
CANARY_GEMINI_KEY = "gemini-SECRET-CANARY-123456"
CANARY_TRANSCRIBE_KEY = "transcribe-SECRET-CANARY-123456"
CANARY_AUTH_SECRET = "auth-SECRET-CANARY-32-CHARS-LONG!!"
CANARY_WEBHOOK_SECRET = "webhook-SECRET-CANARY-123456"
CANARY_REMINDER_TOKEN = "reminder-SECRET-CANARY-123456"
CANARY_CHAT_ID = 987654321
CANARY_EXERCISE = "Supino Secreto Canário"
CANARY_FOOD = "Arroz Secreto Canário"
CANARY_SESSION = "Sessao Secreta Canario"
CANARY_WEBHOOK_URL = "https://webhook-host-SECRET-CANARY.a.run.app/telegram"
CANARY_TG_ERROR_MSG = "tg-error-detail-SECRET-CANARY"

ALL_CANARIES = (
    CANARY_BOT_TOKEN,
    CANARY_SHEET_KEY,
    CANARY_DEPLOYMENT_ID,
    CANARY_SHEET_URL,
    CANARY_LLM_KEY,
    CANARY_GEMINI_KEY,
    CANARY_TRANSCRIBE_KEY,
    CANARY_AUTH_SECRET,
    CANARY_WEBHOOK_SECRET,
    CANARY_REMINDER_TOKEN,
    str(CANARY_CHAT_ID),
    CANARY_EXERCISE,
    CANARY_FOOD,
    CANARY_SESSION,
    CANARY_WEBHOOK_URL,
    CANARY_TG_ERROR_MSG,
)

ENV_KEYS_TO_CLEAR = (
    "SETTINGS_FILE",
    "ENV_FILE",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_WEBHOOK_SECRET",
    "ALLOWED_CHAT_IDS",
    "REMINDER_TOKEN",
    "SHEET_API_URL",
    "SHEET_API_KEY",
    "LLM_MODEL",
    "LLM_API_KEY",
    "LLM_API_BASE",
    "LLM_FALLBACK_MODEL",
    "LLM_FALLBACK_API_KEY",
    "MEDIA_ENABLED",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "MISTRAL_API_KEY",
    "GROQ_API_KEY",
    "OPENROUTER_API_KEY",
    "TRANSCRIBE_MODEL",
    "TRANSCRIBE_API_KEY",
    "TRANSCRIBE_API_BASE",
    "TRANSCRIBE_FALLBACK_MODEL",
    "TRANSCRIBE_FALLBACK_API_KEY",
    "MINIAPP_URL",
    "VOICE_API_URL",
    "APP_AUTH_SECRET",
    "APP_SESSION_NOT_BEFORE",
    "VOICE_ALLOWED_ORIGINS",
)

MINIAPP_URL = "https://coach.github.io/academy-miniapp/index.html"
MINIAPP_ORIGIN = "https://coach.github.io"
VOICE_API_URL = "https://fitness-voice-demo.a.run.app"


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    for key in ENV_KEYS_TO_CLEAR:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(logs, "_SECRETS", set())
    monkeypatch.chdir(tmp_path)
    yaml_file = tmp_path / "settings.yaml"
    yaml_file.write_text("LLM_MODEL: gemini/gemini-3.8-flash\n", encoding="utf-8")
    monkeypatch.setenv("SETTINGS_FILE", str(yaml_file))
    return tmp_path


def _write_env(path: Path, values: dict[str, str]) -> Path:
    lines = [f"{k}={v}" for k, v in values.items()]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def _base_env_values(**overrides: str) -> dict[str, str]:
    base = {
        "TELEGRAM_BOT_TOKEN": CANARY_BOT_TOKEN,
        "ALLOWED_CHAT_IDS": str(CANARY_CHAT_ID),
        "SHEET_API_URL": CANARY_SHEET_URL,
        "SHEET_API_KEY": CANARY_SHEET_KEY,
        "LLM_MODEL": "gemini/gemini-3.8-flash",
        "LLM_API_KEY": CANARY_LLM_KEY,
        "MINIAPP_URL": MINIAPP_URL,
        "VOICE_API_URL": VOICE_API_URL,
        "APP_AUTH_SECRET": CANARY_AUTH_SECRET,
        "VOICE_ALLOWED_ORIGINS": MINIAPP_ORIGIN,
    }
    base.update(overrides)
    return base


def _catalog_payload() -> dict[str, Any]:
    return {
        "ok": True,
        "result": {
            "sessions": [CANARY_SESSION, "Lower"],
            "exercises": [{"name": CANARY_EXERCISE, "group": "Peito"} for _ in range(12)],
            "foods": [{"name": CANARY_FOOD, "kcal": 130} for _ in range(25)],
            "phase": {"plan": {"id": "P1", "sessions": [CANARY_SESSION, "Lower"]}},
        },
    }


def _make_mock_client(
    *,
    catalog_body: dict[str, Any] | None = None,
    sheet_status: int = 200,
    sheet_exc: Callable[[httpx.Request], BaseException] | None = None,
    get_me_body: dict[str, Any] | None = None,
    get_me_status: int = 200,
    webhook_info_body: dict[str, Any] | None = None,
    webhook_status: int = 200,
    telegram_exc: Callable[[httpx.Request], BaseException] | None = None,
    voice_health_status: int = 200,
    voice_cors_origin: str | None = MINIAPP_ORIGIN,
    voice_cors_headers: str | None = ", ".join(CORS_ALLOW_HEADERS),
    voice_cors_status: int = 200,
    voice_exc: Callable[[httpx.Request], BaseException] | None = None,
    voice_transport: httpx.AsyncBaseTransport | None = None,
    captured_requests: list[httpx.Request] | None = None,
) -> httpx.AsyncClient:
    effective_catalog = catalog_body if catalog_body is not None else _catalog_payload()
    effective_me = (
        get_me_body
        if get_me_body is not None
        else {"ok": True, "result": {"id": 111222, "is_bot": True, "username": "academy_fit_bot"}}
    )
    effective_wh = (
        webhook_info_body
        if webhook_info_body is not None
        else {"ok": True, "result": {"url": "", "pending_update_count": 0}}
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if captured_requests is not None:
            captured_requests.append(request)

        host = request.url.host
        path = request.url.path

        if host == "script.google.com":
            if sheet_exc is not None:
                raise sheet_exc(request)
            return httpx.Response(sheet_status, json=effective_catalog)

        if host == "api.telegram.org":
            if telegram_exc is not None:
                raise telegram_exc(request)
            if path.endswith("/getMe"):
                return httpx.Response(get_me_status, json=effective_me)
            if path.endswith("/getWebhookInfo"):
                return httpx.Response(webhook_status, json=effective_wh)
            return httpx.Response(404, json={"ok": False, "error_code": 404})

        if voice_transport is None and host in ("fitness-voice-demo.a.run.app", "127.0.0.1", "localhost"):
            if voice_exc is not None:
                raise voice_exc(request)
            if path == HEALTHZ_PATH and request.method == "GET":
                return httpx.Response(voice_health_status, text="ok")
            if path == TRANSCRIPTIONS_PATH and request.method == "OPTIONS":
                headers: dict[str, str] = {}
                if voice_cors_origin is not None:
                    headers["Access-Control-Allow-Origin"] = voice_cors_origin
                if voice_cors_headers is not None:
                    headers["Access-Control-Allow-Headers"] = voice_cors_headers
                return httpx.Response(voice_cors_status, headers=headers)

        return httpx.Response(500, text="unexpected mock route")

    mounts = (
        {
            VOICE_API_URL: voice_transport,
            "http://127.0.0.1:8081": voice_transport,
        }
        if voice_transport is not None
        else None
    )
    return httpx.AsyncClient(transport=httpx.MockTransport(handler), mounts=mounts)


# ---------------------------------------------------------------------------
# 1. Happy path (all 5 checks green, text + --json, exit 0)
# ---------------------------------------------------------------------------


async def test_happy_path_all_checks_ok_and_json_contract(isolated_env: Path) -> None:
    env_file = _write_env(isolated_env / ".env.client", _base_env_values())

    async with _make_mock_client() as client:
        report = await run_doctor(env_file=env_file, mode="poll", http=client)
        assert report.ok is True
        assert report.exit_code == 0

        by_name = {c.name: c for c in report.checks}
        assert list(by_name) == [
            "settings",
            "miniapp_voice_config",
            "sheet_api",
            "telegram_api",
            "voice_service",
        ]
        assert all(c.status == "ok" for c in report.checks)

        assert "count=1" in by_name["settings"].detail
        assert "script.google.com (/macros/s/.../exec)" in by_name["settings"].detail
        assert "exercises=12, foods=25, sessions=2, phase.plan=true" in by_name["sheet_api"].detail
        assert "@academy_fit_bot" in by_name["telegram_api"].detail
        assert "webhook_set=false" in by_name["telegram_api"].detail
        assert f"Origin={MINIAPP_ORIGIN}" in by_name["voice_service"].detail

        buf = io.StringIO()
        code = await run_cli(["--env", str(env_file), "--mode", "poll", "--json"], http=client, stdout=buf)
        assert code == 0
        parsed = json.loads(buf.getvalue())
        assert parsed["ok"] is True
        assert len(parsed["checks"]) == 5
        assert {item["status"] for item in parsed["checks"]} == {"ok"}


# ---------------------------------------------------------------------------
# 2. Mode conflict: --mode poll with active webhook & --mode webhook / auto
# ---------------------------------------------------------------------------


async def test_poll_mode_fails_when_telegram_webhook_is_set(isolated_env: Path) -> None:
    env_file = _write_env(isolated_env / ".env", _base_env_values())
    wh_active = {
        "ok": True,
        "result": {
            "url": CANARY_WEBHOOK_URL,
            "pending_update_count": 3,
            "last_error_date": 1_700_000_000,
            "last_error_message": CANARY_TG_ERROR_MSG,
        },
    }

    async with _make_mock_client(webhook_info_body=wh_active) as client:
        report = await run_doctor(
            env_file=env_file,
            mode="poll",
            http=client,
            now=lambda: 1_700_000_045.0,
        )
        assert report.ok is False
        assert report.exit_code == 1

        tg_check = {c.name: c for c in report.checks}["telegram_api"]
        assert tg_check.status == "fail"
        assert "webhook_set=true" in tg_check.detail
        assert "pending_update_count=3" in tg_check.detail
        assert "last_error_age_s=45" in tg_check.detail
        assert "webhook-delete" in tg_check.detail
        assert CANARY_WEBHOOK_URL not in tg_check.detail
        assert CANARY_TG_ERROR_MSG not in tg_check.detail


async def test_webhook_and_auto_modes_validate_webhook_readiness(isolated_env: Path) -> None:
    # P2-6: Auto mode with TELEGRAM_WEBHOOK_SECRET set and webhook_set=false warns (exit 0) for pre-deploy
    env_with_secret = _write_env(
        isolated_env / ".env.prod",
        _base_env_values(TELEGRAM_WEBHOOK_SECRET=CANARY_WEBHOOK_SECRET),
    )
    async with _make_mock_client(
        webhook_info_body={"ok": True, "result": {"url": "", "pending_update_count": 0}}
    ) as client:
        report_auto_predeploy = await run_doctor(env_file=env_with_secret, mode="auto", http=client)
        assert report_auto_predeploy.ok is True
        assert report_auto_predeploy.exit_code == 0
        tg_auto_warn = {c.name: c for c in report_auto_predeploy.checks}["telegram_api"]
        assert tg_auto_warn.status == "warn"
        assert "webhook_set=false" in tg_auto_warn.detail
        assert "webhook-set" in tg_auto_warn.detail

        # Explicit --mode webhook with webhook_set=false strictly fails (exit 1)
        report_webhook_fail = await run_doctor(env_file=env_with_secret, mode="webhook", http=client)
        assert report_webhook_fail.ok is False
        assert report_webhook_fail.exit_code == 1
        tg_webhook_fail = {c.name: c for c in report_webhook_fail.checks}["telegram_api"]
        assert tg_webhook_fail.status == "fail"
        assert "webhook-set" in tg_webhook_fail.detail

    # Explicit --mode webhook with webhook_set=true -> ok
    async with _make_mock_client(
        webhook_info_body={"ok": True, "result": {"url": CANARY_WEBHOOK_URL, "pending_update_count": 0}}
    ) as client:
        report_ok = await run_doctor(env_file=env_with_secret, mode="webhook", http=client)
        assert report_ok.exit_code == 0
        assert {c.name: c for c in report_ok.checks}["telegram_api"].status == "ok"

    # Auto mode without TELEGRAM_WEBHOOK_SECRET warns (exit 0) when webhook_set=true
    env_local = _write_env(isolated_env / ".env.local", _base_env_values())
    async with _make_mock_client(
        webhook_info_body={"ok": True, "result": {"url": CANARY_WEBHOOK_URL, "pending_update_count": 0}}
    ) as client:
        report_warn = await run_doctor(env_file=env_local, mode="auto", http=client)
        assert report_warn.exit_code == 0
        tg_warn = {c.name: c for c in report_warn.checks}["telegram_api"]
        assert tg_warn.status == "warn"
        assert "webhook-delete" in tg_warn.detail


# ---------------------------------------------------------------------------
# 3. CORS preflight failure on voice_service & VOICE_ALLOWED_ORIGINS checks
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("cors_origin", "cors_status"),
    [
        (None, 400),
        ("https://other-origin.github.io", 200),
        ("*", 200),
    ],
)
async def test_voice_service_cors_mismatch_fails(
    isolated_env: Path,
    cors_origin: str | None,
    cors_status: int,
) -> None:
    env_file = _write_env(isolated_env / ".env", _base_env_values())

    async with _make_mock_client(voice_cors_origin=cors_origin, voice_cors_status=cors_status) as client:
        report = await run_doctor(env_file=env_file, mode="poll", http=client)
        assert report.ok is False
        assert report.exit_code == 1
        voice_check = {c.name: c for c in report.checks}["voice_service"]
        assert voice_check.status == "fail"
        assert "cors=fail" in voice_check.detail
        assert MINIAPP_ORIGIN in voice_check.detail


async def test_voice_allowed_origins_rejects_paths_and_mismatched_miniapp_origin(
    isolated_env: Path,
) -> None:
    env_with_path = _write_env(
        isolated_env / ".env.path",
        _base_env_values(VOICE_ALLOWED_ORIGINS="https://coach.github.io/subpath"),
    )
    async with _make_mock_client() as client:
        r_path = await run_doctor(env_file=env_with_path, mode="poll", http=client)
        assert r_path.exit_code == 1
        assert {c.name: c for c in r_path.checks}["miniapp_voice_config"].status == "fail"

    env_mismatch = _write_env(
        isolated_env / ".env.mismatch",
        _base_env_values(VOICE_ALLOWED_ORIGINS="https://someone-else.github.io"),
    )
    async with _make_mock_client() as client:
        r_mismatch = await run_doctor(env_file=env_mismatch, mode="poll", http=client)
        assert r_mismatch.exit_code == 1
        cfg_check = {c.name: c for c in r_mismatch.checks}["miniapp_voice_config"]
        assert cfg_check.status == "fail"
        assert MINIAPP_ORIGIN in cfg_check.detail


async def test_p1_1_dotenv_http_voice_url_fails_settings_and_cli_voice_url_probes_local(
    isolated_env: Path,
) -> None:
    # (1) VOICE_API_URL=http://127.0.0.1:8081 inside .env MUST fail Settings faithfully (exit 1)
    env_http = _write_env(
        isolated_env / ".env.bad_http",
        _base_env_values(VOICE_API_URL="http://127.0.0.1:8081"),
    )
    async with _make_mock_client() as client:
        bad_report = await run_doctor(env_file=env_http, mode="poll", http=client)
        assert bad_report.ok is False
        assert bad_report.exit_code == 1
        bad_by_name = {c.name: c for c in bad_report.checks}
        assert bad_by_name["settings"].status == "fail"
        assert "VOICE_API_URL" in bad_by_name["settings"].detail
        assert bad_by_name["miniapp_voice_config"].status == "fail"

        # Even if --voice-url is passed, broken .env still fails settings!
        still_bad_out = io.StringIO()
        assert (
            await run_cli(
                ["--env", str(env_http), "--mode", "poll", "--voice-url", "http://127.0.0.1:8081"],
                http=client,
                stdout=still_bad_out,
            )
            == 1
        )

    # (2) Valid .env + --voice-url http://127.0.0.1:8081 (or localhost) succeeds with explicit local HTTP note
    env_valid = _write_env(isolated_env / ".env.valid", _base_env_values())
    async with _make_mock_client() as client:
        out_loopback = io.StringIO()
        code = await run_cli(
            ["--env", str(env_valid), "--mode", "poll", "--voice-url", "http://127.0.0.1:8081", "--json"],
            http=client,
            stdout=out_loopback,
        )
        assert code == 0
        payload = json.loads(out_loopback.getvalue())
        assert payload["ok"] is True
        checks_by_name = {c["name"]: c for c in payload["checks"]}
        assert checks_by_name["settings"]["status"] == "ok"
        assert checks_by_name["miniapp_voice_config"]["status"] == "ok"
        assert checks_by_name["voice_service"]["status"] == "ok"
        assert "local http probe (http://127.0.0.1:8081)" in checks_by_name["voice_service"]["detail"]

        report_localhost = await run_doctor(
            env_file=env_valid,
            mode="poll",
            voice_url="http://localhost:8081",
            http=client,
        )
        assert report_localhost.exit_code == 0
        voice_localhost = {c.name: c for c in report_localhost.checks}["voice_service"]
        assert voice_localhost.status == "ok"
        assert "local http probe (http://localhost:8081)" in voice_localhost.detail

        # (3) Non-loopback http:// in --voice-url strictly fails requiring HTTPS
        report_remote_http = await run_doctor(
            env_file=env_valid,
            mode="poll",
            voice_url="http://voice-internal.example.com:8081",
            http=client,
        )
        assert report_remote_http.ok is False
        assert report_remote_http.exit_code == 1
        voice_remote = {c.name: c for c in report_remote_http.checks}["voice_service"]
        assert voice_remote.status == "fail"
        assert "https://" in voice_remote.detail


async def test_voice_service_real_asgi_cors_and_routes(isolated_env: Path) -> None:
    assert HEALTHZ_PATH == "/healthz"
    assert TRANSCRIPTIONS_PATH == "/v1/voice/transcriptions"

    voice_settings = VoiceSettings(
        ALLOWED_CHAT_IDS=frozenset({CANARY_CHAT_ID}),
        APP_AUTH_SECRET=SecretStr(CANARY_AUTH_SECRET),
        VOICE_ALLOWED_ORIGINS=("https://example.github.io",),
        TRANSCRIBE_API_KEY=SecretStr(CANARY_TRANSCRIBE_KEY),
    )
    asgi_transport = httpx.ASGITransport(
        app=build_voice_service(voice_settings, transcriber=FakeTranscriber())
    )

    env_matching = _write_env(
        isolated_env / ".env.asgi.ok",
        _base_env_values(
            MINIAPP_URL="https://example.github.io/app/",
            VOICE_ALLOWED_ORIGINS="",
        ),
    )
    env_mismatched = _write_env(
        isolated_env / ".env.asgi.fail",
        _base_env_values(
            MINIAPP_URL="https://other.github.io/app/",
            VOICE_ALLOWED_ORIGINS="",
        ),
    )

    async with _make_mock_client(voice_transport=asgi_transport) as client:
        report_ok = await run_doctor(env_file=env_matching, mode="poll", http=client)
        assert report_ok.ok is True
        assert report_ok.exit_code == 0
        by_name_ok = {c.name: c for c in report_ok.checks}
        assert by_name_ok["voice_service"].status == "ok"
        assert "Origin=https://example.github.io" in by_name_ok["voice_service"].detail

        report_fail = await run_doctor(env_file=env_mismatched, mode="poll", http=client)
        assert report_fail.ok is False
        assert report_fail.exit_code == 1
        by_name_fail = {c.name: c for c in report_fail.checks}
        assert by_name_fail["miniapp_voice_config"].status == "ok"
        assert by_name_fail["voice_service"].status == "fail"
        assert "cors=fail" in by_name_fail["voice_service"].detail
        assert "https://other.github.io" in by_name_fail["voice_service"].detail


# ---------------------------------------------------------------------------
# 4. APP_AUTH_SECRET missing or < 32 chars when VOICE_API_URL is configured
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("bad_secret", ["", "too-short-secret-16c"])
async def test_app_auth_secret_missing_or_too_short_fails_cleanly(
    isolated_env: Path,
    bad_secret: str,
) -> None:
    env_file = _write_env(
        isolated_env / ".env",
        _base_env_values(APP_AUTH_SECRET=bad_secret),
    )
    async with _make_mock_client() as client:
        report = await run_doctor(env_file=env_file, mode="poll", http=client)
        assert report.ok is False
        assert report.exit_code == 1

        by_name = {c.name: c for c in report.checks}
        assert by_name["miniapp_voice_config"].status == "fail"
        assert "APP_AUTH_SECRET" in by_name["miniapp_voice_config"].detail
        if bad_secret:
            assert bad_secret not in format_text(report)
            assert bad_secret not in format_json(report)


# ---------------------------------------------------------------------------
# 5. Sheet failures (ok=false / ConnectError) and Telegram 401 / ConnectError
# ---------------------------------------------------------------------------


async def test_sheet_error_and_telegram_401_fail_cleanly(isolated_env: Path) -> None:
    env_file = _write_env(isolated_env / ".env", _base_env_values())

    sheet_err = {
        "ok": False,
        "errors": [{"path": "", "code": "unauthorized", "message": f"bad key {CANARY_SHEET_KEY}"}],
    }
    tg_401 = {"ok": False, "error_code": 401, "description": f"Unauthorized {CANARY_BOT_TOKEN}"}

    async with _make_mock_client(
        catalog_body=sheet_err,
        get_me_body=tg_401,
        get_me_status=401,
    ) as client:
        report = await run_doctor(env_file=env_file, mode="poll", http=client)
        assert report.ok is False
        assert report.exit_code == 1

        by_name = {c.name: c for c in report.checks}
        assert by_name["sheet_api"].status == "fail"
        assert "code=unauthorized" in by_name["sheet_api"].detail
        assert by_name["telegram_api"].status == "fail"
        assert "HTTP 401" in by_name["telegram_api"].detail


async def test_sheet_connect_error_and_missing_llm_key_fail(isolated_env: Path) -> None:
    # Missing LLM key when MEDIA_ENABLED=false (Settings loads, doctor catches missing LLM key)
    env_no_llm = _write_env(
        isolated_env / ".env.nollm",
        _base_env_values(LLM_API_KEY="", MEDIA_ENABLED="false", VOICE_API_URL="", APP_AUTH_SECRET=""),
    )
    async with _make_mock_client(
        sheet_exc=lambda req: httpx.ConnectError(f"connect failed: {req.url}", request=req)
    ) as client:
        report = await run_doctor(env_file=env_no_llm, mode="poll", voice=True, http=client)
        assert report.exit_code == 1
        by_name = {c.name: c for c in report.checks}
        assert by_name["settings"].status == "fail"
        assert "LLM_API_KEY" in by_name["settings"].detail
        assert by_name["sheet_api"].status == "fail"
        assert "code=unavailable" in by_name["sheet_api"].detail
        assert "ConnectError" in by_name["sheet_api"].detail
        assert by_name["voice_service"].status == "fail"


# ---------------------------------------------------------------------------
# 6. P0 Canary Non-Leakage Suite (happy path + ConnectError + HTTP errors + validation errors)
# ---------------------------------------------------------------------------


def _assert_no_canaries(blob: str, extra: tuple[str, ...] = ()) -> None:
    for canary in (*ALL_CANARIES, *extra):
        assert canary not in blob, f"P0 leak: canary {canary!r} found in output:\n{blob}"


async def test_p0_canary_zero_leakage_across_happy_and_failure_paths(
    isolated_env: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", CANARY_GEMINI_KEY)

    log_stream = io.StringIO()
    handler = logging.StreamHandler(log_stream)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    root_logger = logging.getLogger()
    saved_handlers = list(root_logger.handlers)
    saved_level = root_logger.level
    root_logger.handlers = [handler]
    root_logger.setLevel(logging.DEBUG)

    try:
        full_env_values = _base_env_values(
            TRANSCRIBE_API_KEY=CANARY_TRANSCRIBE_KEY,
            TELEGRAM_WEBHOOK_SECRET=CANARY_WEBHOOK_SECRET,
            REMINDER_TOKEN=CANARY_REMINDER_TOKEN,
            APP_SESSION_NOT_BEFORE=f"{CANARY_CHAT_ID}:1700000000",
        )
        env_happy = _write_env(isolated_env / ".env.canary.ok", full_env_values)

        # (A) Happy path: text + --json
        async with _make_mock_client(
            webhook_info_body={
                "ok": True,
                "result": {
                    "url": CANARY_WEBHOOK_URL,
                    "pending_update_count": 2,
                    "last_error_date": 1_700_000_010,
                    "last_error_message": CANARY_TG_ERROR_MSG,
                },
            }
        ) as ok_client:
            text_out = io.StringIO()
            json_out = io.StringIO()
            assert (
                await run_cli(["--env", str(env_happy), "--mode", "webhook"], http=ok_client, stdout=text_out)
                == 0
            )
            assert (
                await run_cli(
                    ["--env", str(env_happy), "--mode", "webhook", "--json"],
                    http=ok_client,
                    stdout=json_out,
                )
                == 0
            )
            _assert_no_canaries(text_out.getvalue())
            _assert_no_canaries(json_out.getvalue())

        # (B) Transport ConnectError carrying full URLs with bot token and sheet deploymentId
        async with _make_mock_client(
            sheet_exc=lambda req: httpx.ConnectError(
                f"DNS/TLS failure connecting to {req.url} key={CANARY_SHEET_KEY}",
                request=req,
            ),
            telegram_exc=lambda req: httpx.ConnectError(
                f"DNS/TLS failure connecting to {req.url}",
                request=req,
            ),
            voice_exc=lambda req: httpx.ConnectError(
                f"Connect failed {CANARY_AUTH_SECRET} {req.url}",
                request=req,
            ),
        ) as net_err_client:
            err_text = io.StringIO()
            err_json = io.StringIO()
            assert await run_cli(["--env", str(env_happy)], http=net_err_client, stdout=err_text) == 1
            assert (
                await run_cli(["--env", str(env_happy), "--json"], http=net_err_client, stdout=err_json) == 1
            )
            _assert_no_canaries(err_text.getvalue())
            _assert_no_canaries(err_json.getvalue())

        # (C) Validation error path with short secret & malformed chat_id canary
        short_auth_canary = "short-AUTH-CANARY-999"
        bad_chat_canary = f"not-an-int-{CANARY_CHAT_ID}"
        env_invalid = _write_env(
            isolated_env / ".env.canary.bad",
            _base_env_values(
                APP_AUTH_SECRET=short_auth_canary,
                ALLOWED_CHAT_IDS=bad_chat_canary,
            ),
        )
        async with _make_mock_client() as client:
            bad_text = io.StringIO()
            bad_json = io.StringIO()
            assert await run_cli(["--env", str(env_invalid)], http=client, stdout=bad_text) == 1
            assert await run_cli(["--env", str(env_invalid), "--json"], http=client, stdout=bad_json) == 1
            _assert_no_canaries(bad_text.getvalue(), extra=(short_auth_canary, bad_chat_canary))
            _assert_no_canaries(bad_json.getvalue(), extra=(short_auth_canary, bad_chat_canary))

        captured = capsys.readouterr()
        _assert_no_canaries(captured.out, extra=(short_auth_canary, bad_chat_canary))
        _assert_no_canaries(captured.err, extra=(short_auth_canary, bad_chat_canary))
        _assert_no_canaries(log_stream.getvalue(), extra=(short_auth_canary, bad_chat_canary))
    finally:
        root_logger.handlers = saved_handlers
        root_logger.setLevel(saved_level)


# ---------------------------------------------------------------------------
# 7. Registration in pyproject.toml and Makefile
# ---------------------------------------------------------------------------


def test_pyproject_and_makefile_register_agent_doctor() -> None:
    pyproject = tomllib.loads((AGENT_DIR / "pyproject.toml").read_text(encoding="utf-8"))
    scripts = pyproject["project"]["scripts"]
    assert scripts.get("agent-doctor") == "agent.doctor:main"

    makefile = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")
    assert "DOCTOR_ARGS ?=" in makefile
    assert "doctor:" in makefile
    assert "uv run agent-doctor $(DOCTOR_ARGS)" in makefile

    phony_lines: list[str] = []
    in_phony = False
    for line in makefile.splitlines():
        if line.startswith(".PHONY:"):
            in_phony = True
            phony_lines.append(line.partition(".PHONY:")[2])
        elif in_phony:
            if line.startswith("\t"):
                phony_lines.append(line)
            else:
                break
    assert "doctor" in " ".join(phony_lines).split()


# ---------------------------------------------------------------------------
# 8. Adversarial Review v3 Regression Suite (P2-1 through P2-8)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("multibyte_secret", "expect_ok"),
    [
        ("é" * 16, True),  # 16 chars, 32 UTF-8 bytes -> valid
        ("🔑" * 8, True),  # 8 chars, 32 UTF-8 bytes -> valid
        ("é" * 15, False),  # 15 chars, 30 UTF-8 bytes -> too short (<32 bytes)
        ("🔑" * 7, False),  # 7 chars, 28 UTF-8 bytes -> too short (<32 bytes)
    ],
)
async def test_p2_1_app_auth_secret_measured_in_utf8_bytes(
    isolated_env: Path,
    multibyte_secret: str,
    expect_ok: bool,
) -> None:
    env_file = _write_env(
        isolated_env / ".env.utf8secret",
        _base_env_values(APP_AUTH_SECRET=multibyte_secret),
    )
    async with _make_mock_client() as client:
        report = await run_doctor(env_file=env_file, mode="poll", http=client)
        assert report.ok is expect_ok
        assert report.exit_code == (0 if expect_ok else 1)

        by_name = {c.name: c for c in report.checks}
        expected_status = "ok" if expect_ok else "fail"
        assert by_name["settings"].status == expected_status
        assert by_name["miniapp_voice_config"].status == expected_status

        assert multibyte_secret not in format_text(report)
        assert multibyte_secret not in format_json(report)


async def test_p2_2_unreadable_or_invalid_utf8_files_fail_cleanly_without_leak(
    isolated_env: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # (1) .env containing invalid UTF-8 bytes + secret canary
    bad_utf8_env = isolated_env / ".env.badutf8"
    bad_utf8_env.write_bytes(b"TELEGRAM_BOT_TOKEN=utf8-env-SECRET-CANARY-99\nBROKEN=\xff\xfe\xfa\n")

    async with _make_mock_client() as client:
        r_env_utf8 = await run_doctor(env_file=bad_utf8_env, mode="poll", http=client)
        assert r_env_utf8.ok is False
        assert r_env_utf8.exit_code == 1
        settings_res = {c.name: c for c in r_env_utf8.checks}["settings"]
        assert settings_res.status == "fail"
        assert "UnicodeDecodeError" in settings_res.detail
        assert "utf8-env-SECRET-CANARY-99" not in format_text(r_env_utf8)
        assert "utf8-env-SECRET-CANARY-99" not in format_json(r_env_utf8)

        # (2) settings.yaml containing invalid UTF-8 bytes
        valid_env = _write_env(isolated_env / ".env.good", _base_env_values())
        bad_yaml = isolated_env / "bad_settings.yaml"
        bad_yaml.write_bytes(b"LLM_MODEL: gemini/gemini-3.8-flash\n# yaml-SECRET-CANARY \xff\xfe\n")
        monkeypatch.setenv("SETTINGS_FILE", str(bad_yaml))

        r_yaml_utf8 = await run_doctor(env_file=valid_env, mode="poll", http=client)
        assert r_yaml_utf8.ok is False
        assert r_yaml_utf8.exit_code == 1
        yaml_res = {c.name: c for c in r_yaml_utf8.checks}["settings"]
        assert yaml_res.status == "fail"
        assert "UnicodeDecodeError" in yaml_res.detail
        assert "yaml-SECRET-CANARY" not in format_text(r_yaml_utf8)

        # (3) OSError / PermissionError reading .env (must cite only exception class name, never message)
        good_yaml = isolated_env / "good_settings.yaml"
        good_yaml.write_text("LLM_MODEL: gemini/gemini-3.8-flash\n", encoding="utf-8")
        monkeypatch.setenv("SETTINGS_FILE", str(good_yaml))

        orig_read_text = Path.read_text
        blocked_env = isolated_env / ".env.locked"
        blocked_env.write_text("TELEGRAM_BOT_TOKEN=locked-SECRET-CANARY\n", encoding="utf-8")

        def fake_read_text(self: Path, *args: Any, **kwargs: Any) -> str:
            if self == blocked_env:
                raise PermissionError("OS-ERROR-SECRET-CANARY-MESSAGE")
            return orig_read_text(self, *args, **kwargs)

        monkeypatch.setattr(Path, "read_text", fake_read_text)
        r_perm = await run_doctor(env_file=blocked_env, mode="poll", http=client)
        assert r_perm.ok is False
        assert r_perm.exit_code == 1
        perm_res = {c.name: c for c in r_perm.checks}["settings"]
        assert perm_res.status == "fail"
        assert "PermissionError" in perm_res.detail
        assert "OS-ERROR-SECRET-CANARY-MESSAGE" not in format_text(r_perm)
        assert "locked-SECRET-CANARY" not in format_text(r_perm)

    # (4) Direct _check_settings call when Settings(...) itself raises UnicodeDecodeError / PermissionError
    check_utf8_direct, loaded_utf8_direct = _check_settings(bad_utf8_env, pre_error=None)
    assert loaded_utf8_direct is None
    assert check_utf8_direct.status == "fail"
    assert "UnicodeDecodeError" in check_utf8_direct.detail
    assert "utf8-env-SECRET-CANARY-99" not in check_utf8_direct.detail

    import builtins

    orig_open = builtins.open

    def fake_open(file: Any, *args: Any, **kwargs: Any) -> Any:
        if Path(file) == blocked_env:
            raise PermissionError("OS-ERROR-SECRET-CANARY-MESSAGE")
        return orig_open(file, *args, **kwargs)

    monkeypatch.setattr(builtins, "open", fake_open)
    check_direct, loaded_direct = _check_settings(blocked_env, pre_error=None)
    assert loaded_direct is None
    assert check_direct.status == "fail"
    assert "PermissionError" in check_direct.detail
    assert "OS-ERROR-SECRET-CANARY-MESSAGE" not in check_direct.detail


@pytest.mark.parametrize(
    "bad_timeout",
    [
        "nan",
        "NaN",
        "inf",
        "+inf",
        "-inf",
        "Infinity",
        "0",
        "-0.0",
        "-1.5",
        "not-a-number",
        float("nan"),
        float("inf"),
        float("-inf"),
        0.0,
        -5.0,
        True,
    ],
)
def test_p2_3_positive_timeout_rejects_non_finite_and_non_positive(bad_timeout: Any) -> None:
    with pytest.raises(argparse.ArgumentTypeError):
        _positive_timeout(bad_timeout)


@pytest.mark.parametrize("cli_timeout", ["nan", "inf", "-inf", "0", "-3"])
async def test_p2_3_cli_rejects_nan_and_inf_timeout(cli_timeout: str) -> None:
    with pytest.raises(SystemExit) as exc_info:
        await run_cli(["--timeout", cli_timeout])
    assert exc_info.value.code == 2
    assert _positive_timeout("2.5") == 2.5


async def test_p2_4_lowercase_dotenv_keys_are_normalized_and_scrubbed(isolated_env: Path) -> None:
    lowercase_values = {k.lower(): v for k, v in _base_env_values().items()}
    env_lower = _write_env(isolated_env / ".env.lower", lowercase_values)

    async with _make_mock_client() as client:
        report = await run_doctor(env_file=env_lower, mode="poll", http=client)
        assert report.ok is True
        assert report.exit_code == 0

        by_name = {c.name: c for c in report.checks}
        assert list(by_name) == [
            "settings",
            "miniapp_voice_config",
            "sheet_api",
            "telegram_api",
            "voice_service",
        ]
        assert all(c.status == "ok" for c in report.checks)
        _assert_no_canaries(format_text(report))
        _assert_no_canaries(format_json(report))


async def test_p2_5_unmapped_llm_provider_without_llm_api_key_emits_warn(isolated_env: Path) -> None:
    # Unmapped provider (e.g. bedrock/*) without LLM_API_KEY -> warn (exit 0)
    env_unmapped = _write_env(
        isolated_env / ".env.bedrock",
        _base_env_values(
            LLM_MODEL="bedrock/anthropic.claude-3-5-sonnet",
            LLM_API_KEY="",
            MEDIA_ENABLED="false",
        ),
    )
    # Known provider (openai/*) without LLM_API_KEY or OPENAI_API_KEY -> fail (exit 1)
    env_known_missing = _write_env(
        isolated_env / ".env.openai",
        _base_env_values(
            LLM_MODEL="openai/gpt-5.6",
            LLM_API_KEY="",
            MEDIA_ENABLED="false",
        ),
    )

    async with _make_mock_client() as client:
        r_warn = await run_doctor(env_file=env_unmapped, mode="poll", http=client)
        assert r_warn.ok is True
        assert r_warn.exit_code == 0
        settings_warn = {c.name: c for c in r_warn.checks}["settings"]
        assert settings_warn.status == "warn"
        assert "bedrock" in settings_warn.detail

        r_fail = await run_doctor(env_file=env_known_missing, mode="poll", http=client)
        assert r_fail.ok is False
        assert r_fail.exit_code == 1
        settings_fail = {c.name: c for c in r_fail.checks}["settings"]
        assert settings_fail.status == "fail"
        assert "OPENAI_API_KEY" in settings_fail.detail


async def test_p2_7_voice_preflight_sends_request_headers_and_validates_allow_headers(
    isolated_env: Path,
) -> None:
    env_file = _write_env(isolated_env / ".env", _base_env_values())

    # (1) Verify OPTIONS request sends Access-Control-Request-Headers matching CORS_ALLOW_HEADERS
    seen: list[httpx.Request] = []
    async with _make_mock_client(captured_requests=seen) as client:
        ok_report = await run_doctor(env_file=env_file, mode="poll", http=client)
        assert ok_report.exit_code == 0

    options_reqs = [r for r in seen if r.method == "OPTIONS" and r.url.path == TRANSCRIPTIONS_PATH]
    assert len(options_reqs) == 1
    sent_acrh = options_reqs[0].headers.get("Access-Control-Request-Headers", "")
    sent_tokens = {h.strip().lower() for h in sent_acrh.split(",") if h.strip()}
    assert sent_tokens == {h.lower() for h in CORS_ALLOW_HEADERS}

    # (2) Missing or incomplete Access-Control-Allow-Headers fails voice_service
    for bad_allow_headers in (None, "Authorization, Content-Type"):
        async with _make_mock_client(voice_cors_headers=bad_allow_headers) as client:
            fail_report = await run_doctor(env_file=env_file, mode="poll", http=client)
            assert fail_report.ok is False
            assert fail_report.exit_code == 1
            v_check = {c.name: c for c in fail_report.checks}["voice_service"]
            assert v_check.status == "fail"
            assert "Access-Control-Allow-Headers" in v_check.detail

    # (3) Wildcard '*' or lowercase full header list in Access-Control-Allow-Headers succeeds
    for valid_allow_headers in ("*", ", ".join(h.lower() for h in CORS_ALLOW_HEADERS)):
        async with _make_mock_client(voice_cors_headers=valid_allow_headers) as client:
            pass_report = await run_doctor(env_file=env_file, mode="poll", http=client)
            assert pass_report.ok is True
            assert pass_report.exit_code == 0
            assert {c.name: c for c in pass_report.checks}["voice_service"].status == "ok"


async def test_p2_8_google_workspace_apps_script_url_accepted_and_masked(isolated_env: Path) -> None:
    ws_domain = "empresa-secreta-canary.com.br"
    ws_deploy_id = "AKfycb-WORKSPACE-CANARY-777"
    ws_exec_url = f"https://script.google.com/a/macros/{ws_domain}/s/{ws_deploy_id}/exec"
    ws_dev_url = f"https://script.google.com/a/macros/{ws_domain}/s/{ws_deploy_id}/dev"

    env_exec = _write_env(isolated_env / ".env.ws.exec", _base_env_values(SHEET_API_URL=ws_exec_url))
    env_dev = _write_env(isolated_env / ".env.ws.dev", _base_env_values(SHEET_API_URL=ws_dev_url))

    async with _make_mock_client() as client:
        r_exec = await run_doctor(env_file=env_exec, mode="poll", http=client)
        assert r_exec.ok is True
        assert r_exec.exit_code == 0
        by_name = {c.name: c for c in r_exec.checks}
        assert by_name["settings"].status == "ok"
        assert "script.google.com (/a/macros/.../s/.../exec)" in by_name["settings"].detail
        assert by_name["sheet_api"].status == "ok"
        assert "script.google.com (/a/macros/.../s/.../exec)" in by_name["sheet_api"].detail
        _assert_no_canaries(format_text(r_exec), extra=(ws_domain, ws_deploy_id, ws_exec_url))
        _assert_no_canaries(format_json(r_exec), extra=(ws_domain, ws_deploy_id, ws_exec_url))

        r_dev = await run_doctor(env_file=env_dev, mode="poll", http=client)
        assert r_dev.ok is True
        assert r_dev.exit_code == 0
        assert {c.name: c for c in r_dev.checks}["settings"].status == "warn"
        assert (
            "script.google.com (/a/macros/.../s/.../dev"
            in {c.name: c for c in r_dev.checks}["settings"].detail
        )
        _assert_no_canaries(format_text(r_dev), extra=(ws_domain, ws_deploy_id, ws_dev_url))

    # Even if transport exception echoes full Workspace URL, domain + deploymentId are scrubbed
    async with _make_mock_client(
        sheet_exc=lambda req: httpx.ConnectError(f"failed connecting to {req.url}", request=req)
    ) as err_client:
        r_err = await run_doctor(env_file=env_exec, mode="poll", http=err_client)
        assert r_err.exit_code == 1
        _assert_no_canaries(format_text(r_err), extra=(ws_domain, ws_deploy_id, ws_exec_url))
        _assert_no_canaries(format_json(r_err), extra=(ws_domain, ws_deploy_id, ws_exec_url))
