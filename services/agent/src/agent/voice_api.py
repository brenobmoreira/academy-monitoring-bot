"""HTTP route handlers for the standalone voice service (voice input design, §3.5, §5.2–5.8, §6.7).

Enforces the strict processing order of §5.4 (authentication and header validation before reading a
single body chunk), bounded streaming reads, digest-first idempotency, rate and concurrency limits,
post-transcription implied audio token checks, and content-free structured logging (§10).
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import logging
import math
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Final
from zoneinfo import ZoneInfo

from starlette.requests import ClientDisconnect, Request
from starlette.responses import JSONResponse, PlainTextResponse, Response

from agent import logs
from agent.auth import (
    MAX_REQUEST_BYTES,
    VOICE,
    AuthError,
    BadRequest,
    Principal,
    Sessions,
    SignIn,
    SignInProvider,
    b64url_encode,
)
from agent.transcribe import (
    AUDIO_TOKENS_PER_SECOND,
    MIN_BODY_BYTES,
    Audio,
    TranscribeError,
    Transcriber,
    Transcript,
    Usage,
    audio_format,
    implied_audio_tokens,
)
from agent.voice_limits import (
    CachedResponse,
    ConcurrencyGate,
    ConcurrencyLimitError,
    ExchangeLimiter,
    IdempotencyCache,
    IdempotencyConflictError,
    NoSpeechError,
    OwnerAborted,
    RateLimiter,
)
from agent.voice_settings import VoiceSettings

log = logging.getLogger(__name__)

SESSIONS_PATH: Final = "/v1/auth/sessions"
TRANSCRIPTIONS_PATH: Final = "/v1/voice/transcriptions"
HEALTHZ_PATH: Final = "/healthz"

_CACHE_HEADERS: Final[dict[str, str]] = {"Cache-Control": "no-store"}
_IDEMPOTENCY_KEY_RE: Final = re.compile(r"[0-9a-f]{32}")
_CONTENT_LENGTH_RE: Final = re.compile(r"[0-9]{1,20}")
_DURATION_MS_RE: Final = re.compile(r"[0-9]{1,12}")

# Percentage margin for post-transcription implied audio tokens (§3.5: 32 * VOICE_MAX_SECONDS * 1.15).
# Evaluated with exact integer arithmetic so 32 * 90 * 1.15 == 3312 is never tripped by float rounding.
_DURATION_TOKEN_NUMERATOR: Final = 115
_DURATION_TOKEN_DENOMINATOR: Final = 100

_ERROR_SPECS: Final[dict[str, tuple[int, bool, str]]] = {
    "bad_request": (400, False, "Requisição inválida."),
    "unauthenticated": (401, False, "Sessão inválida. Envie /app para renovar a voz."),
    "auth_expired": (401, False, "Sessão expirada. Envie /app para renovar a voz."),
    "credential_used": (401, False, "Este acesso já foi usado. Envie /app para renovar a voz."),
    "forbidden": (403, False, "Você não tem permissão para usar a voz neste app."),
    "idempotency_conflict": (
        409,
        False,
        "Esta chave de envio já foi usada com outro áudio. Grave um novo trecho.",
    ),
    "too_large": (
        413,
        False,
        "O áudio passou do tamanho máximo permitido. Grave um trecho mais curto.",
    ),
    "unsupported_format": (415, False, "Formato de áudio não suportado."),
    "no_speech": (422, False, "Não ouvi nada no áudio. Fale mais perto do microfone."),
    "rate_limited": (
        429,
        True,
        "Muitas tentativas seguidas. Aguarde alguns segundos e tente de novo.",
    ),
    "budget_exhausted": (
        429,
        True,
        "Limite diário de transcrição atingido. Tente novamente amanhã ou envie em texto.",
    ),
    "transcription_failed": (
        502,
        True,
        "Não consegui transcrever o áudio agora. Tente de novo em instantes.",
    ),
    "disabled": (503, False, "A transcrição de voz está desativada neste momento."),
    "timeout": (504, True, "A transcrição demorou demais. Tente de novo."),
    "internal": (500, True, "Erro interno ao processar a solicitação. Tente de novo."),
}


class _ApiError(Exception):
    """Domain error with a closed error code and optional Retry-After seconds."""

    def __init__(self, code: str, *, retry_after: int | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.retry_after = retry_after


def error_response(
    code: str,
    *,
    max_seconds: int = 90,
    retry_after: int | None = None,
) -> JSONResponse:
    if code == "too_long":
        status = 422
        retry = False
        message = f"O áudio passou de {max_seconds} s. Grave um trecho mais curto."
    else:
        status, retry, message = _ERROR_SPECS.get(code, _ERROR_SPECS["internal"])
        if code not in _ERROR_SPECS:
            code = "internal"
    headers = dict(_CACHE_HEADERS)
    if retry_after is not None:
        headers["Retry-After"] = str(max(1, int(retry_after)))
    payload = {"v": 1, "error": {"code": code, "message": message, "retry": retry}}
    return JSONResponse(payload, status_code=status, headers=headers)


def json_ok(payload: dict[str, object]) -> JSONResponse:
    return JSONResponse(payload, status_code=200, headers=dict(_CACHE_HEADERS))


def principal_key_of(principal: Principal) -> str:
    return f"{principal.provider}:{principal.subject}"


def principal_log_tag(log_key: bytes | None, principal_key: str | None) -> str:
    """`b64url(HMAC_SHA256(K_log, principal_key))[:12]` (§5.8), or `"none"` before auth."""
    if log_key is None or not principal_key:
        return "none"
    digest = hmac.new(log_key, principal_key.encode("utf-8"), hashlib.sha256).digest()
    return b64url_encode(digest)[:12]


def seconds_until_midnight(now: datetime, zone: ZoneInfo) -> int:
    local_now = now.astimezone(zone)
    tomorrow = local_now.date() + timedelta(days=1)
    next_midnight = datetime(tomorrow.year, tomorrow.month, tomorrow.day, tzinfo=zone)
    remaining = (next_midnight.astimezone(UTC) - local_now.astimezone(UTC)).total_seconds()
    return max(1, math.ceil(remaining))


def idempotency_error_code(exc: BaseException) -> str | None:
    """Only known domain errors expose a code to `IdempotencyCache`; anything else aborts waiters."""
    if isinstance(exc, (TranscribeError, NoSpeechError, _ApiError)):
        return exc.code
    return None


def _has_ctl(value: str) -> bool:
    return any((ord(ch) < 32 and ch != "\t") or ord(ch) == 127 for ch in value)


def _extract_bearer_token(request: Request) -> str:
    values = request.headers.getlist("authorization")
    if len(values) != 1:
        raise AuthError("unauthenticated")
    raw = values[0].strip(" \t")
    scheme, sep, rest = raw.partition(" ")
    token = rest.strip(" \t")
    if not sep or scheme.lower() != "bearer" or not token or any(ch.isspace() for ch in token):
        raise AuthError("unauthenticated")
    return token


def _parse_content_length(request: Request) -> int | None:
    values = request.headers.getlist("content-length")
    if not values:
        return None
    if len(values) != 1:
        raise _ApiError("bad_request")
    raw = values[0].strip(" \t")
    if _CONTENT_LENGTH_RE.fullmatch(raw) is None:
        raise _ApiError("bad_request")
    return int(raw)


def _parse_exchange_content_type(request: Request) -> None:
    values = request.headers.getlist("content-type")
    if not values:
        return
    if len(values) != 1 or _has_ctl(values[0]):
        raise _ApiError("bad_request")
    base_mime = values[0].split(";", 1)[0].strip().lower()
    if base_mime != "application/json":
        raise _ApiError("bad_request")


def _parse_audio_content_type(request: Request) -> tuple[str, str]:
    values = request.headers.getlist("content-type")
    if len(values) > 1:
        raise _ApiError("bad_request")
    if not values:
        raise _ApiError("unsupported_format")
    raw = values[0]
    if _has_ctl(raw):
        raise _ApiError("bad_request")
    base_mime = raw.split(";", 1)[0].strip().lower()
    if not base_mime:
        raise _ApiError("bad_request")
    fmt = audio_format(base_mime)
    if fmt is None:
        raise _ApiError("unsupported_format")
    return base_mime, fmt


def _parse_idempotency_key(request: Request) -> str:
    values = request.headers.getlist("idempotency-key")
    if len(values) != 1:
        raise _ApiError("bad_request")
    key = values[0].strip(" \t")
    if _IDEMPOTENCY_KEY_RE.fullmatch(key) is None:
        raise _ApiError("bad_request")
    return key


def _parse_duration_ms(request: Request, *, max_seconds: int) -> int | None:
    values = request.headers.getlist("x-audio-duration-ms")
    if not values:
        return None
    if len(values) != 1:
        raise _ApiError("bad_request")
    raw = values[0].strip(" \t")
    if _DURATION_MS_RE.fullmatch(raw) is None:
        raise _ApiError("bad_request")
    duration_ms = int(raw)
    if duration_ms > max_seconds * 1000:
        raise _ApiError("too_long")
    return duration_ms


async def _read_stream_bounded(
    request: Request,
    *,
    max_bytes: int,
    declared_length: int | None,
    over_cap_code: str,
) -> tuple[bytes, int]:
    """Reads `request.stream()` without populating `request._body`, cutting immediately past `max_bytes`."""
    chunks: list[bytes] = []
    total = 0
    try:
        async for chunk in request.stream():
            if not chunk:
                continue
            total += len(chunk)
            if total > max_bytes:
                chunks.clear()
                raise _ApiError(over_cap_code)
            chunks.append(bytes(chunk))
    except ClientDisconnect:
        chunks.clear()
        raise _ApiError("bad_request") from None

    if declared_length is not None and total != declared_length:
        chunks.clear()
        raise _ApiError("bad_request")

    data = b"".join(chunks)
    chunks.clear()
    return data, total


def _exceeds_audio_token_limit(usage: Usage | None, *, max_seconds: int) -> bool:
    implied = implied_audio_tokens(usage)
    if implied is None:
        return False
    return (
        implied * _DURATION_TOKEN_DENOMINATOR
        > AUDIO_TOKENS_PER_SECOND * max_seconds * _DURATION_TOKEN_NUMERATOR
    )


def _format_usage_tokens(usage: Usage | None) -> str:
    if (
        usage is not None
        and type(usage.prompt_tokens) is int
        and type(usage.completion_tokens) is int
        and usage.prompt_tokens >= 0
        and usage.completion_tokens >= 0
    ):
        return f"{usage.prompt_tokens}+{usage.completion_tokens}"
    return "none"


@dataclass
class _RunTelemetry:
    ran: bool = False
    model: str = "none"
    fallback: str = "none"
    tokens: str = "none"


class VoiceApi:
    """Stateful HTTP route handlers bound to one `VoiceSettings` and its injected collaborators."""

    def __init__(
        self,
        settings: VoiceSettings,
        *,
        sessions: Sessions | None,
        sign_in: SignIn | None,
        providers_by_kind: dict[str, SignInProvider],
        transcriber: Transcriber | None,
        rate_limiter: RateLimiter,
        exchange_limiter: ExchangeLimiter,
        concurrency_gate: ConcurrencyGate,
        idempotency_cache: IdempotencyCache,
        log_key: bytes | None,
        clock: Callable[[], datetime],
    ) -> None:
        self._settings = settings
        self._sessions = sessions
        self._sign_in = sign_in
        self._providers = dict(providers_by_kind)
        self._transcriber = transcriber
        self._rate_limiter = rate_limiter
        self._exchange_limiter = exchange_limiter
        self._concurrency_gate = concurrency_gate
        self._idempotency_cache = idempotency_cache
        self._log_key = log_key
        self._clock = clock
        self._zone = ZoneInfo(settings.TIMEZONE)
        self._allowed_models = frozenset(
            m for m in (settings.TRANSCRIBE_MODEL, settings.TRANSCRIBE_FALLBACK_MODEL) if m
        )

    async def healthz(self, _request: Request) -> PlainTextResponse:
        return PlainTextResponse("ok")

    async def create_session(self, request: Request) -> Response:
        started = time.perf_counter()
        principal_tag = "none"
        safe_kind = "none"
        try:
            if not self._settings.VOICE_API_ENABLED or self._sign_in is None or self._sessions is None:
                return self._log_exchange("disabled", 503, safe_kind, principal_tag, started)

            now = self._clock()
            proc_decision = self._exchange_limiter.allow_process()
            if not proc_decision.allowed:
                return self._log_exchange(
                    "rate_limited",
                    429,
                    safe_kind,
                    principal_tag,
                    started,
                    retry_after=proc_decision.retry_after,
                )

            _parse_exchange_content_type(request)
            declared_length = _parse_content_length(request)
            if declared_length is not None and declared_length > MAX_REQUEST_BYTES:
                raise _ApiError("bad_request")

            raw_body, _ = await _read_stream_bounded(
                request,
                max_bytes=MAX_REQUEST_BYTES,
                declared_length=declared_length,
                over_cap_code="bad_request",
            )
            try:
                kind, credential = self._sign_in.parse(raw_body)
            finally:
                raw_body = b""

            if kind in self._sign_in.kinds:
                safe_kind = kind

            try:
                principal = self._providers[kind].verify(credential, now)
            finally:
                credential = ""

            p_key = principal_key_of(principal)
            principal_tag = principal_log_tag(self._log_key, p_key)

            prin_decision = self._exchange_limiter.allow_principal(p_key)
            if not prin_decision.allowed:
                return self._log_exchange(
                    "rate_limited",
                    429,
                    safe_kind,
                    principal_tag,
                    started,
                    retry_after=prin_decision.retry_after,
                )

            token, expires_at = self._sessions.issue(principal, now)
            ref = self._sessions.directory.ref(principal)
            response = json_ok(
                {
                    "v": 1,
                    "session": token,
                    "expires_at": expires_at,
                    "scopes": sorted(principal.scopes),
                    "ref": ref,
                }
            )
            self._emit_exchange_log("ok", 200, safe_kind, principal_tag, started)
            return response
        except asyncio.CancelledError:
            raise
        except BadRequest:
            return self._log_exchange("bad_request", 400, safe_kind, principal_tag, started)
        except AuthError as err:
            status = 403 if err.code == "forbidden" else 401
            return self._log_exchange(err.code, status, safe_kind, principal_tag, started)
        except _ApiError as err:
            resp = error_response(
                err.code,
                max_seconds=self._settings.VOICE_MAX_SECONDS,
                retry_after=err.retry_after,
            )
            self._emit_exchange_log(err.code, resp.status_code, safe_kind, principal_tag, started)
            return resp
        except Exception as err:
            latency_ms = max(0, round((time.perf_counter() - started) * 1000))
            log.error(
                "voice auth session failed: status=500 code=internal kind=%s principal=%s "
                "latency_ms=%d cause=%s",
                safe_kind,
                principal_tag,
                latency_ms,
                logs.describe(err),
            )
            return error_response("internal", max_seconds=self._settings.VOICE_MAX_SECONDS)

    async def transcribe_voice(self, request: Request) -> Response:
        started = time.perf_counter()
        principal_tag = "none"
        fmt = "none"
        duration_ms: int | None = None
        byte_len = 0
        telemetry = _RunTelemetry()
        now: datetime | None = None

        try:
            # §5.4 step 2: VOICE_API_ENABLED and transcriber present, else disabled.
            if not self._settings.VOICE_API_ENABLED or self._transcriber is None or self._sessions is None:
                return self._log_voice(
                    "disabled", 503, byte_len, duration_ms, fmt, principal_tag, telemetry, started
                )

            now = self._clock()
            transcriber = self._transcriber

            # §5.4 step 3: Verify session -> principal; authorize scope `voice`.
            bearer = _extract_bearer_token(request)
            try:
                principal = self._sessions.verify(bearer, VOICE, now)
            finally:
                bearer = ""
            p_key = principal_key_of(principal)
            principal_tag = principal_log_tag(self._log_key, p_key)

            # §5.4 step 4: Per-principal request rate limit.
            rate_decision = self._rate_limiter.allow(p_key)
            if not rate_decision.allowed:
                return self._log_voice(
                    "rate_limited",
                    429,
                    byte_len,
                    duration_ms,
                    fmt,
                    principal_tag,
                    telemetry,
                    started,
                    retry_after=rate_decision.retry_after,
                )

            # §5.4 step 5: Headers (Content-Type, Idempotency-Key, Content-Length, X-Audio-Duration-Ms).
            base_mime, fmt = _parse_audio_content_type(request)
            idempotency_key = _parse_idempotency_key(request)
            declared_length = _parse_content_length(request)
            if declared_length is not None and declared_length > self._settings.VOICE_MAX_BYTES:
                raise _ApiError("too_large")
            duration_ms = _parse_duration_ms(request, max_seconds=self._settings.VOICE_MAX_SECONDS)

            # §5.4 step 6: Take a concurrency slot.
            async with self._concurrency_gate.slot():
                # §5.4 step 7: Read the body as a stream, counting bytes; enforce cap & Content-Length.
                audio_bytes, byte_len = await _read_stream_bounded(
                    request,
                    max_bytes=self._settings.VOICE_MAX_BYTES,
                    declared_length=declared_length,
                    over_cap_code="too_large",
                )

                # §5.4 step 8: digest = SHA-256(body).
                digest = hashlib.sha256(audio_bytes).hexdigest()

                async def run_owner() -> CachedResponse:
                    nonlocal audio_bytes
                    telemetry.ran = True
                    # §5.4 step 10: Under 1 KB -> no_speech (recorded in the idempotency entry).
                    if len(audio_bytes) < MIN_BODY_BYTES:
                        audio_bytes = b""
                        raise TranscribeError("no_speech")

                    # §5.4 step 11: Transcribe (budget reserved per attempt inside).
                    audio = Audio(mime_type=base_mime, data=audio_bytes, trusted_seconds=None)
                    audio_bytes = b""
                    transcript: Transcript = await transcriber.transcribe(audio, principal_key=p_key)

                    telemetry.model = (
                        transcript.model if transcript.model in self._allowed_models else "other"
                    )
                    telemetry.fallback = "true" if transcript.fallback else "false"
                    telemetry.tokens = _format_usage_tokens(transcript.usage)

                    # §5.4 step 12: Usage check of §3.5 via implied_audio_tokens.
                    if _exceeds_audio_token_limit(
                        transcript.usage, max_seconds=self._settings.VOICE_MAX_SECONDS
                    ):
                        raise TranscribeError("too_long")

                    # §5.4 step 13: Record in idempotency entry and respond.
                    return CachedResponse(
                        status=200,
                        body={"v": 1, "id": idempotency_key, "text": transcript.text},
                    )

                try:
                    cached = await self._idempotency_cache.run(p_key, idempotency_key, digest, run_owner)
                finally:
                    audio_bytes = b""
                    del audio_bytes

            response = json_ok(dict(cached.body))
            self._emit_voice_log(
                "ok",
                200,
                byte_len,
                duration_ms,
                fmt,
                principal_tag,
                telemetry,
                started,
                cached=not telemetry.ran,
            )
            return response
        except asyncio.CancelledError:
            raise
        except AuthError as err:
            status = 403 if err.code == "forbidden" else 401
            return self._log_voice(
                err.code, status, byte_len, duration_ms, fmt, principal_tag, telemetry, started
            )
        except ConcurrencyLimitError as err:
            return self._log_voice(
                "rate_limited",
                429,
                byte_len,
                duration_ms,
                fmt,
                principal_tag,
                telemetry,
                started,
                retry_after=err.retry_after,
            )
        except IdempotencyConflictError:
            return self._log_voice(
                "idempotency_conflict",
                409,
                byte_len,
                duration_ms,
                fmt,
                principal_tag,
                telemetry,
                started,
            )
        except NoSpeechError:
            return self._log_voice(
                "no_speech",
                422,
                byte_len,
                duration_ms,
                fmt,
                principal_tag,
                telemetry,
                started,
                cached=not telemetry.ran,
            )
        except OwnerAborted:
            return self._log_voice(
                "transcription_failed",
                502,
                byte_len,
                duration_ms,
                fmt,
                principal_tag,
                telemetry,
                started,
            )
        except TranscribeError as err:
            api_code, status, retry_after = self._map_transcribe_error(err, now)
            return self._log_voice(
                api_code,
                status,
                byte_len,
                duration_ms,
                fmt,
                principal_tag,
                telemetry,
                started,
                retry_after=retry_after,
            )
        except _ApiError as err:
            resp = error_response(
                err.code,
                max_seconds=self._settings.VOICE_MAX_SECONDS,
                retry_after=err.retry_after,
            )
            self._emit_voice_log(
                err.code,
                resp.status_code,
                byte_len,
                duration_ms,
                fmt,
                principal_tag,
                telemetry,
                started,
            )
            return resp
        except Exception as err:
            latency_ms = max(0, round((time.perf_counter() - started) * 1000))
            log.error(
                "voice transcription error: status=500 code=internal bytes=%d duration_ms=%s "
                "format=%s principal=%s latency_ms=%d cause=%s",
                byte_len,
                str(duration_ms) if duration_ms is not None else "none",
                fmt,
                principal_tag,
                latency_ms,
                logs.describe(err),
            )
            return error_response("internal", max_seconds=self._settings.VOICE_MAX_SECONDS)

    def _map_transcribe_error(
        self, err: TranscribeError, now: datetime | None
    ) -> tuple[str, int, int | None]:
        code = err.code
        if code == "unsupported_format":
            return "unsupported_format", 415, None
        if code == "too_long":
            return "too_long", 422, None
        if code == "no_speech":
            return "no_speech", 422, None
        if code == "budget_exhausted":
            ref_now = now if now is not None else self._clock()
            return "budget_exhausted", 429, seconds_until_midnight(ref_now, self._zone)
        if code == "timeout":
            return "timeout", 504, None
        if code == "disabled":
            return "disabled", 503, None
        return "transcription_failed", 502, None

    def _log_exchange(
        self,
        code: str,
        status: int,
        safe_kind: str,
        principal_tag: str,
        started: float,
        *,
        retry_after: int | None = None,
    ) -> JSONResponse:
        self._emit_exchange_log(code, status, safe_kind, principal_tag, started)
        return error_response(
            code,
            max_seconds=self._settings.VOICE_MAX_SECONDS,
            retry_after=retry_after,
        )

    @staticmethod
    def _emit_exchange_log(
        code: str,
        status: int,
        safe_kind: str,
        principal_tag: str,
        started: float,
    ) -> None:
        latency_ms = max(0, round((time.perf_counter() - started) * 1000))
        safe = "ok" if code == "ok" else logs.safe_code(code)
        log.info(
            "voice auth session: status=%d code=%s kind=%s principal=%s latency_ms=%d",
            status,
            safe,
            safe_kind,
            principal_tag,
            latency_ms,
        )

    def _log_voice(
        self,
        code: str,
        status: int,
        byte_len: int,
        duration_ms: int | None,
        fmt: str,
        principal_tag: str,
        telemetry: _RunTelemetry,
        started: float,
        *,
        retry_after: int | None = None,
        cached: bool = False,
    ) -> JSONResponse:
        self._emit_voice_log(
            code,
            status,
            byte_len,
            duration_ms,
            fmt,
            principal_tag,
            telemetry,
            started,
            cached=cached,
        )
        return error_response(
            code,
            max_seconds=self._settings.VOICE_MAX_SECONDS,
            retry_after=retry_after,
        )

    @staticmethod
    def _emit_voice_log(
        code: str,
        status: int,
        byte_len: int,
        duration_ms: int | None,
        fmt: str,
        principal_tag: str,
        telemetry: _RunTelemetry,
        started: float,
        *,
        cached: bool = False,
    ) -> None:
        latency_ms = max(0, round((time.perf_counter() - started) * 1000))
        safe = "ok" if code == "ok" else logs.safe_code(code)
        log.info(
            "voice transcription: status=%d code=%s bytes=%d duration_ms=%s format=%s "
            "model=%s fallback=%s tokens=%s cached=%s principal=%s latency_ms=%d",
            status,
            safe,
            byte_len,
            str(duration_ms) if duration_ms is not None else "none",
            fmt,
            telemetry.model,
            telemetry.fallback,
            telemetry.tokens,
            "true" if cached else "false",
            principal_tag,
            latency_ms,
        )
