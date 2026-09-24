from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from agent.bot import Bot, instruction

from .fakes import OK_DIARY, FakeSheet, ScriptedLlm, call, say

pytestmark = pytest.mark.unit

NOW = datetime(2026, 9, 21, 15, 0, tzinfo=ZoneInfo("America/Sao_Paulo"))


def bot(sheet, script, **kw):
    llm = ScriptedLlm(model="scripted", script=script, requests=[])
    return Bot(sheet, llm, timezone="America/Sao_Paulo", clock=lambda: NOW, **kw), llm


def test_instruction_states_today_weekday_and_the_retry_rule():
    text = instruction(NOW)
    assert "2026-09-21" in text
    assert "segunda-feira" in text
    assert "ok=false" in text


def test_instruction_lists_the_diary_history_tool_and_forbids_inventing_days():
    text = instruction(NOW)
    assert "get_diary_history" in text
    assert "últimas 2 semanas" in text
    assert "nunca invente" in text


async def test_answers_a_history_question_from_the_diary_range():
    history = {
        "ok": True,
        "result": {
            "from": "2026-09-08",
            "to": "2026-09-21",
            "days": [
                {"date": "2026-09-10", "weightKg": 83.0},
                {"date": "2026-09-21", "weightKg": 82.4},
            ],
        },
    }
    sheet = FakeSheet(diary_range=[history])
    answer = "Peso em 2 dias registrados: 83,0 (10/09) → 82,4 (21/09)."
    b, llm = bot(
        sheet,
        [call("get_diary_history", date_from="2026-09-08", date_to="2026-09-21"), say(answer)],
    )
    assert await b.reply("como está meu peso nas últimas 2 semanas?") == answer
    assert sheet.calls == [("diary.range", {"from": "2026-09-08", "to": "2026-09-21"})]
    assert llm.requests[1].contents[-1].parts[0].function_response.response == history
    tools = llm.requests[0].config.tools[0].function_declarations
    assert "get_diary_history" in [t.name for t in tools]


async def test_replies_with_the_confirmation_and_hides_a_bare_ok():
    sheet = FakeSheet(diary_upsert=[OK_DIARY])
    b, llm = bot(sheet, [call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}), say("ok")])
    assert await b.reply("peso 82,4") == "21/09 · Peso kg 82,4"
    assert "2026-09-21" in llm.requests[0].config.system_instruction


async def test_fixes_the_payload_after_the_sheet_rejects_it():
    rejected = {
        "ok": False,
        "errors": [{"path": "args.fields.sleepH", "code": "wrong_type", "message": "número"}],
    }
    written = {"ok": True, "result": {"date": "2026-09-21", "row": 6, "fields": {"sleepH": 7.5}}}
    sheet = FakeSheet(diary_upsert=[rejected, written])
    b, llm = bot(
        sheet,
        [
            call("save_diary", date="2026-09-21", fields={"sleepH": "7h30"}),
            call("save_diary", date="2026-09-21", fields={"sleepH": 7.5}),
            say("ok"),
        ],
    )
    assert await b.reply("dormi 7h30") == "21/09 · Sono h 7,5"
    assert [args["fields"] for _, args in sheet.calls] == [{"sleepH": "7h30"}, {"sleepH": 7.5}]
    assert llm.requests[1].contents[-1].parts[0].function_response.response == rejected


async def test_model_notes_follow_the_confirmation():
    sheet = FakeSheet(diary_upsert=[OK_DIARY])
    b, _ = bot(
        sheet,
        [
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            say("Remada curvada não está no catálogo."),
        ],
    )
    assert (
        await b.reply("peso 82,4, remada 40x10")
        == "21/09 · Peso kg 82,4\n\nRemada curvada não está no catálogo."
    )


async def test_call_budget_stops_the_loop_and_reports_what_was_saved():
    rejected = {"ok": False, "errors": [{"path": "args.date", "code": "invalid_date", "message": "m"}]}
    sheet = FakeSheet(diary_upsert=[OK_DIARY] + [rejected] * 5)
    script = [call("save_diary", date="2026-09-21", fields={"weightKg": 82.4})] + [
        call("save_diary", date="x", fields={"sleepH": 7})
    ] * 5
    b, _ = bot(sheet, script, max_llm_calls=3)
    reply = await b.reply("peso 82,4 dormi 7")
    assert reply.startswith("21/09 · Peso kg 82,4")
    assert "limite de tentativas" in reply


async def test_nothing_written_and_no_text_says_so(sheet):
    b, _ = bot(sheet, [say("")])
    assert await b.reply("oi") == "Nada gravado."
