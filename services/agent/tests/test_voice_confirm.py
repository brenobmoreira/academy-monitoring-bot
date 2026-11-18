from __future__ import annotations

import asyncio
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import pytest

from agent import buttons
from agent.bot import WRITE_UNCERTAIN, Answer, Bot
from agent.buttons import (
    ENTENDI_HEADER,
    VOICE_FIX_PLACEHOLDER,
    VOICE_FIX_PROMPT,
    entendi_text,
    keyboard,
    voice_keyboard,
)
from agent.handler import CUT, Handler
from agent.voice_confirm import (
    VOICE_ALREADY_CANCELLED,
    VOICE_ALREADY_REGISTERING,
    VOICE_ALREADY_SENT,
    VOICE_CANCEL_OK,
    VOICE_CANCEL_REGISTERING,
    VOICE_CANCEL_SENT,
    VOICE_CANCELLED,
    VOICE_CONFIRM_TTL_S,
    VOICE_EXPIRED,
    VOICE_FIX_ALREADY,
    VOICE_REGISTERING,
    VOICE_SUPERSEDED,
    VOICE_TERMINAL_TTL_S,
    VoiceAction,
    VoiceConfirmations,
    VoiceState,
    sha256_hex,
)

from .fakes import FakeSheet, FakeTelegram, ScriptedLlm, call, say

pytestmark = pytest.mark.unit

TRANSCRIPT = "supino 80 por 8, 80 por 7"


class FakeClock:
    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class OrderTelegram(FakeTelegram):
    """Records callback answers, keyboard edits and messages in one shared event list."""

    async def answer_callback_query(self, callback_query_id, text=None):
        self._events.append(f"answer:{text}")
        await super().answer_callback_query(callback_query_id, text)

    async def edit_message_reply_markup(self, chat_id, message_id, reply_markup=None):
        self._events.append("edit")
        await super().edit_message_reply_markup(chat_id, message_id, reply_markup)

    async def send_message(self, chat_id, text, *, html=False, reply_markup=None, reply_to=None):
        self._events.append("send")
        return await super().send_message(
            chat_id, text, html=html, reply_markup=reply_markup, reply_to=reply_to
        )


class GatedBot:
    """Pauses inside `reply` so concurrent taps deterministically overlap with `confirmed`."""

    def __init__(
        self,
        answer: Answer | None = None,
        *,
        started: asyncio.Event | None = None,
        release: asyncio.Event | None = None,
        events: list[str] | None = None,
    ) -> None:
        self.calls: list[tuple[str, str, str | None]] = []
        self._answer = answer or Answer(
            "<b>21/09</b> · Peso kg 82,4", ("w1",), wrote=True, outcome="committed"
        )
        self._started = started
        self._release = release
        self._events = events if events is not None else []

    async def reply(self, text: str, user_id: str = "telegram", *, context: str | None = None, media=None):
        self.calls.append((text, user_id, context))
        self._events.append("bot")
        if self._started is not None:
            self._started.set()
        if len(self.calls) == 1 and self._release is not None:
            await self._release.wait()
        return self._answer


def seed_pending(
    store: VoiceConfirmations,
    body: str = TRANSCRIPT,
    *,
    chat_id: int = 42,
    message_id: int = 9,
) -> str:
    return store.create(chat_id, sha256_hex(body), message_id=message_id)


def voice_tap(
    verb: VoiceAction,
    vid: str,
    *,
    body: str | None = TRANSCRIPT,
    chat_id: int = 42,
    message_id: int | None = 9,
    update_id: int = 10,
    query_id: str = "cb1",
    date: int | None = 1_700_000_000,
) -> dict[str, Any]:
    message: dict[str, Any] = {"chat": {"id": chat_id}}
    if message_id is not None:
        message["message_id"] = message_id
    if date is not None:
        message["date"] = date
    if body is not None:
        message["text"] = entendi_text(body)
    return {
        "update_id": update_id,
        "callback_query": {
            "id": query_id,
            "from": {"id": chat_id, "is_bot": False},
            "data": f"{verb}:{vid}",
            "message": message,
        },
    }


def _force_state(
    store: VoiceConfirmations,
    clock: FakeClock,
    state: VoiceState | Literal["unknown"],
) -> str:
    if state == "unknown":
        return "0123456789abcdef"
    if state == "expired":
        vid = store.create(42, sha256_hex(TRANSCRIPT), message_id=9)
        clock.advance(VOICE_CONFIRM_TTL_S + 1.0)
        store.claim(vid, 42, "vok")
        return vid
    vid = store.create(42, sha256_hex(TRANSCRIPT), message_id=9)
    if state == "pending":
        return vid
    if state == "confirmed":
        store.claim(vid, 42, "vok")
        return vid
    if state in ("done", "uncertain"):
        store.claim(vid, 42, "vok")
        store.finish(vid, state)
        return vid
    if state == "cancelled":
        store.claim(vid, 42, "vno")
        return vid
    assert state == "superseded"
    store.claim(vid, 42, "vfix")
    return vid


# ---- store invariants & privacy -------------------------------------------------------------------


def test_store_keeps_only_metadata_and_refuses_raw_transcripts():
    sentinel = "SENTINELA-TRANSCRICAO-88a1"
    store = VoiceConfirmations()
    with pytest.raises(ValueError):
        store.create(42, sentinel)
    with pytest.raises(ValueError):
        store.create(42, sha256_hex(sentinel).upper())

    vid = store.create(42, sha256_hex(sentinel), message_id=9)
    assert len(vid) == 16 and vid == vid.lower() and int(vid, 16) >= 0
    entry = store.get(vid)
    assert entry is not None
    assert entry.__slots__ == ("chat_id", "message_id", "created_at", "state", "text_sha256")
    assert sentinel not in repr(entry) and sentinel not in repr(store._entries)


# ---- §4.1 response table: pending row & early callback answers ------------------------------------


async def test_vok_on_pending_answers_first_removes_keyboard_runs_agent_with_voice_scope_and_quotes_entendi():
    events: list[str] = []
    store = VoiceConfirmations()
    body = "treino de hoje\nsupino 80 por 8"
    vid = seed_pending(store, body, message_id=17)

    diary_ok = {
        "ok": True,
        "result": {"date": "2026-09-21", "row": 6, "fields": {"weightKg": 82.4}, "writeId": "w9"},
    }
    sheet = FakeSheet(diary_upsert=[diary_ok])
    llm = ScriptedLlm(
        model="scripted",
        script=[
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            say("Ok"),
        ],
    )
    bot = Bot(sheet, llm, timezone="America/Sao_Paulo")
    tg = OrderTelegram(events=events)
    handler = Handler({42}, bot, tg, sheet=sheet, confirmations=store)

    # Even if `Entendi` itself replied to an earlier message, `vok` passes no reply context.
    tap = voice_tap("vok", vid, body=body, message_id=17)
    tap["callback_query"]["message"]["reply_to_message"] = {
        "message_id": 5,
        "from": {"id": 1, "is_bot": True},
        "text": "contexto antigo que nao deve ir",
    }
    await handler.handle_update(tap)

    assert tg.answered == [("cb1", VOICE_REGISTERING)]
    assert tg.edited == [(42, 17, None)]
    assert events[0] == f"answer:{VOICE_REGISTERING}"
    assert events.index("edit") < events.index("send")
    assert sheet.request_ids and sheet.request_ids[0] is not None
    assert sheet.request_ids[0].startswith(f"tg:voice:{vid}:")
    contents = llm.requests[0].contents
    assert contents and contents[0].parts
    sent_prompt = contents[0].parts[0].text
    assert sent_prompt == body
    assert "contexto antigo" not in (sent_prompt or "")
    assert tg.options[-1]["reply_to"] == 17
    assert tg.options[-1]["reply_markup"] == keyboard(["w9"])
    entry = store.get(vid)
    assert entry is not None and entry.state == "done"


async def test_vfix_on_pending_answers_first_sends_html_code_prompt_and_reply_drops_context():
    events: list[str] = []
    store = VoiceConfirmations()
    tricky = "supino <barra> & 80x8"
    vid = seed_pending(store, tricky, message_id=12)
    bot = GatedBot(events=events)
    tg = OrderTelegram(events=events)
    handler = Handler({42}, bot, tg, confirmations=store)

    await handler.handle_update(voice_tap("vfix", vid, body=tricky, message_id=12, update_id=10))

    assert tg.answered == [("cb1", None)]
    assert tg.edited == []  # original keyboard stays; state in VoiceConfirmations is now `superseded`
    assert events == ["answer:None", "send"]
    assert bot.calls == []
    expected_html = f"{VOICE_FIX_PROMPT}\n\n<code>supino &lt;barra&gt; &amp; 80x8</code>"
    assert tg.sent == [(42, expected_html)]
    assert tg.options == [
        {
            "html": True,
            "reply_markup": {"force_reply": True, "input_field_placeholder": VOICE_FIX_PLACEHOLDER},
            "reply_to": 12,
        }
    ]
    entry = store.get(vid)
    assert entry is not None and entry.state == "superseded"

    # When the person replies to the fix prompt, Telegram strips `<code>` and sets `is_bot=True`.
    correction = {
        "update_id": 11,
        "message": {
            "chat": {"id": 42},
            "text": "supino barra 82x8",
            "reply_to_message": {
                "message_id": 1,
                "from": {"id": 999, "is_bot": True},
                "text": f"{VOICE_FIX_PROMPT}\n\n{tricky}",
            },
        },
    }
    await handler.handle_update(correction)
    assert bot.calls == [("supino barra 82x8", "42", None)]


async def test_vno_on_pending_answers_first_removes_keyboard_and_replies_without_agent():
    events: list[str] = []
    store = VoiceConfirmations()
    vid = seed_pending(store, message_id=15)
    bot = GatedBot(events=events)
    tg = OrderTelegram(events=events)
    handler = Handler({42}, bot, tg, confirmations=store)

    await handler.handle_update(voice_tap("vno", vid, message_id=15))

    assert tg.answered == [("cb1", None)]
    assert tg.edited == [(42, 15, None)]
    assert tg.sent == [(42, VOICE_CANCEL_OK)]
    assert tg.options[0]["reply_to"] == 15
    assert events == ["answer:None", "edit", "send"]
    assert bot.calls == []
    entry = store.get(vid)
    assert entry is not None and entry.state == "cancelled"


# ---- §4.1 response table: every non-pending cell (3 verbs × 7 states) -----------------------------


@pytest.mark.parametrize(
    ("verb", "state", "expected_toast", "removes_keyboard"),
    [
        # confirmed
        ("vok", "confirmed", VOICE_ALREADY_REGISTERING, False),
        ("vfix", "confirmed", VOICE_ALREADY_REGISTERING, False),
        ("vno", "confirmed", VOICE_CANCEL_REGISTERING, False),
        # done
        ("vok", "done", VOICE_ALREADY_SENT, False),
        ("vfix", "done", VOICE_ALREADY_SENT, False),
        ("vno", "done", VOICE_CANCEL_SENT, False),
        # uncertain (shares the `done / uncertain` column)
        ("vok", "uncertain", VOICE_ALREADY_SENT, False),
        ("vfix", "uncertain", VOICE_ALREADY_SENT, False),
        ("vno", "uncertain", VOICE_CANCEL_SENT, False),
        # cancelled
        ("vok", "cancelled", VOICE_CANCELLED, False),
        ("vfix", "cancelled", VOICE_CANCELLED, False),
        ("vno", "cancelled", VOICE_ALREADY_CANCELLED, False),
        # superseded
        ("vok", "superseded", VOICE_SUPERSEDED, False),
        ("vfix", "superseded", VOICE_FIX_ALREADY, False),
        ("vno", "superseded", VOICE_SUPERSEDED, False),
        # expired
        ("vok", "expired", VOICE_EXPIRED, True),
        ("vfix", "expired", VOICE_EXPIRED, True),
        ("vno", "expired", VOICE_EXPIRED, True),
        # unknown
        ("vok", "unknown", VOICE_EXPIRED, True),
        ("vfix", "unknown", VOICE_EXPIRED, True),
        ("vno", "unknown", VOICE_EXPIRED, True),
    ],
)
async def test_every_non_pending_cell_of_the_response_table(
    verb: VoiceAction,
    state: VoiceState | Literal["unknown"],
    expected_toast: str,
    removes_keyboard: bool,
):
    clock = FakeClock(100.0)
    store = VoiceConfirmations(clock=clock)
    vid = _force_state(store, clock, state)
    bot = GatedBot()
    tg = OrderTelegram()
    handler = Handler({42}, bot, tg, confirmations=store)

    await handler.handle_update(voice_tap(verb, vid, message_id=9))

    assert tg.answered == [("cb1", expected_toast)]
    assert tg.sent == []
    assert bot.calls == []
    assert tg.edited == ([(42, 9, None)] if removes_keyboard else [])


# ---- concurrency (`asyncio.gather` & OS thread barrier) -------------------------------------------


async def test_concurrent_confirm_vs_cancel_when_confirm_enters_first():
    store = VoiceConfirmations()
    vid = seed_pending(store)
    started, release = asyncio.Event(), asyncio.Event()
    bot = GatedBot(started=started, release=release)
    tg = FakeTelegram()
    handler = Handler({42}, bot, tg, confirmations=store)

    async def confirm_then_release():
        await handler.handle_update(voice_tap("vok", vid, update_id=20, query_id="cb-ok"))

    async def cancel_while_running():
        await started.wait()
        await handler.handle_update(voice_tap("vno", vid, update_id=21, query_id="cb-no"))
        release.set()

    await asyncio.gather(confirm_then_release(), cancel_while_running())

    assert len(bot.calls) == 1
    assert dict(tg.answered) == {"cb-ok": VOICE_REGISTERING, "cb-no": VOICE_CANCEL_REGISTERING}
    entry = store.get(vid)
    assert entry is not None and entry.state == "done"


async def test_concurrent_confirm_vs_cancel_race_via_gather_runs_at_most_once():
    # Cancel scheduled first in gather: cancel wins, confirm sees `cancelled`, zero agent runs.
    store = VoiceConfirmations()
    vid = seed_pending(store)
    bot = GatedBot()
    tg = FakeTelegram()
    handler = Handler({42}, bot, tg, confirmations=store)

    await asyncio.gather(
        handler.handle_update(voice_tap("vno", vid, update_id=30, query_id="cb-no")),
        handler.handle_update(voice_tap("vok", vid, update_id=31, query_id="cb-ok")),
    )

    assert bot.calls == []
    assert dict(tg.answered) == {"cb-no": None, "cb-ok": VOICE_CANCELLED}
    assert tg.sent == [(42, VOICE_CANCEL_OK)]


async def test_concurrent_confirm_vs_fix_both_orders_run_agent_at_most_once():
    # 1) Confirm enters first, fix arrives while agent is running -> fix gets `Já estou registrando.`
    store1 = VoiceConfirmations()
    vid1 = seed_pending(store1)
    started, release = asyncio.Event(), asyncio.Event()
    bot1 = GatedBot(started=started, release=release)
    tg1 = FakeTelegram()
    h1 = Handler({42}, bot1, tg1, confirmations=store1)

    async def run_fix():
        await started.wait()
        await h1.handle_update(voice_tap("vfix", vid1, update_id=41, query_id="cb-fix"))
        release.set()

    await asyncio.gather(
        h1.handle_update(voice_tap("vok", vid1, update_id=40, query_id="cb-ok")),
        run_fix(),
    )
    assert len(bot1.calls) == 1
    assert dict(tg1.answered) == {"cb-ok": VOICE_REGISTERING, "cb-fix": VOICE_ALREADY_REGISTERING}

    # 2) Fix scheduled first in gather -> fix wins (`superseded`), confirm gets `Substituído pela correção.`
    store2 = VoiceConfirmations()
    vid2 = seed_pending(store2)
    bot2 = GatedBot()
    tg2 = FakeTelegram()
    h2 = Handler({42}, bot2, tg2, confirmations=store2)

    await asyncio.gather(
        h2.handle_update(voice_tap("vfix", vid2, update_id=42, query_id="cb-fix")),
        h2.handle_update(voice_tap("vok", vid2, update_id=43, query_id="cb-ok")),
    )
    assert bot2.calls == []
    assert dict(tg2.answered) == {"cb-fix": None, "cb-ok": VOICE_SUPERSEDED}


async def test_double_confirm_concurrently_runs_agent_once():
    store = VoiceConfirmations()
    vid = seed_pending(store)
    started, release = asyncio.Event(), asyncio.Event()
    bot = GatedBot(started=started, release=release)
    tg = FakeTelegram()
    handler = Handler({42}, bot, tg, confirmations=store)

    async def second_confirm():
        await started.wait()
        await handler.handle_update(voice_tap("vok", vid, update_id=51, query_id="cb2"))
        release.set()

    await asyncio.gather(
        handler.handle_update(voice_tap("vok", vid, update_id=50, query_id="cb1")),
        second_confirm(),
    )

    assert len(bot.calls) == 1
    assert dict(tg.answered) == {"cb1": VOICE_REGISTERING, "cb2": VOICE_ALREADY_REGISTERING}


def test_claim_is_atomic_across_threads():
    store = VoiceConfirmations()
    vid = seed_pending(store)
    barrier = threading.Barrier(8)

    def contender(i: int) -> bool:
        barrier.wait()
        action: VoiceAction = "vok" if i % 2 == 0 else "vno"
        return store.claim(vid, 42, action).ok

    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(contender, range(8)))
    assert outcomes.count(True) == 1


# ---- restart, eviction, TTL, hash check, inaccessible message, chat binding, uncertain ------------


async def test_new_store_after_restart_treats_vid_as_expired_and_never_runs_agent():
    before_restart = VoiceConfirmations()
    vid = seed_pending(before_restart, message_id=22)

    after_restart = VoiceConfirmations()
    bot = GatedBot()
    tg = FakeTelegram()
    handler = Handler({42}, bot, tg, confirmations=after_restart)

    await handler.handle_update(voice_tap("vok", vid, message_id=22))

    assert tg.answered == [("cb1", VOICE_EXPIRED)]
    assert tg.edited == [(42, 22, None)]
    assert tg.sent == []
    assert bot.calls == []


async def test_eviction_at_capacity_two_evicts_terminal_first_then_oldest_pending():
    store = VoiceConfirmations(max_size=2)
    v1 = seed_pending(store, "primeiro", message_id=1)
    v2 = seed_pending(store, "segundo", message_id=2)
    v3 = seed_pending(store, "terceiro", message_id=3)  # evicts oldest pending (v1)

    bot = GatedBot()
    tg = FakeTelegram()
    handler = Handler({42}, bot, tg, confirmations=store)

    await handler.handle_update(voice_tap("vok", v1, body="primeiro", message_id=1, update_id=60))
    assert tg.answered == [("cb1", VOICE_EXPIRED)]
    assert tg.edited == [(42, 1, None)]
    assert bot.calls == []

    # Cancel v3 (v3 becomes terminal while v2 is still pending), then insert v4: terminal v3 goes first!
    store.claim(v3, 42, "vno")
    v4 = seed_pending(store, "quarto", message_id=4)
    assert store.get(v3) is None
    assert store.get(v2) is not None and store.get(v4) is not None

    await handler.handle_update(
        voice_tap("vok", v2, body="segundo", message_id=2, update_id=61, query_id="cb2")
    )
    assert len(bot.calls) == 1 and bot.calls[0][0] == "segundo"


def test_eviction_never_drops_in_flight_confirmed_entry():
    store = VoiceConfirmations(max_size=2)
    v1 = seed_pending(store, "um")
    v2 = seed_pending(store, "dois")
    assert store.claim(v1, 42, "vok").ok
    assert store.claim(v2, 42, "vok").ok
    v3 = seed_pending(store, "tres")
    assert store.get(v1) is not None and store.get(v2) is not None and store.get(v3) is not None


async def test_ttl_and_terminal_retention_with_fake_clocks():
    clock = FakeClock(1000.0)
    store = VoiceConfirmations(clock=clock)
    v_boundary = seed_pending(store, message_id=1)
    clock.advance(VOICE_CONFIRM_TTL_S)  # exact boundary (age == 1800 s): still valid
    assert store.claim(v_boundary, 42, "vno").ok

    v_late = seed_pending(store, message_id=2)
    clock.advance(VOICE_CONFIRM_TTL_S + 0.01)  # age > 1800 s: expired
    bot = GatedBot()
    tg = FakeTelegram()
    handler = Handler({42}, bot, tg, confirmations=store)
    await handler.handle_update(voice_tap("vok", v_late, message_id=2, update_id=70))
    assert tg.answered == [("cb1", VOICE_EXPIRED)]
    assert tg.edited == [(42, 2, None)]
    assert bot.calls == []
    entry = store.get(v_late)
    assert entry is not None and entry.state == "expired"

    # Terminal entries answer precisely for 24 h from when they became terminal, then become unknown.
    v_cancelled = seed_pending(store, message_id=3)
    assert store.claim(v_cancelled, 42, "vno").ok
    clock.advance(VOICE_TERMINAL_TTL_S)
    assert store.claim(v_cancelled, 42, "vok").state == "cancelled"
    clock.advance(0.01)
    assert store.claim(v_cancelled, 42, "vok").refusal == "unknown"

    # Datetime clock also works.
    now_dt = datetime(2026, 11, 14, 12, 0, tzinfo=UTC)
    dt_store = VoiceConfirmations(clock=lambda: now_dt)
    vid_dt = dt_store.create(42, sha256_hex(TRANSCRIPT))
    now_dt = now_dt + timedelta(minutes=31)
    assert dt_store.claim(vid_dt, 42, "vok").refusal == "expired"


@pytest.mark.parametrize("verb", ["vok", "vfix"])
async def test_hash_mismatch_undoes_claim_to_expired_and_runs_nothing(verb: VoiceAction):
    store = VoiceConfirmations()
    vid = seed_pending(store, "supino 60 por 8", message_id=9)
    bot = GatedBot()
    tg = FakeTelegram()
    handler = Handler({42}, bot, tg, confirmations=store)

    await handler.handle_update(voice_tap(verb, vid, body="supino 160 por 8", message_id=9, update_id=80))

    assert tg.answered == [("cb1", VOICE_EXPIRED)]
    assert tg.edited == [(42, 9, None)]
    assert tg.sent == []
    assert bot.calls == []
    entry = store.get(vid)
    assert entry is not None and entry.state == "expired"


@pytest.mark.parametrize(
    "bad_tap",
    [
        # Telegram `InaccessibleMessage`: date == 0, no text
        lambda vid: voice_tap("vok", vid, body=None, date=0, update_id=81),
        # `InaccessibleMessage` even if text were forged alongside date == 0
        lambda vid: voice_tap("vok", vid, body=TRANSCRIPT, date=0, update_id=82),
        # Message without `Entendi` header
        lambda vid: {
            "update_id": 83,
            "callback_query": {
                "id": "cb1",
                "from": {"id": 42, "is_bot": False},
                "data": f"vok:{vid}",
                "message": {"message_id": 9, "chat": {"id": 42}, "date": 1_700_000_000, "text": TRANSCRIPT},
            },
        },
        # Callback query with missing `message` field altogether
        lambda vid: {
            "update_id": 84,
            "callback_query": {
                "id": "cb1",
                "from": {"id": 42, "is_bot": False},
                "data": f"vok:{vid}",
            },
        },
    ],
)
async def test_missing_or_inaccessible_message_undoes_claim_to_expired(bad_tap):
    store = VoiceConfirmations()
    vid = seed_pending(store, TRANSCRIPT, message_id=9)
    bot = GatedBot()
    tg = FakeTelegram()
    handler = Handler({42}, bot, tg, confirmations=store)

    await handler.handle_update(bad_tap(vid))

    assert tg.answered == [("cb1", VOICE_EXPIRED)]
    assert tg.edited == [(42, 9, None)]
    assert tg.sent == []
    assert bot.calls == []
    entry = store.get(vid)
    assert entry is not None and entry.state == "expired"


async def test_tap_from_another_chat_is_refused_without_touching_owners_pending_entry():
    store = VoiceConfirmations()
    vid = seed_pending(store, TRANSCRIPT, chat_id=42, message_id=9)
    bot = GatedBot()
    tg = FakeTelegram()
    handler = Handler({42, 43}, bot, tg, confirmations=store)

    # Disallowed chat 7: answered silently and ignored.
    await handler.handle_update(voice_tap("vok", vid, chat_id=7, update_id=90, query_id="cb-7"))
    # Another allowed chat 43: refused by VoiceConfirmations (`wrong_chat` -> `Expirou…`), owner untouched.
    await handler.handle_update(voice_tap("vok", vid, chat_id=43, update_id=91, query_id="cb-43"))

    assert tg.answered == [("cb-7", None), ("cb-43", VOICE_EXPIRED)]
    assert tg.edited == []
    assert bot.calls == []
    entry = store.get(vid)
    assert entry is not None and entry.state == "pending"

    # Owner chat 42 can still confirm normally.
    await handler.handle_update(voice_tap("vok", vid, chat_id=42, update_id=92, query_id="cb-42"))
    assert len(bot.calls) == 1


async def test_confirmed_run_ending_uncertain_leaves_vid_uncertain_and_later_vok_answers_ja_enviado():
    store = VoiceConfirmations()
    vid = seed_pending(store, TRANSCRIPT, message_id=9)
    uncertain = Answer(WRITE_UNCERTAIN, failed=True, outcome="uncertain")
    bot = GatedBot(answer=uncertain)
    tg = FakeTelegram()
    handler = Handler({42}, bot, tg, confirmations=store)

    await handler.handle_update(voice_tap("vok", vid, update_id=100, query_id="cb1"))
    entry = store.get(vid)
    assert entry is not None and entry.state == "uncertain"
    assert tg.sent == [(42, WRITE_UNCERTAIN)]

    await handler.handle_update(voice_tap("vok", vid, update_id=101, query_id="cb2"))
    await handler.handle_update(voice_tap("vno", vid, update_id=102, query_id="cb3"))
    assert len(bot.calls) == 1
    assert tg.answered == [
        ("cb1", VOICE_REGISTERING),
        ("cb2", VOICE_ALREADY_SENT),
        ("cb3", VOICE_CANCEL_SENT),
    ]


async def test_confirmed_run_cut_by_hard_limit_leaves_vid_uncertain():
    class SlowBot:
        calls = 0

        async def reply(self, text, user_id="telegram", *, context=None, media=None):
            self.calls += 1
            await asyncio.sleep(5)
            return Answer("ok")

    store = VoiceConfirmations()
    vid = seed_pending(store, TRANSCRIPT, message_id=9)
    bot = SlowBot()
    tg = FakeTelegram()
    handler = Handler({42}, bot, tg, confirmations=store, message_deadline_s=0.05, send_reserve_s=0.05)

    await handler.handle_update(voice_tap("vok", vid, update_id=110, query_id="cb1"))
    entry = store.get(vid)
    assert entry is not None and entry.state == "uncertain"
    assert tg.sent == [(42, CUT)]

    await handler.handle_update(voice_tap("vok", vid, update_id=111, query_id="cb2"))
    assert bot.calls == 1
    assert tg.answered[-1] == ("cb2", VOICE_ALREADY_SENT)


def test_voice_keyboard_matches_spec_labels_and_callback_data():
    vid = "0123456789abcdef"
    markup = voice_keyboard(vid)
    row = markup["inline_keyboard"][0]
    assert [b["text"] for b in row] == ["✅ Confirmar", "✏️ Corrigir", "✖️ Cancelar"]
    assert [b["callback_data"] for b in row] == [f"vok:{vid}", f"vfix:{vid}", f"vno:{vid}"]
    assert entendi_text("peso 82") == f"{ENTENDI_HEADER}\n\npeso 82"
    assert buttons.action(f"vok:{vid}") == "vok"
    assert buttons.action(f"vfix:{vid}") == "vfix"
    assert buttons.action(f"vno:{vid}") == "vno"
