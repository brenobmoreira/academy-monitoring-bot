"""Pure in-memory rate limiters for the voice service (spec §5.6 and §6.7).

All time reads go through an injected clock (defaulting to ``time.monotonic``). Both minute and
day limits use sliding windows (60 s and 86 400 s) and clamp backwards clock steps per window so
that NTP steps or DST fall-backs never release quota early.
"""

from __future__ import annotations

import asyncio
import contextlib
import math
import threading
import time
from collections import deque
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, TypeVar

# Spec §5.6: per-principal voice transcription limits.
VOICE_RATE_PER_MIN = 6
VOICE_RATE_PER_DAY = 60
VOICE_MAX_CONCURRENT = 4
CONCURRENCY_RETRY_AFTER = 2

# Spec §5.5 (D6): finished idempotency entries TTL.
IDEMPOTENCY_TTL_S = 300.0

# Spec §6.7: POST /v1/auth/sessions exchange limits.
EXCHANGE_RATE_PER_MIN = 30  # per process
EXCHANGE_RATE_PER_DAY = 20  # per principal

MINUTE_WINDOW_S = 60.0
DAY_WINDOW_S = 86_400.0
_GC_THRESHOLD = 4096

Clock = Callable[[], float | datetime]
T = TypeVar("T")


@dataclass(frozen=True)
class RateLimitDecision:
    """Result of a rate-limit check (`bool(decision)` is True when allowed)."""

    allowed: bool
    retry_after: int = 0

    def __bool__(self) -> bool:
        return self.allowed


def _to_seconds(value: float | datetime) -> float:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC).timestamp()
        return value.timestamp()
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"clock must return a finite number or datetime, got {value!r}")
    return float(value)


class _SlidingWindow:
    """Thread-unsafe sliding-window timestamp tracker (callers hold a lock)."""

    __slots__ = ("limit", "window_s", "_entries", "_last_now")

    def __init__(self, limit: int, window_s: float) -> None:
        if limit < 1:
            raise ValueError(f"limit must be >= 1, got {limit}")
        if window_s <= 0:
            raise ValueError(f"window_s must be > 0, got {window_s}")
        self.limit = limit
        self.window_s = window_s
        self._entries: deque[float] = deque()
        self._last_now: float | None = None

    def clamp_now(self, raw_now: float) -> float:
        now = raw_now if self._last_now is None else max(raw_now, self._last_now)
        self._last_now = now
        return now

    def prune(self, now: float) -> None:
        cutoff_shift = self.window_s
        while self._entries and self._entries[0] + cutoff_shift <= now:
            self._entries.popleft()

    def wait_seconds(self, now: float) -> float | None:
        """Seconds until space opens, or None when below the limit."""
        if len(self._entries) < self.limit:
            return None
        return max(0.0, self._entries[0] + self.window_s - now)

    def record(self, now: float) -> None:
        self._entries.append(now)

    def is_stale(self, raw_now: float) -> bool:
        return self._last_now is not None and self._last_now + self.window_s <= raw_now


def _retry_seconds(wait_s: float) -> int:
    return max(1, math.ceil(wait_s))


class _PrincipalWindows:
    __slots__ = ("minute", "day", "last_now")

    def __init__(self, per_minute: int, per_day: int) -> None:
        self.minute = _SlidingWindow(per_minute, MINUTE_WINDOW_S)
        self.day = _SlidingWindow(per_day, DAY_WINDOW_S)
        self.last_now: float | None = None

    def clamp_now(self, raw_now: float) -> float:
        now = raw_now if self.last_now is None else max(raw_now, self.last_now)
        self.last_now = now
        return now


class RateLimiter:
    """Thread-safe per-principal sliding-window limiter (minute and day)."""

    def __init__(
        self,
        per_minute: int = VOICE_RATE_PER_MIN,
        per_day: int = VOICE_RATE_PER_DAY,
        *,
        clock: Clock = time.monotonic,
    ) -> None:
        if per_minute < 1:
            raise ValueError(f"per_minute must be >= 1, got {per_minute}")
        if per_day < 1:
            raise ValueError(f"per_day must be >= 1, got {per_day}")
        self._per_minute = per_minute
        self._per_day = per_day
        self._clock = clock
        self._lock = threading.Lock()
        self._principals: dict[str, _PrincipalWindows] = {}

    def allow(self, principal_key: str, *, now: float | datetime | None = None) -> RateLimitDecision:
        raw_now = _to_seconds(self._clock() if now is None else now)
        with self._lock:
            state = self._principals.get(principal_key)
            if state is None:
                if len(self._principals) >= _GC_THRESHOLD:
                    self._gc(raw_now)
                state = _PrincipalWindows(self._per_minute, self._per_day)
                self._principals[principal_key] = state
            clamped = state.clamp_now(raw_now)
            state.minute.prune(clamped)
            state.day.prune(clamped)
            wait_min = state.minute.wait_seconds(clamped)
            wait_day = state.day.wait_seconds(clamped)
            if wait_min is not None or wait_day is not None:
                waits = [w for w in (wait_min, wait_day) if w is not None]
                return RateLimitDecision(allowed=False, retry_after=_retry_seconds(max(waits)))
            state.minute.record(clamped)
            state.day.record(clamped)
            return RateLimitDecision(allowed=True)

    def _gc(self, raw_now: float) -> None:
        stale = [
            key
            for key, state in self._principals.items()
            if state.last_now is not None and state.last_now + DAY_WINDOW_S <= raw_now
        ]
        for key in stale:
            del self._principals[key]


class ExchangeLimiter:
    """Thread-safe rate limiter for credential-to-session exchanges (§6.7).

    Enforces both:
    - per-process sliding minute limit (default 30/min), checkable before credential parsing;
    - per-principal sliding day limit (default 20/day), checkable once principal is known.
    """

    def __init__(
        self,
        per_minute: int = EXCHANGE_RATE_PER_MIN,
        per_day_per_principal: int = EXCHANGE_RATE_PER_DAY,
        *,
        clock: Clock = time.monotonic,
    ) -> None:
        if per_minute < 1:
            raise ValueError(f"per_minute must be >= 1, got {per_minute}")
        if per_day_per_principal < 1:
            raise ValueError(f"per_day_per_principal must be >= 1, got {per_day_per_principal}")
        self._per_day_per_principal = per_day_per_principal
        self._clock = clock
        self._lock = threading.Lock()
        self._process_minute = _SlidingWindow(per_minute, MINUTE_WINDOW_S)
        self._principals: dict[str, _SlidingWindow] = {}

    def allow_process(self, *, now: float | datetime | None = None) -> RateLimitDecision:
        """Check and consume one slot in the per-process minute window."""
        raw_now = _to_seconds(self._clock() if now is None else now)
        with self._lock:
            clamped = self._process_minute.clamp_now(raw_now)
            self._process_minute.prune(clamped)
            wait = self._process_minute.wait_seconds(clamped)
            if wait is not None:
                return RateLimitDecision(allowed=False, retry_after=_retry_seconds(wait))
            self._process_minute.record(clamped)
            return RateLimitDecision(allowed=True)

    def allow_principal(
        self, principal_key: str, *, now: float | datetime | None = None
    ) -> RateLimitDecision:
        """Check and consume one slot in `principal_key`'s daily window."""
        raw_now = _to_seconds(self._clock() if now is None else now)
        with self._lock:
            window = self._get_principal(principal_key, raw_now)
            clamped = window.clamp_now(raw_now)
            window.prune(clamped)
            wait = window.wait_seconds(clamped)
            if wait is not None:
                return RateLimitDecision(allowed=False, retry_after=_retry_seconds(wait))
            window.record(clamped)
            return RateLimitDecision(allowed=True)

    def allow(self, principal_key: str, *, now: float | datetime | None = None) -> RateLimitDecision:
        """Atomically check and consume both the process minute limit and principal day limit."""
        raw_now = _to_seconds(self._clock() if now is None else now)
        with self._lock:
            proc_now = self._process_minute.clamp_now(raw_now)
            self._process_minute.prune(proc_now)
            wait_proc = self._process_minute.wait_seconds(proc_now)

            prin_window = self._get_principal(principal_key, raw_now)
            prin_now = prin_window.clamp_now(raw_now)
            prin_window.prune(prin_now)
            wait_prin = prin_window.wait_seconds(prin_now)

            if wait_proc is not None or wait_prin is not None:
                waits = [w for w in (wait_proc, wait_prin) if w is not None]
                return RateLimitDecision(allowed=False, retry_after=_retry_seconds(max(waits)))
            self._process_minute.record(proc_now)
            prin_window.record(prin_now)
            return RateLimitDecision(allowed=True)

    def _get_principal(self, principal_key: str, raw_now: float) -> _SlidingWindow:
        window = self._principals.get(principal_key)
        if window is None:
            if len(self._principals) >= _GC_THRESHOLD:
                for key in [k for k, w in self._principals.items() if w.is_stale(raw_now)]:
                    del self._principals[key]
            window = _SlidingWindow(self._per_day_per_principal, DAY_WINDOW_S)
            self._principals[principal_key] = window
        return window


class ConcurrencyLimitError(Exception):
    """Raised when `VOICE_MAX_CONCURRENT` transcriptions are already in flight (§5.6)."""

    def __init__(self, retry_after: int = CONCURRENCY_RETRY_AFTER) -> None:
        super().__init__("concurrency limit reached")
        self.retry_after = retry_after


class ConcurrencyGate:
    """Bounded non-blocking concurrency gate per process (§5.6)."""

    def __init__(
        self,
        max_concurrent: int = VOICE_MAX_CONCURRENT,
        *,
        retry_after: int = CONCURRENCY_RETRY_AFTER,
    ) -> None:
        if max_concurrent < 1:
            raise ValueError(f"max_concurrent must be >= 1, got {max_concurrent}")
        if retry_after < 1:
            raise ValueError(f"retry_after must be >= 1, got {retry_after}")
        self._max_concurrent = max_concurrent
        self._retry_after = retry_after
        self._active = 0
        self._lock = threading.Lock()

    @property
    def max_concurrent(self) -> int:
        return self._max_concurrent

    @property
    def active(self) -> int:
        with self._lock:
            return self._active

    def _try_acquire(self) -> bool:
        with self._lock:
            if self._active >= self._max_concurrent:
                return False
            self._active += 1
            return True

    def _release(self) -> None:
        with self._lock:
            if self._active > 0:
                self._active -= 1

    @contextlib.asynccontextmanager
    async def slot(self) -> AsyncIterator[None]:
        if not self._try_acquire():
            raise ConcurrencyLimitError(self._retry_after)
        try:
            yield
        finally:
            self._release()


class IdempotencyConflictError(Exception):
    """Raised when `(principal_key, idempotency_key)` is reused with a different body digest (§5.5)."""


class OwnerAborted(Exception):
    """Raised in waiters when the in-flight owner is cancelled or fails unexpectedly (§5.5)."""


@dataclass(frozen=True)
class CachedResponse:
    """Pure response value tracked by `IdempotencyCache` without coupling to HTTP."""

    status: int
    body: Any = None
    code: str | None = None


@dataclass
class _InFlightEntry:
    digest: str
    future: asyncio.Future[Any]


@dataclass
class _FinishedEntry:
    digest: str
    expires_at: float
    result: Any
    is_error: bool = False


def _consume_exception(future: asyncio.Future[Any]) -> None:
    if not future.cancelled():
        future.exception()


def _is_cacheable(result: Any) -> bool:
    status = getattr(result, "status", None)
    if status is not None:
        code = getattr(result, "code", None)
        return status == 200 or (status == 422 and code == "no_speech")
    return True


def _default_error_code(exc: BaseException) -> str | None:
    if isinstance(exc, Exception):
        code = getattr(exc, "code", None)
        if isinstance(code, str):
            return code
    return None


class IdempotencyCache:
    """Digest-first idempotency store with owner/waiter semantics (§5.5).

    Keyed by `(principal_key, idempotency_key)`. Stores only digests and responses (never audio).
    Only `200` and `no_speech` outcomes are kept for `ttl_s` (5 minutes); other errors delete the
    entry so a retry can run again.
    """

    def __init__(
        self,
        ttl_s: float = IDEMPOTENCY_TTL_S,
        *,
        clock: Clock = time.monotonic,
        error_code: Callable[[BaseException], str | None] = _default_error_code,
    ) -> None:
        if ttl_s <= 0:
            raise ValueError(f"ttl_s must be > 0, got {ttl_s}")
        self._ttl_s = ttl_s
        self._clock = clock
        self._error_code = error_code
        self._entries: dict[tuple[str, str], _InFlightEntry | _FinishedEntry] = {}
        self._last_now: float | None = None

    def _now(self) -> float:
        raw = _to_seconds(self._clock())
        now = raw if self._last_now is None else max(raw, self._last_now)
        self._last_now = now
        return now

    def _prune(self, now: float) -> None:
        expired = [
            key
            for key, entry in self._entries.items()
            if isinstance(entry, _FinishedEntry) and entry.expires_at <= now
        ]
        for key in expired:
            del self._entries[key]

    def __len__(self) -> int:
        self._prune(self._now())
        return len(self._entries)

    async def run(
        self,
        principal_key: str,
        idempotency_key: str,
        digest: str,
        fn: Callable[[], Awaitable[T]],
    ) -> T:
        now = self._now()
        self._prune(now)
        key = (principal_key, idempotency_key)
        existing = self._entries.get(key)
        if existing is not None:
            if existing.digest != digest:
                raise IdempotencyConflictError()
            if isinstance(existing, _FinishedEntry):
                if existing.is_error:
                    raise existing.result
                return existing.result
            return await asyncio.shield(existing.future)

        loop = asyncio.get_running_loop()
        future: asyncio.Future[T] = loop.create_future()
        future.add_done_callback(_consume_exception)
        in_flight = _InFlightEntry(digest=digest, future=future)
        self._entries[key] = in_flight

        try:
            result = await fn()
        except BaseException as exc:
            code = self._error_code(exc)
            if code is not None:
                if code == "no_speech":
                    finish_now = self._now()
                    self._entries[key] = _FinishedEntry(
                        digest=digest,
                        expires_at=finish_now + self._ttl_s,
                        result=exc,
                        is_error=True,
                    )
                elif self._entries.get(key) is in_flight:
                    del self._entries[key]
                if not future.done():
                    future.set_exception(exc)
                    future.exception()
                raise
            if self._entries.get(key) is in_flight:
                del self._entries[key]
            if not future.done():
                future.set_exception(OwnerAborted())
                future.exception()
            raise

        if _is_cacheable(result):
            finish_now = self._now()
            self._entries[key] = _FinishedEntry(
                digest=digest,
                expires_at=finish_now + self._ttl_s,
                result=result,
                is_error=False,
            )
        elif self._entries.get(key) is in_flight:
            del self._entries[key]
        if not future.done():
            future.set_result(result)
        return result
