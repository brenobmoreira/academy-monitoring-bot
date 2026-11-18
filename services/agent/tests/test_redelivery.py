"""§4.3.4 / §4.3.5 re-delivery tests: a terminal write state survives failed replies and callbacks."""

from __future__ import annotations

import copy
import json
from datetime import datetime
from typing import Any

import pytest

from agent import miniapp
from agent.bot import SHEET_FAILED, Bot
from agent.buttons import entendi_text
from agent.handler import Handler
from agent.voice_confirm import VOICE_ALREADY_SENT, VoiceConfirmations, sha256_hex

from .fakes import OK_DIARY, FakeSheet, FakeTelegram, ScriptedLlm, call, say

pytestmark = pytest.mark.unit

TZ = "America/Sao_Paulo"
DOWN = {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": "locked"}]}
UNCERTAIN = {"ok": False, "errors": [{"path": "", "code": "internal", "message": "after commit"}]}

FOOD_FORM: dict[str, Any] = {
    "v": 1,
    "t": "food",
    "id": "0123456789abcdef0123456789abcdef",
    "args": {
        "date": "2026-09-21",
        "meal": "Almoço",
        "items": [{"food": "Arroz", "qty": 150, "unit": "g"}],
    },
}


class FlakyTelegram(FakeTelegram):
    """Fails `send_message`, `answer_callback_query` and/or `edit_message_reply_markup` a fixed
    number of times before succeeding."""

    def __init__(
        self,
        *,
        fail_sends: int = 0,
        fail_answers: int = 0,
        fail_edits: int = 0,
    ) -> None:
        super().__init__()
        self.fail_sends = fail_sends
        self.fail_answers = fail_answers
        self.fail_edits = fail_edits

    async def send_message(self, chat_id, text, *, html=False, reply_markup=None, reply_to=None):
        if self.fail_sends > 0:
            self.fail_sends -= 1
            raise RuntimeError("telegram send failed")
        return await super().send_message(
            chat_id, text, html=html, reply_markup=reply_markup, reply_to=reply_to
        )

    async def answer_callback_query(self, callback_query_id, text=None):
        if self.fail_answers > 0:
            self.fail_answers -= 1
            raise RuntimeError("telegram answerCallbackQuery failed")
        await super().answer_callback_query(callback_query_id, text)

    async def edit_message_reply_markup(self, chat_id, message_id, reply_markup=None):
        if self.fail_edits > 0:
            self.fail_edits -= 1
            raise RuntimeError("telegram editMessageReplyMarkup failed")
        await super().edit_message_reply_markup(chat_id, message_id, reply_markup)


def scripted_bot(sheet: FakeSheet, script: list[Any] | None = None) -> tuple[Bot, ScriptedLlm]:
    llm = ScriptedLlm(model="scripted", script=script or [])
    return Bot(sheet, llm, timezone=TZ), llm


def text_update(text: str = "peso 82,4", *, update_id: int = 1) -> dict[str, Any]:
    return {"update_id": update_id, "message": {"chat": {"id": 42}, "text": text}}


def clock() -> datetime:
    return datetime(2026, 9, 21, 12, 0)


# ---- 1. Agent write `committed` + `send_message` fails --------------------------------------------


async def test_committed_agent_write_is_not_rerun_when_send_message_fails():
    sheet = FakeSheet(diary_upsert=[OK_DIARY, OK_DIARY])
    bot, llm = scripted_bot(
        sheet,
        [
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            say("Ok"),
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            say("Ok"),
        ],
    )
    tg = FlakyTelegram(fail_sends=1)
    handler = Handler({42}, bot, tg, sheet=sheet)

    same_update = text_update(update_id=101)
    await handler.handle_update(copy.deepcopy(same_update))
    assert tg.sent == []  # first send failed
    assert [op for op, _ in sheet.calls] == ["diary.upsert"]
    assert len(llm.requests) == 2

    # Re-delivering the exact same update: deduplicator kept it completed -> neither bot nor sheet runs.
    await handler.handle_update(copy.deepcopy(same_update))
    assert [op for op, _ in sheet.calls] == ["diary.upsert"]
    assert len(llm.requests) == 2
    assert tg.sent == []


# ---- 2. Agent write `uncertain` + `send_message` fails --------------------------------------------


async def test_uncertain_agent_write_is_not_rerun_when_send_message_fails():
    sheet = FakeSheet(diary_upsert=[UNCERTAIN, OK_DIARY])
    bot, llm = scripted_bot(
        sheet,
        [
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            say("Pode ter entrado."),
        ],
    )
    tg = FlakyTelegram(fail_sends=1)
    handler = Handler({42}, bot, tg, sheet=sheet)

    same_update = text_update(update_id=102)
    await handler.handle_update(copy.deepcopy(same_update))
    assert tg.sent == []
    assert [op for op, _ in sheet.calls] == ["diary.upsert"]

    await handler.handle_update(copy.deepcopy(same_update))
    assert [op for op, _ in sheet.calls] == ["diary.upsert"]
    assert len(llm.requests) == 2
    assert tg.sent == []


# ---- 3. `not_committed` + transient + `send_message` fails -> allowed to run again ----------------


async def test_not_committed_transient_failure_reruns_on_redelivery_after_failed_send():
    sheet = FakeSheet(diary_upsert=[DOWN, OK_DIARY])
    bot, _ = scripted_bot(
        sheet,
        [
            # 1st delivery: sheet is down before any write -> not_committed + transient, send fails
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            say("Planilha fora."),
            # 2nd delivery: allowed to run again -> succeeds!
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            say("Ok"),
        ],
    )
    tg = FlakyTelegram(fail_sends=1)
    handler = Handler({42}, bot, tg, sheet=sheet)

    same_update = text_update(update_id=103)
    await handler.handle_update(copy.deepcopy(same_update))
    assert tg.sent == []
    assert [op for op, _ in sheet.calls] == ["diary.upsert"]

    await handler.handle_update(copy.deepcopy(same_update))
    assert [op for op, _ in sheet.calls] == ["diary.upsert", "diary.upsert"]
    assert len(tg.sent) == 1
    assert tg.sent[0][1] != SHEET_FAILED and "82,4" in tg.sent[0][1]


# ---- 4. `vok` -> `uncertain` + reply and `answer_callback_query` both fail ------------------------


async def test_vok_uncertain_with_failed_reply_and_callback_answer_never_runs_again():
    transcript = "peso 82,4"
    store = VoiceConfirmations()
    vid = store.create(42, sha256_hex(transcript), message_id=9)

    sheet = FakeSheet(diary_upsert=[UNCERTAIN, OK_DIARY])
    bot, llm = scripted_bot(
        sheet,
        [
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            say("Não sei se entrou."),
        ],
    )
    tg = FlakyTelegram(fail_sends=1, fail_answers=1, fail_edits=1)
    handler = Handler({42}, bot, tg, sheet=sheet, confirmations=store)

    cb_update = {
        "update_id": 104,
        "callback_query": {
            "id": "cb-vok-1",
            "from": {"id": 42, "is_bot": False},
            "data": f"vok:{vid}",
            "message": {
                "message_id": 9,
                "chat": {"id": 42},
                "date": 1_700_000_000,
                "text": entendi_text(transcript),
            },
        },
    }

    await handler.handle_update(copy.deepcopy(cb_update))
    assert tg.sent == [] and tg.answered == []
    assert [op for op, _ in sheet.calls] == ["diary.upsert"]
    entry = store.get(vid)
    assert entry is not None and entry.state == "uncertain"

    # (a) Same callback update re-delivered by Telegram: ignored, zero second run.
    await handler.handle_update(copy.deepcopy(cb_update))
    assert [op for op, _ in sheet.calls] == ["diary.upsert"]
    assert len(llm.requests) == 2

    # (b) Brand-new callback update with the same `vok:<vid>`: VoiceConfirmations answers `Já enviado…`!
    later_tap = {
        **copy.deepcopy(cb_update),
        "update_id": 105,
        "callback_query": {**copy.deepcopy(cb_update["callback_query"]), "id": "cb-vok-2"},
    }
    await handler.handle_update(later_tap)
    assert [op for op, _ in sheet.calls] == ["diary.upsert"]
    assert len(llm.requests) == 2
    assert tg.answered == [("cb-vok-2", VOICE_ALREADY_SENT)]


# ---- 5. `retry:<id>` -> `uncertain` + reply fails -> no second write & dropped from PendingStore --


async def test_retry_uncertain_with_failed_reply_drops_pending_and_never_writes_twice(monkeypatch):
    monkeypatch.setattr(miniapp, "RETRY_DELAYS", (0, 0))
    pending = miniapp.PendingStore()
    sheet = FakeSheet(
        food_add=[
            DOWN,
            DOWN,
            DOWN,  # initial form submission: 3 outages -> stored in PendingStore
            UNCERTAIN,  # 1st retry tap -> write_outcome == "uncertain"
            {"ok": True, "result": {"writeId": "w1", "date": "2026-09-21", "meal": "Almoço", "added": 1}},
        ]
    )
    bot, _ = scripted_bot(sheet)
    tg = FlakyTelegram()
    handler = Handler({42}, bot, tg, sheet=sheet, clock=clock, pending=pending)

    form_update = {
        "update_id": 200,
        "message": {"chat": {"id": 42}, "web_app_data": {"data": json.dumps(FOOD_FORM)}},
    }
    await handler.handle_update(form_update)
    assert len(pending) == 1
    retry_data = tg.options[0]["reply_markup"]["inline_keyboard"][0][0]["callback_data"]
    assert retry_data.startswith("retry:")

    # Now fail both `send_message` and `answer_callback_query` during the retry tap!
    tg.fail_sends = 1
    tg.fail_answers = 1
    retry_update = {
        "update_id": 201,
        "callback_query": {
            "id": "cb-retry-1",
            "data": retry_data,
            "message": {"message_id": 1, "chat": {"id": 42}, "text": miniapp.UNAVAILABLE},
        },
    }
    await handler.handle_update(copy.deepcopy(retry_update))
    assert len(sheet.calls) == 4  # 3 initial + 1 uncertain retry
    assert len(pending) == 0  # dropped from PendingStore even though reply failed!

    # (a) Exact same callback update re-delivered: ignored by deduplicator -> no 5th call.
    await handler.handle_update(copy.deepcopy(retry_update))
    assert len(sheet.calls) == 4

    # (b) Even a new tap on the unedited button gets EXPIRED without calling the sheet.
    new_tap = {
        **copy.deepcopy(retry_update),
        "update_id": 202,
        "callback_query": {**copy.deepcopy(retry_update["callback_query"]), "id": "cb-retry-2"},
    }
    await handler.handle_update(new_tap)
    assert len(sheet.calls) == 4
    assert tg.sent[-1] == (42, miniapp.EXPIRED)


# ---- 6. `undo:...` -> `uncertain` + reply fails -> delivered again -> no second undo --------------


async def test_undo_uncertain_with_failed_reply_is_not_rerun_on_redelivery():
    sheet = FakeSheet(
        write_undo=[
            UNCERTAIN,
            {"ok": True, "result": {"writeId": "u2", "undone": {"op": "diary.upsert", "date": "2026-09-21"}}},
        ]
    )
    bot, _ = scripted_bot(sheet)
    tg = FlakyTelegram(fail_sends=1, fail_answers=1, fail_edits=1)
    handler = Handler({42}, bot, tg, sheet=sheet)

    undo_update = {
        "update_id": 300,
        "callback_query": {
            "id": "cb-undo-1",
            "data": "undo:w1",
            "message": {"message_id": 9, "chat": {"id": 42}, "text": "21/09 · Peso kg 82,4"},
        },
    }
    await handler.handle_update(copy.deepcopy(undo_update))
    assert sheet.calls == [("write.undo", {"writeId": "w1"})]
    assert tg.sent == []

    # Same callback update re-delivered: completed was True -> no second `write.undo`.
    await handler.handle_update(copy.deepcopy(undo_update))
    assert sheet.calls == [("write.undo", {"writeId": "w1"})]


# ---- Additional §4.3.4 checks: Mini App direct form & non-write updates ---------------------------


@pytest.mark.parametrize(
    "sheet_answer",
    [
        {"ok": True, "result": {"writeId": "w1", "date": "2026-09-21", "meal": "Almoço", "added": 1}},
        UNCERTAIN,
    ],
)
async def test_miniapp_terminal_write_survives_failed_send(sheet_answer: dict[str, Any]):
    sheet = FakeSheet(food_add=[sheet_answer, sheet_answer])
    bot, _ = scripted_bot(sheet)
    tg = FlakyTelegram(fail_sends=1)
    handler = Handler({42}, bot, tg, sheet=sheet, clock=clock)

    form_update = {
        "update_id": 400,
        "message": {"chat": {"id": 42}, "web_app_data": {"data": json.dumps(FOOD_FORM)}},
    }
    await handler.handle_update(copy.deepcopy(form_update))
    await handler.handle_update(copy.deepcopy(form_update))
    assert len(sheet.calls) == 1


async def test_update_with_no_write_keeps_existing_rule_when_send_fails():
    empty = {"ok": True, "result": {"date": "2026-09-21", "diary": {}, "workout": []}}
    sheet = FakeSheet(day_get=[empty, empty])
    bot, _ = scripted_bot(sheet)
    tg = FlakyTelegram(fail_sends=1)
    handler = Handler({42}, bot, tg, sheet=sheet, clock=clock)

    read_update = text_update("/hoje", update_id=500)
    await handler.handle_update(copy.deepcopy(read_update))
    assert tg.sent == []
    assert len(sheet.calls) == 1

    # No write was attempted (`write_outcome is None`) and send failed -> second delivery runs and replies.
    await handler.handle_update(copy.deepcopy(read_update))
    assert len(sheet.calls) == 2
    assert tg.sent == [(42, "Nada registrado em 21/09.")]


# ---- 7. Mini App `t: "text"` terminal write + `send_message` fails (§4.2 + §4.3.4) -----------------


def miniapp_text_update(
    text: str = "peso 82,4",
    *,
    sid: str = "fedcba9876543210fedcba9876543210",
    update_id: int = 600,
) -> dict[str, Any]:
    payload = {"v": 1, "t": "text", "id": sid, "src": "voice", "text": text}
    return {
        "update_id": update_id,
        "message": {"chat": {"id": 42}, "web_app_data": {"data": json.dumps(payload)}},
    }


@pytest.mark.parametrize("sheet_answer", [OK_DIARY, UNCERTAIN])
async def test_miniapp_text_terminal_write_is_not_rerun_when_send_message_fails(
    sheet_answer: dict[str, Any],
):
    from agent.text_submissions import DONE_REPLY, UNCERTAIN_REPLY, TextSubmissions

    sheet = FakeSheet(diary_upsert=[sheet_answer, OK_DIARY])
    bot, llm = scripted_bot(
        sheet,
        [
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            say("Ok"),
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            say("Não deveria rodar."),
        ],
    )
    tg = FlakyTelegram(fail_sends=1)
    submissions = TextSubmissions()
    handler = Handler({42}, bot, tg, sheet=sheet, clock=clock, text_submissions=submissions)

    same_update = miniapp_text_update(update_id=601)
    await handler.handle_update(copy.deepcopy(same_update))
    assert tg.sent == []  # first reply failed to send
    assert [op for op, _ in sheet.calls] == ["diary.upsert"]
    assert len(llm.requests) == 2

    # (a) Exact same `update_id` re-delivered by Telegram: ignored by deduplicator, zero second run.
    await handler.handle_update(copy.deepcopy(same_update))
    assert [op for op, _ in sheet.calls] == ["diary.upsert"]
    assert len(llm.requests) == 2
    assert tg.sent == []

    # (b) Even a new `update_id` with the same `t: "text"` payload is stopped by TextSubmissions.
    await handler.handle_update(miniapp_text_update(update_id=602))
    assert [op for op, _ in sheet.calls] == ["diary.upsert"]
    assert len(llm.requests) == 2
    expected = DONE_REPLY if sheet_answer is OK_DIARY else UNCERTAIN_REPLY
    assert tg.sent == [(42, expected)]


async def test_miniapp_text_not_committed_transient_reruns_on_same_update_redelivery_after_failed_send():
    sheet = FakeSheet(diary_upsert=[DOWN, OK_DIARY])
    bot, _ = scripted_bot(
        sheet,
        [
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            say("Planilha fora."),
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            say("Ok"),
        ],
    )
    tg = FlakyTelegram(fail_sends=1)
    handler = Handler({42}, bot, tg, sheet=sheet, clock=clock)

    same_update = miniapp_text_update(update_id=603)
    await handler.handle_update(copy.deepcopy(same_update))
    assert tg.sent == []
    assert [op for op, _ in sheet.calls] == ["diary.upsert"]

    await handler.handle_update(copy.deepcopy(same_update))
    assert [op for op, _ in sheet.calls] == ["diary.upsert", "diary.upsert"]
    assert len(tg.sent) == 1
    assert tg.sent[0][1] != SHEET_FAILED and "82,4" in tg.sent[0][1]
