import asyncio

import pytest

from agent.tools import (
    DiaryFields,
    Exercise,
    FoodItem,
    Journal,
    LoadSet,
    WorkSet,
    build_tools,
    update_key_scope,
)

from .fakes import OK_DIARY, FakeSheet

pytestmark = pytest.mark.unit


def tools(sheet, journal=None):
    return {t.__name__: t for t in build_tools(sheet, journal or Journal())}


def test_exposes_the_tools_with_docstrings(sheet):
    t = tools(sheet)
    assert list(t) == [
        "get_catalog",
        "save_diary",
        "save_workout",
        "save_food",
        "get_exercise_history",
        "get_diary_history",
        "get_phase",
        "get_week",
    ]
    assert all(fn.__doc__ for fn in t.values())


async def test_save_diary_drops_absent_fields_and_journals_success():
    sheet = FakeSheet(diary_upsert=[OK_DIARY])
    journal = Journal()
    res = await tools(sheet, journal)["save_diary"]("2026-09-21", DiaryFields(weightKg=82.4, sleepH=None))
    assert sheet.calls == [("diary.upsert", {"date": "2026-09-21", "fields": {"weightKg": 82.4}})]
    assert res == OK_DIARY
    assert journal.writes == [("diary.upsert", OK_DIARY["result"])]


async def test_save_diary_clears_only_the_fields_asked(sheet):
    await tools(sheet)["save_diary"]("2026-09-21", DiaryFields(sleepH=7), clear=["waistCm"])
    assert sheet.calls == [
        ("diary.upsert", {"date": "2026-09-21", "fields": {"sleepH": 7.0, "waistCm": None}})
    ]


async def test_accepts_raw_dicts_when_adk_could_not_build_the_models(sheet):
    await tools(sheet)["save_workout"](
        "2026-09-21",
        "Upper",
        [{"name": "Leg press", "work": [{"kg": 100, "reps": 10, "rir": None}], "pain": None}],
    )
    assert sheet.calls == [
        (
            "workout.upsert",
            {
                "date": "2026-09-21",
                "session": "Upper",
                "exercises": [{"name": "Leg press", "work": [{"kg": 100, "reps": 10}]}],
            },
        )
    ]


async def test_save_workout_sends_work_sets_with_rir_apart_from_warm_up_and_feeder(sheet):
    ex = Exercise(
        name="Supino inclinado",
        warmup=LoadSet(kg=20, reps=12),
        work=[WorkSet(kg=60, reps=8, rir=2), WorkSet(kg=62.5, reps=8)],
    )
    await tools(sheet)["save_workout"]("2026-09-21", "Upper", [ex], complete=True)
    op, args = sheet.calls[0]
    assert args["exercises"] == [
        {
            "name": "Supino inclinado",
            "work": [{"kg": 60.0, "reps": 8, "rir": 2.0}, {"kg": 62.5, "reps": 8}],
            "warmup": {"kg": 20.0, "reps": 12},
        }
    ]
    assert args["complete"] is True
    await tools(sheet)["save_workout"]("2026-09-21", "Upper", [ex])
    assert "complete" not in sheet.calls[1][1]


async def test_save_food_journals_the_items_the_sheet_wrote():
    written = {"ok": True, "result": {"date": "2026-09-21", "meal": "Almoço", "items": [], "writeId": "f1"}}
    sheet = FakeSheet(food_add=[written])
    journal = Journal()
    items = [FoodItem(food="Arroz branco cozido", qty=150, unit="g"), FoodItem(description="Pastel")]
    await tools(sheet, journal)["save_food"]("2026-09-21", "Almoço", items)
    assert sheet.calls == [
        (
            "food.add",
            {
                "date": "2026-09-21",
                "meal": "Almoço",
                "items": [
                    {"food": "Arroz branco cozido", "qty": 150.0, "unit": "g"},
                    {"description": "Pastel"},
                ],
            },
        )
    ]
    assert journal.writes == [("food.add", written["result"])]
    assert journal.write_ids == ["f1"]


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
    await t["get_diary_history"]("2026-09-08", "2026-09-21")
    await t["get_phase"]("2026-08-01")
    await t["get_week"]("2026-09-21")
    assert sheet.calls == [
        ("catalog", {}),
        ("exercise.history", {"name": "Leg press", "limit": 3}),
        ("diary.range", {"from": "2026-09-08", "to": "2026-09-21"}),
        ("phase.get", {"date": "2026-08-01"}),
        ("week.get", {"date": "2026-09-21"}),
    ]


async def test_error_codes_of_reads_and_writes_are_kept():
    internal = {"ok": False, "errors": [{"path": "", "code": "internal", "message": "m"}]}
    rejected = {"ok": False, "errors": [{"path": "args.date", "code": "invalid_date", "message": "m"}]}
    sheet = FakeSheet(catalog=[internal], diary_upsert=[rejected])
    journal = Journal()
    t = tools(sheet, journal)
    await t["get_catalog"]()
    await t["save_diary"]("ontem", DiaryFields(sleepH=7))
    assert journal.error_codes == ["internal", "invalid_date"]
    assert journal.sheet_failed
    assert journal.writes == []


def test_rejected_payloads_are_not_a_sheet_failure():
    journal = Journal()
    journal.record("diary.upsert", {"ok": False, "errors": [{"code": "invalid_date"}]})
    journal.check({"ok": False})
    assert journal.error_codes == ["invalid_date"]
    assert not journal.sheet_failed


def test_journal_lists_the_write_ids_of_the_message_in_order():
    journal = Journal()
    journal.record("diary.upsert", {"ok": True, "result": {"date": "2026-09-21", "writeId": "a1"}})
    journal.record("workout.upsert", {"ok": False, "errors": []})
    journal.record("workout.upsert", {"ok": True, "result": {"date": "2026-09-21", "writeId": "b2"}})
    journal.record("diary.upsert", {"ok": True, "result": {"date": "2026-09-21"}})
    assert journal.write_ids == ["a1", "b2"]


async def test_write_tools_attach_deterministic_request_ids_and_sequence_identical_calls():
    outage = {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": "timeout"}]}
    food_ok_1 = {
        "ok": True,
        "result": {
            "date": "2026-09-21",
            "meal": "Almoço",
            "items": [{"food": "Arroz branco cozido", "qty": 150.0, "unit": "g", "kcal": 192}],
            "writeId": "w-food-1",
        },
    }
    food_ok_2 = {
        "ok": True,
        "result": {
            "date": "2026-09-21",
            "meal": "Almoço",
            "items": [{"food": "Arroz branco cozido", "qty": 150.0, "unit": "g", "kcal": 192}],
            "writeId": "w-food-2",
        },
    }
    sheet = FakeSheet(food_add=[outage, food_ok_1, food_ok_2])
    with update_key_scope("tg:99"):
        journal = Journal()
        t = tools(sheet, journal)
        await t["get_catalog"]()
        items = [FoodItem(food="Arroz branco cozido", qty=150, unit="g")]
        await t["save_food"]("2026-09-21", "Almoço", items)  # fails -> does not advance seq
        await t["save_food"]("2026-09-21", "Almoço", items)  # retry -> reuses seq 1
        await t["save_food"]("2026-09-21", "Almoço", items)  # intentional 2nd call -> gets :2

    assert sheet.request_ids[0] is None  # read call has no requestId
    assert sheet.request_ids[1] is not None and sheet.request_ids[1].startswith("tg:99:food.add:")
    assert sheet.request_ids[2] == sheet.request_ids[1]  # retry after failure reuses same requestId
    assert sheet.request_ids[3] == f"{sheet.request_ids[1]}:2"  # 2nd success in same turn gets :2
    assert journal.write_ids == ["w-food-1", "w-food-2"]
    assert not journal.sheet_failed  # initial outage was recovered by the retry


async def test_parallel_write_tools_keep_distinct_sequence_numbers():
    class YieldingSheet(FakeSheet):
        async def add_food(self, date, meal, items):
            res = super()._next("food.add", {"date": date, "meal": meal, "items": items})
            await asyncio.sleep(0)
            return res

        async def upsert_diary(self, date, fields):
            res = super()._next("diary.upsert", {"date": date, "fields": fields})
            await asyncio.sleep(0)
            return res

    items = [FoodItem(food="Ovo cozido", qty=2, unit="un")]
    sheet = YieldingSheet()
    with update_key_scope("tg:100"):
        journal = Journal()
        t = tools(sheet, journal)
        await asyncio.gather(
            t["save_food"]("2026-09-21", "Café", items),
            t["save_food"]("2026-09-21", "Café", items),
        )
    assert sheet.request_ids[0] is not None
    assert sheet.request_ids[1] == f"{sheet.request_ids[0]}:2"

    sheet2 = YieldingSheet()
    with update_key_scope("tg:101"):
        journal2 = Journal()
        t2 = tools(sheet2, journal2)
        await asyncio.gather(
            t2["save_food"]("2026-09-21", "Café", items),
            t2["save_diary"]("2026-09-21", DiaryFields(weightKg=80)),
        )
        await t2["save_food"]("2026-09-21", "Café", items)
    food_ids = [r for (op, _), r in zip(sheet2.calls, sheet2.request_ids, strict=True) if op == "food.add"]
    assert len(food_ids) == 2 and food_ids[0] is not None
    assert food_ids[1] == f"{food_ids[0]}:2"


async def test_undone_replay_is_not_journaled_and_warns_the_model():
    undone_res = {
        "ok": True,
        "result": {
            "date": "2026-09-21",
            "row": 6,
            "fields": {"weightKg": 82.4},
            "writeId": "w1",
            "undone": True,
        },
    }
    sheet = FakeSheet(diary_upsert=[undone_res])
    journal = Journal()
    res = await tools(sheet, journal)["save_diary"]("2026-09-21", DiaryFields(weightKg=82.4))
    assert journal.writes == []
    assert journal.write_ids == []
    assert "desfeita" in res["result"]["message"]
