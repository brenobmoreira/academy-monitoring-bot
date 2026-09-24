import pytest

from agent.tools import DiaryFields, Exercise, Journal, WorkSet, build_tools

from .fakes import OK_DIARY, FakeSheet

pytestmark = pytest.mark.unit


def tools(sheet, journal=None):
    return {t.__name__: t for t in build_tools(sheet, journal or Journal())}


def test_exposes_the_four_tools_with_docstrings(sheet):
    t = tools(sheet)
    assert list(t) == ["get_catalog", "save_diary", "save_workout", "get_exercise_history"]
    assert all(fn.__doc__ for fn in t.values())


async def test_save_diary_drops_absent_fields_and_journals_success():
    sheet = FakeSheet(diary_upsert=[OK_DIARY])
    journal = Journal()
    res = await tools(sheet, journal)["save_diary"]("2026-09-21", DiaryFields(weightKg=82.4, sleepH=None))
    assert sheet.calls == [("diary.upsert", {"date": "2026-09-21", "fields": {"weightKg": 82.4}})]
    assert res == OK_DIARY
    assert journal.writes == [("diary.upsert", OK_DIARY["result"])]


async def test_accepts_raw_dicts_when_adk_could_not_build_the_models(sheet):
    await tools(sheet)["save_workout"](
        "2026-09-21", "Upper", [{"name": "Leg press", "sets": [{"kg": 100, "reps": 10}], "rir": None}]
    )
    assert sheet.calls == [
        (
            "workout.upsert",
            {
                "date": "2026-09-21",
                "session": "Upper",
                "exercises": [{"name": "Leg press", "sets": [{"kg": 100, "reps": 10}]}],
            },
        )
    ]


async def test_save_workout_sends_models_as_plain_json(sheet):
    ex = Exercise(name="Supino inclinado", sets=[WorkSet(kg=60, reps=8)], rir=2)
    await tools(sheet)["save_workout"]("2026-09-21", "Upper", [ex], phase="Regular")
    op, args = sheet.calls[0]
    assert args["exercises"] == [{"name": "Supino inclinado", "sets": [{"kg": 60.0, "reps": 8}], "rir": 2}]
    assert args["phase"] == "Regular"


async def test_errors_go_back_to_the_model_and_are_not_journaled():
    errors = {"ok": False, "errors": [{"path": "args.date", "code": "invalid_date", "message": "m"}]}
    sheet = FakeSheet(diary_upsert=[errors])
    journal = Journal()
    res = await tools(sheet, journal)["save_diary"]("ontem", DiaryFields(sleepH=7))
    assert res == errors
    assert journal.writes == []


async def test_read_tools_pass_through(sheet):
    t = tools(sheet)
    await t["get_catalog"]()
    await t["get_exercise_history"]("Leg press", 3)
    assert sheet.calls == [("catalog", {}), ("exercise.history", {"name": "Leg press", "limit": 3})]


def test_journal_lists_the_write_ids_of_the_message_in_order():
    journal = Journal()
    journal.record("diary.upsert", {"ok": True, "result": {"date": "2026-09-21", "writeId": "a1"}})
    journal.record("workout.upsert", {"ok": False, "errors": []})
    journal.record("workout.upsert", {"ok": True, "result": {"date": "2026-09-21", "writeId": "b2"}})
    journal.record("diary.upsert", {"ok": True, "result": {"date": "2026-09-21"}})
    assert journal.write_ids == ["a1", "b2"]
