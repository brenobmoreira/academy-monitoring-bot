from __future__ import annotations

import base64
import json
import zlib
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import pytest

from agent import buttons, miniapp
from agent.bot import Bot, Media
from agent.handler import Handler
from agent.summary import food_draft_summary
from agent.voice_confirm import VoiceConfirmations, sha256_hex

from .fakes import FakeSheet, FakeTelegram, ScriptedLlm, call, file, media_update, say

pytestmark = pytest.mark.unit

NOW = datetime(2026, 9, 21, 13, 0, tzinfo=ZoneInfo("America/Sao_Paulo"))
MINIAPP_URL = "https://example.github.io/shape/"
CATALOG: dict[str, Any] = {
    "client": {"name": "Luan"},
    "today": "2026-09-21",
    "timezone": "America/Sao_Paulo",
    "meals": ["Café da manhã", "Almoço", "Jantar"],
    "units": ["g", "un", "ml"],
    "foods": ["Arroz branco cozido", "Peito de frango grelhado"],
    "favorites": ["Café da manhã básico"],
}


class FakeClock:
    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def decode_food_fragment(url: str) -> dict[str, Any]:
    prefix = f"{MINIAPP_URL}#v=food&c="
    assert url.startswith(prefix)
    token = url[len(prefix) :]
    padded = token + "=" * (-len(token) % 4)
    compressed = base64.urlsafe_b64decode(padded.encode("ascii"))
    return json.loads(zlib.decompress(compressed, -15).decode("utf-8"))


def tap(data: str, *, chat_id: int = 42, message_id: int = 1, update_id: int = 50, query_id: str = "cb1"):
    return {
        "update_id": update_id,
        "callback_query": {
            "id": query_id,
            "from": {"id": chat_id, "is_bot": False},
            "data": data,
            "message": {"message_id": message_id, "chat": {"id": chat_id}, "text": "rascunho"},
        },
    }


def test_food_draft_summary_escapes_html_and_warns_nothing_saved():
    draft = {
        "date": "2026-09-21",
        "meal": "Almoço <1>",
        "items": [
            {"food": "Arroz & Feijão", "qty": 150.5, "unit": "g", "measure": "Estimada"},
            {"favorite": "Café <básico>", "portions": 2},
            {"description": "bife <acebolado>", "qty": 120, "unit": "g"},
        ],
    }
    html = food_draft_summary(draft)
    lines = html.splitlines()
    assert lines[0] == "🍽️ <b>Rascunho — 21/09 · Almoço &lt;1&gt;:</b>"
    assert lines[1] == "• Arroz &amp; Feijão 150,5 g (Estimada)"
    assert lines[2] == "• Café &lt;básico&gt; × 2 (favorita)"
    assert lines[3] == "• bife &lt;acebolado&gt; 120 g (sem cálculo)"
    assert lines[4] == "Nada foi gravado ainda. Confirme para registrar ou ajuste no Mini App."


def test_food_draft_store_enforces_chat_binding_single_claim_ttl_and_capacity():
    clock = FakeClock()
    store = miniapp.FoodDraftStore(max_size=2, ttl_s=60.0, clock=clock)
    draft = {"date": "2026-09-21", "meal": "Almoço", "items": [{"food": "Arroz", "qty": 150, "unit": "g"}]}

    k1 = store.put(42, draft)
    assert len(k1) == 16 and len(store) == 1
    assert store.peek(k1, 99) is None
    peeked = store.peek(k1, 42)
    assert peeked == draft
    # Mutating peeked copy never corrupts stored draft
    assert peeked is not None
    peeked["meal"] = "Outro"
    assert store.peek(k1, 42) == draft

    # Single claim consumes the draft
    claimed = store.claim(k1, 42)
    assert claimed == draft
    assert store.claim(k1, 42) is None
    assert store.peek(k1, 42) is None

    # Eviction drops oldest at capacity
    a = store.put(42, {**draft, "meal": "A"})
    b = store.put(42, {**draft, "meal": "B"})
    c = store.put(42, {**draft, "meal": "C"})
    assert len(store) == 2
    assert store.peek(a, 42) is None
    assert store.peek(b, 42) is not None and store.peek(c, 42) is not None

    # TTL purge expires stale drafts strictly after ttl_s
    clock.advance(60.0)
    assert store.peek(b, 42) is None
    assert len(store) == 0


def test_food_draft_markup_trims_catalog_under_tight_budget_while_preserving_df():
    big_catalog = {
        **CATALOG,
        "foods": [f"Alimento longo número {i:03d}" for i in range(60)],
        # The sheet's `catalog` rows: name, base unit, base qty, kcal, protein, carbs, fat,
        # household measure and its quantity.
        "foodTable": [
            [f"Alimento longo número {i:03d}", "g", 100, 120 + i, 5, 10, 2, None, None] for i in range(60)
        ],
        "todayTotals": {"kcal": 800, "protein": 60, "carbs": 90, "fat": 20},
        "phase": {"goal": {"kcal": 2400, "protein": 160, "carbs": 260, "fat": 70}},
    }
    draft = {
        "date": "2026-09-21",
        "meal": "Almoço",
        "items": [{"food": "Arroz branco cozido", "qty": 150, "unit": "g", "measure": "Estimada"}],
    }
    markup, dropped = miniapp.food_draft_markup(
        MINIAPP_URL,
        big_catalog,
        draft,
        max_len=450,
        voice_keys={"vu": "https://voice.example/upload", "vc": "secret", "vx": 9999999999},
    )
    assert markup["one_time_keyboard"] is True
    assert markup["keyboard"][0][0]["text"] == miniapp.DRAFT_ADJUST_BUTTON
    assert "fv" in dropped
    decoded = decode_food_fragment(markup["keyboard"][0][0]["web_app"]["url"])
    assert decoded["view"] == "food"
    assert "fv" not in decoded
    assert decoded["df"] == {
        "d": "2026-09-21",
        "m": "Almoço",
        "i": [{"f": "Arroz branco cozido", "q": 150, "u": "g", "ms": "Estimada"}],
    }


async def test_bot_propose_food_leaves_sheet_untouched_and_populates_answer_draft():
    sheet = FakeSheet(catalog=[{"ok": True, "result": CATALOG}])
    draft_items = [
        {"food": "Arroz branco cozido", "qty": 160, "unit": "g", "measure": "Estimada"},
        {"food": "Peito de frango grelhado", "qty": 120, "unit": "g", "measure": "Estimada"},
    ]
    llm = ScriptedLlm(
        model="scripted",
        script=[
            call("get_catalog"),
            call("propose_food", date="2026-09-21", meal="Almoço", items=draft_items),
            say("Estimei o prato pela foto; confira as gramas antes de salvar."),
        ],
        requests=[],
    )
    b = Bot(sheet, llm, timezone="America/Sao_Paulo", clock=lambda: NOW)
    reply = await b.reply(
        "almoço de hoje",
        media=[Media("image/jpeg", b"\xff\xd8\xff\xe0")],
    )

    assert reply.wrote is False
    assert reply.write_ids == ()
    assert reply.food_draft == {"date": "2026-09-21", "meal": "Almoço", "items": draft_items}
    assert sheet.calls == [("catalog", {})]  # no food.add write!
    assert "Nada foi gravado ainda." in reply.text
    assert "Arroz branco cozido 160 g (Estimada)" in reply.text


async def test_photo_handler_draft_confirm_adjust_and_cancel_flows():
    sheet = FakeSheet(
        catalog=[
            {"ok": True, "result": CATALOG},  # Bot get_catalog
            {"ok": True, "result": CATALOG},  # Handler dfix sheet.catalog()
        ],
        food_add=[
            {
                "ok": True,
                "result": {
                    "writeId": "w_food_1",
                    "date": "2026-09-21",
                    "meal": "Almoço",
                    "items": [{"food": "Arroz branco cozido", "qty": 150, "unit": "g"}],
                },
            }
        ],
    )
    draft_items = [{"food": "Arroz branco cozido", "qty": 150, "unit": "g", "measure": "Estimada"}]
    llm = ScriptedLlm(
        model="scripted",
        script=[
            call("get_catalog"),
            call("propose_food", date="2026-09-21", meal="Almoço", items=draft_items),
            say("Prato montado como rascunho."),
        ],
        requests=[],
    )
    b = Bot(sheet, llm, timezone="America/Sao_Paulo", clock=lambda: NOW)
    tg = FakeTelegram(files=file("p1", b"\xff\xd8\xff\xe0", "photos/p1.jpg"))
    store = miniapp.FoodDraftStore()
    handler = Handler(
        {42, 99},
        b,
        tg,
        sheet=sheet,
        clock=lambda: NOW,
        miniapp_url=MINIAPP_URL,
        food_drafts=store,
    )

    # 1. Photo triggers propose_food -> sends draft HTML + inline keyboard, 0 sheet writes
    await handler.handle_update(
        media_update(
            chat_id=42,
            photo=[{"file_id": "p1", "file_size": 4, "width": 100, "height": 100}],
            caption="meu almoço",
        )
    )
    assert len(tg.sent) == 1
    assert "Nada foi gravado ainda." in tg.sent[0][1]
    kb = tg.options[0]["reply_markup"]["inline_keyboard"]
    dok_data = kb[0][0]["callback_data"]
    dfix_data = kb[0][1]["callback_data"]
    dno_data = kb[1][0]["callback_data"]
    assert dok_data.startswith("dok:") and dfix_data.startswith("dfix:") and dno_data.startswith("dno:")
    assert [op for op, _ in sheet.calls] == ["catalog"]

    # 2. Tapping dfix keeps draft alive and returns ReplyKeyboard with compressed df fragment
    await handler.handle_update(tap(dfix_data, chat_id=42, message_id=1, update_id=3, query_id="cb_fix"))
    assert len(tg.sent) == 2
    reply_kb = tg.options[1]["reply_markup"]
    assert reply_kb["one_time_keyboard"] is True
    assert reply_kb["keyboard"][0][0]["text"] == miniapp.DRAFT_ADJUST_BUTTON
    decoded = decode_food_fragment(reply_kb["keyboard"][0][0]["web_app"]["url"])
    assert decoded["df"]["d"] == "2026-09-21"
    assert decoded["df"]["m"] == "Almoço"
    assert decoded["df"]["i"] == [{"f": "Arroz branco cozido", "q": 150, "u": "g", "ms": "Estimada"}]

    # 3. Wrong chat cannot claim or peek the draft
    await handler.handle_update(tap(dok_data, chat_id=99, message_id=1, update_id=4, query_id="cb_wrong"))
    assert tg.sent[-1] == (99, miniapp.DRAFT_EXPIRED)
    assert [op for op, _ in sheet.calls] == ["catalog", "catalog"]

    # 4. Same chat confirms via dok -> removes inline buttons & calls food.add once with requestId
    await handler.handle_update(tap(dok_data, chat_id=42, message_id=1, update_id=5, query_id="cb_ok"))
    assert (42, 1, None) in tg.edited
    add_calls = [call_item for call_item in sheet.calls if call_item[0] == "food.add"]
    assert len(add_calls) == 1
    assert add_calls[0][1] == {"date": "2026-09-21", "meal": "Almoço", "items": draft_items}
    assert sheet.request_ids[-1] is not None
    assert "Arroz branco cozido" in tg.sent[-1][1]

    # 5. Re-tapping dok or dno after claim reports expired and writes nothing else
    await handler.handle_update(tap(dno_data, chat_id=42, message_id=1, update_id=6, query_id="cb_late"))
    assert tg.sent[-1] == (42, miniapp.DRAFT_EXPIRED)
    assert len([op for op, _ in sheet.calls if op == "food.add"]) == 1


async def test_dno_discards_draft_without_calling_sheet_and_vok_can_propose_food():
    sheet = FakeSheet(catalog=[{"ok": True, "result": CATALOG}])
    draft_items = [{"description": "prato feito estimado", "qty": 1, "unit": "un"}]
    llm = ScriptedLlm(
        model="scripted",
        script=[
            call("propose_food", date="2026-09-21", meal="Jantar", items=draft_items),
            say("Confirma esse jantar estimado?"),
        ],
        requests=[],
    )
    b = Bot(sheet, llm, timezone="America/Sao_Paulo", clock=lambda: NOW)
    tg = FakeTelegram()
    drafts = miniapp.FoodDraftStore()
    confirmations = VoiceConfirmations()
    transcript = "jantei um prato feito mais ou menos"
    vid = confirmations.create(42, sha256_hex(transcript), message_id=9)

    handler = Handler(
        {42},
        b,
        tg,
        sheet=sheet,
        clock=lambda: NOW,
        miniapp_url=MINIAPP_URL,
        confirmations=confirmations,
        food_drafts=drafts,
    )

    # Voice confirmation (vok) -> LLM calls propose_food -> sends draft keyboard, 0 writes
    await handler.handle_update(
        {
            "update_id": 10,
            "callback_query": {
                "id": "cb_voice",
                "from": {"id": 42, "is_bot": False},
                "data": f"{buttons.VOICE_OK}:{vid}",
                "message": {
                    "chat": {"id": 42},
                    "message_id": 9,
                    "date": 1_700_000_000,
                    "text": buttons.entendi_text(transcript),
                },
            },
        }
    )
    assert sheet.calls == []
    kb = tg.options[0]["reply_markup"]["inline_keyboard"]
    dno_data = kb[1][0]["callback_data"]
    assert dno_data.startswith("dno:")

    # Cancelling via dno removes buttons and discards without sheet write
    await handler.handle_update(tap(dno_data, chat_id=42, message_id=1, update_id=11, query_id="cb_cancel"))
    assert (42, 1, None) in tg.edited
    assert tg.sent[-1] == (42, miniapp.DRAFT_CANCELLED)
    assert sheet.calls == []
    assert len(drafts) == 0


async def test_dok_uses_miniapp_retry_pipeline_when_sheet_is_temporarily_unavailable(monkeypatch):
    monkeypatch.setattr(miniapp, "RETRY_DELAYS", (0, 0))
    down = {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": "timeout"}]}
    sheet = FakeSheet(
        # All 3 automatic attempts fail, so the reply offers the retry button.
        food_add=[
            down,
            down,
            down,
            {
                "ok": True,
                "result": {
                    "writeId": "w_retry_1",
                    "date": "2026-09-21",
                    "meal": "Almoço",
                    "items": [{"food": "Arroz branco cozido", "qty": 150, "unit": "g"}],
                },
            },
        ]
    )
    tg = FakeTelegram()
    drafts = miniapp.FoodDraftStore()
    pending = miniapp.PendingStore()
    did = drafts.put(
        42,
        {
            "date": "2026-09-21",
            "meal": "Almoço",
            "items": [{"food": "Arroz branco cozido", "qty": 150, "unit": "g"}],
        },
    )
    handler = Handler(
        {42},
        Bot(sheet, ScriptedLlm(model="scripted", script=[], requests=[]), timezone="America/Sao_Paulo"),
        tg,
        sheet=sheet,
        miniapp_url=MINIAPP_URL,
        pending=pending,
        food_drafts=drafts,
    )

    await handler.handle_update(
        tap(f"dok:{did}", chat_id=42, message_id=20, update_id=30, query_id="cb_down")
    )
    retry_kb = tg.options[-1]["reply_markup"]["inline_keyboard"]
    retry_data = retry_kb[0][0]["callback_data"]
    assert retry_data.startswith(f"{buttons.RETRY}:")

    await handler.handle_update(tap(retry_data, chat_id=42, message_id=2, update_id=31, query_id="cb_retry"))
    assert [op for op, _ in sheet.calls] == ["food.add"] * 4
    assert sheet.request_ids[0] is not None and len(set(sheet.request_ids)) == 1
    assert "Arroz branco cozido" in tg.sent[-1][1]
