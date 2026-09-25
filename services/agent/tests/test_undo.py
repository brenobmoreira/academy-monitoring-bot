import pytest

from agent.undo import ALREADY, GONE, NOTHING, SHEET_DOWN, undo_last, undo_writes, undone_line

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


async def test_undo_writes_goes_newest_first_and_merges_repeated_lines():
    diary = ok({"op": "diary.upsert", "date": "2026-09-24", "fields": ["weightKg"]})
    sheet = FakeSheet(write_undo=[error("already_undone"), diary, error("already_undone")])
    assert await undo_writes(sheet, ["w1", "w2", "w3"]) == (
        f"{ALREADY}\n↩️ Desfeito: 24/09 · Diário (Peso kg)",
        False,
    )
    assert [args for _, args in sheet.calls] == [{"writeId": "w3"}, {"writeId": "w2"}, {"writeId": "w1"}]


async def test_undo_writes_explains_a_pruned_write_and_other_refusals():
    sheet = FakeSheet(write_undo=[error("not_found"), error("conflict", "a linha 6 mudou")])
    assert await undo_writes(sheet, ["w1", "w2"]) == (f"{GONE}\n⚠ Não desfiz: a linha 6 mudou", False)


async def test_undo_writes_stops_when_the_sheet_is_down():
    sheet = FakeSheet(write_undo=[error("internal")])
    assert await undo_writes(sheet, ["w1", "w2"]) == (SHEET_DOWN, True)
    assert len(sheet.calls) == 1


async def test_undo_writes_without_ids_has_nothing_to_undo():
    assert await undo_writes(FakeSheet(), []) == (NOTHING, False)
