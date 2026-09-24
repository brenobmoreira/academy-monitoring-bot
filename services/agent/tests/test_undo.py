import pytest

from agent.undo import NOTHING, SHEET_DOWN, undo_last, undone_line

from .fakes import FakeSheet

pytestmark = pytest.mark.unit


def ok(undone):
    return {"ok": True, "result": {"writeId": "w1", "undone": undone}}


def error(code, message="m"):
    return {"ok": False, "errors": [{"path": "args", "code": code, "message": message}]}


async def test_undoes_the_latest_write_and_says_what_was_undone():
    sheet = FakeSheet(
        write_undo=[ok({"op": "diary.upsert", "date": "2026-09-24", "fields": ["weightKg", "sleepH"]})]
    )
    assert await undo_last(sheet) == "↩️ Desfeito: 24/09 · Diário (Peso kg, Sono h)"
    assert sheet.calls == [("write.undo", {})]


def test_workout_lines_name_the_session_and_exercises():
    undone = {
        "op": "workout.upsert",
        "date": "2026-09-21",
        "session": "Upper",
        "exercises": ["Supino", "Remada"],
    }
    assert undone_line(undone) == "↩️ Desfeito: 21/09 · Upper (Supino, Remada)"


@pytest.mark.parametrize(
    ("response", "reply"),
    [
        (error("nothing_to_undo"), NOTHING),
        (error("unavailable"), SHEET_DOWN),
        (error("internal"), SHEET_DOWN),
        (error("conflict", "a linha 6 mudou"), "⚠ Não desfiz: a linha 6 mudou"),
    ],
)
async def test_refusals_become_short_replies(response, reply):
    assert await undo_last(FakeSheet(write_undo=[response])) == reply
