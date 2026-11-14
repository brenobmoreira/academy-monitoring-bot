"""The token budget (voice spec §5.6): per principal and per process, per day in TIMEZONE, in memory.

Principals and numbers are synthetic.
"""

import threading
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from agent.budget import MemoryBudget

pytestmark = pytest.mark.unit

SP = ZoneInfo("America/Sao_Paulo")
NOON = datetime(2030, 3, 5, 12, 0, tzinfo=SP)


def budget(principal: int = 1000, process: int = 5000, tz: str = "America/Sao_Paulo") -> MemoryBudget:
    return MemoryBudget(principal_daily=principal, global_daily=process, timezone=tz)


def test_a_reservation_within_both_limits_is_granted_and_counted():
    b = budget()
    assert b.reserve("p1", 400, NOON) is not None
    assert b.used("p1", NOON) == (400, 400)


def test_a_reservation_that_would_pass_the_principal_limit_is_refused_and_not_counted():
    b = budget(principal=1000)
    assert b.reserve("p1", 600, NOON) is not None
    assert b.reserve("p1", 401, NOON) is None
    assert b.used("p1", NOON) == (600, 600)


def test_the_limit_is_inclusive():
    b = budget(principal=1000)
    assert b.reserve("p1", 1000, NOON) is not None
    assert b.reserve("p1", 1, NOON) is None


def test_the_process_limit_covers_all_principals():
    b = budget(principal=1000, process=1500)
    assert b.reserve("p1", 1000, NOON) is not None
    assert b.reserve("p2", 600, NOON) is None
    assert b.reserve("p2", 500, NOON) is not None


def test_principals_do_not_share_their_own_limit():
    b = budget(principal=1000, process=5000)
    assert b.reserve("p1", 1000, NOON) is not None
    assert b.reserve("p2", 1000, NOON) is not None


def test_settle_replaces_the_reserved_amount_with_the_actual_one():
    b = budget()
    r = b.reserve("p1", 400, NOON)
    assert r is not None
    r.settle(150)
    assert b.used("p1", NOON) == (150, 150)


def test_settle_can_exceed_the_reservation_and_the_excess_is_charged():
    b = budget(principal=1000, process=5000)
    r = b.reserve("p1", 400, NOON)
    assert r is not None
    r.settle(900)
    assert b.used("p1", NOON) == (900, 900)
    # Over the limit after the fact: the next reservation is refused, nothing is clamped.
    r2 = b.reserve("p1", 200, NOON)
    assert r2 is None


def test_release_gives_the_whole_reservation_back():
    b = budget()
    r = b.reserve("p1", 400, NOON)
    assert r is not None
    r.release()
    assert b.used("p1", NOON) == (0, 0)


def test_a_reservation_is_settled_only_once():
    b = budget()
    r = b.reserve("p1", 400, NOON)
    assert r is not None
    r.settle(100)
    r.settle(900)
    r.release()
    assert b.used("p1", NOON) == (100, 100)


def test_a_released_reservation_cannot_be_settled_later():
    b = budget()
    r = b.reserve("p1", 400, NOON)
    assert r is not None
    r.release()
    r.settle(300)
    assert b.used("p1", NOON) == (0, 0)


def test_negative_amounts_are_rejected():
    b = budget()
    with pytest.raises(ValueError):
        b.reserve("p1", -1, NOON)
    r = b.reserve("p1", 10, NOON)
    assert r is not None
    with pytest.raises(ValueError):
        r.settle(-5)


# --- the day, in TIMEZONE -----------------------------------------------------------------------


def test_counters_start_from_zero_at_midnight_in_the_configured_timezone():
    b = budget(principal=1000, process=1000)
    late = datetime(2030, 3, 5, 23, 59, tzinfo=SP)
    assert b.reserve("p1", 1000, late) is not None
    assert b.reserve("p1", 1, late) is None
    after_midnight = late + timedelta(minutes=2)  # 00:01 on the 6th, Sao Paulo
    assert b.reserve("p1", 1000, after_midnight) is not None
    assert b.used("p1", after_midnight) == (1000, 1000)


def test_the_day_follows_timezone_not_utc():
    b = budget(principal=1000, process=1000, tz="America/Sao_Paulo")
    # 02:30 UTC on the 6th is still 23:30 on the 5th in Sao Paulo (UTC-3): same day as 20:00 UTC.
    evening = datetime(2030, 3, 5, 22, 0, tzinfo=UTC)  # 19:00 on the 5th in Sao Paulo
    still_same_day = datetime(2030, 3, 6, 2, 30, tzinfo=UTC)  # 23:30 on the 5th in Sao Paulo
    assert b.reserve("p1", 1000, evening) is not None
    assert b.reserve("p1", 1, still_same_day) is None
    next_day = datetime(2030, 3, 6, 3, 30, tzinfo=UTC)  # 00:30 on the 6th in Sao Paulo
    assert b.reserve("p1", 1, next_day) is not None


def test_a_reservation_belongs_to_the_day_it_was_made():
    b = budget(principal=1000, process=1000)
    late = datetime(2030, 3, 5, 23, 59, tzinfo=SP)
    old = b.reserve("p1", 600, late)
    assert old is not None
    morning = late + timedelta(hours=8)
    assert b.reserve("p1", 300, morning) is not None  # new day, fresh counters
    old.settle(900)  # settles yesterday's counters, not today's
    assert b.used("p1", morning) == (300, 300)
    old.release()  # already settled: still nothing
    assert b.used("p1", morning) == (300, 300)


def test_an_earlier_clock_reading_does_not_reset_the_counters():
    b = budget(principal=1000, process=1000)
    assert b.reserve("p1", 1000, NOON) is not None
    assert b.reserve("p1", 1, NOON - timedelta(days=1)) is None


def test_a_new_instance_starts_from_zero_like_a_cold_start():
    first = budget(principal=1000, process=1000)
    assert first.reserve("p1", 1000, NOON) is not None
    assert first.reserve("p1", 1, NOON) is None
    cold = budget(principal=1000, process=1000)
    assert cold.used("p1", NOON) == (0, 0)
    assert cold.reserve("p1", 1000, NOON) is not None


# --- concurrency --------------------------------------------------------------------------------


def test_concurrent_reservations_never_exceed_the_limits():
    b = budget(principal=10_000, process=10_000)
    granted: list[int] = []
    gate = threading.Barrier(16)

    def worker(i: int) -> None:
        gate.wait()
        for _ in range(50):
            if b.reserve("p1", 37, NOON) is not None:
                granted.append(37)

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(16)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(granted) <= 10_000
    assert b.used("p1", NOON) == (sum(granted), sum(granted))
    assert 10_000 - sum(granted) < 37  # and the budget really was filled up
