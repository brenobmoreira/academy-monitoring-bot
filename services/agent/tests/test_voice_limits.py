from __future__ import annotations

import asyncio
import contextlib
import gc
import logging
import threading
import traceback
import warnings
import weakref
from datetime import datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

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
    _InFlightEntry,
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

    for _ in range(6):
        decision = limiter.allow("test:u1")
        assert decision
        assert decision.allowed is True
        assert decision.retry_after == 0

    # 7th request in the same minute is the first refusal (§5.6: 6 per minute).
    refused = limiter.allow("test:u1")
    assert not refused
    assert refused.allowed is False
    assert refused.retry_after == 60


def test_rate_limiter_default_day_limit_exact():
    clock = FakeClock(0.0)
    limiter = RateLimiter(clock=clock)

    # 10 batches of 6 spaced by 60 s = 60 requests (§5.6: 60 per day).
    for batch in range(10):
        for _ in range(6):
            assert limiter.allow("test:u1")
        if batch < 9:
            clock.advance(60.0)

    # Advance past the last minute window: minute bucket is empty, day bucket is full (60).
    clock.advance(60.0)  # now = 600.0
    # 61st request in 24h is the first refusal.
    refused = limiter.allow("test:u1")
    assert not refused
    assert refused.retry_after == 85_800  # 86_400 - 600


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

    clock.advance(60.0)
    # Daily quota must still have 2 remaining (not polluted by the 10 refused calls).
    assert limiter.allow("test:u1")
    assert limiter.allow("test:u1")
    assert not limiter.allow("test:u1")


# ---- RateLimiter: independent principals ---------------------------------------------------------


def test_rate_limiter_principals_are_independent():
    clock = FakeClock(0.0)
    limiter = RateLimiter(clock=clock)

    for _ in range(6):
        assert limiter.allow("test:u1")
    assert not limiter.allow("test:u1")

    # Second principal has full independent minute & day quotas.
    for _ in range(6):
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

    for i in range(30):
        assert limiter.allow_process()
        if i == 0:
            clock.advance(1.0)

    # 30 requests: first at 10.0, remaining 29 at 11.0.
    # At 69.9: 31st request is refused because the first has not left the 60 s window yet.
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

    for _ in range(20):
        assert limiter.allow("test:u1")
    # 21st request for the same principal in 24h is the first refusal (§6.7: 20 per day).
    refused = limiter.allow("test:u1")
    assert not refused
    assert refused.retry_after == 86_400

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
    for _ in range(20):
        assert limiter.allow("test:u1")
    assert not limiter.allow("test:u1")
    # Refused u1 calls must NOT consume the remaining 10 process-minute slots.
    for _ in range(15):
        assert not limiter.allow("test:u1")

    # u2 can still take all 10 remaining process-minute slots (20 + 10 = 30).
    for _ in range(10):
        assert limiter.allow("test:u2")

    # 31st request in the minute (u3) is refused by the process limit and does not consume u3's daily quota.
    refused = limiter.allow("test:u3")
    assert not refused
    assert refused.retry_after == 60

    clock.advance(60.0)
    # u3 still has its full 20/day quota; 21st is refused.
    for _ in range(20):
        assert limiter.allow("test:u3")
    assert not limiter.allow("test:u3")


def test_exchange_limiter_backwards_clock_frees_nothing():
    clock = FakeClock(500.0)
    limiter = ExchangeLimiter(clock=clock)

    for _ in range(30):
        assert limiter.allow_process()
    assert not limiter.allow_process()

    for _ in range(20):
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


# ---- ConcurrencyGate (§5.6) ----------------------------------------------------------------------


async def test_concurrency_gate_enforces_limit_and_retry_after():
    gate = ConcurrencyGate()
    assert gate.max_concurrent == 4
    entered = [asyncio.Event() for _ in range(4)]
    release = asyncio.Event()

    async def holder(idx: int) -> None:
        async with gate.slot():
            entered[idx].set()
            await release.wait()

    tasks = [asyncio.create_task(holder(i)) for i in range(4)]
    await asyncio.gather(*(ev.wait() for ev in entered))
    assert gate.active == 4

    with pytest.raises(ConcurrencyLimitError) as exc_info:
        async with gate.slot():
            pass
    assert exc_info.value.retry_after == 2
    assert gate.active == 4

    release.set()
    await asyncio.gather(*tasks)
    assert gate.active == 0


async def test_concurrency_gate_releases_slot_on_exception_and_cancellation():
    gate = ConcurrencyGate(max_concurrent=2)

    async def failing() -> None:
        async with gate.slot():
            assert gate.active == 1
            raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        await failing()
    assert gate.active == 0

    entered = asyncio.Event()
    never = asyncio.Event()

    async def cancellable() -> None:
        async with gate.slot():
            entered.set()
            await never.wait()

    task = asyncio.create_task(cancellable())
    await entered.wait()
    assert gate.active == 1
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert gate.active == 0

    # Both slots are reusable after exception and cancellation.
    async with gate.slot(), gate.slot():
        assert gate.active == 2
    assert gate.active == 0


def test_concurrency_gate_and_idempotency_cache_validate_args():
    with pytest.raises(ValueError):
        ConcurrencyGate(max_concurrent=0)
    with pytest.raises(ValueError):
        ConcurrencyGate(retry_after=0)
    with pytest.raises(ValueError):
        IdempotencyCache(ttl_s=0)


# ---- IdempotencyCache (§5.5) ---------------------------------------------------------------------


class FakeTranscribeError(Exception):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


async def test_idempotency_in_flight_join_runs_once_and_shares_result():
    clock = FakeClock(10.0)
    cache = IdempotencyCache(clock=clock)
    started = asyncio.Event()
    proceed = asyncio.Event()
    calls = 0

    async def work() -> CachedResponse:
        nonlocal calls
        calls += 1
        started.set()
        await proceed.wait()
        return CachedResponse(status=200, body={"text": "supino 80 por 8"})

    owner = asyncio.create_task(cache.run("test:u1", "k1", "digest-a", work))
    await started.wait()

    waiter_calls = 0

    async def waiter_work() -> CachedResponse:
        nonlocal waiter_calls
        waiter_calls += 1
        return CachedResponse(status=200, body={"text": "should not run"})

    waiter = asyncio.create_task(cache.run("test:u1", "k1", "digest-a", waiter_work))
    await asyncio.sleep(0)
    assert not waiter.done()

    proceed.set()
    res_owner, res_waiter = await asyncio.gather(owner, waiter)
    assert res_owner == CachedResponse(status=200, body={"text": "supino 80 por 8"})
    assert res_waiter == res_owner
    assert calls == 1
    assert waiter_calls == 0


async def test_idempotency_finished_replay_without_running_and_principal_isolation():
    clock = FakeClock(10.0)
    cache = IdempotencyCache(clock=clock)
    calls = 0

    async def work() -> CachedResponse:
        nonlocal calls
        calls += 1
        return CachedResponse(status=200, body={"id": "k1", "text": "ok"})

    first = await cache.run("test:u1", "k1", "digest-a", work)
    replay = await cache.run("test:u1", "k1", "digest-a", work)
    assert first == replay
    assert calls == 1

    # Different principal with the same Idempotency-Key and digest runs independently.
    other = await cache.run("test:u2", "k1", "digest-a", work)
    assert other == first
    assert calls == 2


async def test_idempotency_different_digest_conflicts_in_flight_and_finished_never_returns_cached():
    clock = FakeClock(10.0)
    cache = IdempotencyCache(clock=clock)
    started = asyncio.Event()
    proceed = asyncio.Event()

    async def owner_work() -> CachedResponse:
        started.set()
        await proceed.wait()
        return CachedResponse(status=200, body={"text": "secret-transcript"})

    async def conflicting_work() -> CachedResponse:
        raise AssertionError("conflicting call must not execute fn")

    owner = asyncio.create_task(cache.run("test:u1", "k1", "digest-a", owner_work))
    await started.wait()

    try:
        # Conflict while in-flight: raises immediately without waiting for `proceed`.
        with pytest.raises(IdempotencyConflictError):
            await asyncio.wait_for(cache.run("test:u1", "k1", "digest-b", conflicting_work), timeout=0.5)
    finally:
        proceed.set()
    expected = await owner
    assert expected.status == 200

    # Conflict after finished: raises and NEVER returns the cached result.
    with pytest.raises(IdempotencyConflictError):
        await cache.run("test:u1", "k1", "digest-b", conflicting_work)


async def test_idempotency_only_200_and_no_speech_are_cached():
    clock = FakeClock(0.0)
    cache = IdempotencyCache(clock=clock)

    # Non-cacheable statuses/codes must NOT be stored: retry executes again.
    non_cacheable = [
        CachedResponse(status=502, code="transcription_failed", body={"error": "transcription_failed"}),
        CachedResponse(status=504, code="timeout", body={"error": "timeout"}),
        CachedResponse(status=429, code="budget_exhausted", body={"error": "budget_exhausted"}),
        CachedResponse(status=422, code="too_long", body={"error": "too_long"}),
        CachedResponse(status=422, code=None, body={"error": "unprocessable"}),
        CachedResponse(status=415, code="unsupported_format", body={"error": "unsupported_format"}),
        CachedResponse(status=500, code="internal", body={"error": "internal"}),
        CachedResponse(status=201, body={"created": True}),
    ]
    for idx, response in enumerate(non_cacheable):
        key = f"k-{idx}"
        runs = 0

        async def run_once(resp: CachedResponse = response) -> CachedResponse:
            nonlocal runs
            runs += 1
            return resp

        out1 = await cache.run("test:u1", key, "d1", run_once)
        assert out1 == response
        assert len(cache) == 0
        out2 = await cache.run("test:u1", key, "d1", run_once)
        assert out2 == response
        assert runs == 2

    # 422 no_speech as CachedResponse IS cached (replay without running, conflict on other digest).
    no_speech_runs = 0

    async def no_speech_resp() -> CachedResponse:
        nonlocal no_speech_runs
        no_speech_runs += 1
        return CachedResponse(status=422, code="no_speech", body={"error": "no_speech"})

    r1 = await cache.run("test:u1", "k-ns-resp", "d1", no_speech_resp)
    r2 = await cache.run("test:u1", "k-ns-resp", "d1", no_speech_resp)
    assert r1 == r2
    assert no_speech_runs == 1
    with pytest.raises(IdempotencyConflictError):
        await cache.run("test:u1", "k-ns-resp", "d2", no_speech_resp)

    # Raised exception with code="no_speech" IS cached as a minimal outcome and replayed as a fresh exception.
    exc_runs = 0

    async def no_speech_exc() -> CachedResponse:
        nonlocal exc_runs
        exc_runs += 1
        raise FakeTranscribeError("no_speech")

    with pytest.raises(FakeTranscribeError) as err1:
        await cache.run("test:u1", "k-ns-exc", "d1", no_speech_exc)
    assert err1.value.code == "no_speech"
    with pytest.raises(NoSpeechError) as err2:
        await cache.run("test:u1", "k-ns-exc", "d1", no_speech_exc)
    assert err2.value.code == "no_speech"
    assert err2.value.status == 422
    assert exc_runs == 1

    # Custom no_speech_error factory constructs the domain exception on each replay.
    custom_cache = IdempotencyCache(
        clock=clock,
        no_speech_error=lambda: FakeTranscribeError("no_speech"),
    )
    custom_runs = 0

    async def custom_ns() -> CachedResponse:
        nonlocal custom_runs
        custom_runs += 1
        raise FakeTranscribeError("no_speech")

    with pytest.raises(FakeTranscribeError):
        await custom_cache.run("test:u1", "k-ns-custom", "d1", custom_ns)
    with pytest.raises(FakeTranscribeError) as err_custom:
        await custom_cache.run("test:u1", "k-ns-custom", "d1", custom_ns)
    assert err_custom.value.code == "no_speech"
    assert custom_runs == 1


async def test_idempotency_out_of_contract_results_are_not_cached():
    clock = FakeClock(0.0)
    cache = IdempotencyCache(clock=clock)

    out_of_contract: list[object] = [
        {"status": 500, "code": "internal"},
        {"status": 200, "body": {"text": "dict-not-cached"}},
        SimpleNamespace(code="no_speech"),
        SimpleNamespace(status=200, body={"text": "wrong-type"}),
        None,
        "plain-string",
        200,
    ]
    for idx, value in enumerate(out_of_contract):
        key = f"k-bad-{idx}"
        runs = 0

        async def work(val: object = value) -> object:
            nonlocal runs
            runs += 1
            return val

        first = await cache.run("test:u1", key, "d1", work)
        assert first == value
        assert len(cache) == 0
        second = await cache.run("test:u1", key, "d1", work)
        assert second == value
        assert runs == 2


async def test_idempotency_no_speech_does_not_retain_audio_or_closures():
    class SyntheticAudio:
        def __init__(self, size: int) -> None:
            self.data = b"\x55" * size

    clock = FakeClock(0.0)
    cache = IdempotencyCache(
        clock=clock,
        no_speech_error=lambda: FakeTranscribeError("no_speech"),
    )
    audio_ref: weakref.ref[SyntheticAudio] | None = None

    async def invoke_with_large_audio() -> None:
        nonlocal audio_ref
        audio = SyntheticAudio(2_000_000)
        audio_ref = weakref.ref(audio)

        async def transcribe_closure() -> CachedResponse:
            assert len(audio.data) == 2_000_000
            raise FakeTranscribeError("no_speech")

        with contextlib.suppress(FakeTranscribeError):
            await cache.run("test:u1", "k-retain", "d-retain", transcribe_closure)

    await invoke_with_large_audio()
    gc.collect()
    assert len(cache) == 1
    assert audio_ref is not None and audio_ref() is None

    # Also verify with an in-flight waiter joining before no_speech is raised.
    waiter_audio_ref: weakref.ref[SyntheticAudio] | None = None

    async def invoke_owner_and_waiter() -> None:
        nonlocal waiter_audio_ref
        audio = SyntheticAudio(2_000_000)
        waiter_audio_ref = weakref.ref(audio)
        started = asyncio.Event()
        proceed = asyncio.Event()

        async def slow_no_speech() -> CachedResponse:
            started.set()
            await proceed.wait()
            assert len(audio.data) == 2_000_000
            raise FakeTranscribeError("no_speech")

        owner = asyncio.create_task(cache.run("test:u1", "k-retain-waiter", "d-waiter", slow_no_speech))
        await started.wait()
        waiter = asyncio.create_task(cache.run("test:u1", "k-retain-waiter", "d-waiter", slow_no_speech))
        await asyncio.sleep(0)
        proceed.set()

        for task in (owner, waiter):
            with contextlib.suppress(FakeTranscribeError):
                await task

    await invoke_owner_and_waiter()
    await asyncio.sleep(0)
    gc.collect()
    assert len(cache) == 2
    assert waiter_audio_ref is not None and waiter_audio_ref() is None


async def test_idempotency_no_speech_100_replays_fresh_exception_and_constant_traceback():
    clock = FakeClock(0.0)
    cache = IdempotencyCache(
        clock=clock,
        no_speech_error=lambda: FakeTranscribeError("no_speech"),
    )
    runs = 0

    async def no_speech_work() -> CachedResponse:
        nonlocal runs
        runs += 1
        raise FakeTranscribeError("no_speech")

    with pytest.raises(FakeTranscribeError) as owner_err:
        await cache.run("test:u1", "k-replay-100", "d1", no_speech_work)

    trace_lengths: list[int] = []
    replay_exceptions: list[BaseException] = []
    for _ in range(100):
        with pytest.raises(FakeTranscribeError) as exc_info:
            await cache.run("test:u1", "k-replay-100", "d1", no_speech_work)
        assert exc_info.value.code == "no_speech"
        trace_lengths.append(len(traceback.extract_tb(exc_info.value.__traceback__)))
        replay_exceptions.append(exc_info.value)

    assert runs == 1
    assert trace_lengths[0] == trace_lengths[-1]
    assert set(trace_lengths) == {trace_lengths[0]}
    assert len({id(exc) for exc in replay_exceptions}) == 100
    assert owner_err.value not in replay_exceptions


async def test_idempotency_expires_at_5_minutes_with_fake_clock():
    clock = FakeClock(100.0)
    cache = IdempotencyCache(clock=clock)
    runs = 0

    async def work() -> CachedResponse:
        nonlocal runs
        runs += 1
        return CachedResponse(status=200, body={"run": runs})

    first = await cache.run("test:u1", "k1", "d1", work)
    assert first.body == {"run": 1}

    # At 299.9 s later (399.9): still cached and still conflicts on another digest.
    clock.now = 399.9
    assert (await cache.run("test:u1", "k1", "d1", work)).body == {"run": 1}
    assert runs == 1
    with pytest.raises(IdempotencyConflictError):
        await cache.run("test:u1", "k1", "d2", work)

    # At exact 300.0 s (400.0): expired; same key can run again (even with a new digest).
    clock.now = 400.0
    assert len(cache) == 0
    second = await cache.run("test:u1", "k1", "d2", work)
    assert second.body == {"run": 2}
    assert runs == 2


async def test_idempotency_waiter_cancelled_leaves_owner_and_other_waiter_untouched():
    clock = FakeClock(0.0)
    cache = IdempotencyCache(clock=clock)
    started = asyncio.Event()
    proceed = asyncio.Event()
    runs = 0

    async def work() -> CachedResponse:
        nonlocal runs
        runs += 1
        started.set()
        await proceed.wait()
        return CachedResponse(status=200, body={"text": "treino ok"})

    owner = asyncio.create_task(cache.run("test:u1", "k1", "d1", work))
    await started.wait()

    waiter_cancelled = asyncio.create_task(cache.run("test:u1", "k1", "d1", work))
    waiter_surviving = asyncio.create_task(cache.run("test:u1", "k1", "d1", work))
    await asyncio.sleep(0)

    entry = cache._entries[("test:u1", "k1")]
    assert isinstance(entry, _InFlightEntry)
    shared_future = entry.future
    assert not shared_future.cancelled()

    waiter_cancelled.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter_cancelled

    # Shared future, owner, and the second waiter are all untouched.
    assert not shared_future.cancelled()
    assert not shared_future.done()
    assert not owner.done()
    assert not waiter_surviving.done()

    proceed.set()
    owner_result, waiter_result = await asyncio.gather(owner, waiter_surviving)
    expected = CachedResponse(status=200, body={"text": "treino ok"})
    assert owner_result == expected
    assert waiter_result == expected
    assert shared_future.done() and not shared_future.cancelled()
    assert len(cache) == 1

    # Later request with the same key gets the cached response without a second run.
    replayed = await cache.run("test:u1", "k1", "d1", work)
    assert replayed == expected
    assert runs == 1


async def test_idempotency_owner_cancelled_raises_owner_aborted_in_both_waiters_and_allows_retry():
    clock = FakeClock(0.0)
    cache = IdempotencyCache(clock=clock)
    started = asyncio.Event()
    never = asyncio.Event()
    runs = 0

    async def work() -> CachedResponse:
        nonlocal runs
        runs += 1
        if runs == 1:
            started.set()
            await never.wait()
        return CachedResponse(status=200, body={"text": "retried ok"})

    owner = asyncio.create_task(cache.run("test:u1", "k1", "d1", work))
    await started.wait()

    w1 = asyncio.create_task(cache.run("test:u1", "k1", "d1", work))
    w2 = asyncio.create_task(cache.run("test:u1", "k1", "d1", work))
    await asyncio.sleep(0)

    owner.cancel()
    with pytest.raises(asyncio.CancelledError):
        await owner

    for waiter in (w1, w2):
        with pytest.raises(OwnerAborted):
            await waiter

    assert len(cache) == 0

    # Next request finds no entry and runs a fresh transcription.
    retried = await cache.run("test:u1", "k1", "d1", work)
    assert retried == CachedResponse(status=200, body={"text": "retried ok"})
    assert runs == 2


async def test_idempotency_owner_transcription_failed_propagates_code_to_waiters_and_clears_entry():
    clock = FakeClock(0.0)
    cache = IdempotencyCache(clock=clock)
    started = asyncio.Event()
    proceed = asyncio.Event()
    runs = 0

    async def failing_work() -> CachedResponse:
        nonlocal runs
        runs += 1
        started.set()
        await proceed.wait()
        raise FakeTranscribeError("transcription_failed")

    owner = asyncio.create_task(cache.run("test:u1", "k1", "d1", failing_work))
    await started.wait()
    w1 = asyncio.create_task(cache.run("test:u1", "k1", "d1", failing_work))
    w2 = asyncio.create_task(cache.run("test:u1", "k1", "d1", failing_work))
    await asyncio.sleep(0)

    proceed.set()
    for task in (owner, w1, w2):
        with pytest.raises(FakeTranscribeError) as exc_info:
            await task
        assert exc_info.value.code == "transcription_failed"

    assert len(cache) == 0

    # Retry executes again cleanly.
    async def ok_work() -> CachedResponse:
        nonlocal runs
        runs += 1
        return CachedResponse(status=200, body={"ok": True})

    assert (await cache.run("test:u1", "k1", "d1", ok_work)).status == 200
    assert runs == 2


async def test_idempotency_owner_unexpected_error_aborts_waiters_and_deletes_entry():
    clock = FakeClock(0.0)
    cache = IdempotencyCache(clock=clock)
    started = asyncio.Event()
    proceed = asyncio.Event()

    async def crashing_work() -> CachedResponse:
        started.set()
        await proceed.wait()
        raise RuntimeError("unexpected")

    owner = asyncio.create_task(cache.run("test:u1", "k1", "d1", crashing_work))
    await started.wait()
    waiter = asyncio.create_task(cache.run("test:u1", "k1", "d1", crashing_work))
    await asyncio.sleep(0)

    proceed.set()
    with pytest.raises(RuntimeError, match="unexpected"):
        await owner
    with pytest.raises(OwnerAborted):
        await waiter
    assert len(cache) == 0


async def test_idempotency_owner_aborts_without_waiters_logs_no_unretrieved_exception(caplog):
    loop = asyncio.get_running_loop()
    previous_handler = loop.get_exception_handler()
    loop_exceptions: list[dict[str, object]] = []
    loop.set_exception_handler(lambda _loop, ctx: loop_exceptions.append(ctx))

    try:
        with warnings.catch_warnings(record=True) as recorded_warnings:
            warnings.simplefilter("always")
            with caplog.at_level(logging.WARNING, logger="asyncio"):
                clock = FakeClock(0.0)
                cache = IdempotencyCache(clock=clock)

                # 1) Owner cancelled with no waiters.
                started = asyncio.Event()
                never = asyncio.Event()

                async def slow_work() -> CachedResponse:
                    started.set()
                    await never.wait()
                    return CachedResponse(status=200)

                t_cancel = asyncio.create_task(cache.run("test:u1", "k-cancel", "d1", slow_work))
                await started.wait()
                t_cancel.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await t_cancel
                del t_cancel

                # 2) Owner raises unexpected error with no waiters.
                async def crash_work() -> CachedResponse:
                    raise RuntimeError("boom")

                with pytest.raises(RuntimeError):
                    await cache.run("test:u1", "k-crash", "d1", crash_work)

                # 3) Owner raises domain error with no waiters.
                async def fail_work() -> CachedResponse:
                    raise FakeTranscribeError("transcription_failed")

                with pytest.raises(FakeTranscribeError):
                    await cache.run("test:u1", "k-fail", "d1", fail_work)

                gc.collect()
                await asyncio.sleep(0)

        assert loop_exceptions == []
        assert not [r for r in caplog.records if "never retrieved" in r.getMessage()]
        assert recorded_warnings == []
    finally:
        loop.set_exception_handler(previous_handler)
