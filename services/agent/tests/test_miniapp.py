import base64
import copy
import json
import zlib
from datetime import date
from typing import Any

import pytest

from agent import miniapp
from agent.commands import COMMANDS, Context, Reply
from agent.handler import Handler
from agent.miniapp import (
    EXPIRED,
    NOTHING_SAVED,
    UNAVAILABLE,
    CatalogTooLarge,
    PendingStore,
    catalog_v1,
    handle,
    keyboard_markup,
    parse_payload,
    request_id,
)
from agent.poll import poll_once

from .fakes import FakeSheet
from .test_handler import FakeBot, FakeTelegram

pytestmark = pytest.mark.unit


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    monkeypatch.setattr(miniapp, "RETRY_DELAYS", (0, 0))


TODAY = date(2026, 11, 9)
URL = "https://example.github.io/app/"
SID = "0123456789abcdef0123456789abcdef"  # the page's submission id (random per draft)


def markup(reply: Reply) -> dict[str, Any]:
    assert reply.reply_markup is not None
    return reply.reply_markup


WORKOUT: dict[str, Any] = {
    "v": 1,
    "t": "workout",
    "id": SID,
    "args": {
        "date": "2026-11-09",
        "session": "Push A",
        "complete": False,
        "exercises": [
            {
                "name": "Supino reto",
                "work": [{"kg": 80, "reps": 8, "rir": 1}, {"kg": 82.5, "reps": 6}],
                "warmup": {"kg": 40, "reps": 10},
                "pain": 0,
                "note": "ombro ok",
            }
        ],
    },
}
FOOD: dict[str, Any] = {
    "v": 1,
    "t": "food",
    "id": SID,
    "args": {
        "date": "2026-11-09",
        "meal": "Almoço",
        "items": [
            {"food": "Arroz branco cozido", "qty": 150, "unit": "g", "measure": "Pesada"},
            {"favorite": "Café da manhã padrão", "portions": 1},
            {"description": "pastel de feira", "qty": 1, "unit": "un"},
        ],
    },
}


def raw(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def errors_of(payload, today=TODAY):
    parsed, errors = parse_payload(raw(payload) if not isinstance(payload, str) else payload, today)
    assert parsed is None
    return errors


def mutated(base, path, value):
    out = copy.deepcopy(base)
    node = out
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    return out


# ---- payload validation ---------------------------------------------------------------------


def test_valid_workout_and_food_payloads_parse():
    for payload in (WORKOUT, FOOD):
        parsed, errors = parse_payload(raw(payload), TODAY)
        assert errors == []
        assert parsed is not None
        assert parsed.t == payload["t"]


def test_an_unknown_field_is_refused_with_its_path():
    errors = errors_of(mutated(WORKOUT, ["args", "exercises", 0, "extra"], 1))
    assert errors == ["args.exercises[0].extra: campo desconhecido"]
    assert errors_of({**WORKOUT, "x": 1}) == ["x: campo desconhecido"]


def test_numbers_must_be_json_numbers():
    errors = errors_of(mutated(WORKOUT, ["args", "exercises", 0, "work", 0, "kg"], "82,5"))
    assert len(errors) == 1
    assert errors[0].startswith("args.exercises[0].work[0].kg: esperado número")
    assert errors_of(mutated(WORKOUT, ["args", "exercises", 0, "work", 0, "reps"], True))
    assert errors_of(mutated(FOOD, ["args", "items", 0, "qty"], "150"))


def test_integers_must_be_whole_numbers_but_rir_may_be_fractional():
    assert errors_of(mutated(WORKOUT, ["args", "exercises", 0, "work", 0, "reps"], 8.5))
    assert errors_of(mutated(WORKOUT, ["args", "exercises", 0, "pain"], 2.5))
    ok = mutated(WORKOUT, ["args", "exercises", 0, "work", 0, "rir"], 1.5)  # the validator: number
    assert parse_payload(raw(ok), TODAY)[1] == []
    whole_float = (
        '{"v":1,"t":"workout","id":"' + SID + '","args":{"date":"2026-11-09","session":"A",'
        '"exercises":[{"name":"X","work":[{"kg":80,"reps":8.0}]}]}}'
    )
    assert parse_payload(whole_float, TODAY)[1] == []  # JSON has one number type (Number.isInteger)


def test_a_third_work_set_is_refused():
    sets = [{"kg": 80, "reps": 8}] * 3
    errors = errors_of(mutated(WORKOUT, ["args", "exercises", 0, "work"], sets))
    assert errors[0].startswith("args.exercises[0].work: quantidade de itens")


def test_ranges_and_exercise_count():
    assert errors_of(mutated(WORKOUT, ["args", "exercises", 0, "work", 0, "kg"], 1001))
    assert errors_of(mutated(WORKOUT, ["args", "exercises", 0, "pain"], 11))
    assert errors_of(mutated(WORKOUT, ["args", "exercises"], []))  # none unless complete
    done = mutated(mutated(WORKOUT, ["args", "exercises"], []), ["args", "complete"], True)
    assert parse_payload(raw(done), TODAY)[1] == []
    many = [{"name": f"Ex {i}", "work": [{"kg": 1, "reps": 1}]} for i in range(16)]
    assert errors_of(mutated(WORKOUT, ["args", "exercises"], many))


def test_a_repeated_exercise_is_refused_ignoring_case_and_accents():
    twin = copy.deepcopy(WORKOUT["args"]["exercises"][0])
    twin["name"] = "SUPINO  Reto"
    errors = errors_of(mutated(WORKOUT, ["args", "exercises"], [WORKOUT["args"]["exercises"][0], twin]))
    assert "repetido" in errors[0]


def test_future_and_malformed_dates_are_refused():
    assert "depois de hoje" in errors_of(mutated(WORKOUT, ["args", "date"], "2026-11-10"))[0]
    assert errors_of(mutated(WORKOUT, ["args", "date"], "2026-02-30"))
    assert errors_of(mutated(WORKOUT, ["args", "date"], "09/11/2026"))
    assert errors_of(mutated(WORKOUT, ["args", "date"], "1999-12-31"))
    assert parse_payload(raw(mutated(WORKOUT, ["args", "date"], "2026-11-09")), TODAY)[1] == []


def test_a_food_item_has_exactly_one_of_food_favorite_description():
    both = {"food": "Arroz", "qty": 1, "description": "x"}
    errors = errors_of(mutated(FOOD, ["args", "items"], [both]))
    assert errors == ["args.items[0]: cada item tem exatamente um de: food (+ qty), favorite ou description"]
    assert errors_of(mutated(FOOD, ["args", "items"], [{"qty": 1}]))
    assert errors_of(mutated(FOOD, ["args", "items"], [{"food": "Arroz"}])) == [
        "args.items[0].qty: campo obrigatório"
    ]
    assert errors_of(mutated(FOOD, ["args", "items"], [{"favorite": "F", "qty": 1}])) == [
        "args.items[0].qty: campo desconhecido"
    ]


def test_food_limits():
    assert errors_of(mutated(FOOD, ["args", "meal"], "x" * 61))
    assert errors_of(mutated(FOOD, ["args", "meal"], "  "))
    assert errors_of(mutated(FOOD, ["args", "items"], []))
    assert errors_of(mutated(FOOD, ["args", "items", 0, "measure"], "Chute"))
    assert errors_of(mutated(FOOD, ["args", "items", 1, "portions"], 51))
    assert errors_of(mutated(FOOD, ["args", "items", 0, "qty"], 0))
    too_many = [{"description": f"d{i}"} for i in range(21)]
    assert errors_of(mutated(FOOD, ["args", "items"], too_many))


def test_version_and_type_are_checked():
    assert errors_of({**WORKOUT, "v": 2})
    assert errors_of({**WORKOUT, "v": True})
    assert errors_of({**WORKOUT, "t": "diary"})
    assert errors_of("não é json")
    assert errors_of("[1]")


def test_oversize_payload_is_refused_before_parsing():
    big = raw(mutated(WORKOUT, ["args", "exercises", 0, "note"], "é" * 2100))
    assert len(big.encode()) > 4096
    assert errors_of(big) == ["dados passam de 4096 bytes"]


def test_request_id_depends_on_chat_draft_and_op_and_not_on_the_args():
    a = request_id(7, SID, "food.add")
    assert a == f"tg:7:miniapp:food.add:{SID}"
    assert a != request_id(8, SID, "food.add")
    assert a != request_id(7, "f" * 32, "food.add")
    assert a != request_id(7, SID, "workout.upsert")
    long = request_id(-1001234567890, SID, "workout.upsert")
    assert long is not None and len(long) <= 120  # the sheet's MAX_REQUEST_ID
    assert request_id(None, SID, "food.add") is None


async def test_an_edited_resend_of_a_saved_draft_keeps_the_request_id_and_the_conflict_is_explained():
    """Restore, change a quantity, resend: the same request id reaches the sheet, which refuses
    it as a conflict; the reply says so instead of a second row going in."""
    conflict = {"ok": False, "errors": [{"path": "requestId", "code": "conflict", "message": "já utilizado"}]}
    sheet = FakeSheet(food_add=[FOOD_OK, conflict])
    tg = FakeTelegram()
    handler = Handler({42}, FakeBot(), tg, sheet=sheet, clock=clock())
    await handler.handle_update(web_app_update(FOOD, update_id=50))
    edited = mutated(FOOD, ["args", "items", 0, "qty"], 999)
    await handler.handle_update(web_app_update(edited, update_id=51))
    assert len(sheet.request_ids) == 2 and len(set(sheet.request_ids)) == 1
    assert tg.sent[-1][1] == miniapp.ALREADY_SAVED


@pytest.mark.parametrize(
    "bad",
    [None, 7, "", "0123456789ABCDEF0123456789ABCDEF", SID[:-1], SID + "0", SID[:-1] + "g", " " + SID[1:]],
)
def test_the_submission_id_is_required_and_strict(bad):
    payload = {k: v for k, v in FOOD.items() if k != "id"}
    assert errors_of(payload) == ["id: campo obrigatório"]
    assert errors_of({**FOOD, "id": bad})


async def test_a_resend_after_a_restart_reuses_the_request_id_so_the_sheet_cannot_write_twice():
    """The page restores the last send with its id; a new update (new update_id, no pending
    retry in memory) still reaches the sheet with the request id of the first attempt."""
    sheet = FakeSheet(food_add=[DOWN, DOWN, DOWN, FOOD_OK])
    tg = FakeTelegram()
    first = Handler({42}, FakeBot(), tg, sheet=sheet, clock=clock())
    await first.handle_update(web_app_update(FOOD, update_id=50))
    restarted = Handler({42}, FakeBot(), tg, sheet=sheet, clock=clock())  # the pending store is gone
    await restarted.handle_update(web_app_update(FOOD, update_id=93))
    assert len(sheet.calls) == 4 and len(set(sheet.request_ids)) == 1
    other_draft = {**FOOD, "id": "f" * 32}  # the same meal on purpose, from a fresh draft
    await restarted.handle_update(web_app_update(other_draft, update_id=94))
    assert sheet.request_ids[-1] != sheet.request_ids[0]


def test_the_expired_retry_message_points_to_a_safe_resend():
    assert "Restaurar último envio" in EXPIRED and "não grava duas vezes" in EXPIRED


# ---- handle ---------------------------------------------------------------------------------


WORKOUT_OK: dict[str, Any] = {
    "ok": True,
    "result": {
        "writeId": "w1",
        "date": "2026-11-09",
        "session": "Push A",
        "exercises": [{"name": "Supino reto", "work": [{"kg": 80, "reps": 8, "rir": 1}]}],
    },
}


async def test_handle_writes_a_workout_with_a_request_id_and_confirms_from_the_response():
    sheet = FakeSheet(workout_upsert=[WORKOUT_OK])
    reply = await handle(sheet, raw(WORKOUT), 5, TODAY)
    [(op, args)] = sheet.calls
    assert op == "workout.upsert"
    assert args["exercises"] == WORKOUT["args"]["exercises"] and args["complete"] is False
    assert sheet.request_ids[0] == request_id(5, SID, "workout.upsert")
    assert reply.html and not reply.transient and not reply.failed
    assert "Push A" in reply.text and "80×8" in reply.text and "82,5" not in reply.text  # sheet's data only
    assert [b["callback_data"] for b in markup(reply)["inline_keyboard"][0]] == ["ok", "undo:w1", "fix"]


async def test_handle_writes_food():
    ok = {
        "ok": True,
        "result": {"writeId": "w2", "date": "2026-11-09", "meal": "Almoço", "items": []},
    }
    sheet = FakeSheet(food_add=[ok])
    reply = await handle(sheet, raw(FOOD), 6, TODAY)
    assert sheet.calls[0][0] == "food.add" and sheet.calls[0][1]["items"] == FOOD["args"]["items"]
    assert markup(reply)["inline_keyboard"][0][1]["callback_data"] == "undo:w2"


async def test_a_confirmation_without_write_id_has_no_buttons():
    ok = {"ok": True, "result": {**WORKOUT_OK["result"], "writeId": None}}
    reply = await handle(FakeSheet(workout_upsert=[ok]), raw(WORKOUT), 5, TODAY)
    assert reply.reply_markup is None


async def test_an_invalid_payload_never_reaches_the_sheet():
    sheet = FakeSheet()
    reply = await handle(sheet, raw(mutated(WORKOUT, ["args", "date"], "2026-12-01")), 5, TODAY)
    assert sheet.calls == []
    assert reply.text.startswith(NOTHING_SAVED) and "depois de hoje" in reply.text
    assert not reply.transient and not reply.html


async def test_sheet_refusal_lists_errors_and_suggestions():
    refusal = {
        "ok": False,
        "errors": [
            {
                "path": "args.exercises[0].name",
                "code": "not_in_catalog",
                "message": '"Supino" não existe',
                "suggestions": ["Supino reto", "Supino inclinado"],
            }
        ],
    }
    reply = await handle(FakeSheet(workout_upsert=[refusal]), raw(WORKOUT), 5, TODAY)
    assert reply.text.startswith(NOTHING_SAVED)
    assert "args.exercises[0].name" in reply.text
    assert "Você quis dizer: Supino reto, Supino inclinado" in reply.text
    assert not reply.transient and reply.reply_markup is None


@pytest.mark.parametrize("code", ["unavailable", "internal"])
async def test_outage_codes_are_transient(code):
    down = {"ok": False, "errors": [{"path": "", "code": code, "message": "x"}]}
    reply = await handle(FakeSheet(food_add=[down] * 3), raw(FOOD), 5, TODAY)
    assert reply.text == UNAVAILABLE and reply.transient and reply.reply_markup is None


# ---- handler --------------------------------------------------------------------------------


def web_app_update(payload, chat_id=42, update_id=11):
    data = payload if isinstance(payload, str) else raw(payload)
    message = {"chat": {"id": chat_id}, "web_app_data": {"data": data, "button_text": "🏋️ Treino"}}
    return {"update_id": update_id, "message": message}


def clock():
    from datetime import datetime

    return lambda: datetime(2026, 11, 9, 12, 0)


async def test_web_app_data_is_handled_without_the_model_or_typing():
    bot, tg, sheet = FakeBot(), FakeTelegram(), FakeSheet(workout_upsert=[WORKOUT_OK])
    await Handler({42}, bot, tg, sheet=sheet, clock=clock()).handle_update(web_app_update(WORKOUT))
    assert bot.texts == [] and tg.actions == [] and tg.fetched == []
    assert sheet.request_ids == [request_id(42, SID, "workout.upsert")]
    [(chat, text)] = tg.sent
    assert chat == 42 and "Push A" in text
    assert tg.options[0]["html"] and tg.options[0]["reply_markup"]["inline_keyboard"]


async def test_web_app_data_from_a_disallowed_chat_is_ignored():
    bot, tg, sheet = FakeBot(), FakeTelegram(), FakeSheet()
    await Handler({42}, bot, tg, sheet=sheet, clock=clock()).handle_update(web_app_update(WORKOUT, chat_id=7))
    assert sheet.calls == [] and tg.sent == [] and bot.texts == []


async def test_web_app_data_validation_errors_are_replied():
    bot, tg, sheet = FakeBot(), FakeTelegram(), FakeSheet()
    await Handler({42}, bot, tg, sheet=sheet, clock=clock()).handle_update(web_app_update("{}"))
    assert sheet.calls == []
    assert tg.sent[0][1].startswith(NOTHING_SAVED)


async def test_a_handler_without_sheet_answers_the_failure():
    tg = FakeTelegram()
    await Handler({42}, FakeBot(), tg, clock=clock()).handle_update(web_app_update(WORKOUT))
    assert "Não consegui processar" in tg.sent[0][1]


# ---- catalog -> keyboard --------------------------------------------------------------------

CATALOG = {
    "today": "2026-11-09",
    "timezone": "America/Sao_Paulo",
    "client": {"name": "Luan"},
    "nextSession": "Push A",
    "sessions": ["Push A", "Pull A"],
    "exercises": [{"name": "Supino reto", "group": "Peito"}, {"name": "Remada", "group": None}],
    "recentGroups": [
        {"group": "Peito", "sets": 6},
        {"group": "Costas", "sets": 0},
        {"group": "", "sets": 2},
        {"group": "Ombros", "sets": True},
        {"group": "Tríceps", "sets": "3"},
        "junk",
        {"group": "Bíceps", "sets": 2},
    ],
    "plan": [
        {
            "session": "Push A",
            "exercise": "Supino reto",
            "group": "Peito",
            "prescription": "2×6–8 · RIR 0–1",
            "lastWork": {"date": "2026-11-02", "text": "80×8, 80×7", "work": []},
        },
        {"session": "Pull A", "exercise": "Remada", "group": "", "prescription": "", "lastWork": None},
    ],
    "foods": ["Arroz branco cozido", "Frango grelhado"],
    "favorites": [],
    "meals": ["Café da manhã", "Almoço"],
    "units": ["g", "ml", "un"],
}


def decode(url):
    blob = url.split("&c=", 1)[1]
    packed = base64.urlsafe_b64decode(blob + "=" * (-len(blob) % 4))
    return json.loads(zlib.decompress(packed, -15).decode("utf-8"))


def test_catalog_v1_uses_short_keys_and_omits_empty_fields():
    assert catalog_v1(CATALOG) == {
        "v": 1,
        "today": "2026-11-09",
        "tz": "America/Sao_Paulo",
        "client": "Luan",
        "next": "Push A",
        "sessions": ["Push A", "Pull A"],
        "plan": [
            {"s": "Push A", "e": "Supino reto", "g": "Peito", "p": "2×6–8 · RIR 0–1", "l": "80×8, 80×7"},
            {"s": "Pull A", "e": "Remada"},
        ],
        "ex": [["Supino reto", "Peito"], ["Remada", ""]],
        "wk": [["Peito", 6], ["Bíceps", 2]],  # only well-formed rows with sets > 0
        "foods": ["Arroz branco cozido", "Frango grelhado"],
        "meals": ["Café da manhã", "Almoço"],
        "units": ["g", "ml", "un"],
    }


def test_keyboard_markup_round_trips_the_catalog():
    markup, dropped = keyboard_markup(URL, CATALOG)
    assert dropped == []
    assert markup["is_persistent"] is True and markup["resize_keyboard"] is True
    [row] = markup["keyboard"]
    assert [b["text"] for b in row] == ["🏋️ Treino", "🍽️ Refeição"]
    workout, food = (b["web_app"]["url"] for b in row)
    assert workout.startswith(URL + "#v=workout&c=") and food.startswith(URL + "#v=food&c=")
    assert "=" not in workout.split("&c=", 1)[1]  # base64url without padding
    assert decode(workout) == decode(food) == catalog_v1(CATALOG)


def big_catalog():
    cat = copy.deepcopy(CATALOG)
    cat["foods"] = [f"Alimento número {i} com nome longo {i * 7919}" for i in range(400)]
    cat["plan"] = [
        {
            "session": "S",
            "exercise": f"Exercício {i}-{i * 104729}",
            "group": "G",
            "prescription": f"{i}×{i * 31 % 97} RIR {i * 17 % 5}",
            "lastWork": {"text": f"{i * 13 % 120}×{i * 7 % 30}, {i * 11 % 120}×{i * 3 % 30}"},
        }
        for i in range(60)
    ]
    return cat


def url_len(cat, **kw):
    markup, dropped = keyboard_markup(URL, cat, **kw)
    return max(len(b["web_app"]["url"]) for b in markup["keyboard"][0]), dropped, markup


def test_trimming_drops_last_work_first_then_prescriptions_then_foods():
    cat = big_catalog()
    full, dropped, _ = url_len(cat, max_len=10**6)
    assert dropped == []
    without_l = url_len(
        {**cat, "plan": [{k: v for k, v in r.items() if k != "lastWork"} for r in cat["plan"]]}
    )[0]
    assert without_l < full

    size, dropped, markup = url_len(cat, max_len=full - 1)
    assert dropped == ["l"] and size <= full - 1
    assert "l" not in decode(markup["keyboard"][0][0]["web_app"]["url"])["plan"][0]

    size_l, _, _ = url_len(cat, max_len=full - 1)
    size, dropped, markup = url_len(cat, max_len=size_l - 1)
    assert dropped == ["l", "p"]
    page = decode(markup["keyboard"][0][0]["web_app"]["url"])
    assert "p" not in page["plan"][0] and "foods" in page

    bare = {**cat, "foods": [], "plan": [{**r, "lastWork": None, "prescription": ""} for r in cat["plan"]]}
    floor = url_len(bare, max_len=10**6)[0]
    size, dropped, markup = url_len(cat, max_len=floor)
    assert dropped == ["l", "p", "foods"]
    assert "foods" not in decode(markup["keyboard"][0][0]["web_app"]["url"])


def test_a_url_that_still_does_not_fit_after_all_trims_raises():
    cat = big_catalog()
    with pytest.raises(CatalogTooLarge) as err:
        keyboard_markup(URL, cat, max_len=200)
    assert err.value.max_len == 200 and err.value.length > 200


async def test_app_explains_a_catalog_that_cannot_fit():
    sheet = FakeSheet(catalog=[{"ok": True, "result": big_catalog()}])
    ctx = Context(sheet=sheet, today=TODAY, miniapp_url="https://example.com/" + "x" * 4090)
    reply = await COMMANDS["app"].run(ctx, "")
    assert reply.reply_markup is None and "grande demais" in reply.text and "caracteres" in reply.text


# ---- /app -----------------------------------------------------------------------------------


async def test_app_without_miniapp_url_says_it_is_not_configured():
    sheet = FakeSheet()
    reply = await COMMANDS["app"].run(Context(sheet=sheet, today=TODAY), "")
    assert "não está configurado" in reply.text
    assert reply.reply_markup is None and sheet.calls == []


async def test_app_sends_the_reply_keyboard():
    sheet = FakeSheet(catalog=[{"ok": True, "result": CATALOG}])
    reply = await COMMANDS["app"].run(Context(sheet=sheet, today=TODAY, miniapp_url=URL), "")
    assert markup(reply)["is_persistent"] is True
    assert "deixei de fora" not in reply.text


async def test_app_says_what_was_dropped():
    sheet = FakeSheet(catalog=[{"ok": True, "result": big_catalog()}])
    ctx = Context(sheet=sheet, today=TODAY, miniapp_url="https://example.github.io/" + "x" * 3000)
    reply = await COMMANDS["app"].run(ctx, "")
    assert "deixei de fora: últimas cargas" in reply.text


async def test_app_reports_a_sheet_outage():
    down = {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": "x"}]}
    reply = await COMMANDS["app"].run(
        Context(sheet=FakeSheet(catalog=[down]), today=TODAY, miniapp_url=URL), ""
    )
    assert reply.transient


# ---- formula injection ----------------------------------------------------------------------

FREE_TEXT = [
    (["args", "exercises", 0, "note"], "=HYPERLINK(1)"),
    (["args", "exercises", 0, "equipment"], "+1"),
    (["args", "items", 2, "description"], "@SUM(A1)"),
    (["args", "items", 2, "note"], "-2+3"),
    (["args", "items", 2, "unit"], "  =x"),
    (["args", "meal"], "=1"),
]


@pytest.mark.parametrize(("path", "text"), FREE_TEXT)
def test_free_text_cannot_start_with_a_formula_character(path, text):
    base = FOOD if path[1] in ("items", "meal") else WORKOUT
    errors = errors_of(mutated(base, path, text))
    assert len(errors) == 1 and "texto não pode começar com =, +, - ou @" in errors[0]


@pytest.mark.parametrize("lead", ["=", "+", "@", "\t="])
def test_names_cannot_start_with_a_formula_character_either(lead):
    for base, path in (
        (WORKOUT, ["args", "session"]),
        (WORKOUT, ["args", "exercises", 0, "name"]),
        (FOOD, ["args", "items", 0, "food"]),
        (FOOD, ["args", "items", 1, "favorite"]),
    ):
        errors = errors_of(mutated(base, path, lead + "Supino"))
        assert "texto não pode começar com =, + ou @" in errors[0]


def test_a_dash_inside_text_and_a_leading_dash_in_a_name_are_left_to_the_sheet():
    ok = mutated(FOOD, ["args", "items", 2, "description"], "pastel - feira")
    assert parse_payload(raw(ok), TODAY)[1] == []
    ok = mutated(WORKOUT, ["args", "session"], "-Push")
    assert parse_payload(raw(ok), TODAY)[1] == []


# ---- null policy (api_validator.js: absent is not null; only work[].rir may be null) --------

NULLABLE_FOOD = [["args", "items", 0, k] for k in ("unit", "measure", "note")] + [
    ["args", "items", 1, "portions"],
    ["args", "items", 2, "qty"],
    ["args", "items", 2, "unit"],
    ["args", "items", 2, "note"],
]
NULLABLE_WORKOUT = [
    ["args", "complete"],
    ["args", "exercises", 0, "warmup"],
    ["args", "exercises", 0, "feeder"],
    ["args", "exercises", 0, "pain"],
    ["args", "exercises", 0, "note"],
    ["args", "exercises", 0, "equipment"],
    ["args", "exercises", 0, "work", 0, "kg"],
    ["args", "exercises", 0, "work", 0, "reps"],
    ["args", "exercises", 0, "warmup", "kg"],
]


@pytest.mark.parametrize("path", NULLABLE_WORKOUT)
def test_explicit_null_is_refused_in_workouts(path):
    assert errors_of(mutated(WORKOUT, path, None))


@pytest.mark.parametrize("path", NULLABLE_FOOD)
def test_explicit_null_is_refused_in_food(path):
    assert errors_of(mutated(FOOD, path, None))


def test_rir_may_be_null_exactly_as_in_the_validator():
    ok = mutated(WORKOUT, ["args", "exercises", 0, "work", 0, "rir"], None)
    assert parse_payload(raw(ok), TODAY)[1] == []


def test_null_required_fields_are_refused():
    for path in (["args", "date"], ["args", "session"], ["args", "exercises"], ["v"], ["args"]):
        assert errors_of(mutated(WORKOUT, path, None))
    assert errors_of(mutated(FOOD, ["args", "meal"], None))


# ---- retry of a sheet outage ----------------------------------------------------------------

DOWN = {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": "x"}]}
FOOD_OK = {"ok": True, "result": {"writeId": "w9", "date": "2026-11-09", "meal": "Almoço", "items": []}}


async def test_handle_retries_up_to_three_times_with_the_same_request_id():
    sheet = FakeSheet(food_add=[DOWN, DOWN, FOOD_OK])
    reply = await handle(sheet, raw(FOOD), 5, TODAY, PendingStore())
    assert len(sheet.calls) == 3 and len(set(sheet.request_ids)) == 1
    assert sheet.request_ids[0] == request_id(5, SID, "food.add")
    assert markup(reply)["inline_keyboard"][0][1]["callback_data"] == "undo:w9"


async def test_a_validation_refusal_is_not_retried():
    refusal = {"ok": False, "errors": [{"path": "args.meal", "code": "too_long", "message": "m"}]}
    sheet = FakeSheet(food_add=[refusal])
    await handle(sheet, raw(FOOD), 5, TODAY, PendingStore())
    assert len(sheet.calls) == 1


async def test_a_persistent_outage_keeps_the_write_and_offers_the_retry_button():
    store, sheet = PendingStore(), FakeSheet(food_add=[DOWN, DOWN, DOWN])
    reply = await handle(sheet, raw(FOOD), 5, TODAY, store)
    assert len(sheet.calls) == 3 and reply.transient
    assert reply.text.startswith("⚠ Planilha indisponível, nada confirmado")
    [[button]] = markup(reply)["inline_keyboard"]
    assert button["text"] == "🔁 Tentar de novo"
    assert button["callback_data"].startswith("retry:") and len(button["callback_data"].encode()) <= 64


class OnePoll:
    """A Telegram that hands the poller each batch of updates once."""

    def __init__(self, *batches):
        self.batches = list(batches)

    async def get_updates(self, offset=None, wait=50):
        return self.batches.pop(0) if self.batches else []


def tap_retry(data, chat_id=42, update_id=21):
    message = {"message_id": 9, "chat": {"id": chat_id}, "text": UNAVAILABLE}
    return {"update_id": update_id, "callback_query": {"id": "cb", "data": data, "message": message}}


async def test_the_retry_button_replays_the_write_with_the_original_request_id_through_the_poller():
    sheet = FakeSheet(food_add=[DOWN, DOWN, DOWN, FOOD_OK])
    tg = FakeTelegram()
    handler = Handler({42}, FakeBot(), tg, sheet=sheet, clock=clock())
    offset = await poll_once(OnePoll([web_app_update(FOOD, update_id=20)]), handler, None)
    assert offset == 21 and len(sheet.calls) == 3
    data = tg.options[0]["reply_markup"]["inline_keyboard"][0][0]["callback_data"]

    await poll_once(OnePoll([tap_retry(data)]), handler, offset)
    assert len(sheet.calls) == 4
    assert len(set(sheet.request_ids)) == 1  # replay = same key, so the sheet cannot write it twice
    assert "Almoço" in tg.sent[-1][1] and tg.edited  # confirmation sent, retry button removed
    assert tg.answered == [("cb", None)]

    await handler.handle_update(tap_retry(data, update_id=22))  # a second tap
    assert len(sheet.calls) == 4 and tg.sent[-1][1] == EXPIRED


async def test_a_retry_that_fails_again_keeps_the_button():
    sheet = FakeSheet(food_add=[DOWN] * 9)
    tg = FakeTelegram()
    handler = Handler({42}, FakeBot(), tg, sheet=sheet, clock=clock())
    await handler.handle_update(web_app_update(FOOD, update_id=30))
    data = tg.options[0]["reply_markup"]["inline_keyboard"][0][0]["callback_data"]
    await handler.handle_update(tap_retry(data, update_id=31))
    assert tg.sent[-1][1].startswith("⚠ Planilha indisponível") and not tg.edited
    await handler.handle_update(tap_retry(data, update_id=32))
    assert len(sheet.calls) == 9


async def test_an_unknown_retry_id_gets_a_friendly_answer_and_a_disallowed_chat_nothing():
    sheet, tg = FakeSheet(), FakeTelegram()
    handler = Handler({42}, FakeBot(), tg, sheet=sheet, clock=clock())
    await handler.handle_update(tap_retry("retry:nope"))
    assert tg.sent == [(42, EXPIRED)] and sheet.calls == []
    await handler.handle_update(tap_retry("retry:nope", chat_id=7, update_id=22))
    assert len(tg.sent) == 1


async def test_a_retry_token_works_only_in_the_chat_that_created_it():
    sheet = FakeSheet(food_add=[DOWN, DOWN, DOWN, FOOD_OK])
    tg = FakeTelegram()
    handler = Handler({42, 43}, FakeBot(), tg, sheet=sheet, clock=clock())
    await handler.handle_update(web_app_update(FOOD, chat_id=42, update_id=60))
    data = tg.options[0]["reply_markup"]["inline_keyboard"][0][0]["callback_data"]
    await handler.handle_update(tap_retry(data, chat_id=43, update_id=61))
    assert len(sheet.calls) == 3, "chat 43 cannot run chat 42's write"
    assert tg.sent[-1] == (43, EXPIRED) and "Almoço" not in tg.sent[-1][1]
    await handler.handle_update(tap_retry(data, chat_id=42, update_id=62))
    assert len(sheet.calls) == 4 and tg.sent[-1][0] == 42 and "Almoço" in tg.sent[-1][1]


def test_the_pending_store_is_bounded_and_expires():
    now = [0.0]
    store = PendingStore(max_size=20, ttl_s=100, clock=lambda: now[0])
    keys = [store.put(miniapp.Pending("food.add", {"n": i}, f"r{i}", 42)) for i in range(25)]
    assert store.get(keys[0], 42) is None and store.get(keys[4], 42) is None
    fifth, last = store.get(keys[5], 42), store.get(keys[24], 42)
    assert fifth is not None and fifth.args == {"n": 5}
    assert last is not None and last.request_id == "r24"
    assert store.get(keys[24], 43) is None  # another chat never gets it
    now[0] = 101
    assert store.get(keys[24], 42) is None
    store.discard("missing")
