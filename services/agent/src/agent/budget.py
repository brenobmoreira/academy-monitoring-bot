"""Approximate token budget for transcription (voice spec §5.6).

A `Budget` hands out reservations. Each model attempt reserves the most it can cost, then settles
at what it did cost (or releases the reservation when it cost nothing). `MemoryBudget` keeps the
counters in process memory, per principal and for the whole process, per day in a time zone:

- a new process starts from zero (a cold start renews the counters);
- the first reservation of a new day starts from zero too (an instance that stays up across
  midnight gets fresh counters without restarting);
- a reservation belongs to the day it was made: settling it later changes that day, not today.

So the limits hold per day, per instance and per counter life. This is approximate by design:
several instances, restarts and midnights each add their own allowance (the provider's spend cap
is the real ceiling). Nothing here logs; principals are opaque keys.
"""

from __future__ import annotations

import threading
from datetime import date, datetime
from typing import Protocol
from zoneinfo import ZoneInfo


class Reservation(Protocol):
    def settle(self, tokens: int) -> None:
        """Replaces the reserved amount with the actual one (it may be larger). Only the first
        settle or release has an effect."""

    def release(self) -> None:
        """The attempt cost nothing: the reserved amount goes back."""


class Budget(Protocol):
    def reserve(self, principal_key: str, tokens: int, now: datetime) -> Reservation | None:
        """Atomically reserves `tokens` against the principal's and the process's budget for the
        day of `now`; None when either would be passed."""


class _Day:
    """The counters of one day. A reservation keeps a reference to its own."""

    def __init__(self, day: date) -> None:
        self.day = day
        self.total = 0
        self.per_principal: dict[str, int] = {}


class _MemoryReservation:
    def __init__(self, budget: MemoryBudget, day: _Day, principal_key: str, tokens: int) -> None:
        self._budget = budget
        self._day = day
        self._principal_key = principal_key
        self._tokens = tokens
        self._done = False

    def settle(self, tokens: int) -> None:
        _check(tokens)
        with self._budget._lock:
            if self._done:
                return
            self._done = True
            self._apply(tokens - self._tokens)

    def release(self) -> None:
        with self._budget._lock:
            if self._done:
                return
            self._done = True
            self._apply(-self._tokens)

    def _apply(self, delta: int) -> None:
        self._day.total += delta
        per = self._day.per_principal
        per[self._principal_key] = per.get(self._principal_key, 0) + delta


def _check(tokens: int) -> None:
    if isinstance(tokens, bool) or not isinstance(tokens, int) or tokens < 0:
        raise ValueError("tokens must be a non-negative integer")


class MemoryBudget:
    def __init__(self, *, principal_daily: int, global_daily: int, timezone: str) -> None:
        self.principal_daily = principal_daily
        self.global_daily = global_daily
        self._zone = ZoneInfo(timezone)
        self._lock = threading.Lock()
        self._current: _Day | None = None

    def _day_for(self, now: datetime) -> _Day:
        """The counters of `now`'s day; call with the lock held. Only moves forward: a clock
        reading from an earlier day keeps counting on the current one."""
        today = now.astimezone(self._zone).date()
        if self._current is None or today > self._current.day:
            self._current = _Day(today)
        return self._current

    def reserve(self, principal_key: str, tokens: int, now: datetime) -> Reservation | None:
        _check(tokens)
        with self._lock:
            day = self._day_for(now)
            mine = day.per_principal.get(principal_key, 0)
            if mine + tokens > self.principal_daily or day.total + tokens > self.global_daily:
                return None
            day.per_principal[principal_key] = mine + tokens
            day.total += tokens
            return _MemoryReservation(self, day, principal_key, tokens)

    def used(self, principal_key: str, now: datetime) -> tuple[int, int]:
        """(the principal's, the process's) counted tokens for the day of `now`."""
        with self._lock:
            day = self._day_for(now)
            return day.per_principal.get(principal_key, 0), day.total
