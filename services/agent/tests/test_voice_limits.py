from __future__ import annotations

import threading
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from agent.voice_limits import (
    DAY_WINDOW_S,
    EXCHANGE_RATE_PER_DAY,
    EXCHANGE_RATE_PER_MIN,
    MINUTE_WINDOW_S,
    VOICE_RATE_PER_DAY,
    VOICE_RATE_PER_MIN,
    ExchangeLimiter,
    RateLimiter,
)

pytestmark = pytest.mark.unit

SAO_PAULO = ZoneInfo("America/Sao_Paulo")


class FakeClock:
    def __init__(self, start: float = 0.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> float:
        self.now += seconds
        return self.now


class FakeDateTimeClock:
    def __init__(self, start: datetime) -> None:
        self.now = start

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **kwargs: float) -> datetime:
        self.now += timedelta(**kwargs)
        return self.now


# ---- RateLimiter: exact limits & defaults --------------------------------------------------------


def test_rate_limiter_default_minute_limit_exact():
    clock = FakeClock(100.0)
    limiter = RateLimiter(clock=clock)

    for _ in range(VOICE_RATE_PER_MIN):
        decision = limiter.allow("test:u1")
        assert decision
        assert decision.allowed is True
        assert decision.retry_after == 0

    refused = limiter.allow("test:u1")
    assert not refused
    assert refused.allowed is False
    assert refused.retry_after == int(MINUTE_WINDOW_S)


def test_rate_limiter_default_day_limit_exact():
    clock = FakeClock(0.0)
    limiter = RateLimiter(clock=clock)

    # 10 batches of 6 spaced by 60 s = 60 requests (exact VOICE_RATE_PER_DAY).
    batches = VOICE_RATE_PER_DAY // VOICE_RATE_PER_MIN
    assert batches * VOICE_RATE_PER_MIN == VOICE_RATE_PER_DAY
    for batch in range(batches):
        for _ in range(VOICE_RATE_PER_MIN):
            assert limiter.allow("test:u1")
        if batch < batches - 1:
            clock.advance(MINUTE_WINDOW_S)

    # Advance past the last minute window: minute bucket is empty, day bucket is full (60).
    clock.advance(MINUTE_WINDOW_S)  # now = 600.0
    refused = limiter.allow("test:u1")
    assert not refused
    assert refused.retry_after == int(DAY_WINDOW_S - 600.0)


# ---- RateLimiter: sliding windows & boundary (< vs <=) -------------------------------------------


def test_rate_limiter_minute_window_slides_and_frees_at_exact_boundary():
    clock = FakeClock(100.0)
    limiter = RateLimiter(per_minute=6, per_day=60, clock=clock)

    # Staggered entries at 100, 110, 120, 130, 140, 150.
    for _ in range(6):
        assert limiter.allow("test:u1")
        clock.advance(10.0)

    # Now at 160.0 -> wait, 100 + 60 == 160.0, so let's check at 159.999 first!
    clock.now = 159.999
    refused = limiter.allow("test:u1")
    assert not refused
    assert refused.retry_after == 1

    # Refused calls must not consume quota; at exact boundary 100 + 60 == 160.0 one slot opens.
    clock.now = 160.0
    assert limiter.allow("test:u1")

    # 7th active in [110..160] is refused until 110 + 60 == 170.
    clock.now = 165.2
    refused2 = limiter.allow("test:u1")
    assert not refused2
    assert refused2.retry_after == 5  # ceil(170.0 - 165.2)

    clock.now = 170.0
    assert limiter.allow("test:u1")


def test_rate_limiter_day_window_exact_boundary_and_retry_after_max():
    clock = FakeClock(0.1)
    limiter = RateLimiter(per_minute=3, per_day=5, clock=clock)

    # 3 at t=0.1, then 2 at t=86_380.1 (total 5 in day).
    for _ in range(3):
        assert limiter.allow("test:u1")
    clock.now = 86_380.1
    for _ in range(2):
        assert limiter.allow("test:u1")

    # At 86_399.5: still 1.6 s before 0.1 + 86_400 = 86_400.1 -> refused.
    clock.now = 86_399.5
    refused = limiter.allow("test:u1")
    assert not refused
    assert refused.retry_after == 1

    # At exact 0.1 + 86_400.0 = 86_400.1: the 3 requests from 0.1 slide out.
    clock.now = 86_400.1
    assert limiter.allow("test:u1")


def test_rate_limiter_both_windows_full_returns_larger_retry_after():
    clock = FakeClock(0.0)
    limiter = RateLimiter(per_minute=2, per_day=4, clock=clock)

    # 2 at t=0.0, then 2 at t=86_380.0 -> day full (4), minute full (2 at 86_380).
    assert limiter.allow("test:u1")
    assert limiter.allow("test:u1")
    clock.now = 86_380.0
    assert limiter.allow("test:u1")
    assert limiter.allow("test:u1")

    # At 86_390.0: day opens in 10 s (86_400), minute opens in 50 s (86_440).
    clock.now = 86_390.0
    refused = limiter.allow("test:u1")
    assert not refused
    assert refused.retry_after == 50

    # At 86_400.0: day window now has 2 slots free, but minute window still has 2 -> still refused.
    clock.now = 86_400.0
    still_refused = limiter.allow("test:u1")
    assert not still_refused
    assert still_refused.retry_after == 40

    # At 86_440.0: both windows are open.
    clock.now = 86_440.0
    assert limiter.allow("test:u1")


def test_rate_limiter_refused_requests_do_not_consume_daily_or_minute_quota():
    clock = FakeClock(0.0)
    limiter = RateLimiter(per_minute=2, per_day=4, clock=clock)

    assert limiter.allow("test:u1")
    assert limiter.allow("test:u1")
    # Spam 10 refused requests in the same minute.
    for _ in range(10):
        assert not limiter.allow("test:u1")

    clock.advance(MINUTE_WINDOW_S)
    # Daily quota must still have 2 remaining (not polluted by the 10 refused calls).
    assert limiter.allow("test:u1")
    assert limiter.allow("test:u1")
    assert not limiter.allow("test:u1")


# ---- RateLimiter: independent principals ---------------------------------------------------------


def test_rate_limiter_principals_are_independent():
    clock = FakeClock(0.0)
    limiter = RateLimiter(clock=clock)

    for _ in range(VOICE_RATE_PER_MIN):
        assert limiter.allow("test:u1")
    assert not limiter.allow("test:u1")

    # Second principal has full independent minute & day quotas.
    for _ in range(VOICE_RATE_PER_MIN):
        assert limiter.allow("test:u2")
    assert not limiter.allow("test:u2")


# ---- Day rollover according to the spec (sliding 24h window with datetime clock) -----------------


def test_rate_limiter_day_rollover_follows_sliding_24h_window():
    clock = FakeDateTimeClock(datetime(2026, 11, 16, 23, 50, 0, tzinfo=SAO_PAULO))
    limiter = RateLimiter(per_minute=6, per_day=12, clock=clock)

    for _ in range(6):
        assert limiter.allow("telegram:9001")
    clock.advance(minutes=2)  # 23:52:00
    for _ in range(6):
        assert limiter.allow("telegram:9001")

    # Cross calendar midnight in America/Sao_Paulo to 2026-11-17 00:05:00:
    # under §5.6 / §13 C5b sliding windows, midnight does NOT reset the 24h limit.
    clock.advance(minutes=13)  # 2026-11-17 00:05:00
    refused = limiter.allow("telegram:9001")
    assert not refused
    assert refused.retry_after == int(23 * 3600 + 45 * 60)

    # Just before 24h after the first batch (23:49:59): still refused.
    clock.now = datetime(2026, 11, 17, 23, 49, 59, tzinfo=SAO_PAULO)
    assert not limiter.allow("telegram:9001")

    # Exactly 24h after the first batch (23:50:00): first 6 slide out, 6 new allowed.
    clock.now = datetime(2026, 11, 17, 23, 50, 0, tzinfo=SAO_PAULO)
    for _ in range(6):
        assert limiter.allow("telegram:9001")
    assert not limiter.allow("telegram:9001")


def test_naive_datetime_clock_supported():
    clock = FakeDateTimeClock(datetime(2026, 11, 16, 12, 0, 0))
    limiter = RateLimiter(per_minute=1, per_day=5, clock=clock)

    assert limiter.allow("test:u1")
    assert not limiter.allow("test:u1")
    clock.advance(seconds=60)
    assert limiter.allow("test:u1")


# ---- Clock moving backwards frees nothing --------------------------------------------------------


def test_rate_limiter_backwards_clock_frees_nothing():
    clock = FakeClock(1000.0)
    limiter = RateLimiter(per_minute=6, per_day=60, clock=clock)

    for _ in range(6):
        assert limiter.allow("test:u1")
    assert not limiter.allow("test:u1")

    # Jump clock backwards (to before the window, to zero, and even negative).
    for back_t in (990.0, 500.0, 0.0, -100.0):
        clock.now = back_t
        refused = limiter.allow("test:u1")
        assert not refused
        assert refused.retry_after >= 1

    # Return to 1059.0 (still inside the original [1000, 1060) window): still refused.
    clock.now = 1059.0
    assert not limiter.allow("test:u1")

    # Only once clock passes 1060.0 does the window open.
    clock.now = 1060.0
    assert limiter.allow("test:u1")


def test_rate_limiter_backwards_clock_does_not_backdate_new_entries_or_affect_other_principals():
    clock = FakeClock(1000.0)
    limiter = RateLimiter(per_minute=2, per_day=10, clock=clock)

    assert limiter.allow("test:u1")

    # Clock steps backwards to 100.0; u1's second request is clamped to 1000.0, not 100.0.
    clock.now = 100.0
    assert limiter.allow("test:u1")
    assert not limiter.allow("test:u1")

    # Untouched principal u2 starts on its own timeline at 100.0 and expires at 160.0.
    assert limiter.allow("test:u2")
    assert limiter.allow("test:u2")
    assert not limiter.allow("test:u2")

    clock.now = 160.0
    assert limiter.allow("test:u2")
    # Meanwhile u1's requests were at 1000.0, so at 160.0 u1 is still blocked!
    assert not limiter.allow("test:u1")

    clock.now = 1060.0
    assert limiter.allow("test:u1")


def test_datetime_clock_backwards_fall_back_frees_nothing():
    clock = FakeDateTimeClock(datetime(2026, 11, 16, 1, 30, 0, tzinfo=SAO_PAULO))
    limiter = RateLimiter(per_minute=2, per_day=10, clock=clock)

    assert limiter.allow("test:u1")
    assert limiter.allow("test:u1")
    assert not limiter.allow("test:u1")

    clock.advance(hours=-1)
    assert not limiter.allow("test:u1")

    clock.advance(hours=1, seconds=59)
    assert not limiter.allow("test:u1")

    clock.advance(seconds=1)
    assert limiter.allow("test:u1")


# ---- ExchangeLimiter (§6.7: 30/min per process, 20/day per principal) ----------------------------


def test_exchange_limiter_process_minute_limit_exact_and_sliding():
    clock = FakeClock(10.0)
    limiter = ExchangeLimiter(clock=clock)

    for i in range(EXCHANGE_RATE_PER_MIN):
        assert limiter.allow_process()
        if i == 0:
            clock.advance(1.0)

    # 30 requests: first at 10.0, remaining 29 at 11.0.
    # At 69.9: first has not left yet -> refused.
    clock.now = 69.9
    refused = limiter.allow_process()
    assert not refused
    assert refused.retry_after == 1

    # At exact 10.0 + 60.0 == 70.0: first slides out -> 1 allowed, next refused (wait until 71.0).
    clock.now = 70.0
    assert limiter.allow_process()
    refused2 = limiter.allow_process()
    assert not refused2
    assert refused2.retry_after == 1


def test_exchange_limiter_principal_day_limit_exact_and_rollover():
    clock = FakeDateTimeClock(datetime(2026, 11, 16, 23, 55, 0, tzinfo=SAO_PAULO))
    limiter = ExchangeLimiter(clock=clock)

    for _ in range(EXCHANGE_RATE_PER_DAY):
        assert limiter.allow("test:u1")
    refused = limiter.allow("test:u1")
    assert not refused
    assert refused.retry_after == int(DAY_WINDOW_S)

    # Another principal is unaffected by u1's daily quota.
    assert limiter.allow("test:u2")

    # Crossing midnight does not reset the 24h sliding window.
    clock.advance(minutes=10)  # 2026-11-17 00:05:00
    assert not limiter.allow("test:u1")

    # Advancing 24h from 23:55:00 frees u1's slots.
    clock.now = datetime(2026, 11, 17, 23, 55, 0, tzinfo=SAO_PAULO)
    assert limiter.allow("test:u1")


def test_exchange_limiter_combined_allow_is_atomic_and_process_limit_shared():
    clock = FakeClock(0.0)
    limiter = ExchangeLimiter(clock=clock)

    # Exhaust u1's 20/day limit (uses 20 of the 30/min process slots).
    for _ in range(EXCHANGE_RATE_PER_DAY):
        assert limiter.allow("test:u1")
    # Refused u1 calls must NOT consume the remaining 10 process-minute slots.
    for _ in range(15):
        assert not limiter.allow("test:u1")

    # u2 can still take all 10 remaining process-minute slots (20 + 10 = 30).
    for _ in range(EXCHANGE_RATE_PER_MIN - EXCHANGE_RATE_PER_DAY):
        assert limiter.allow("test:u2")

    # 31st request in the minute (u3) is refused by the process limit and does not consume u3's daily quota.
    refused = limiter.allow("test:u3")
    assert not refused
    assert refused.retry_after == int(MINUTE_WINDOW_S)

    clock.advance(MINUTE_WINDOW_S)
    # u3 still has its full 20/day quota.
    for _ in range(EXCHANGE_RATE_PER_DAY):
        assert limiter.allow("test:u3")
    assert not limiter.allow("test:u3")


def test_exchange_limiter_backwards_clock_frees_nothing():
    clock = FakeClock(500.0)
    limiter = ExchangeLimiter(clock=clock)

    for _ in range(EXCHANGE_RATE_PER_MIN):
        assert limiter.allow_process()
    assert not limiter.allow_process()

    for _ in range(EXCHANGE_RATE_PER_DAY):
        assert limiter.allow_principal("test:u1")
    assert not limiter.allow_principal("test:u1")

    clock.now = 100.0
    assert not limiter.allow_process()
    assert not limiter.allow_principal("test:u1")
    assert not limiter.allow("test:u1")


# ---- Concurrency & validation --------------------------------------------------------------------


def test_rate_limiter_is_thread_safe_under_barrier():
    clock = FakeClock(100.0)
    limiter = RateLimiter(per_minute=6, per_day=60, clock=clock)
    n_threads = 24
    barrier = threading.Barrier(n_threads)
    results: list[bool] = []
    lock = threading.Lock()

    def worker() -> None:
        barrier.wait()
        ok = bool(limiter.allow("test:concurrent"))
        with lock:
            results.append(ok)

    threads = [threading.Thread(target=worker) for _ in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sum(results) == 6
    assert len(results) == n_threads


def test_exchange_limiter_is_thread_safe_under_barrier():
    clock = FakeClock(100.0)
    limiter = ExchangeLimiter(per_minute=10, per_day_per_principal=20, clock=clock)
    n_threads = 25
    barrier = threading.Barrier(n_threads)
    results: list[bool] = []
    lock = threading.Lock()

    def worker(idx: int) -> None:
        barrier.wait()
        ok = bool(limiter.allow(f"test:u{idx}"))
        with lock:
            results.append(ok)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(n_threads)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert sum(results) == 10
    assert len(results) == n_threads


def test_invalid_limits_and_clock_values_rejected():
    with pytest.raises(ValueError):
        RateLimiter(per_minute=0)
    with pytest.raises(ValueError):
        RateLimiter(per_day=0)
    with pytest.raises(ValueError):
        ExchangeLimiter(per_minute=0)
    with pytest.raises(ValueError):
        ExchangeLimiter(per_day_per_principal=0)

    bad_limiter = RateLimiter(clock=lambda: float("nan"))
    with pytest.raises(ValueError):
        bad_limiter.allow("test:u1")
    bool_limiter = RateLimiter(clock=lambda: True)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        bool_limiter.allow("test:u1")
