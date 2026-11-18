"""Integration, settings, CORS, isolation and §10.3 sentinel tests for the voice service (C5c)."""

from __future__ import annotations

import ast
import base64
import io
import logging
import sys
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import litellm
import pytest
from pydantic import ValidationError
from starlette.requests import Request
from starlette.testclient import TestClient

from agent import logs, telegram, voice_asgi
from agent import settings as bot_settings
from agent.auth import VOICE, Principal
from agent.budget import MemoryBudget
from agent.settings import ConfigError
from agent.transcribe import Transcriber, Transcript, Usage
from agent.voice_api import HEALTHZ_PATH, SESSIONS_PATH, TRANSCRIPTIONS_PATH
from agent.voice_asgi import build_voice_service, configure_voice_logging, get_app
from agent.voice_settings import VoiceSettings, validation_problems

from .fakes import FakeLiteLLMClient
from .voice_fakes import (
    DEFAULT_NOW,
    OTHER_CHAT_ID,
    SYNTHETIC_AUTH_SECRET,
    SYNTHETIC_BOT_TOKEN,
    SYNTHETIC_CHAT_ID,
    SYNTHETIC_ORIGIN,
    SYNTHETIC_TRANSCRIBE_KEY,
    FakeClock,
    FakeTranscriber,
    TestAuthorizer,
    TestDirectory,
    TestProvider,
    make_init_data,
    make_link_code,
    make_test_principal,
)

pytestmark = pytest.mark.unit

SRC_AGENT_DIR = Path(__file__).resolve().parents[1] / "src" / "agent"
FORBIDDEN_MODULES = frozenset({"handler", "bot", "sheet_client", "telegram", "commands", "voice_fakes"})

AUDIO_SENTINEL = b"SENTINEL-AUDIO-7f3a"
AUDIO_SENTINEL_B64 = base64.b64encode(AUDIO_SENTINEL).decode("ascii")
AUDIO_SENTINEL_B64_STRIPPED = AUDIO_SENTINEL_B64.rstrip("=")
TEXT_SENTINEL = "SENTINELA-TEXTO-91c2"
IDEMPOTENCY_SENTINEL = "a1b2c3d4e5f60718293a4b5c6d7e8f90"
RAW_SUBJECT_SENTINEL = "subject-sentinel-u99"

SERVICE_LOG_FORMAT = "%(asctime)s %(levelname)s %(name)s: %(message)s"


def _clear_agent_env(monkeypatch: pytest.MonkeyPatch) -> None:
    keys = (
        "SETTINGS_FILE",
        "ENV_FILE",
        "VOICE_API_ENABLED",
        "TIMEZONE",
        "ALLOWED_CHAT_IDS",
        "TELEGRAM_BOT_TOKEN",
        "TELEGRAM_WEBHOOK_SECRET",
        "REMINDER_TOKEN",
        "SHEET_API_URL",
        "SHEET_API_KEY",
        "LLM_MODEL",
        "LLM_API_KEY",
        "LLM_API_BASE",
        "APP_AUTH_SECRET",
        "APP_CODE_TTL_S",
        "APP_SESSION_TTL_S",
        "INITDATA_MAX_AGE_S",
        "APP_SESSION_NOT_BEFORE",
        "VOICE_ALLOWED_ORIGINS",
        "VOICE_MAX_SECONDS",
        "VOICE_MAX_BYTES",
        "VOICE_RATE_PER_MIN",
        "VOICE_RATE_PER_DAY",
        "VOICE_MAX_CONCURRENT",
        "VOICE_IDEMPOTENCY_TTL_S",
        "EXCHANGE_RATE_PER_MIN",
        "EXCHANGE_RATE_PER_DAY",
        "VOICE_DAILY_TOKENS",
        "VOICE_GLOBAL_DAILY_TOKENS",
        "TRANSCRIBE_MODEL",
        "TRANSCRIBE_API_KEY",
        "TRANSCRIBE_API_BASE",
        "TRANSCRIBE_FALLBACK_MODEL",
        "TRANSCRIBE_FALLBACK_API_KEY",
        "TRANSCRIBE_FALLBACK_API_BASE",
        "TRANSCRIBE_TIMEOUT_S",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
    )
    for key in keys:
        monkeypatch.delenv(key, raising=False)


def _audio_body(size: int = 2048) -> bytes:
    repeats = (size // len(AUDIO_SENTINEL)) + 2
    return (AUDIO_SENTINEL * repeats)[:size]


def _litellm_reply(text: str = "agachamento 100 por 6, RIR 2") -> Any:
    usage = SimpleNamespace(
        prompt_tokens=480,
        completion_tokens=16,
        prompt_tokens_details=SimpleNamespace(audio_tokens=640),
    )
    return SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
        usage=usage,
    )


# ---------------------------------------------------------------------------
# 1. Static import & boundary verification
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("filename", ["voice_settings.py", "voice_api.py", "voice_asgi.py"])
def test_voice_modules_never_import_forbidden_bot_or_sheet_modules(filename: str) -> None:
    source = (SRC_AGENT_DIR / filename).read_text(encoding="utf-8")
    tree = ast.parse(source, filename=filename)
    imported: set[str] = set()

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                parts = alias.name.split(".")
                imported.update(parts)
        elif isinstance(node, ast.ImportFrom):
            if node.module:
                imported.update(node.module.split("."))
            for alias in node.names:
                imported.add(alias.name)

    offenders = imported & FORBIDDEN_MODULES
    assert offenders == set(), f"{filename} imported forbidden modules: {sorted(offenders)}"


# ---------------------------------------------------------------------------
# 2. VoiceSettings shared loader, precedence, secret safety & bot Settings strictness
# ---------------------------------------------------------------------------


def test_voice_settings_loads_precedence_and_masks_secrets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _clear_agent_env(monkeypatch)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(logs, "_SECRETS", set())

    yaml_file = tmp_path / "voice.yaml"
    yaml_file.write_text(
        "TIMEZONE: UTC\n"
        "VOICE_MAX_SECONDS: 60\n"
        "VOICE_RATE_PER_MIN: 4\n"
        "VOICE_ALLOWED_ORIGINS:\n"
        "  - https://Yaml.Example.Test:8443\n",
        encoding="utf-8",
    )
    dotenv_file = tmp_path / ".env"
    dotenv_file.write_text(
        f"ALLOWED_CHAT_IDS={SYNTHETIC_CHAT_ID},{OTHER_CHAT_ID}\n"
        f"APP_AUTH_SECRET={SYNTHETIC_AUTH_SECRET}\n"
        f"TRANSCRIBE_API_KEY={SYNTHETIC_TRANSCRIBE_KEY}\n"
        "VOICE_RATE_PER_MIN=7\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("SETTINGS_FILE", str(yaml_file))
    monkeypatch.setenv("VOICE_RATE_PER_MIN", "9")

    loaded = VoiceSettings.load(dotenv_file)
    assert loaded.TIMEZONE == "UTC"
    assert loaded.VOICE_MAX_SECONDS == 60
    assert loaded.VOICE_RATE_PER_MIN == 9  # env > .env > yaml
    assert loaded.ALLOWED_CHAT_IDS == frozenset({SYNTHETIC_CHAT_ID, OTHER_CHAT_ID})
    assert loaded.VOICE_ALLOWED_ORIGINS == ("https://yaml.example.test:8443",)
    assert loaded.TELEGRAM_BOT_TOKEN is None

    # Secrets registered in logs masking
    logger_stream = io.StringIO()
    handler = logging.StreamHandler(logger_stream)
    handler.setFormatter(logging.Formatter("%(message)s"))
    test_logger = logging.getLogger("test.voice_settings.mask")
    test_logger.handlers = [handler]
    test_logger.propagate = False
    test_logger.setLevel(logging.INFO)
    test_logger.info("leaked %s and %s", SYNTHETIC_AUTH_SECRET, SYNTHETIC_TRANSCRIBE_KEY)
    rendered = logger_stream.getvalue()
    assert SYNTHETIC_AUTH_SECRET not in rendered
    assert SYNTHETIC_TRANSCRIBE_KEY not in rendered
    assert rendered.count(logs.MASK) == 2


def test_voice_settings_refuses_secrets_in_yaml(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _clear_agent_env(monkeypatch)
    monkeypatch.chdir(tmp_path)
    yaml_file = tmp_path / "bad.yaml"
    yaml_file.write_text(
        f"APP_AUTH_SECRET: {SYNTHETIC_AUTH_SECRET}\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("SETTINGS_FILE", str(yaml_file))
    with pytest.raises(ConfigError, match="must not contain secrets") as exc_info:
        VoiceSettings.load()
    assert SYNTHETIC_AUTH_SECRET not in str(exc_info.value)


def test_voice_settings_validation_errors_never_leak_rejected_values(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _clear_agent_env(monkeypatch)
    monkeypatch.chdir(tmp_path)
    short_secret = "short-secret-sentinel-value"
    bad_origin = "http://insecure-origin-sentinel.example.test/path?secret=1"
    bad_chat = "chat-sentinel-not-an-int"

    with pytest.raises(ValidationError) as exc_info:
        VoiceSettings(
            ALLOWED_CHAT_IDS=bad_chat,  # type: ignore[arg-type]
            APP_AUTH_SECRET=short_secret,  # type: ignore[arg-type]
            VOICE_ALLOWED_ORIGINS=bad_origin,  # type: ignore[arg-type]
            TRANSCRIBE_API_KEY=SYNTHETIC_TRANSCRIBE_KEY,  # type: ignore[arg-type]
        )

    summary = f"{exc_info.value} | {repr(exc_info.value)} | {validation_problems(exc_info.value)}"
    for secret_piece in (short_secret, bad_origin, bad_chat, SYNTHETIC_TRANSCRIBE_KEY):
        assert secret_piece not in summary


def test_bot_settings_remains_strict_and_still_requires_sheet_and_telegram_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _clear_agent_env(monkeypatch)
    monkeypatch.chdir(tmp_path)
    yaml_file = tmp_path / "empty.yaml"
    yaml_file.write_text("{}\n", encoding="utf-8")

    monkeypatch.setenv("SETTINGS_FILE", str(yaml_file))
    monkeypatch.setenv("ALLOWED_CHAT_IDS", str(SYNTHETIC_CHAT_ID))
    monkeypatch.setenv("APP_AUTH_SECRET", SYNTHETIC_AUTH_SECRET)
    monkeypatch.setenv("VOICE_ALLOWED_ORIGINS", SYNTHETIC_ORIGIN)
    monkeypatch.setenv("TRANSCRIBE_API_KEY", SYNTHETIC_TRANSCRIBE_KEY)

    # VoiceSettings succeeds without sheet or bot token...
    voice_cfg = VoiceSettings.load()
    assert voice_cfg.TELEGRAM_BOT_TOKEN is None

    # ...while bot Settings still fails closed without SHEET_API_*, TELEGRAM_BOT_TOKEN and LLM_API_KEY.
    with pytest.raises(ConfigError) as exc_info:
        bot_settings.Settings.load()
    msg = str(exc_info.value)
    assert "SHEET_API_URL" in msg
    assert "SHEET_API_KEY" in msg
    assert "TELEGRAM_BOT_TOKEN" in msg


# ---------------------------------------------------------------------------
# 3. §5.1 Acceptance test: Service starts and transcribes without the sheet or LLM_* or bot token
# ---------------------------------------------------------------------------


def test_service_without_sheet_or_llm_or_bot_token_transcribes_end_to_end(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _clear_agent_env(monkeypatch)
    monkeypatch.chdir(tmp_path)
    yaml_file = tmp_path / "settings.yaml"
    yaml_file.write_text("TIMEZONE: America/Sao_Paulo\n", encoding="utf-8")

    monkeypatch.setenv("SETTINGS_FILE", str(yaml_file))
    monkeypatch.setenv("ALLOWED_CHAT_IDS", str(SYNTHETIC_CHAT_ID))
    monkeypatch.setenv("APP_AUTH_SECRET", SYNTHETIC_AUTH_SECRET)
    monkeypatch.setenv("VOICE_ALLOWED_ORIGINS", SYNTHETIC_ORIGIN)
    monkeypatch.setenv("TRANSCRIBE_MODEL", "gemini/gemini-3.8-flash")
    monkeypatch.setenv("TRANSCRIBE_API_KEY", SYNTHETIC_TRANSCRIBE_KEY)

    clock = FakeClock(DEFAULT_NOW)
    settings = VoiceSettings.load()
    assert settings.TELEGRAM_BOT_TOKEN is None

    fake_llm = FakeLiteLLMClient([_litellm_reply("rosca direta 18 por 10, RIR 1")])
    budget = MemoryBudget(
        principal_daily=settings.VOICE_DAILY_TOKENS,
        global_daily=settings.VOICE_GLOBAL_DAILY_TOKENS,
        timezone=settings.TIMEZONE,
    )
    transcriber = Transcriber(settings, budget, client=fake_llm, clock=clock)
    app = build_voice_service(settings, transcriber=transcriber, clock=clock)

    code = make_link_code(
        secret=SYNTHETIC_AUTH_SECRET,
        chat_id=SYNTHETIC_CHAT_ID,
        allowed_chats=(SYNTHETIC_CHAT_ID,),
        now=clock(),
    )

    with TestClient(app) as client:
        health = client.get(HEALTHZ_PATH)
        assert health.status_code == 200
        assert health.text == "ok"

        # Without TELEGRAM_BOT_TOKEN, tg_init_data is disabled (400 bad_request).
        init_resp = client.post(
            SESSIONS_PATH,
            json={"v": 1, "kind": "tg_init_data", "credential": make_init_data(now=clock())},
            headers={"Origin": SYNTHETIC_ORIGIN},
        )
        assert init_resp.status_code == 400
        assert init_resp.json()["error"]["code"] == "bad_request"

        # tg_link succeeds and issues a scoped session.
        sess_resp = client.post(
            SESSIONS_PATH,
            json={"v": 1, "kind": "tg_link", "credential": code},
            headers={"Origin": SYNTHETIC_ORIGIN},
        )
        assert sess_resp.status_code == 200
        sess_body = sess_resp.json()
        assert sess_body["v"] == 1
        assert sess_body["scopes"] == [VOICE]
        session_token = sess_body["session"]

        # POST /v1/voice/transcriptions succeeds with the fake LiteLLM client.
        idem_key = "0123456789abcdef0123456789abcdef"
        tx_resp = client.post(
            TRANSCRIPTIONS_PATH,
            content=_audio_body(2048),
            headers={
                "Origin": SYNTHETIC_ORIGIN,
                "Authorization": f"Bearer {session_token}",
                "Content-Type": "audio/webm;codecs=opus",
                "Idempotency-Key": idem_key,
                "X-Audio-Duration-Ms": "4200",
            },
        )
        assert tx_resp.status_code == 200
        assert tx_resp.json() == {
            "v": 1,
            "id": idem_key,
            "text": "rosca direta 18 por 10, RIR 1",
        }
        assert len(fake_llm.requests) == 1


def test_lazy_asgi_app_lifespan_starts_and_answers_healthz(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _clear_agent_env(monkeypatch)
    monkeypatch.chdir(tmp_path)
    yaml_file = tmp_path / "settings.yaml"
    yaml_file.write_text("VOICE_API_ENABLED: false\n", encoding="utf-8")
    monkeypatch.setenv("SETTINGS_FILE", str(yaml_file))
    monkeypatch.setenv("ALLOWED_CHAT_IDS", str(SYNTHETIC_CHAT_ID))

    get_app.cache_clear()
    try:
        with TestClient(voice_asgi.app) as client:
            resp = client.get(HEALTHZ_PATH)
            assert resp.status_code == 200
            assert resp.text == "ok"

            disabled = client.post(SESSIONS_PATH, json={"v": 1, "kind": "tg_link", "credential": "abc"})
            assert disabled.status_code == 503
            assert disabled.json()["error"]["code"] == "disabled"
    finally:
        get_app.cache_clear()


# ---------------------------------------------------------------------------
# 4. §13 Mandatory acceptance test: Outside Telegram
# ---------------------------------------------------------------------------


def test_outside_telegram_provider_exchanges_and_transcribes_with_telegram_and_bot_blocked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _clear_agent_env(monkeypatch)
    monkeypatch.chdir(tmp_path)
    yaml_file = tmp_path / "settings.yaml"
    yaml_file.write_text("TIMEZONE: America/Sao_Paulo\n", encoding="utf-8")

    monkeypatch.setenv("SETTINGS_FILE", str(yaml_file))
    monkeypatch.setenv("ALLOWED_CHAT_IDS", "")
    monkeypatch.setenv("APP_AUTH_SECRET", SYNTHETIC_AUTH_SECRET)
    monkeypatch.setenv("VOICE_ALLOWED_ORIGINS", SYNTHETIC_ORIGIN)
    monkeypatch.setenv("TRANSCRIBE_API_KEY", SYNTHETIC_TRANSCRIBE_KEY)

    # Patch TelegramClient so constructing it fails immediately, and poison bot/handler/sheet/commands
    # in sys.modules so importing any of them raises ModuleNotFoundError.
    def _forbidden_telegram_client(*_args: Any, **_kwargs: Any) -> None:
        pytest.fail("TelegramClient must never be constructed by the voice service")

    monkeypatch.setattr(telegram, "TelegramClient", _forbidden_telegram_client)
    for mod_name in ("agent.bot", "agent.handler", "agent.sheet_client", "agent.commands"):
        monkeypatch.setitem(sys.modules, mod_name, None)

    clock = FakeClock(DEFAULT_NOW)
    settings = VoiceSettings.load()
    assert settings.TELEGRAM_BOT_TOKEN is None

    expected_principal = Principal(provider="test", subject="u1", chat_id=None, scopes=frozenset({VOICE}))
    provider = TestProvider()
    directory = TestDirectory([expected_principal])
    authorizer = TestAuthorizer(["u1"])
    fake_transcriber = FakeTranscriber(default_text="remada curvada 70 por 8, RIR 2")

    app = build_voice_service(
        settings,
        transcriber=fake_transcriber,
        sign_in=[provider],
        directory=directory,
        authorizer=authorizer,
        clock=clock,
    )

    with TestClient(app) as client:
        # Non-Telegram sign_in replaces defaults completely: tg_link is rejected as unknown kind (400).
        tg_attempt = client.post(
            SESSIONS_PATH,
            json={"v": 1, "kind": "tg_link", "credential": "anything"},
            headers={"Origin": SYNTHETIC_ORIGIN},
        )
        assert tg_attempt.status_code == 400
        assert tg_attempt.json()["error"]["code"] == "bad_request"

        # Exchange with kind="test" issues session for Principal(provider="test", subject="u1", chat_id=None).
        exchange_resp = client.post(
            SESSIONS_PATH,
            json={"v": 1, "kind": "test", "credential": "u1"},
            headers={"Origin": SYNTHETIC_ORIGIN},
        )
        assert exchange_resp.status_code == 200
        session_payload = exchange_resp.json()
        expected_ref = directory.ref(expected_principal)
        assert session_payload["ref"] == expected_ref
        assert session_payload["scopes"] == [VOICE]

        resolved = directory.resolve("test", session_payload["ref"])
        assert resolved == expected_principal
        assert resolved is not None and resolved.chat_id is None

        idem_key = "fedcba9876543210fedcba9876543210"
        tx_resp = client.post(
            TRANSCRIPTIONS_PATH,
            content=_audio_body(2048),
            headers={
                "Origin": SYNTHETIC_ORIGIN,
                "Authorization": f"Bearer {session_payload['session']}",
                "Content-Type": "audio/ogg",
                "Idempotency-Key": idem_key,
            },
        )
        assert tx_resp.status_code == 200
        assert tx_resp.json() == {
            "v": 1,
            "id": idem_key,
            "text": "remada curvada 70 por 8, RIR 2",
        }
        assert len(fake_transcriber.calls) == 1
        assert fake_transcriber.calls[0][1] == "test:u1"


# ---------------------------------------------------------------------------
# 5. CORS (§5.7): 200, 4xx, 500 (including middleware crash), Retry-After, preflight allow/deny
# ---------------------------------------------------------------------------


def _make_cors_app(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    *,
    transcriber: Transcriber | None = None,
    sign_in_error: BaseException | None = None,
) -> tuple[Any, FakeClock]:
    _clear_agent_env(monkeypatch)
    monkeypatch.chdir(tmp_path)
    yaml_file = tmp_path / "settings.yaml"
    yaml_file.write_text("VOICE_RATE_PER_MIN: 2\n", encoding="utf-8")
    monkeypatch.setenv("SETTINGS_FILE", str(yaml_file))
    monkeypatch.setenv("ALLOWED_CHAT_IDS", str(SYNTHETIC_CHAT_ID))
    monkeypatch.setenv("APP_AUTH_SECRET", SYNTHETIC_AUTH_SECRET)
    monkeypatch.setenv("VOICE_ALLOWED_ORIGINS", SYNTHETIC_ORIGIN)
    monkeypatch.setenv("TRANSCRIBE_API_KEY", SYNTHETIC_TRANSCRIBE_KEY)

    clock = FakeClock(DEFAULT_NOW)
    settings = VoiceSettings.load()
    app = build_voice_service(
        settings,
        transcriber=transcriber or FakeTranscriber(),
        sign_in=[TestProvider(error=sign_in_error)],
        directory=TestDirectory(),
        authorizer=TestAuthorizer(),
        clock=clock,
    )
    return app, clock


def test_cors_headers_present_on_200_4xx_rate_limit_and_500(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    boom = RuntimeError("unexpected crash inside transcriber")
    fake_tx = FakeTranscriber(steps=[boom])
    app, _clock = _make_cors_app(monkeypatch, tmp_path, transcriber=fake_tx)

    with TestClient(app, raise_server_exceptions=False) as client:
        # 1. 200 on session exchange
        ok_sess = client.post(
            SESSIONS_PATH,
            json={"v": 1, "kind": "test", "credential": "u1"},
            headers={"Origin": SYNTHETIC_ORIGIN},
        )
        assert ok_sess.status_code == 200
        assert ok_sess.headers.get("access-control-allow-origin") == SYNTHETIC_ORIGIN
        assert "Retry-After" in ok_sess.headers.get("access-control-expose-headers", "")
        token = ok_sess.json()["session"]

        # 2. 401 unauthenticated error
        err_401 = client.post(
            TRANSCRIPTIONS_PATH,
            content=_audio_body(2048),
            headers={"Origin": SYNTHETIC_ORIGIN},
        )
        assert err_401.status_code == 401
        assert err_401.headers.get("access-control-allow-origin") == SYNTHETIC_ORIGIN
        assert "Retry-After" in err_401.headers.get("access-control-expose-headers", "")

        # 3. 500 unhandled exception inside transcriber -> JSON 500 WITH CORS headers
        err_500 = client.post(
            TRANSCRIPTIONS_PATH,
            content=_audio_body(2048),
            headers={
                "Origin": SYNTHETIC_ORIGIN,
                "Authorization": f"Bearer {token}",
                "Content-Type": "audio/webm",
                "Idempotency-Key": "11111111111111111111111111111111",
            },
        )
        assert err_500.status_code == 500
        assert err_500.json()["error"]["code"] == "internal"
        assert err_500.headers.get("access-control-allow-origin") == SYNTHETIC_ORIGIN
        assert "Retry-After" in err_500.headers.get("access-control-expose-headers", "")

        # 4. 200 on second transcription call
        ok_tx = client.post(
            TRANSCRIPTIONS_PATH,
            content=_audio_body(2048),
            headers={
                "Origin": SYNTHETIC_ORIGIN,
                "Authorization": f"Bearer {token}",
                "Content-Type": "audio/webm",
                "Idempotency-Key": "22222222222222222222222222222222",
            },
        )
        assert ok_tx.status_code == 200
        assert ok_tx.headers.get("access-control-allow-origin") == SYNTHETIC_ORIGIN

        # 5. 429 rate limit carries Retry-After AND exposes it via CORS
        err_429 = client.post(
            TRANSCRIPTIONS_PATH,
            content=_audio_body(2048),
            headers={
                "Origin": SYNTHETIC_ORIGIN,
                "Authorization": f"Bearer {token}",
                "Content-Type": "audio/webm",
                "Idempotency-Key": "33333333333333333333333333333333",
            },
        )
        assert err_429.status_code == 429
        assert int(err_429.headers["retry-after"]) >= 1
        assert err_429.headers.get("access-control-allow-origin") == SYNTHETIC_ORIGIN
        assert "Retry-After" in err_429.headers.get("access-control-expose-headers", "")


def test_cors_preserved_even_when_route_raises_past_handler_into_inner_error_middleware(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app, _clock = _make_cors_app(monkeypatch, tmp_path, sign_in_error=RuntimeError("boom in sign-in"))

    # Also mount a synthetic route that raises directly without VoiceApi's try/except to test
    # _JsonServerErrorMiddleware sitting inside CORSMiddleware.
    async def exploding_route(_request: Request) -> None:
        raise RuntimeError(f"raw route crash {TEXT_SENTINEL}")

    app.router.add_route("/v1/boom", exploding_route, methods=["POST"])

    with TestClient(app, raise_server_exceptions=False) as client:
        sess_500 = client.post(
            SESSIONS_PATH,
            json={"v": 1, "kind": "test", "credential": "u1"},
            headers={"Origin": SYNTHETIC_ORIGIN},
        )
        assert sess_500.status_code == 500
        assert sess_500.headers.get("access-control-allow-origin") == SYNTHETIC_ORIGIN
        assert sess_500.json()["error"]["code"] == "internal"

        raw_500 = client.post("/v1/boom", headers={"Origin": SYNTHETIC_ORIGIN})
        assert raw_500.status_code == 500
        assert raw_500.headers.get("access-control-allow-origin") == SYNTHETIC_ORIGIN
        assert "Retry-After" in raw_500.headers.get("access-control-expose-headers", "")
        assert raw_500.json() == {
            "v": 1,
            "error": {
                "code": "internal",
                "message": "Erro interno ao processar a solicitação. Tente de novo.",
                "retry": True,
            },
        }


@pytest.mark.parametrize("path", [SESSIONS_PATH, TRANSCRIPTIONS_PATH])
def test_cors_preflight_allows_configured_origin_and_rejects_disallowed_origin(
    path: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    app, _clock = _make_cors_app(monkeypatch, tmp_path)

    with TestClient(app) as client:
        allowed = client.options(
            path,
            headers={
                "Origin": SYNTHETIC_ORIGIN,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": (
                    "Authorization, Content-Type, Idempotency-Key, X-Audio-Duration-Ms"
                ),
            },
        )
        assert allowed.status_code == 200
        assert allowed.headers.get("access-control-allow-origin") == SYNTHETIC_ORIGIN
        assert allowed.headers.get("access-control-max-age") == "600"
        allow_headers = allowed.headers.get("access-control-allow-headers", "").lower()
        for expected in ("authorization", "content-type", "idempotency-key", "x-audio-duration-ms"):
            assert expected in allow_headers

        denied = client.options(
            path,
            headers={
                "Origin": "https://evil.example.test",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "Authorization, Content-Type",
            },
        )
        assert denied.status_code == 400
        assert "access-control-allow-origin" not in denied.headers


# ---------------------------------------------------------------------------
# 6. §10.3 Sentinel privacy & safe logging tests for both routes
# ---------------------------------------------------------------------------


class _SentinelResponse:
    text = TEXT_SENTINEL
    content = AUDIO_SENTINEL

    def json(self) -> dict[str, str]:
        return {"leak": TEXT_SENTINEL, "audio": AUDIO_SENTINEL_B64}


class _AttributeOnlySentinelError(Exception):
    """Carries sentinels exclusively in attributes (§10.3): .code, .status_code, .body, etc."""

    def __init__(self) -> None:
        super().__init__("clean outer text")
        self.code = f"code-{TEXT_SENTINEL}"
        self.status_code = f"status-{TEXT_SENTINEL}"
        self.body = {"transcript": TEXT_SENTINEL, "audio": AUDIO_SENTINEL_B64}
        self.message = f"msg-{TEXT_SENTINEL}"
        self.llm_provider = f"prov-{TEXT_SENTINEL}"
        self.response = _SentinelResponse()


def _chained_sentinel_error() -> RuntimeError:
    inner = ValueError(
        f"inner {TEXT_SENTINEL} {AUDIO_SENTINEL.decode('ascii')} {AUDIO_SENTINEL_B64}",
        AUDIO_SENTINEL,
    )
    outer = RuntimeError(
        f"outer {TEXT_SENTINEL} {AUDIO_SENTINEL_B64}",
        TEXT_SENTINEL,
    )
    outer.__cause__ = inner
    return outer


def _dynamic_sentinel_error() -> Exception:
    cls = type(f"Dynamic_{TEXT_SENTINEL}", (Exception,), {})
    return cls(f"dynamic body {TEXT_SENTINEL} {AUDIO_SENTINEL_B64}")


class _RecordCollector(logging.Handler):
    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.records: list[logging.LogRecord] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.records.append(record)


def _assert_zero_sentinels(
    records: list[logging.LogRecord],
    formatted_stream: str,
    stdout_text: str,
    stderr_text: str,
    forbidden_strings: list[str],
) -> None:
    for needle in forbidden_strings:
        assert needle, "sentinel needle must be non-empty"
        assert needle not in formatted_stream, f"sentinel {needle!r} leaked into formatted log stream"
        assert needle not in stdout_text, f"sentinel {needle!r} leaked into stdout"
        assert needle not in stderr_text, f"sentinel {needle!r} leaked into stderr"

    for rec in records:
        msg = rec.getMessage()
        args_repr = repr(rec.args)
        exc_text = rec.exc_text or ""
        stack_info = rec.stack_info or ""
        assert rec.exc_info is None, f"record {rec.name} retained exc_info: {rec.exc_info!r}"
        for needle in forbidden_strings:
            assert needle not in msg, f"sentinel {needle!r} leaked in record.getMessage()"
            assert needle not in args_repr, f"sentinel {needle!r} leaked in repr(record.args)"
            assert needle not in exc_text, f"sentinel {needle!r} leaked in record.exc_text"
            assert needle not in stack_info, f"sentinel {needle!r} leaked in record.stack_info"


def test_section_10_3_sentinels_never_appear_in_logs_streams_stdout_or_stderr_across_both_routes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _clear_agent_env(monkeypatch)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(logs, "_SECRETS", set())
    configure_voice_logging()

    yaml_file = tmp_path / "settings.yaml"
    yaml_file.write_text("VOICE_RATE_PER_MIN: 50\nEXCHANGE_RATE_PER_MIN: 50\n", encoding="utf-8")
    monkeypatch.setenv("SETTINGS_FILE", str(yaml_file))
    monkeypatch.setenv("ALLOWED_CHAT_IDS", str(SYNTHETIC_CHAT_ID))
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", SYNTHETIC_BOT_TOKEN)
    monkeypatch.setenv("APP_AUTH_SECRET", SYNTHETIC_AUTH_SECRET)
    monkeypatch.setenv("VOICE_ALLOWED_ORIGINS", SYNTHETIC_ORIGIN)
    monkeypatch.setenv("TRANSCRIBE_API_KEY", SYNTHETIC_TRANSCRIBE_KEY)

    root = logging.getLogger()
    saved_handlers = list(root.handlers)
    saved_level = root.level

    stream = io.StringIO()
    stream_handler = logging.StreamHandler(stream)
    stream_handler.setFormatter(logging.Formatter(SERVICE_LOG_FORMAT))
    collector = _RecordCollector()
    root.handlers = [stream_handler, collector]
    root.setLevel(logging.DEBUG)
    for lib_name in ("LiteLLM", "google_adk", "google_adk.models"):
        lib_logger = logging.getLogger(lib_name)
        monkeypatch.setattr(lib_logger, "propagate", True)
        monkeypatch.setattr(lib_logger, "level", logging.INFO)

    try:
        clock = FakeClock(DEFAULT_NOW)
        settings = VoiceSettings.load()

        link_code = make_link_code(
            secret=SYNTHETIC_AUTH_SECRET,
            chat_id=SYNTHETIC_CHAT_ID,
            allowed_chats=(SYNTHETIC_CHAT_ID,),
            now=clock(),
        )
        init_data = make_init_data(
            bot_token=SYNTHETIC_BOT_TOKEN,
            user_id=SYNTHETIC_CHAT_ID,
            now=clock(),
            extra_pairs=[("start_param", TEXT_SENTINEL)],
        )
        init_hash = init_data.split("hash=", 1)[1]

        timeout_err = litellm.Timeout(
            message=f"timed out reading {TEXT_SENTINEL} {AUDIO_SENTINEL_B64}",
            model="gemini/gemini-3.8-flash",
            llm_provider="gemini",
        )

        # 1) Default Telegram providers + real Transcriber over FakeLiteLLMClient
        fake_llm = FakeLiteLLMClient(
            [
                _litellm_reply(TEXT_SENTINEL),
                timeout_err,
                _chained_sentinel_error(),
            ]
        )
        budget = MemoryBudget(
            principal_daily=settings.VOICE_DAILY_TOKENS,
            global_daily=settings.VOICE_GLOBAL_DAILY_TOKENS,
            timezone=settings.TIMEZONE,
        )
        real_transcriber = Transcriber(settings, budget, client=fake_llm, clock=clock)
        tg_app = build_voice_service(settings, transcriber=real_transcriber, clock=clock)

        bad_bearer_sentinel = "Bearer-Sentinel-Token-998877"

        with TestClient(tg_app, raise_server_exceptions=False) as client:
            r_link = client.post(
                SESSIONS_PATH,
                json={"v": 1, "kind": "tg_link", "credential": link_code},
                headers={"Origin": SYNTHETIC_ORIGIN},
            )
            assert r_link.status_code == 200
            tg_session_1 = r_link.json()["session"]

            r_init = client.post(
                SESSIONS_PATH,
                json={"v": 1, "kind": "tg_init_data", "credential": init_data},
                headers={"Origin": SYNTHETIC_ORIGIN},
            )
            assert r_init.status_code == 200
            tg_session_2 = r_init.json()["session"]

            r_unauth = client.post(
                TRANSCRIPTIONS_PATH,
                content=_audio_body(2048),
                headers={
                    "Origin": SYNTHETIC_ORIGIN,
                    "Authorization": f"Bearer {bad_bearer_sentinel}",
                    "Content-Type": "audio/ogg",
                    "Idempotency-Key": IDEMPOTENCY_SENTINEL,
                },
            )
            assert r_unauth.status_code == 401

            r_ok = client.post(
                TRANSCRIPTIONS_PATH,
                content=_audio_body(2048),
                headers={
                    "Origin": SYNTHETIC_ORIGIN,
                    "Authorization": f"Bearer {tg_session_1}",
                    "Content-Type": "audio/ogg",
                    "Idempotency-Key": IDEMPOTENCY_SENTINEL,
                },
            )
            assert r_ok.status_code == 200
            assert r_ok.json()["text"] == TEXT_SENTINEL

            r_timeout = client.post(
                TRANSCRIPTIONS_PATH,
                content=_audio_body(2048),
                headers={
                    "Origin": SYNTHETIC_ORIGIN,
                    "Authorization": f"Bearer {tg_session_2}",
                    "Content-Type": "audio/ogg",
                    "Idempotency-Key": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                },
            )
            assert r_timeout.status_code == 504

            r_prov_err = client.post(
                TRANSCRIPTIONS_PATH,
                content=_audio_body(2048),
                headers={
                    "Origin": SYNTHETIC_ORIGIN,
                    "Authorization": f"Bearer {tg_session_2}",
                    "Content-Type": "audio/ogg",
                    "Idempotency-Key": "cccccccccccccccccccccccccccccccc",
                },
            )
            assert r_prov_err.status_code == 502

        # 2) Direct exceptions escaping FakeTranscriber and TestProvider + library loggers
        def _library_noise_transcript(_audio: Any, _principal_key: str) -> Transcript:
            litellm_log = logging.getLogger("LiteLLM")
            adk_log = logging.getLogger("google_adk.models")
            litellm_log.warning("raw prompt %s audio=%s", TEXT_SENTINEL, AUDIO_SENTINEL_B64)
            try:
                raise _chained_sentinel_error()
            except RuntimeError:
                adk_log.error(
                    "adk failure %s %s",
                    TEXT_SENTINEL,
                    AUDIO_SENTINEL_B64,
                    exc_info=True,
                )
            return Transcript(
                text=TEXT_SENTINEL,
                model="gemini/gemini-3.8-flash",
                usage=Usage(prompt_tokens=100, completion_tokens=10, audio_tokens=64),
                fallback=False,
            )

        custom_principal = make_test_principal(RAW_SUBJECT_SENTINEL)
        scripted_tx = FakeTranscriber(
            steps=[
                _library_noise_transcript,
                _AttributeOnlySentinelError(),
                _chained_sentinel_error(),
                _dynamic_sentinel_error(),
            ]
        )
        custom_app = build_voice_service(
            settings,
            transcriber=scripted_tx,
            sign_in=[TestProvider(valid={"cred-ok": RAW_SUBJECT_SENTINEL})],
            directory=TestDirectory([custom_principal]),
            authorizer=TestAuthorizer([RAW_SUBJECT_SENTINEL]),
            clock=clock,
        )
        with TestClient(custom_app, raise_server_exceptions=False) as client:
            s_ok = client.post(
                SESSIONS_PATH,
                json={"v": 1, "kind": "test", "credential": "cred-ok"},
                headers={"Origin": SYNTHETIC_ORIGIN},
            )
            assert s_ok.status_code == 200
            custom_session = s_ok.json()["session"]

            for idx, expected_status in enumerate((200, 500, 500, 500)):
                resp = client.post(
                    TRANSCRIPTIONS_PATH,
                    content=_audio_body(2048),
                    headers={
                        "Origin": SYNTHETIC_ORIGIN,
                        "Authorization": f"Bearer {custom_session}",
                        "Content-Type": "audio/webm",
                        "Idempotency-Key": f"{idx:032x}",
                    },
                )
                assert resp.status_code == expected_status

        # Also provoke AttributeOnly, Chained and Dynamic class errors on POST /v1/auth/sessions
        for session_err in (
            _AttributeOnlySentinelError(),
            _chained_sentinel_error(),
            _dynamic_sentinel_error(),
        ):
            err_app = build_voice_service(
                settings,
                transcriber=FakeTranscriber(),
                sign_in=[TestProvider(error=session_err)],
                directory=TestDirectory(),
                authorizer=TestAuthorizer(),
                clock=clock,
            )
            with TestClient(err_app, raise_server_exceptions=False) as client:
                er = client.post(
                    SESSIONS_PATH,
                    json={"v": 1, "kind": "test", "credential": f"cred-{TEXT_SENTINEL}"},
                    headers={"Origin": SYNTHETIC_ORIGIN},
                )
                assert er.status_code == 500

        # Also provoke Handler.handleError directly with a broken format string carrying sentinels
        bad_record = logging.LogRecord(
            name="agent.voice_api",
            level=logging.ERROR,
            pathname=__file__,
            lineno=1,
            msg="broken %d format " + TEXT_SENTINEL,
            args=(TEXT_SENTINEL, AUDIO_SENTINEL_B64),
            exc_info=None,
        )
        stream_handler.handleError(bad_record)

        formatted_output = stream.getvalue()
        assert "status=other code=other" in formatted_output
        assert "cause=Exception" in formatted_output
        assert "LiteLLM WARNING record (content omitted)" in formatted_output
        assert "google_adk.models ERROR record (content omitted)" in formatted_output

        captured_io = capsys.readouterr()
        forbidden = [
            AUDIO_SENTINEL.decode("ascii"),
            AUDIO_SENTINEL_B64,
            AUDIO_SENTINEL_B64_STRIPPED,
            TEXT_SENTINEL,
            TEXT_SENTINEL.replace("-", "_"),
            IDEMPOTENCY_SENTINEL,
            RAW_SUBJECT_SENTINEL,
            str(SYNTHETIC_CHAT_ID),
            SYNTHETIC_AUTH_SECRET,
            SYNTHETIC_TRANSCRIBE_KEY,
            SYNTHETIC_BOT_TOKEN,
            link_code,
            init_data,
            init_hash,
            tg_session_1,
            tg_session_2,
            custom_session,
            bad_bearer_sentinel,
            "cred-ok",
        ]
        _assert_zero_sentinels(
            collector.records,
            formatted_output,
            captured_io.out,
            captured_io.err,
            forbidden,
        )
    finally:
        root.handlers = saved_handlers
        root.setLevel(saved_level)
