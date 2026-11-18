"""Standalone ASGI entry point for the voice service (voice input design, §5.1, §5.2, §5.7, §13).

    uv run uvicorn agent.voice_asgi:app --host 0.0.0.0 --port 8080

Routes:
- POST /v1/auth/sessions        credential-to-session exchange (§6.7)
- POST /v1/voice/transcriptions raw audio upload -> transcript (§5.3)
- OPTIONS on both               CORS preflight (§5.7)
- GET /healthz                  liveness check (§5.2)

This module intentionally never imports `handler`, `bot`, `sheet_client`, `telegram` or `commands`.
"""

from __future__ import annotations

import asyncio
import functools
import logging
import os
import time
from collections.abc import Callable, Sequence
from datetime import UTC, datetime

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware
from starlette.routing import Route
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from agent import logs
from agent.auth import (
    AllowedChats,
    Authorizer,
    ConfigRevocations,
    Directory,
    LinkCodes,
    Sessions,
    SignIn,
    SignInProvider,
    TelegramDirectory,
    TelegramInitData,
    derive_keys,
)
from agent.budget import MemoryBudget
from agent.settings import PROVIDER_KEY_VARIABLES, ConfigError
from agent.transcribe import Transcriber, build_transcriber
from agent.voice_api import (
    HEALTHZ_PATH,
    SESSIONS_PATH,
    TRANSCRIPTIONS_PATH,
    VoiceApi,
    error_response,
    idempotency_error_code,
)
from agent.voice_limits import (
    Clock,
    ConcurrencyGate,
    ExchangeLimiter,
    IdempotencyCache,
    RateLimiter,
)
from agent.voice_settings import VoiceSettings

log = logging.getLogger(__name__)

CORS_ALLOW_METHODS = ("POST", "OPTIONS")
CORS_ALLOW_HEADERS = (
    "Authorization",
    "Content-Type",
    "Idempotency-Key",
    "X-Audio-Duration-Ms",
)
CORS_EXPOSE_HEADERS = ("Retry-After",)
CORS_MAX_AGE_S = 600


def configure_voice_logging() -> None:
    """Installs log masking and content guards without importing `agent.telegram`."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logs.install()


class _JsonServerErrorMiddleware:
    """Inner safety net inside `CORSMiddleware` so no `Exception` reaches `ServerErrorMiddleware`."""

    def __init__(self, app: ASGIApp, *, max_seconds: int) -> None:
        self.app = app
        self._max_seconds = max_seconds

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        started_response = False

        async def tracked_send(message: Message) -> None:
            nonlocal started_response
            if message["type"] == "http.response.start":
                started_response = True
            await send(message)

        try:
            await self.app(scope, receive, tracked_send)
        except asyncio.CancelledError:
            raise
        except Exception as err:
            log.error("voice asgi unhandled error: %s", logs.describe(err))
            if not started_response:
                response = error_response("internal", max_seconds=self._max_seconds)
                await response(scope, receive, send)


def build_voice_service(
    settings: VoiceSettings,
    *,
    transcriber: Transcriber | None = None,
    sign_in: Sequence[SignInProvider] | None = None,
    directory: Directory | None = None,
    authorizer: Authorizer | None = None,
    clock: Callable[[], datetime] | None = None,
) -> Starlette:
    """Assembles the voice service Starlette app (spec §13 C5c).

    Every non-`None` collaborator argument replaces the production default in full. No setting or
    environment variable can register an extra `SignInProvider`.
    """
    logs.register_secrets(settings.secret_values())
    logs.register_secrets(os.environ.get(name) for name in PROVIDER_KEY_VARIABLES)
    logs.install()

    active_clock: Callable[[], datetime] = clock if clock is not None else (lambda: datetime.now(UTC))
    limiter_clock: Clock = clock if clock is not None else time.monotonic

    sessions: Sessions | None = None
    exchange: SignIn | None = None
    providers_by_kind: dict[str, SignInProvider] = {}
    active_transcriber: Transcriber | None = transcriber
    log_key: bytes | None = None

    if settings.VOICE_API_ENABLED:
        if settings.APP_AUTH_SECRET is None:
            raise ConfigError("APP_AUTH_SECRET is required when VOICE_API_ENABLED is true")
        if not settings.VOICE_ALLOWED_ORIGINS:
            raise ConfigError("VOICE_ALLOWED_ORIGINS is required when VOICE_API_ENABLED is true")

        keys = derive_keys(settings.APP_AUTH_SECRET.get_secret_value())
        log_key = keys.log

        active_directory: Directory = (
            directory if directory is not None else TelegramDirectory(keys, settings.ALLOWED_CHAT_IDS)
        )
        active_authorizer: Authorizer = (
            authorizer if authorizer is not None else AllowedChats(settings.ALLOWED_CHAT_IDS)
        )
        revocations = ConfigRevocations(settings.APP_SESSION_NOT_BEFORE)
        sessions = Sessions(
            keys,
            active_directory,
            active_authorizer,
            revocations,
            ttl_s=settings.APP_SESSION_TTL_S,
        )

        if sign_in is not None:
            providers = tuple(sign_in)
        else:
            default_providers: list[SignInProvider] = [
                LinkCodes(
                    keys,
                    active_directory,
                    active_authorizer,
                    ttl_s=settings.APP_CODE_TTL_S,
                )
            ]
            if settings.TELEGRAM_BOT_TOKEN is not None:
                default_providers.append(
                    TelegramInitData(
                        settings.TELEGRAM_BOT_TOKEN.get_secret_value(),
                        active_authorizer,
                        max_age_s=settings.INITDATA_MAX_AGE_S,
                    )
                )
            providers = tuple(default_providers)

        exchange = SignIn(providers, sessions)
        providers_by_kind = {provider.kind: provider for provider in providers}

        if active_transcriber is None:
            budget = MemoryBudget(
                principal_daily=settings.VOICE_DAILY_TOKENS,
                global_daily=settings.VOICE_GLOBAL_DAILY_TOKENS,
                timezone=settings.TIMEZONE,
            )
            active_transcriber = build_transcriber(settings, budget, clock=active_clock)
    elif settings.APP_AUTH_SECRET is not None:
        log_key = derive_keys(settings.APP_AUTH_SECRET.get_secret_value()).log

    rate_limiter = RateLimiter(
        per_minute=settings.VOICE_RATE_PER_MIN,
        per_day=settings.VOICE_RATE_PER_DAY,
        clock=limiter_clock,
    )
    exchange_limiter = ExchangeLimiter(
        per_minute=settings.EXCHANGE_RATE_PER_MIN,
        per_day_per_principal=settings.EXCHANGE_RATE_PER_DAY,
        clock=limiter_clock,
    )
    concurrency_gate = ConcurrencyGate(max_concurrent=settings.VOICE_MAX_CONCURRENT)
    idempotency_cache = IdempotencyCache(
        ttl_s=settings.VOICE_IDEMPOTENCY_TTL_S,
        max_entries=settings.VOICE_IDEMPOTENCY_MAX_ENTRIES,
        clock=limiter_clock,
        error_code=idempotency_error_code,
    )

    api = VoiceApi(
        settings,
        sessions=sessions,
        sign_in=exchange,
        providers_by_kind=providers_by_kind,
        transcriber=active_transcriber,
        rate_limiter=rate_limiter,
        exchange_limiter=exchange_limiter,
        concurrency_gate=concurrency_gate,
        idempotency_cache=idempotency_cache,
        log_key=log_key,
        clock=active_clock,
    )

    middleware = [
        Middleware(
            CORSMiddleware,
            allow_origins=list(settings.VOICE_ALLOWED_ORIGINS),
            allow_methods=list(CORS_ALLOW_METHODS),
            allow_headers=list(CORS_ALLOW_HEADERS),
            expose_headers=list(CORS_EXPOSE_HEADERS),
            allow_credentials=False,
            max_age=CORS_MAX_AGE_S,
        ),
        Middleware(_JsonServerErrorMiddleware, max_seconds=settings.VOICE_MAX_SECONDS),
    ]

    routes = [
        Route(SESSIONS_PATH, api.create_session, methods=["POST"]),
        Route(TRANSCRIPTIONS_PATH, api.transcribe_voice, methods=["POST"]),
        Route(HEALTHZ_PATH, api.healthz, methods=["GET"]),
    ]

    return Starlette(debug=False, routes=routes, middleware=middleware)


@functools.cache
def get_app() -> Starlette:
    configure_voice_logging()
    return build_voice_service(VoiceSettings.load())


class _LazyVoiceApp:
    """ASGI entry point (`uvicorn agent.voice_asgi:app`) that loads settings on startup or first call."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "lifespan":
            await self._lifespan(scope, receive, send)
            return
        await get_app()(scope, receive, send)

    @staticmethod
    async def _lifespan(scope: Scope, receive: Receive, send: Send) -> None:
        first = await receive()
        try:
            target = get_app()
        except Exception as err:
            detail = str(err) if isinstance(err, ConfigError) else logs.describe(err)
            await send({"type": "lifespan.startup.failed", "message": detail})
            return

        sent_first = False

        async def replay_receive() -> Message:
            nonlocal sent_first
            if not sent_first:
                sent_first = True
                return first
            return await receive()

        await target(scope, replay_receive, send)


app: ASGIApp = _LazyVoiceApp()
