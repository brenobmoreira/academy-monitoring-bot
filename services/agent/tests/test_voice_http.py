"""Security and DoS hardening tests for the voice HTTP endpoints (audit §5.4, §5.5, §5.6).

Exercises:
- IdempotencyCache hard cap (IDEMPOTENCY_MAX_ENTRIES): a client flooding distinct idempotency keys
  gets ConcurrencyLimitError -> HTTP 429 rate_limited with Retry-After once the cache is full.
- max_entries=0 is rejected at construction.
- Finished entries that expire free up slots (prune-then-accept path).
- Retry-After header is always present on 429 rate-limited responses.
- Cache-Control: no-store on 200 responses.
- Oversized body is rejected with 413 too_large.
- Content-Length mismatch yields 400 bad_request.
- Missing / malformed Authorization header returns 401.
- Multiple concurrent requests beyond VOICE_MAX_CONCURRENT get 429 + Retry-After.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import pytest

from agent.transcribe import MIN_BODY_BYTES, Transcript
from agent.voice_asgi import build_voice_service
from agent.voice_limits import CachedResponse, ConcurrencyLimitError, IdempotencyCache
from agent.voice_settings import VoiceSettings

from .voice_fakes import (
    SYNTHETIC_AUTH_SECRET,
    SYNTHETIC_CHAT_ID,
    SYNTHETIC_ORIGIN,
    SYNTHETIC_TRANSCRIBE_KEY,
    FakeClock,
    FakeTranscriber,
    make_link_code,
)

pytestmark = pytest.mark.unit

VALID_KEY = "0123456789abcdef0123456789abcdef"
SECOND_KEY = "fedcba9876543210fedcba9876543210"
AUDIO_BODY = b"OggS" + (b"\x5a" * (MIN_BODY_BYTES + 256))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


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


def async_client(app: Any) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app),
        base_url="https://voice.example.test",
    )


async def issue_session(client: httpx.AsyncClient, *, clock: FakeClock) -> str:
    now = clock()
    code = make_link_code(chat_id=SYNTHETIC_CHAT_ID, allowed_chats=(SYNTHETIC_CHAT_ID,), now=now)
    resp = await client.post(
        "/v1/auth/sessions",
        json={"v": 1, "kind": "tg_link", "credential": code},
    )
    assert resp.status_code == 200, f"issue_session failed: {resp.text}"
    return resp.json()["session"]


def _transcribe_headers(session: str, ikey: str) -> dict[str, str]:
    return {
        "Authorization": f"Bearer {session}",
        "Content-Type": "audio/ogg",
        "Idempotency-Key": ikey,
    }


def _default_app(
    *,
    clock: FakeClock | None = None,
    transcriber: FakeTranscriber | None = None,
    **settings_overrides: Any,
) -> Any:
    """Build a minimal voice app with sane test defaults.

    Uses the default Telegram providers; `make_link_code` issues real link codes signed with
    SYNTHETIC_AUTH_SECRET so the exchange endpoint works without injecting a custom sign_in.
    """
    if clock is None:
        clock = FakeClock()
    return build_voice_service(
        make_voice_settings(**settings_overrides),
        transcriber=transcriber,
        clock=clock,
    )


# ---------------------------------------------------------------------------
# DoS guard: IdempotencyCache max_entries hard cap (unit)
# ---------------------------------------------------------------------------


async def test_idempotency_cache_max_entries_zero_raises():
    """max_entries=0 must be rejected at construction (guard: not a silent no-op)."""
    with pytest.raises(ValueError, match="max_entries"):
        IdempotencyCache(max_entries=0)


async def test_idempotency_cache_max_entries_negative_raises():
    """max_entries=-1 must also be rejected."""
    with pytest.raises(ValueError, match="max_entries"):
        IdempotencyCache(max_entries=-1)


async def test_idempotency_cache_max_entries_hit_raises_concurrency_limit():
    """Once max_entries in-flight slots are occupied, the next distinct key raises ConcurrencyLimitError."""
    # Use a monotonic-compatible float clock (IdempotencyCache uses Clock = Callable[[], float|datetime]).
    t = [0.0]

    def mono() -> float:
        return t[0]

    cap = 3
    cache = IdempotencyCache(ttl_s=300.0, max_entries=cap, clock=mono)

    started_count = 0
    all_started = asyncio.Event()
    release = asyncio.Event()

    async def slow() -> CachedResponse:
        nonlocal started_count
        started_count += 1
        if started_count >= cap:
            all_started.set()
        await release.wait()
        return CachedResponse(status=200, body={"text": "ok"})

    tasks = [asyncio.create_task(cache.run("u1", f"k{i}", f"d{i}", slow)) for i in range(cap)]
    # Wait until ALL in-flight coroutines have started and filled the slots.
    await all_started.wait()

    # Next distinct key must be refused.
    with pytest.raises(ConcurrencyLimitError):
        await cache.run("u1", "k_overflow", "d_overflow", slow)

    # Teardown.
    release.set()
    await asyncio.gather(*tasks, return_exceptions=True)


async def test_idempotency_cache_prune_then_accept():
    """Finished entries that expire must free slots so a subsequent key is accepted."""
    t = [0.0]

    def mono() -> float:
        return t[0]

    ttl = 10.0
    cache = IdempotencyCache(ttl_s=ttl, max_entries=2, clock=mono)

    async def fast_ok() -> CachedResponse:
        return CachedResponse(status=200, body={"text": "ok"})

    await cache.run("u1", "k0", "d0", fast_ok)
    await cache.run("u1", "k1", "d1", fast_ok)
    assert len(cache) == 2  # both finished entries present

    # Advance clock past TTL.
    t[0] += ttl + 1

    # New key must be accepted after prune.
    result = await cache.run("u1", "k2", "d2", fast_ok)
    assert isinstance(result, CachedResponse)
    assert result.status == 200


async def test_idempotency_cache_same_key_not_counted_twice():
    """Re-submitting the exact same (principal, key, digest) must not consume an extra slot."""
    t = [0.0]

    def mono() -> float:
        return t[0]

    cache = IdempotencyCache(ttl_s=300.0, max_entries=1, clock=mono)

    async def fast_ok() -> CachedResponse:
        return CachedResponse(status=200, body={"text": "ok"})

    r1 = await cache.run("u1", "k0", "d0", fast_ok)
    # Same key/digest again — hits the cache, no new slot consumed.
    r2 = await cache.run("u1", "k0", "d0", fast_ok)
    assert r1.status == r2.status == 200


# ---------------------------------------------------------------------------
# HTTP integration: rate-limited 429 carries Retry-After
# ---------------------------------------------------------------------------


async def test_rate_limited_response_includes_retry_after():
    """rate_limited 429 from per-minute quota must include Retry-After >= 1."""
    clock = FakeClock()
    transcriber = FakeTranscriber()

    settings = make_voice_settings(VOICE_RATE_PER_MIN=1, VOICE_RATE_PER_DAY=100)
    app = build_voice_service(
        settings,
        transcriber=transcriber,
        clock=clock,
    )

    async with async_client(app) as client:
        session = await issue_session(client, clock=clock)
        # First request consumes the per-minute quota.
        await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers=_transcribe_headers(session, VALID_KEY),
        )
        # Second request with a different idempotency key hits the rate limit.
        r2 = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers=_transcribe_headers(session, SECOND_KEY),
        )

    assert r2.status_code == 429
    assert r2.json()["error"]["code"] == "rate_limited"
    assert "Retry-After" in r2.headers
    assert int(r2.headers["Retry-After"]) >= 1


# ---------------------------------------------------------------------------
# Cache-Control: no-store on 200 responses
# ---------------------------------------------------------------------------


async def test_sessions_200_has_cache_control_no_store():
    """POST /v1/auth/sessions 200 must include Cache-Control: no-store."""
    clock = FakeClock()
    app = build_voice_service(make_voice_settings(), clock=clock)

    async with async_client(app) as client:
        now = clock()
        code = make_link_code(chat_id=SYNTHETIC_CHAT_ID, allowed_chats=(SYNTHETIC_CHAT_ID,), now=now)
        resp = await client.post(
            "/v1/auth/sessions",
            json={"v": 1, "kind": "tg_link", "credential": code},
        )

    assert resp.status_code == 200
    assert "no-store" in resp.headers.get("cache-control", "")


async def test_transcriptions_200_has_cache_control_no_store():
    """POST /v1/voice/transcriptions 200 must include Cache-Control: no-store."""
    clock = FakeClock()
    transcriber = FakeTranscriber()
    settings = make_voice_settings()
    app = build_voice_service(settings, transcriber=transcriber, clock=clock)

    async with async_client(app) as client:
        session = await issue_session(client, clock=clock)
        resp = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers=_transcribe_headers(session, VALID_KEY),
        )

    assert resp.status_code == 200
    assert "no-store" in resp.headers.get("cache-control", "")


# ---------------------------------------------------------------------------
# Authorization header security
# ---------------------------------------------------------------------------


async def test_missing_authorization_header_returns_401():
    """POST /v1/voice/transcriptions without Authorization must return 401 unauthenticated."""
    app = build_voice_service(make_voice_settings())

    async with async_client(app) as client:
        resp = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers={
                "Content-Type": "audio/ogg",
                "Idempotency-Key": VALID_KEY,
            },
        )

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthenticated"


async def test_malformed_bearer_scheme_returns_401():
    """A non-Bearer scheme in Authorization must return 401."""
    app = build_voice_service(make_voice_settings())

    async with async_client(app) as client:
        resp = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers={
                "Authorization": "Basic dXNlcjpwYXNz",
                "Content-Type": "audio/ogg",
                "Idempotency-Key": VALID_KEY,
            },
        )

    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "unauthenticated"


async def test_bearer_token_with_whitespace_returns_401():
    """A token containing internal whitespace must return 401 (not crash or succeed)."""
    app = build_voice_service(make_voice_settings())

    async with async_client(app) as client:
        resp = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers={
                "Authorization": "Bearer tok en",
                "Content-Type": "audio/ogg",
                "Idempotency-Key": VALID_KEY,
            },
        )

    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# Payload size limits
# ---------------------------------------------------------------------------


async def test_oversized_body_returns_413():
    """A body larger than VOICE_MAX_BYTES must be rejected with 413 too_large."""
    max_bytes = 512
    clock = FakeClock()
    settings = make_voice_settings(VOICE_MAX_BYTES=max_bytes)
    transcriber = FakeTranscriber()
    app = build_voice_service(settings, transcriber=transcriber, clock=clock)

    async with async_client(app) as client:
        session = await issue_session(client, clock=clock)
        big_body = b"OggS" + b"\x00" * (max_bytes + 1)
        resp = await client.post(
            "/v1/voice/transcriptions",
            content=big_body,
            headers=_transcribe_headers(session, VALID_KEY),
        )

    assert resp.status_code == 413
    assert resp.json()["error"]["code"] == "too_large"


async def test_content_length_mismatch_returns_400():
    """Content-Length that does not match actual body size must yield 400 bad_request."""
    clock = FakeClock()
    transcriber = FakeTranscriber()
    settings = make_voice_settings()
    app = build_voice_service(settings, transcriber=transcriber, clock=clock)

    async with async_client(app) as client:
        session = await issue_session(client, clock=clock)
        headers = dict(_transcribe_headers(session, VALID_KEY))
        # Declare more bytes than we actually send.
        headers["Content-Length"] = str(len(AUDIO_BODY) + 100)
        resp = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers=headers,
        )

    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "bad_request"


# ---------------------------------------------------------------------------
# Concurrency gate: HTTP 429 with Retry-After
# ---------------------------------------------------------------------------


async def test_concurrency_gate_429_with_retry_after():
    """VOICE_MAX_CONCURRENT=1: second concurrent request must return 429 rate_limited + Retry-After."""
    clock = FakeClock()
    blocked = asyncio.Event()
    release = asyncio.Event()

    # FakeTranscriber calls step(audio, principal_key) with positional args.
    async def slow(audio: Any, principal_key: str) -> Transcript:
        blocked.set()
        await release.wait()
        return Transcript(text="ok", model="m", fallback=False, usage=None)

    transcriber = FakeTranscriber(steps=[slow])
    settings = make_voice_settings(VOICE_MAX_CONCURRENT=1)
    app = build_voice_service(settings, transcriber=transcriber, clock=clock)

    async with async_client(app) as client:
        session = await issue_session(client, clock=clock)

        async def first() -> httpx.Response:
            return await client.post(
                "/v1/voice/transcriptions",
                content=AUDIO_BODY,
                headers=_transcribe_headers(session, VALID_KEY),
            )

        async def second() -> httpx.Response:
            # Wait for the first request to have taken the concurrency slot.
            await blocked.wait()
            resp = await client.post(
                "/v1/voice/transcriptions",
                content=AUDIO_BODY,
                headers=_transcribe_headers(session, SECOND_KEY),
            )
            # Second request finished (expected 429); let the first request's transcription finish.
            release.set()
            return resp

        r1, r2 = await asyncio.gather(first(), second())

    assert r2.status_code == 429
    assert r2.json()["error"]["code"] == "rate_limited"
    assert "Retry-After" in r2.headers
    assert int(r2.headers["Retry-After"]) >= 1


# ---------------------------------------------------------------------------
# Error JSON structure
# ---------------------------------------------------------------------------


async def test_error_response_has_v1_envelope():
    """All error responses must carry the {v:1, error:{code,message,retry}} envelope."""
    app = build_voice_service(make_voice_settings())

    async with async_client(app) as client:
        resp = await client.post(
            "/v1/voice/transcriptions",
            content=AUDIO_BODY,
            headers={
                "Content-Type": "audio/ogg",
                "Idempotency-Key": VALID_KEY,
                # No Authorization
            },
        )

    assert resp.status_code == 401
    body = resp.json()
    assert body["v"] == 1
    assert isinstance(body["error"]["code"], str)
    assert isinstance(body["error"]["message"], str)
    assert isinstance(body["error"]["retry"], bool)
