"""HTTP contract tests for `agent.voice_api` (spec §3.5, §5.2–5.6, §6.7).

Covers every row of §5.3 and §6.7, strict §5.4 processing order (proving `receive` and the
transcriber are untouched on early rejections), chunked streaming and `Content-Length` mismatches,
`usage=None` vs `implied_audio_tokens` boundary checks, idempotency owner/waiter semantics, and
rate/concurrency limits.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Mapping
from typing import Any

import httpx
import pytest
from starlette.applications import Starlette
from starlette.types import Message, Scope

from agent.transcribe import (
    MIN_BODY_BYTES,
    TRANSCRIBE_PROMPT_TOKENS,
    TranscribeError,
    Transcript,
    Usage,
)
from agent.voice_asgi import build_voice_service
from agent.voice_settings import VoiceSettings

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
)

pytestmark = pytest.mark.unit

VALID_KEY = "0123456789abcdef0123456789abcdef"
SECOND_KEY = "fedcba9876543210fedcba9876543210"
AUDIO_BODY = b"OggS" + (b"\x5a" * (MIN_BODY_BYTES + 256))
OTHER_AUDIO_BODY = b"OggS" + (b"\xa5" * (MIN_BODY_BYTES + 256))


def make_voice_settings(**overrides: Any) -> VoiceSettings:
    defaults: dict[str, Any] = {
        "_env_file": None,
        "VOICE_API_ENABLED": True,
        "TIMEZONE": "America/Sao_Paulo",
        "ALLOWED_CHAT_IDS": frozenset({SYNTHETIC_CHAT_ID}),
        "APP_AUTH_SECRET": SYNTHETIC_AUTH_SECRET,
        "TRANSCRIBE_MODEL": "gemini/gemini-3.8-flash",
        "TRANSCRIBE_API_KEY": SYNTHETIC_TRANSCRIBE_KEY,
        "VOICE_ALLOWED_ORIGINS": (SYNTHETIC_ORIGIN,),
    }
    defaults.update(overrides)
    return VoiceSettings(**defaults)


def async_client(app: Starlette) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="https://voice.example.test",
    )


async def issue_session(
    client: httpx.AsyncClient,
    *,
    chat_id: int = SYNTHETIC_CHAT_ID,
    clock: FakeClock | None = None,
) -> str:
    now = clock() if clock is not None else DEFAULT_NOW
    code = make_link_code(chat_id=chat_id, allowed_chats=(chat_id,), now=now)
    resp = await client.post(
        "/v1/auth/sessions",
        json={"v": 1, "kind": "tg_link", "credential": code},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["session"]


async def raw_asgi_call(
    app: Starlette,
    *,
    method: str,
    path: str,
    headers: Mapping[str, str],
    chunks: list[bytes] | None = None,
    disconnect: bool = False,
) -> tuple[int, dict[str, str], bytes, int]:
    """Calls `app` directly over ASGI and counts how many times `receive()` was awaited."""
    receive_calls = 0
    pending = list(chunks or [b""])

    async def receive() -> Message:
        nonlocal receive_calls
        receive_calls += 1
        if disconnect:
            return {"type": "http.disconnect"}
        if not pending:
            return {"type": "http.request", "body": b"", "more_body": False}
        body = pending.pop(0)
        return {"type": "http.request", "body": body, "more_body": bool(pending)}

    sent_status = 0
    sent_headers: dict[str, str] = {}
    sent_body = bytearray()

    async def send(message: Message) -> None:
        nonlocal sent_status
        if message["type"] == "http.response.start":
            sent_status = message["status"]
            for raw_k, raw_v in message.get("headers", []):
                sent_headers[raw_k.decode("latin1").lower()] = raw_v.decode("latin1")
        elif message["type"] == "http.response.body":
            sent_body.extend(message.get("body", b""))

    scope: Scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": method,
        "scheme": "https",
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": b"",
        "headers": [(k.lower().encode("latin1"), v.encode("latin1")) for k, v in headers.items()],
        "client": ("127.0.0.1", 50000),
        "server": ("voice.example.test", 443),
    }
    await app(scope, receive, send)
    return sent_status, sent_headers, bytes(sent_body), receive_calls


def assert_error_envelope(
    resp: httpx.Response,
    *,
    status: int,
    code: str,
    retry: bool,
) -> dict[str, Any]:
    assert resp.status_code == status, resp.text
    assert resp.headers.get("cache-control") == "no-store"
    assert resp.headers.get("content-type", "").startswith("application/json")
    data = resp.json()
    assert set(data) == {"v", "error"}
    assert data["v"] == 1
    err = data["error"]
    assert set(err) == {"code", "message", "retry"}
    assert err["code"] == code
    assert err["retry"] is retry
    assert isinstance(err["message"], str) and len(err["message"]) >= 5
    return data


# --- POST /v1/auth/sessions (§6.7) -----------------------------------------------------------------


async def test_exchange_tg_link_succeeds_and_returns_opaque_ref():
    clock = FakeClock()
    settings = make_voice_settings()
    app = build_voice_service(settings, transcriber=FakeTranscriber(), clock=clock)

    async with async_client(app) as client:
        code = make_link_code(now=clock())
        resp = await client.post(
            "/v1/auth/sessions",
            json={"v": 1, "kind": "tg_link", "credential": code},
        )

    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "no-store"
    body = resp.json()
    assert set(body) == {"v", "session", "expires_at", "scopes", "ref"}
    assert body["v"] == 1
    assert body["session"].startswith("s1.")
    assert body["expires_at"] == int(clock().timestamp()) + settings.APP_SESSION_TTL_S
    assert body["scopes"] == ["voice"]
    assert len(body["ref"]) == 22
    assert str(SYNTHETIC_CHAT_ID) not in body["ref"]
    assert str(SYNTHETIC_CHAT_ID) not in body["session"]


async def test_exchange_tg_init_data_requires_bot_token_and_succeeds_when_configured():
    clock = FakeClock()
    init_data = make_init_data(now=clock())

    app_without_token = build_voice_service(
        make_voice_settings(TELEGRAM_BOT_TOKEN=None),
        transcriber=FakeTranscriber(),
        clock=clock,
    )
    async with async_client(app_without_token) as client:
        refused = await client.post(
            "/v1/auth/sessions",
            json={"v": 1, "kind": "tg_init_data", "credential": init_data},
        )
    assert_error_envelope(refused, status=400, code="bad_request", retry=False)

    app_with_token = build_voice_service(
        make_voice_settings(TELEGRAM_BOT_TOKEN=SYNTHETIC_BOT_TOKEN),
        transcriber=FakeTranscriber(),
        clock=clock,
    )
    async with async_client(app_with_token) as client:
        ok = await client.post(
            "/v1/auth/sessions",
            json={"v": 1, "kind": "tg_init_data", "credential": init_data},
        )
    assert ok.status_code == 200
    assert ok.json()["scopes"] == ["voice"]


@pytest.mark.parametrize(
    "raw_payload",
    [
        b"not-json",
        b'["array"]',
        b'{"v": 2, "kind": "tg_link", "credential": "x"}',
        b'{"v": true, "kind": "tg_link", "credential": "x"}',
        b'{"v": "1", "kind": "tg_link", "credential": "x"}',
        b'{"v": 1, "kind": "unknown_kind", "credential": "x"}',
        b'{"v": 1, "kind": "tg_link", "credential": ""}',
        b'{"v": 1, "kind": "tg_link", "credential": "x", "extra": 1}',
        b'{"v": 1, "v": 1, "kind": "tg_link", "credential": "x"}',
    ],
)
async def test_exchange_bad_request_shapes(raw_payload: bytes):
    app = build_voice_service(make_voice_settings(), transcriber=FakeTranscriber())
    async with async_client(app) as client:
        resp = await client.post(
            "/v1/auth/sessions",
            content=raw_payload,
            headers={"Content-Type": "application/json"},
        )
    assert_error_envelope(resp, status=400, code="bad_request", retry=False)


async def test_exchange_rejects_wrong_content_type_oversized_body_and_length_mismatch():
    app = build_voice_service(make_voice_settings(), transcriber=FakeTranscriber())
    async with async_client(app) as client:
        wrong_ct = await client.post(
            "/v1/auth/sessions",
            content=b'{"v":1,"kind":"tg_link","credential":"x"}',
            headers={"Content-Type": "text/plain"},
        )
        assert_error_envelope(wrong_ct, status=400, code="bad_request", retry=False)

    # Oversized Content-Length (> 4096) rejected before reading stream.
    status, _, _, reads = await raw_asgi_call(
        app,
        method="POST",
        path="/v1/auth/sessions",
        headers={"content-type": "application/json", "content-length": "5000"},
        chunks=[b"x" * 5000],
    )
    assert status == 400
    assert reads == 0

    # Chunked body > 4096 bytes stopped immediately.
    status_chunked, _, _, reads_chunked = await raw_asgi_call(
        app,
        method="POST",
        path="/v1/auth/sessions",
        headers={"content-type": "application/json"},
        chunks=[b"a" * 3000, b"b" * 2000, b"c" * 2000],
    )
    assert status_chunked == 400
    assert reads_chunked == 2

    # Content-Length mismatch -> 400.
    status_mismatch, _, _, _ = await raw_asgi_call(
        app,
        method="POST",
        path="/v1/auth/sessions",
        headers={"content-type": "application/json", "content-length": "100"},
        chunks=[b'{"v":1,"kind":"tg_link","credential":"abc"}'],
    )
    assert status_mismatch == 400


async def test_exchange_auth_errors_unauthenticated_expired_used_and_forbidden():
    clock = FakeClock()
    settings = make_voice_settings(TELEGRAM_BOT_TOKEN=SYNTHETIC_BOT_TOKEN)
    app = build_voice_service(settings, transcriber=FakeTranscriber(), clock=clock)

    async with async_client(app) as client:
        # 401 unauthenticated (bad MAC)
        bad_code = make_link_code(now=clock())[:-4] + "AAAA"
        r_unauth = await client.post(
            "/v1/auth/sessions",
            json={"v": 1, "kind": "tg_link", "credential": bad_code},
        )
        assert_error_envelope(r_unauth, status=401, code="unauthenticated", retry=False)

        # 401 credential_used (second redemption of a one-time code)
        good_code = make_link_code(now=clock())
        first = await client.post(
            "/v1/auth/sessions",
            json={"v": 1, "kind": "tg_link", "credential": good_code},
        )
        assert first.status_code == 200
        second = await client.post(
            "/v1/auth/sessions",
            json={"v": 1, "kind": "tg_link", "credential": good_code},
        )
        assert_error_envelope(second, status=401, code="credential_used", retry=False)

        # 403 forbidden (chat outside ALLOWED_CHAT_IDS on tg_init_data)
        outsider_init = make_init_data(user_id=OTHER_CHAT_ID, now=clock())
        r_forbidden = await client.post(
            "/v1/auth/sessions",
            json={"v": 1, "kind": "tg_init_data", "credential": outsider_init},
        )
        assert_error_envelope(r_forbidden, status=403, code="forbidden", retry=False)

        # 401 auth_expired (expired code)
        expiring_code = make_link_code(now=clock(), ttl_s=10)
        clock.advance(11)
        r_expired = await client.post(
            "/v1/auth/sessions",
            json={"v": 1, "kind": "tg_link", "credential": expiring_code},
        )
        assert_error_envelope(r_expired, status=401, code="auth_expired", retry=False)


async def test_exchange_rate_limits_disabled_and_internal():
    clock = FakeClock()

    # Per-process minute limit (2/min)
    app_proc = build_voice_service(
        make_voice_settings(EXCHANGE_RATE_PER_MIN=2, EXCHANGE_RATE_PER_DAY=10),
        transcriber=FakeTranscriber(),
        clock=clock,
    )
    async with async_client(app_proc) as client:
        for _ in range(2):
            c = make_link_code(now=clock())
            ok = await client.post("/v1/auth/sessions", json={"v": 1, "kind": "tg_link", "credential": c})
            assert ok.status_code == 200
        third = await client.post(
            "/v1/auth/sessions",
            json={"v": 1, "kind": "tg_link", "credential": make_link_code(now=clock())},
        )
        assert_error_envelope(third, status=429, code="rate_limited", retry=True)
        assert int(third.headers["retry-after"]) >= 1

    # Per-principal daily limit (1/day)
    app_prin = build_voice_service(
        make_voice_settings(EXCHANGE_RATE_PER_MIN=30, EXCHANGE_RATE_PER_DAY=1),
        transcriber=FakeTranscriber(),
        clock=clock,
    )
    async with async_client(app_prin) as client:
        first = await client.post(
            "/v1/auth/sessions",
            json={"v": 1, "kind": "tg_link", "credential": make_link_code(now=clock())},
        )
        assert first.status_code == 200
        second = await client.post(
            "/v1/auth/sessions",
            json={"v": 1, "kind": "tg_link", "credential": make_link_code(now=clock())},
        )
        assert_error_envelope(second, status=429, code="rate_limited", retry=True)
        assert int(second.headers["retry-after"]) >= 1

    # 503 disabled
    app_disabled = build_voice_service(
        make_voice_settings(VOICE_API_ENABLED=False, APP_AUTH_SECRET=None, VOICE_ALLOWED_ORIGINS=()),
    )
    async with async_client(app_disabled) as client:
        r_dis = await client.post(
            "/v1/auth/sessions",
            json={"v": 1, "kind": "tg_link", "credential": "anything"},
        )
        assert_error_envelope(r_dis, status=503, code="disabled", retry=False)

    # 500 internal
    app_boom = build_voice_service(
        make_voice_settings(),
        sign_in=[TestProvider(error=RuntimeError("secret internal detail"))],
        directory=TestDirectory(),
        authorizer=TestAuthorizer(),
        transcriber=FakeTranscriber(),
        clock=clock,
    )
    async with async_client(app_boom) as client:
        r_500 = await client.post(
            "/v1/auth/sessions",
            json={"v": 1, "kind": "test", "credential": "u1"},
        )
        data = assert_error_envelope(r_500, status=500, code="internal", retry=True)
        assert "secret internal detail" not in str(data)


# --- POST /v1/voice/transcriptions (§5.3, §5.4, §3.5, §5.5) ----------------------------------------


@pytest.mark.parametrize(
    ("mime", "expected_base"),
    [
        ("audio/webm;codecs=opus", "audio/webm"),
        ("audio/ogg; codecs=opus", "audio/ogg"),
        ("audio/opus", "audio/opus"),
        ("audio/mp4", "audio/mp4"),
        ("audio/m4a", "audio/m4a"),
        ("audio/x-m4a", "audio/x-m4a"),
        ("audio/aac", "audio/aac"),
        ("audio/mpeg", "audio/mpeg"),
        ("audio/mp3", "audio/mp3"),
        ("audio/wav", "audio/wav"),
        ("audio/x-wav", "audio/x-wav"),
        ("audio/wave", "audio/wave"),
    ],
)
async def test_transcriptions_accept_every_supported_mime(mime: str, expected_base: str):
    clock = FakeClock()
    fake = FakeTranscriber(default_text="agachamento 100 por 6, RIR 2")
    app = build_voice_service(make_voice_settings(), transcriber=fake, clock=clock)

    async with async_client(app) as client:
        session = await issue_session(client, clock=clock)
        resp = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers={
                "Authorization": f"Bearer {session}",
                "Content-Type": mime,
                "Idempotency-Key": VALID_KEY,
                "X-Audio-Duration-Ms": "12500",
            },
        )

    assert resp.status_code == 200
    assert resp.headers["cache-control"] == "no-store"
    assert resp.json() == {"v": 1, "id": VALID_KEY, "text": "agachamento 100 por 6, RIR 2"}
    assert len(fake.calls) == 1
    sent_audio, sent_principal, _ = fake.calls[0]
    assert sent_audio.mime_type == expected_base
    assert sent_audio.trusted_seconds is None
    assert sent_principal == f"telegram:{SYNTHETIC_CHAT_ID}"


async def test_voice_route_never_accepts_a_link_code_or_init_data_as_bearer():
    clock = FakeClock()
    fake = FakeTranscriber()
    app = build_voice_service(
        make_voice_settings(TELEGRAM_BOT_TOKEN=SYNTHETIC_BOT_TOKEN),
        transcriber=fake,
        clock=clock,
    )
    code = make_link_code(now=clock())
    init_data = make_init_data(now=clock())

    async with async_client(app) as client:
        for credential in (code, init_data):
            resp = await client.post(
                "/v1/voice/transcriptions",
                content=AUDIO_BODY,
                headers={
                    "Authorization": f"Bearer {credential}",
                    "Content-Type": "audio/ogg",
                    "Idempotency-Key": VALID_KEY,
                },
            )
            assert_error_envelope(resp, status=401, code="unauthenticated", retry=False)
    assert fake.calls == []


async def test_strict_section_5_4_order_never_reads_body_or_calls_transcriber_before_all_gates():
    clock = FakeClock()
    fake = FakeTranscriber()
    authorizer = TestAuthorizer(allowed_subjects={"u1", "u2"})
    directory = TestDirectory()
    settings = make_voice_settings(
        VOICE_MAX_BYTES=4096,
        VOICE_MAX_SECONDS=90,
        VOICE_RATE_PER_MIN=2,
        VOICE_MAX_CONCURRENT=1,
    )
    app = build_voice_service(
        settings,
        sign_in=[TestProvider()],
        directory=directory,
        authorizer=authorizer,
        transcriber=fake,
        clock=clock,
    )

    async with async_client(app) as client:
        r_sess = await client.post("/v1/auth/sessions", json={"v": 1, "kind": "test", "credential": "u1"})
        session = r_sess.json()["session"]
        r_sess2 = await client.post("/v1/auth/sessions", json={"v": 1, "kind": "test", "credential": "u2"})
        session_u2 = r_sess2.json()["session"]

    # 1. Unauthenticated request (even with invalid headers & oversized body) -> 401, 0 body reads.
    status, _, _, reads = await raw_asgi_call(
        app,
        method="POST",
        path="/v1/voice/transcriptions",
        headers={
            "content-type": "video/mp4",
            "content-length": "999999",
        },
        chunks=[b"x" * 10000],
    )
    assert status == 401
    assert reads == 0
    assert fake.calls == []

    # 2. Expired session -> 401 auth_expired, 0 body reads.
    clock.advance(settings.APP_SESSION_TTL_S + 1)
    status_exp, _, body_exp, reads_exp = await raw_asgi_call(
        app,
        method="POST",
        path="/v1/voice/transcriptions",
        headers={
            "authorization": f"Bearer {session}",
            "content-type": "audio/ogg",
            "idempotency-key": VALID_KEY,
        },
        chunks=[AUDIO_BODY],
    )
    assert status_exp == 401 and b"auth_expired" in body_exp
    assert reads_exp == 0
    assert fake.calls == []

    # Issue fresh sessions at current clock.
    async with async_client(app) as client:
        session = (
            await client.post("/v1/auth/sessions", json={"v": 1, "kind": "test", "credential": "u1"})
        ).json()["session"]
        session_u2 = (
            await client.post("/v1/auth/sessions", json={"v": 1, "kind": "test", "credential": "u2"})
        ).json()["session"]

    # 3. Forbidden principal -> 403, 0 body reads.
    authorizer.revoke("u2")
    status_forb, _, _, reads_forb = await raw_asgi_call(
        app,
        method="POST",
        path="/v1/voice/transcriptions",
        headers={
            "authorization": f"Bearer {session_u2}",
            "content-type": "audio/ogg",
            "idempotency-key": VALID_KEY,
        },
        chunks=[AUDIO_BODY],
    )
    assert status_forb == 403
    assert reads_forb == 0
    authorizer.grant("u2")

    # 4. Header rejections (415, 400, 413 Content-Length, 422 X-Audio-Duration-Ms) -> 0 body reads!
    # We give a higher rate limit app so we can test all 4 header gates cleanly.
    app_headers = build_voice_service(
        make_voice_settings(VOICE_MAX_BYTES=4096, VOICE_MAX_SECONDS=90, VOICE_RATE_PER_MIN=20),
        sign_in=[TestProvider()],
        directory=directory,
        authorizer=authorizer,
        transcriber=fake,
        clock=clock,
    )
    async with async_client(app_headers) as client:
        s_hdr = (
            await client.post("/v1/auth/sessions", json={"v": 1, "kind": "test", "credential": "u1"})
        ).json()["session"]

    for hdrs, expected_status in [
        (
            {"authorization": f"Bearer {s_hdr}", "content-type": "video/mp4", "idempotency-key": VALID_KEY},
            415,
        ),
        ({"authorization": f"Bearer {s_hdr}", "content-type": "audio/ogg", "idempotency-key": "BAD"}, 400),
        (
            {
                "authorization": f"Bearer {s_hdr}",
                "content-type": "audio/ogg",
                "idempotency-key": VALID_KEY,
                "content-length": "4097",
            },
            413,
        ),
        (
            {
                "authorization": f"Bearer {s_hdr}",
                "content-type": "audio/ogg",
                "idempotency-key": VALID_KEY,
                "x-audio-duration-ms": "90001",
            },
            422,
        ),
    ]:
        st, _, _, rds = await raw_asgi_call(
            app_headers,
            method="POST",
            path="/v1/voice/transcriptions",
            headers=hdrs,
            chunks=[AUDIO_BODY],
        )
        assert st == expected_status
        assert rds == 0
    assert fake.calls == []

    # 5. Per-principal rate limit (2/min on `app`) checked BEFORE headers and BEFORE body read.
    for key in (VALID_KEY, SECOND_KEY):
        st_ok, _, _, _ = await raw_asgi_call(
            app,
            method="POST",
            path="/v1/voice/transcriptions",
            headers={
                "authorization": f"Bearer {session}",
                "content-type": "audio/ogg",
                "idempotency-key": key,
            },
            chunks=[AUDIO_BODY],
        )
        assert st_ok == 200
    assert len(fake.calls) == 2

    # 3rd call in same minute has invalid headers too, yet step 4 (rate limit) fires first -> 429, 0 reads!
    st_rl, hdr_rl, _, rds_rl = await raw_asgi_call(
        app,
        method="POST",
        path="/v1/voice/transcriptions",
        headers={
            "authorization": f"Bearer {session}",
            "content-type": "video/mp4",
        },
        chunks=[AUDIO_BODY],
    )
    assert st_rl == 429
    assert int(hdr_rl["retry-after"]) >= 1
    assert rds_rl == 0
    assert len(fake.calls) == 2


async def test_concurrency_gate_rejects_with_retry_after_2_before_reading_body():
    clock = FakeClock()
    entered = asyncio.Event()
    release = asyncio.Event()

    async def slow_step(_audio: Any, _principal: str) -> Transcript:
        entered.set()
        await release.wait()
        return Transcript("ok", "gemini/gemini-3.8-flash", None, False)

    fake = FakeTranscriber(steps=[slow_step])
    app = build_voice_service(
        make_voice_settings(VOICE_MAX_CONCURRENT=1, VOICE_RATE_PER_MIN=20),
        transcriber=fake,
        clock=clock,
    )

    async with async_client(app) as client:
        session = await issue_session(client, clock=clock)
        first_task = asyncio.create_task(
            client.post(
                "/v1/voice/transcriptions",
                content=AUDIO_BODY,
                headers={
                    "Authorization": f"Bearer {session}",
                    "Content-Type": "audio/ogg",
                    "Idempotency-Key": VALID_KEY,
                },
            )
        )
        await entered.wait()

        # Second concurrent request is rejected at step 6 BEFORE step 7 reads its body!
        st_busy, hdr_busy, _, reads_busy = await raw_asgi_call(
            app,
            method="POST",
            path="/v1/voice/transcriptions",
            headers={
                "authorization": f"Bearer {session}",
                "content-type": "audio/ogg",
                "idempotency-key": SECOND_KEY,
            },
            chunks=[OTHER_AUDIO_BODY],
        )
        assert st_busy == 429
        assert hdr_busy["retry-after"] == "2"
        assert reads_busy == 0

        release.set()
        first_resp = await first_task
        assert first_resp.status_code == 200
    assert len(fake.calls) == 1


async def test_chunked_streaming_accepts_up_to_cap_and_cuts_immediately_above_cap():
    clock = FakeClock()
    fake = FakeTranscriber(default_text="chunked ok")
    app = build_voice_service(
        make_voice_settings(VOICE_MAX_BYTES=2048, VOICE_RATE_PER_MIN=20),
        transcriber=fake,
        clock=clock,
    )

    async with async_client(app) as client:
        session = await issue_session(client, clock=clock)

        async def ok_stream() -> AsyncIterator[bytes]:
            yield b"a" * 1024
            yield b"b" * 1024

        resp_ok = await client.post(
            "/v1/voice/transcriptions",
            content=ok_stream(),
            headers={
                "Authorization": f"Bearer {session}",
                "Content-Type": "audio/ogg",
                "Idempotency-Key": VALID_KEY,
            },
        )
        assert resp_ok.status_code == 200
        assert resp_ok.json()["text"] == "chunked ok"
        assert len(fake.calls) == 1
        assert len(fake.calls[0][0].data) == 2048

        pulled_chunks = 0

        async def oversized_stream() -> AsyncIterator[bytes]:
            nonlocal pulled_chunks
            for _ in range(10):
                pulled_chunks += 1
                yield b"z" * 1000

        resp_big = await client.post(
            "/v1/voice/transcriptions",
            content=oversized_stream(),
            headers={
                "Authorization": f"Bearer {session}",
                "Content-Type": "audio/ogg",
                "Idempotency-Key": SECOND_KEY,
            },
        )
        assert_error_envelope(resp_big, status=413, code="too_large", retry=False)
        # 3rd chunk brings total to 3000 > 2048 -> stops immediately; chunks 4..10 are never pulled!
        assert pulled_chunks == 3
        assert len(fake.calls) == 1


async def test_content_length_mismatch_and_client_disconnect_return_400():
    clock = FakeClock()
    fake = FakeTranscriber()
    app = build_voice_service(
        make_voice_settings(VOICE_MAX_BYTES=10_000, VOICE_RATE_PER_MIN=20),
        transcriber=fake,
        clock=clock,
    )
    async with async_client(app) as client:
        session = await issue_session(client, clock=clock)

    # Declared larger than actual bytes sent -> 400
    st_short, _, _, _ = await raw_asgi_call(
        app,
        method="POST",
        path="/v1/voice/transcriptions",
        headers={
            "authorization": f"Bearer {session}",
            "content-type": "audio/ogg",
            "idempotency-key": VALID_KEY,
            "content-length": str(len(AUDIO_BODY) + 50),
        },
        chunks=[AUDIO_BODY],
    )
    assert st_short == 400

    # Declared smaller than actual bytes sent (still <= VOICE_MAX_BYTES) -> 400
    st_long, _, _, _ = await raw_asgi_call(
        app,
        method="POST",
        path="/v1/voice/transcriptions",
        headers={
            "authorization": f"Bearer {session}",
            "content-type": "audio/ogg",
            "idempotency-key": SECOND_KEY,
            "content-length": str(len(AUDIO_BODY) - 50),
        },
        chunks=[AUDIO_BODY],
    )
    assert st_long == 400

    # ClientDisconnect mid-stream -> 400
    st_disc, _, _, _ = await raw_asgi_call(
        app,
        method="POST",
        path="/v1/voice/transcriptions",
        headers={
            "authorization": f"Bearer {session}",
            "content-type": "audio/ogg",
            "idempotency-key": VALID_KEY,
        },
        disconnect=True,
    )
    assert st_disc == 400
    assert fake.calls == []


@pytest.mark.parametrize(
    "bad_headers",
    [
        {"Content-Type": "audio/ogg"},  # missing Idempotency-Key
        {"Content-Type": "audio/ogg", "Idempotency-Key": "0123456789ABCDEF0123456789ABCDEF"},  # uppercase
        {"Content-Type": "audio/ogg", "Idempotency-Key": "0123456789abcdef"},  # too short
        {"Content-Type": "audio/ogg", "Idempotency-Key": VALID_KEY, "X-Audio-Duration-Ms": "-1"},
        {"Content-Type": "audio/ogg", "Idempotency-Key": VALID_KEY, "X-Audio-Duration-Ms": "12.5"},
        {"Content-Type": "audio/ogg", "Idempotency-Key": VALID_KEY, "X-Audio-Duration-Ms": "nan"},
        {"Content-Type": "audio/ogg", "Idempotency-Key": VALID_KEY, "Content-Length": "not-an-int"},
    ],
)
async def test_malformed_headers_return_400_bad_request(bad_headers: dict[str, str]):
    clock = FakeClock()
    fake = FakeTranscriber()
    app = build_voice_service(
        make_voice_settings(VOICE_RATE_PER_MIN=30),
        transcriber=fake,
        clock=clock,
    )
    async with async_client(app) as client:
        session = await issue_session(client, clock=clock)
    hdrs = {k.lower(): v for k, v in bad_headers.items()}
    hdrs["authorization"] = f"Bearer {session}"
    st, _, _, rds = await raw_asgi_call(
        app,
        method="POST",
        path="/v1/voice/transcriptions",
        headers=hdrs,
        chunks=[AUDIO_BODY],
    )
    assert st == 400
    assert rds == 0
    assert fake.calls == []


async def test_usage_none_skips_duration_check_and_implied_audio_tokens_enforces_exact_boundary():
    clock = FakeClock()
    # 32 * 90 * 1.15 == 3312 exact tokens allowed; 3313 must fail with 422 too_long.
    steps = [
        Transcript("sem usage", "gemini/gemini-3.8-flash", None, False),
        Transcript("no limite exato", "gemini/gemini-3.8-flash", Usage(3800, 20, 3312), False),
        Transcript("passou 1 token", "gemini/gemini-3.8-flash", Usage(3800, 20, 3313), False),
        Transcript(
            "inferido pelo prompt ok",
            "gemini/gemini-3.8-flash",
            Usage(TRANSCRIBE_PROMPT_TOKENS + 3312, 20, None),
            False,
        ),
        Transcript(
            "inferido pelo prompt longo",
            "gemini/gemini-3.8-flash",
            Usage(TRANSCRIBE_PROMPT_TOKENS + 3313, 20, None),
            False,
        ),
    ]
    fake = FakeTranscriber(steps=steps)
    app = build_voice_service(
        make_voice_settings(VOICE_MAX_SECONDS=90, VOICE_RATE_PER_MIN=20),
        transcriber=fake,
        clock=clock,
    )

    async with async_client(app) as client:
        session = await issue_session(client, clock=clock)

        def post_with_key(idx: int):
            key = f"{idx:032x}"
            return client.post(
                "/v1/voice/transcriptions",
                content=AUDIO_BODY,
                headers={
                    "Authorization": f"Bearer {session}",
                    "Content-Type": "audio/ogg",
                    "Idempotency-Key": key,
                },
            )

        r_none = await post_with_key(1)
        assert r_none.status_code == 200 and r_none.json()["text"] == "sem usage"

        r_3312 = await post_with_key(2)
        assert r_3312.status_code == 200 and r_3312.json()["text"] == "no limite exato"

        r_3313 = await post_with_key(3)
        data_long = assert_error_envelope(r_3313, status=422, code="too_long", retry=False)
        assert "passou 1 token" not in str(data_long)
        assert data_long["error"]["message"] == "O áudio passou de 90 s. Grave um trecho mais curto."

        r_inf_ok = await post_with_key(4)
        assert r_inf_ok.status_code == 200 and r_inf_ok.json()["text"] == "inferido pelo prompt ok"

        r_inf_long = await post_with_key(5)
        assert_error_envelope(r_inf_long, status=422, code="too_long", retry=False)


async def test_all_remaining_section_5_3_error_rows_and_revocation():
    clock = FakeClock()
    steps = [
        TranscribeError("no_speech"),
        TranscribeError("budget_exhausted"),
        TranscribeError("failed"),
        TranscribeError("timeout"),
        TranscribeError("disabled"),
        RuntimeError("unexpected provider crash"),
    ]
    fake = FakeTranscriber(steps=steps)
    app = build_voice_service(
        make_voice_settings(VOICE_RATE_PER_MIN=30),
        transcriber=fake,
        clock=clock,
    )

    async with async_client(app) as client:
        session = await issue_session(client, clock=clock)

        # Under 1 KB -> 422 no_speech without calling transcriber, and cached!
        r_short = await client.post(
            "/v1/voice/transcriptions",
            content=b"tiny",
            headers={
                "Authorization": f"Bearer {session}",
                "Content-Type": "audio/ogg",
                "Idempotency-Key": f"{10:032x}",
            },
        )
        assert_error_envelope(r_short, status=422, code="no_speech", retry=False)
        assert len(fake.calls) == 0

        # Model no_speech -> 422 no_speech
        r_nospeech = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers={
                "Authorization": f"Bearer {session}",
                "Content-Type": "audio/ogg",
                "Idempotency-Key": f"{11:032x}",
            },
        )
        assert_error_envelope(r_nospeech, status=422, code="no_speech", retry=False)

        # 429 budget_exhausted with Retry-After until local midnight (15:00 -> 00:00 = 32400 s)
        r_budget = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers={
                "Authorization": f"Bearer {session}",
                "Content-Type": "audio/ogg",
                "Idempotency-Key": f"{12:032x}",
            },
        )
        assert_error_envelope(r_budget, status=429, code="budget_exhausted", retry=True)
        assert r_budget.headers["retry-after"] == "32400"

        # 502 transcription_failed
        r_failed = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers={
                "Authorization": f"Bearer {session}",
                "Content-Type": "audio/ogg",
                "Idempotency-Key": f"{13:032x}",
            },
        )
        assert_error_envelope(r_failed, status=502, code="transcription_failed", retry=True)

        # 504 timeout
        r_timeout = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers={
                "Authorization": f"Bearer {session}",
                "Content-Type": "audio/ogg",
                "Idempotency-Key": f"{14:032x}",
            },
        )
        assert_error_envelope(r_timeout, status=504, code="timeout", retry=True)

        # 503 disabled (from TranscribeError("disabled"))
        r_dis = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers={
                "Authorization": f"Bearer {session}",
                "Content-Type": "audio/ogg",
                "Idempotency-Key": f"{15:032x}",
            },
        )
        assert_error_envelope(r_dis, status=503, code="disabled", retry=False)

        # 500 internal (unexpected exception, no leak)
        r_500 = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers={
                "Authorization": f"Bearer {session}",
                "Content-Type": "audio/ogg",
                "Idempotency-Key": f"{16:032x}",
            },
        )
        data_500 = assert_error_envelope(r_500, status=500, code="internal", retry=True)
        assert "unexpected provider crash" not in str(data_500)

    # Session revoked via APP_SESSION_NOT_BEFORE -> 401 auth_expired
    revoked_app = build_voice_service(
        make_voice_settings(
            APP_SESSION_NOT_BEFORE={SYNTHETIC_CHAT_ID: int(clock().timestamp()) + 60},
        ),
        transcriber=FakeTranscriber(),
        clock=clock,
    )
    async with async_client(revoked_app) as client:
        r_revoked = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers={
                "Authorization": f"Bearer {session}",
                "Content-Type": "audio/ogg",
                "Idempotency-Key": VALID_KEY,
            },
        )
        assert_error_envelope(r_revoked, status=401, code="auth_expired", retry=False)

    # VOICE_API_ENABLED=false on /v1/voice/transcriptions -> 503 disabled before auth
    disabled_app = build_voice_service(
        make_voice_settings(VOICE_API_ENABLED=False, APP_AUTH_SECRET=None, VOICE_ALLOWED_ORIGINS=())
    )
    st_off, _, body_off, rds_off = await raw_asgi_call(
        disabled_app,
        method="POST",
        path="/v1/voice/transcriptions",
        headers={},
        chunks=[AUDIO_BODY],
    )
    assert st_off == 503 and b"disabled" in body_off and rds_off == 0


async def test_idempotency_replay_conflict_in_flight_and_owner_abort():
    clock = FakeClock()
    started = asyncio.Event()
    proceed = asyncio.Event()

    async def gated_call(_audio: Any, _principal: str) -> Transcript:
        started.set()
        await proceed.wait()
        return Transcript("primeira fala", "gemini/gemini-3.8-flash", None, False)

    fake = FakeTranscriber(
        steps=[
            gated_call,
            Transcript("apos ttl", "gemini/gemini-3.8-flash", None, False),
        ]
    )
    app = build_voice_service(
        make_voice_settings(VOICE_RATE_PER_MIN=30, VOICE_MAX_CONCURRENT=4),
        transcriber=fake,
        clock=clock,
    )

    async with async_client(app) as client:
        session = await issue_session(client, clock=clock)
        headers = {
            "Authorization": f"Bearer {session}",
            "Content-Type": "audio/ogg",
            "Idempotency-Key": VALID_KEY,
        }

        owner_task = asyncio.create_task(
            client.post("/v1/voice/transcriptions", content=AUDIO_BODY, headers=headers)
        )
        await started.wait()

        # Different digest while owner is in flight -> immediate 409 idempotency_conflict!
        conflict_inflight = await client.post(
            "/v1/voice/transcriptions",
            content=OTHER_AUDIO_BODY,
            headers=headers,
        )
        assert_error_envelope(conflict_inflight, status=409, code="idempotency_conflict", retry=False)

        # Same digest while owner is in flight -> joins future, only 1 transcriber call!
        waiter_task = asyncio.create_task(
            client.post("/v1/voice/transcriptions", content=AUDIO_BODY, headers=headers)
        )
        await asyncio.sleep(0)
        proceed.set()

        r_owner, r_waiter = await asyncio.gather(owner_task, waiter_task)
        assert r_owner.status_code == 200 and r_owner.json()["text"] == "primeira fala"
        assert r_waiter.status_code == 200 and r_waiter.json()["text"] == "primeira fala"
        assert len(fake.calls) == 1

        # Finished replay within 5 min -> cached 200, still 1 transcriber call!
        r_replay = await client.post("/v1/voice/transcriptions", content=AUDIO_BODY, headers=headers)
        assert r_replay.status_code == 200 and r_replay.json()["text"] == "primeira fala"
        assert len(fake.calls) == 1

        # Different digest after finished -> 409 idempotency_conflict, never returns cached text!
        conflict_done = await client.post(
            "/v1/voice/transcriptions",
            content=OTHER_AUDIO_BODY,
            headers=headers,
        )
        assert_error_envelope(conflict_done, status=409, code="idempotency_conflict", retry=False)
        assert "primeira fala" not in conflict_done.text

        # Advance past 300 s TTL -> runs again!
        clock.advance(301)
        r_after_ttl = await client.post("/v1/voice/transcriptions", content=AUDIO_BODY, headers=headers)
        assert r_after_ttl.status_code == 200 and r_after_ttl.json()["text"] == "apos ttl"
        assert len(fake.calls) == 2

    # Owner unexpected failure -> owner gets 500 internal, waiter gets 502 transcription_failed,
    # entry is removed so retry succeeds!
    boom_started = asyncio.Event()
    boom_release = asyncio.Event()

    async def crashing_owner(_audio: Any, _principal: str) -> Transcript:
        boom_started.set()
        await boom_release.wait()
        raise RuntimeError("owner exploded")

    fake2 = FakeTranscriber(
        steps=[
            crashing_owner,
            Transcript("recuperado no retry", "gemini/gemini-3.8-flash", None, False),
        ]
    )
    app2 = build_voice_service(
        make_voice_settings(VOICE_RATE_PER_MIN=30, VOICE_MAX_CONCURRENT=4),
        transcriber=fake2,
        clock=clock,
    )
    async with async_client(app2) as client:
        session2 = await issue_session(client, clock=clock)
        hdr2 = {
            "Authorization": f"Bearer {session2}",
            "Content-Type": "audio/ogg",
            "Idempotency-Key": SECOND_KEY,
        }
        t_owner = asyncio.create_task(
            client.post("/v1/voice/transcriptions", content=AUDIO_BODY, headers=hdr2)
        )
        await boom_started.wait()
        t_waiter = asyncio.create_task(
            client.post("/v1/voice/transcriptions", content=AUDIO_BODY, headers=hdr2)
        )
        await asyncio.sleep(0)
        boom_release.set()

        resp_owner, resp_waiter = await asyncio.gather(t_owner, t_waiter)
        assert_error_envelope(resp_owner, status=500, code="internal", retry=True)
        assert_error_envelope(resp_waiter, status=502, code="transcription_failed", retry=True)

        # Retry with the same key runs fresh and succeeds!
        resp_retry = await client.post("/v1/voice/transcriptions", content=AUDIO_BODY, headers=hdr2)
        assert resp_retry.status_code == 200
        assert resp_retry.json()["text"] == "recuperado no retry"
