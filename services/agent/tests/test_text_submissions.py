from __future__ import annotations

import asyncio
import hashlib
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from agent.bot import WRITE_UNCERTAIN
from agent.commands import Reply
from agent.text_submissions import (
    CONFLICT_REPLY,
    DONE_REPLY,
    RUNNING_REPLY,
    TEXT_SUBMISSION_CAPACITY,
    TEXT_SUBMISSION_TTL_S,
    UNCERTAIN_REPLY,
    TextSubmissions,
    principal_key,
    text_digest,
    text_scope_key,
)
from agent.tools import Journal, update_key_scope

pytestmark = pytest.mark.unit

SID = "0123456789abcdef0123456789abcdef"
OTHER_SID = "fedcba9876543210fedcba9876543210"


def _contains_text(root: Any, needle: str) -> bool:
    """Recursively inspects reachable objects to ensure raw submission text is never retained."""
    seen: set[int] = set()
    needle_bytes = needle.encode("utf-8")

    def walk(obj: Any) -> bool:
        if obj is None or isinstance(obj, (int, float, bool)):
            return False
        if isinstance(obj, str):
            return needle in obj
        if isinstance(obj, (bytes, bytearray, memoryview)):
            return needle_bytes in bytes(obj)
        oid = id(obj)
        if oid in seen:
            return False
        seen.add(oid)
        if isinstance(obj, dict):
            return any(walk(k) or walk(v) for k, v in obj.items())
        if isinstance(obj, (list, tuple, set, frozenset)):
            return any(walk(item) for item in obj)
        if hasattr(obj, "__dict__") and walk(vars(obj)):
            return True
        cls = type(obj)
        for base in cls.__mro__:
            slots = getattr(base, "__slots__", ())
            if isinstance(slots, str):
                slots = (slots,)
            for slot in slots:
                if slot in ("__dict__", "__weakref__"):
                    continue
                try:
                    val = getattr(obj, slot)
                except AttributeError:
                    continue
                if walk(val):
                    return True
        return False

    return walk(root)


def test_defaults_match_spec():
    assert TEXT_SUBMISSION_TTL_S == 48 * 3600
    assert TEXT_SUBMISSION_CAPACITY == 1024


def test_principal_and_scope_keys_validate_inputs_and_fit_sheet_request_id_limit():
    assert principal_key(42) == "telegram:42"
    assert principal_key("telegram:42") == "telegram:42"
    assert principal_key("pwa:user-1") == "pwa:user-1"
    with pytest.raises(TypeError):
        principal_key(True)
    with pytest.raises(ValueError):
        principal_key("   ")

    scope = text_scope_key(42, SID)
    assert scope == f"tg:42:miniapp:text:{SID}"
    with pytest.raises(TypeError):
        text_scope_key(True, SID)
    with pytest.raises(ValueError):
        text_scope_key(42, "")

    # Even a negative 13-digit chat id + longest tool name + args hash + ordinal stays <= 120 chars.
    long_scope = text_scope_key(-1001234567890, SID)
    with update_key_scope(long_scope):
        journal = Journal()
        journal.request_id_for("measures.upsert", {"date": "2026-11-14", "weightKg": 82.4})
        req_id, _ = journal.request_id_for("measures.upsert", {"date": "2026-11-14", "weightKg": 82.4})
    assert req_id is not None and req_id.endswith(":2") and len(req_id) <= 120


async def test_concurrent_same_payload_runs_agent_once_and_answers_running_immediately():
    store = TextSubmissions()
    started = asyncio.Event()
    release = asyncio.Event()
    runs = 0

    async def slow_agent() -> Reply:
        nonlocal runs
        runs += 1
        started.set()
        await release.wait()
        return Reply("<b>Gravado</b>", html=True, write_outcome="committed")

    first_task = asyncio.create_task(store.run(42, SID, "almoço 150 g arroz", slow_agent))
    await started.wait()

    # Second concurrent call with identical (chat_id, id, text) returns immediately without waiting.
    second_calls = 0

    async def should_not_run() -> Reply:
        nonlocal second_calls
        second_calls += 1
        return Reply("boom")

    duplicate = await store.run(42, SID, "almoço 150 g arroz", should_not_run)
    assert duplicate == Reply(RUNNING_REPLY, failed=False, transient=False)
    assert second_calls == 0
    assert not first_task.done()

    release.set()
    first = await first_task
    assert first.text == "<b>Gravado</b>"
    assert runs == 1


async def test_committed_outcome_marks_done_and_sequential_duplicate_never_reruns():
    store = TextSubmissions()
    runs = 0

    async def commit_work() -> Reply:
        nonlocal runs
        runs += 1
        return Reply("ok", html=True, write_outcome="committed")

    first = await store.run(42, SID, "peso 82,4", commit_work)
    assert first.write_outcome == "committed"
    assert runs == 1

    # Same chat expressed as int or canonical principal_key hits the same entry.
    second = await store.run(42, SID, "peso 82,4", commit_work)
    third = await store.run("telegram:42", SID, "peso 82,4", commit_work)
    assert second == Reply(DONE_REPLY, failed=False, transient=False)
    assert third == Reply(DONE_REPLY, failed=False, transient=False)
    assert runs == 1


async def test_same_id_with_different_text_returns_conflict_without_running_or_overwriting():
    store = TextSubmissions()
    runs = 0

    async def work() -> Reply:
        nonlocal runs
        runs += 1
        return Reply("ok", write_outcome="committed")

    # Conflict while running:
    decision = store.begin(42, SID, "texto original")
    assert decision and decision.reason == "accepted"

    conflict_running = await store.run(42, SID, "texto adulterado", work)
    assert conflict_running == Reply(CONFLICT_REPLY, failed=True, transient=False)
    assert runs == 0
    # Original running state is untouched:
    same_running = await store.run(42, SID, "texto original", work)
    assert same_running == Reply(RUNNING_REPLY)

    # Transition original to done, then conflict again:
    store.finish(42, SID, outcome="committed")
    conflict_done = await store.run(42, SID, "outro texto", work)
    assert conflict_done == Reply(CONFLICT_REPLY, failed=True, transient=False)
    assert runs == 0
    assert await store.run(42, SID, "texto original", work) == Reply(DONE_REPLY)

    # Conflict while uncertain:
    await store.run(
        42,
        OTHER_SID,
        "envio incerto",
        lambda: asyncio.sleep(0, result=Reply(WRITE_UNCERTAIN, failed=True, write_outcome="uncertain")),
    )
    conflict_uncertain = await store.run(42, OTHER_SID, "texto diferente", work)
    assert conflict_uncertain == Reply(CONFLICT_REPLY, failed=True, transient=False)
    assert runs == 0
    assert await store.run(42, OTHER_SID, "envio incerto", work) == Reply(UNCERTAIN_REPLY)


async def test_written_answer_lost_uncertain_outcome_keeps_entry_and_blocks_second_run():
    store = TextSubmissions()
    runs = 0

    async def uncertain_work() -> Reply:
        nonlocal runs
        runs += 1
        return Reply(WRITE_UNCERTAIN, failed=True, transient=False, write_outcome="uncertain")

    first = await store.run(42, SID, "supino 80x8, 80x8", uncertain_work)
    assert first.write_outcome == "uncertain"
    assert runs == 1
    assert len(store) == 1

    resend = await store.run(42, SID, "supino 80x8, 80x8", uncertain_work)
    assert resend == Reply(UNCERTAIN_REPLY, failed=False, transient=False)
    assert runs == 1


@pytest.mark.parametrize("exc_type", [TimeoutError, asyncio.CancelledError])
async def test_deadline_cut_marks_entry_uncertain_so_resend_does_not_duplicate(exc_type):
    store = TextSubmissions()
    runs = 0

    async def cut_work() -> Reply:
        nonlocal runs
        runs += 1
        raise exc_type()

    with pytest.raises(exc_type):
        await store.run(42, SID, "agachamento 120x5", cut_work)
    assert runs == 1
    assert len(store) == 1

    resend = await store.run(42, SID, "agachamento 120x5", cut_work)
    assert resend == Reply(UNCERTAIN_REPLY, failed=False, transient=False)
    assert runs == 1


async def test_not_committed_and_pre_write_failures_remove_entry_allowing_retry():
    store = TextSubmissions()
    attempts = 0

    async def sheet_down_then_ok() -> Reply:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return Reply("planilha fora", failed=True, transient=True, write_outcome="not_committed")
        if attempts == 2:
            # Model failed before any tool call attempted a write (outcome=None, failed=True).
            return Reply("modelo fora", failed=True, transient=True, write_outcome=None)
        if attempts == 3:
            raise RuntimeError("unexpected crash before write")
        return Reply("<b>Salvo</b>", html=True, write_outcome="committed")

    r1 = await store.run(42, SID, "dormi 7h30", sheet_down_then_ok)
    assert r1.write_outcome == "not_committed" and len(store) == 0

    r2 = await store.run(42, SID, "dormi 7h30", sheet_down_then_ok)
    assert r2.failed and len(store) == 0

    with pytest.raises(RuntimeError, match="unexpected crash"):
        await store.run(42, SID, "dormi 7h30", sheet_down_then_ok)
    assert len(store) == 0

    r4 = await store.run(42, SID, "dormi 7h30", sheet_down_then_ok)
    assert r4.text == "<b>Salvo</b>" and attempts == 4 and len(store) == 1

    r5 = await store.run(42, SID, "dormi 7h30", sheet_down_then_ok)
    assert r5 == Reply(DONE_REPLY) and attempts == 4


async def test_non_mutating_successful_reply_marks_done():
    store = TextSubmissions()
    runs = 0

    async def read_only_answer() -> Reply:
        nonlocal runs
        runs += 1
        return Reply("Seu último supino foi 80×8.", html=True, failed=False, transient=False)

    first = await store.run(42, SID, "qual meu último supino?", read_only_answer)
    assert first.text.startswith("Seu último")
    second = await store.run(42, SID, "qual meu último supino?", read_only_answer)
    assert second == Reply(DONE_REPLY)
    assert runs == 1


async def test_chat_ids_are_isolated():
    store = TextSubmissions()
    seen_chats: list[int] = []

    for chat_id in (42, 7):
        reply = await store.run(
            chat_id,
            SID,
            "mesmo id em chats diferentes",
            lambda cid=chat_id: asyncio.sleep(
                0, result=(seen_chats.append(cid) or Reply("ok", write_outcome="committed"))
            ),
        )
        assert reply.text == "ok"
    assert seen_chats == [42, 7]
    # Different text on chat 99 with the same SID is not a conflict with chat 42 or 7:
    reply_99 = await store.run(
        99,
        SID,
        "outro texto no chat 99",
        lambda: asyncio.sleep(0, result=Reply("ok99", write_outcome="committed")),
    )
    assert reply_99.text == "ok99"


async def test_ttl_expiration_with_injected_clock_and_running_entries_never_expire():
    now = [1_000.0]
    store = TextSubmissions(ttl_s=TEXT_SUBMISSION_TTL_S, clock=lambda: now[0])
    runs = 0

    async def work() -> Reply:
        nonlocal runs
        runs += 1
        return Reply("ok", write_outcome="committed")

    await store.run(42, SID, "peso 81,9", work)
    in_flight_id = "a" * 32
    assert store.begin(42, in_flight_id, "em andamento").proceed

    # Backwards clock step is clamped and cannot age entries backwards or corrupt TTL.
    now[0] = 500.0
    assert await store.run(42, SID, "peso 81,9", work) == Reply(DONE_REPLY)

    # 1 second before 48h from clamped 1_000.0: still cached.
    now[0] = 1_000.0 + TEXT_SUBMISSION_TTL_S - 1.0
    assert await store.run(42, SID, "peso 81,9", work) == Reply(DONE_REPLY)
    assert runs == 1

    # Exactly at 48h: terminal entry expires and runs again, while running entry survives!
    now[0] = 1_000.0 + TEXT_SUBMISSION_TTL_S
    assert await store.run(42, SID, "peso 81,9", work) == Reply("ok", write_outcome="committed")
    assert runs == 2
    assert store.begin(42, in_flight_id, "em andamento").reason == "running"

    # Also supports aware datetime clocks:
    t0 = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)
    dt_now = [t0]
    dt_store = TextSubmissions(ttl_s=60, clock=lambda: dt_now[0])
    await dt_store.run(7, SID, "agua 500 ml", work)
    dt_now[0] = t0 + timedelta(seconds=59)
    assert await dt_store.run(7, SID, "agua 500 ml", work) == Reply(DONE_REPLY)
    dt_now[0] = t0 + timedelta(seconds=60)
    assert (await dt_store.run(7, SID, "agua 500 ml", work)).text == "ok"


async def test_capacity_evicts_oldest_terminal_entries_and_never_evicts_running():
    store = TextSubmissions(max_size=3)
    running_id = f"{0:032x}"
    assert store.begin(42, running_id, "ainda rodando").proceed

    ids = [f"{i:032x}" for i in range(1, 5)]
    for sub_id in ids[:2]:
        await store.run(
            42,
            sub_id,
            f"item {sub_id}",
            lambda: asyncio.sleep(0, result=Reply("ok", write_outcome="committed")),
        )
    assert len(store) == 3  # running_id + ids[0] + ids[1]

    # Adding ids[2] pushes size over 3: running_id (oldest!) MUST NOT be evicted; ids[0] is evicted!
    await store.run(
        42, ids[2], f"item {ids[2]}", lambda: asyncio.sleep(0, result=Reply("ok", write_outcome="committed"))
    )
    assert len(store) == 3
    assert store.begin(42, running_id, "ainda rodando").reason == "running"
    assert store.begin(42, ids[1], f"item {ids[1]}").reason == "done"
    assert store.begin(42, ids[2], f"item {ids[2]}").reason == "done"

    # Evicted ids[0] is accepted anew (and doing so evicts ids[1], keeping running_id!):
    runs = 0

    async def rerun() -> Reply:
        nonlocal runs
        runs += 1
        return Reply("ok", write_outcome="committed")

    assert (await store.run(42, ids[0], f"item {ids[0]}", rerun)).text == "ok"
    assert runs == 1
    assert store.begin(42, running_id, "ainda rodando").reason == "running"


async def test_raw_submission_text_is_never_stored_in_memory():
    store = TextSubmissions()
    s_running = "SENTINEL_RUNNING_RAW_TEXT_77a1b2c3"
    s_done = "SENTINEL_DONE_RAW_TEXT_88d4e5f6"
    s_uncertain = "SENTINEL_UNCERTAIN_RAW_TEXT_99001122"

    assert store.begin(42, f"{1:032x}", s_running).proceed
    await store.run(
        42, f"{2:032x}", s_done, lambda: asyncio.sleep(0, result=Reply("ok", write_outcome="committed"))
    )
    await store.run(
        42,
        f"{3:032x}",
        s_uncertain,
        lambda: asyncio.sleep(0, result=Reply(WRITE_UNCERTAIN, failed=True, write_outcome="uncertain")),
    )

    for sentinel in (s_running, s_done, s_uncertain):
        assert not _contains_text(store, sentinel)
        expected_hash = hashlib.sha256(sentinel.encode("utf-8")).hexdigest()
        assert text_digest(sentinel) == expected_hash
        assert _contains_text(store, expected_hash)
