"""Pure in-memory rate limiters for the voice service (spec §5.6 and §6.7).

All time reads go through an injected clock (defaulting to ``time.monotonic``). Both minute and
day limits use sliding windows (60 s and 86 400 s) and clamp backwards clock steps per window so
that NTP steps or DST fall-backs never release quota early.
"""

from __future__ import annotations

import math
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

# Spec §5.6: per-principal voice transcription limits.
VOICE_RATE_PER_MIN = 6
VOICE_RATE_PER_DAY = 60

# Spec §6.7: POST /v1/auth/sessions exchange limits.
EXCHANGE_RATE_PER_MIN = 30  # per process
EXCHANGE_RATE_PER_DAY = 20  # per principal

MINUTE_WINDOW_S = 60.0
DAY_WINDOW_S = 86_400.0
_GC_THRESHOLD = 4096

Clock = Callable[[], float | datetime]


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
