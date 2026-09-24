from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from agent.bot import MODEL_FAILED, MODEL_FAILED_NOTHING_WRITTEN, SHEET_FAILED, Bot, instruction

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


def test_instruction_has_the_recent_context_rules_and_no_reply_block_by_default():
    text = instruction(NOW)
    assert "Contexto recente" in text
    assert "recent" in text
    assert "e mais 3x10 de rosca" in text
    assert "na verdade foi 62 no supino" in text
    assert "responde a esta mensagem anterior" not in text
    assert "responde a esta mensagem anterior" not in instruction(NOW, "  ")


def test_instruction_quotes_the_replied_message_and_caps_its_length():
    text = instruction(NOW, "21/09 · Upper {x}\nSupino inclinado: 60×8")
    assert "responde a esta mensagem anterior" in text
    assert "<<<\n21/09 · Upper {x}\nSupino inclinado: 60×8\n>>>" in text
    long = instruction(NOW, "a" * 5000)
    assert "a" * 2000 + "\n>>>" in long
    assert "a" * 2001 not in long


async def test_the_replied_text_reaches_the_model_and_the_correction_rewrites_that_write():
    confirmation = "21/09 · Upper\nSupino inclinado: 60×8, 60×8"
    catalog = {
        "ok": True,
        "result": {
            "recent": [
                {
                    "writeId": "w1",
                    "at": "2026-09-21T17:50:00.000Z",
                    "op": "workout.upsert",
                    "date": "2026-09-21",
                    "session": "Upper",
                    "exercises": ["Supino inclinado"],
                }
            ]
        },
    }
    sets = [{"kg": 62, "reps": 8}, {"kg": 62, "reps": 8}]
    written = {
        "date": "2026-09-21",
        "session": "Upper",
        "phase": "Adaptação",
        "sessionId": "2026-09-21/Upper",
        "exercises": [{"name": "Supino inclinado", "row": 6, "sets": sets}],
    }
    sheet = FakeSheet(catalog=[catalog], workout_upsert=[{"ok": True, "result": written}])
    b, llm = bot(
        sheet,
        [
            call("get_catalog"),
            call(
                "save_workout",
                date="2026-09-21",
                session="Upper",
                exercises=[{"name": "Supino inclinado", "sets": sets}],
            ),
            say("ok"),
        ],
    )
    reply = await b.reply("na verdade foi 62", context=confirmation)
    assert "Supino inclinado</b> 62×8 62×8" in reply
    assert confirmation in llm.requests[0].config.system_instruction
    assert llm.requests[1].contents[-1].parts[0].function_response.response == catalog
    assert sheet.calls[1] == (
        "workout.upsert",
        {"date": "2026-09-21", "session": "Upper", "exercises": [{"name": "Supino inclinado", "sets": sets}]},
    )


async def test_without_a_reply_the_instruction_has_no_replied_message(sheet):
    b, llm = bot(sheet, [say("ok")])
    await b.reply("peso 82")
    assert "responde a esta mensagem anterior" not in llm.requests[0].config.system_instruction


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
    assert await b.reply("peso 82,4") == "<b>21/09</b> · Peso kg 82,4"
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
    assert await b.reply("dormi 7h30") == "<b>21/09</b> · Sono h 7,5"
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
        == "<b>21/09</b> · Peso kg 82,4\n\nRemada curvada não está no catálogo."
    )


async def test_call_budget_stops_the_loop_and_reports_what_was_saved():
    rejected = {"ok": False, "errors": [{"path": "args.date", "code": "invalid_date", "message": "m"}]}
    sheet = FakeSheet(diary_upsert=[OK_DIARY] + [rejected] * 5)
    script = [call("save_diary", date="2026-09-21", fields={"weightKg": 82.4})] + [
        call("save_diary", date="x", fields={"sleepH": 7})
    ] * 5
    b, _ = bot(sheet, script, max_llm_calls=3)
    reply = await b.reply("peso 82,4 dormi 7")
    assert reply.startswith("<b>21/09</b> · Peso kg 82,4")
    assert "limite de tentativas" in reply


async def test_nothing_written_and_no_text_says_so(sheet):
    b, _ = bot(sheet, [say("")])
    assert await b.reply("oi") == "Nada gravado."


UNAVAILABLE = {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": "HTTP 503"}]}


async def test_model_failure_after_a_write_keeps_the_confirmation():
    sheet = FakeSheet(diary_upsert=[OK_DIARY])
    b, _ = bot(
        sheet, [call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}), TimeoutError("slow")]
    )
    assert await b.reply("peso 82,4") == f"<b>21/09</b> · Peso kg 82,4\n\n{MODEL_FAILED}"


async def test_model_failure_before_any_write_says_nothing_was_saved(sheet):
    b, _ = bot(sheet, [RuntimeError("provider down")])
    assert await b.reply("peso 82,4") == MODEL_FAILED_NOTHING_WRITTEN
    assert sheet.calls == []


async def test_sheet_outage_with_nothing_written_replaces_the_model_text():
    sheet = FakeSheet(diary_upsert=[UNAVAILABLE])
    b, _ = bot(
        sheet,
        [call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}), say("A planilha caiu.")],
    )
    assert await b.reply("peso 82,4") == SHEET_FAILED


async def test_sheet_outage_wins_over_a_later_model_failure_when_nothing_was_written():
    internal = {"ok": False, "errors": [{"path": "", "code": "internal", "message": "boom"}]}
    sheet = FakeSheet(catalog=[internal])
    b, _ = bot(sheet, [call("get_catalog"), RuntimeError("provider down")])
    assert await b.reply("upper: supino 60x8") == SHEET_FAILED


async def test_sheet_outage_after_a_write_shows_the_confirmation_and_the_model_text():
    sheet = FakeSheet(diary_upsert=[OK_DIARY], workout_upsert=[UNAVAILABLE])
    b, _ = bot(
        sheet,
        [
            call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}),
            call("save_workout", date="2026-09-21", session="Upper", exercises=[]),
            say("A planilha não respondeu ao gravar o treino."),
        ],
    )
    assert (
        await b.reply("peso 82,4, upper")
        == "<b>21/09</b> · Peso kg 82,4\n\nA planilha não respondeu ao gravar o treino."
    )


async def test_other_errors_reach_the_handler():
    class BrokenSheet(FakeSheet):
        async def upsert_diary(self, date, fields):
            raise ValueError("bug")

    b, _ = bot(BrokenSheet(), [call("save_diary", date="2026-09-21", fields={"weightKg": 82.4})])
    with pytest.raises(ValueError, match="bug"):
        await b.reply("peso 82,4")


async def test_model_text_is_escaped_for_html(sheet):
    b, _ = bot(sheet, [say("Use <b>kg</b> & reps")])
    assert await b.reply("oi") == "Use &lt;b&gt;kg&lt;/b&gt; &amp; reps"
