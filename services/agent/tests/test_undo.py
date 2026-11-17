import pytest

from agent.undo import (
    ALREADY,
    GONE,
    NOTHING,
    SHEET_DOWN,
    UNDO_UNCERTAIN,
    undo_last,
    undo_run,
    undo_writes,
    undone_line,
)

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
    assert await undo_last(sheet) == ("↩️ Desfeito: 24/09 · Diário (Peso kg, Sono h)", "committed")
    assert sheet.calls == [("write.undo", {})]


def test_workout_lines_name_the_session_and_exercises():
    undone = {
        "op": "workout.upsert",
        "date": "2026-09-21",
        "session": "Upper",
        "exercises": ["Supino", "Remada"],
    }
    assert undone_line(undone) == "↩️ Desfeito: 21/09 · Upper (Supino, Remada)"


def test_food_lines_name_the_meal_and_items():
    undone = {"op": "food.add", "date": "2026-09-21", "meal": "Almoço", "items": ["Arroz", "Pastel"]}
    assert undone_line(undone) == "↩️ Desfeito: 21/09 · Almoço (Arroz, Pastel)"


def test_an_action_made_in_the_sheet_is_named_by_its_label():
    assert undone_line({"action": "Salvar dia", "changes": 2}) == "↩️ Desfeito: Salvar dia"


@pytest.mark.parametrize(
    ("response", "reply"),
    [
        (error("nothing_to_undo"), NOTHING),
        (error("unavailable"), SHEET_DOWN),
        (error("conflict", "a linha 6 mudou"), "⚠ Não desfiz: a linha 6 mudou"),
    ],
)
async def test_refusals_become_short_replies(response, reply):
    assert await undo_last(FakeSheet(write_undo=[response])) == (reply, "not_committed")


@pytest.mark.parametrize("code", ["internal", "rejected", "write_uncertain"])
async def test_an_undo_that_may_have_been_applied_says_so(code):
    # These codes can follow the reverts (core_log.js:385): "não desfiz" would be a guess.
    assert await undo_last(FakeSheet(write_undo=[error(code)])) == (UNDO_UNCERTAIN, "uncertain")


async def test_undo_run_stops_at_an_uncertain_undo_and_keeps_what_it_undid():
    diary = ok({"op": "diary.upsert", "date": "2026-09-24", "fields": ["weightKg"]})
    sheet = FakeSheet(write_undo=[diary, error("internal"), diary])
    run = await undo_run(sheet, ["w1", "w2", "w3"])
    assert run == (f"↩️ Desfeito: 24/09 · Diário (Peso kg)\n{UNDO_UNCERTAIN}", False, "uncertain")
    assert len(sheet.calls) == 2  # w1 is left alone: no retry, no further undo


async def test_undo_run_reports_the_outcome_of_the_whole_run():
    diary = ok({"op": "diary.upsert", "date": "2026-09-24", "fields": ["weightKg"]})
    assert (await undo_run(FakeSheet(write_undo=[diary]), ["w1"])).outcome == "committed"
    already = await undo_run(FakeSheet(write_undo=[error("already_undone")]), ["w1"])
    assert already.outcome == "not_committed"
    down = await undo_run(FakeSheet(write_undo=[diary, error("unavailable")]), ["w1", "w2"])
    assert down.sheet_down and down.outcome == "committed"
    assert await undo_run(FakeSheet(), []) == (NOTHING, False, None)


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
    sheet = FakeSheet(write_undo=[error("unavailable")])
    assert await undo_writes(sheet, ["w1", "w2"]) == (SHEET_DOWN, True)
    assert len(sheet.calls) == 1


async def test_undo_writes_without_ids_has_nothing_to_undo():
    assert await undo_writes(FakeSheet(), []) == (NOTHING, False)
