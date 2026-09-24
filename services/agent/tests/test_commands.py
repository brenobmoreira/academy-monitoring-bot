import json
import re
from datetime import date
from pathlib import Path

import pytest

from agent.commands import COMMANDS, SHEET_DOWN, Context, help_text, menu, parse_command, parse_day

from .fakes import FakeSheet

pytestmark = pytest.mark.unit

TODAY = date(2026, 9, 21)
SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "set-webhook.sh"

PLAN = [
    {
        "session": "Upper",
        "exercise": "Supino inclinado",
        "setsAdaptation": 2,
        "setsRegular": 3,
        "repsMin": 6,
        "repsMax": 10,
    },
    {
        "session": "Upper",
        "exercise": "Puxada aberta",
        "setsAdaptation": 2,
        "setsRegular": 3,
        "repsMin": 8,
        "repsMax": 8,
    },
    {
        "session": "Lower",
        "exercise": "Leg press",
        "setsAdaptation": 2,
        "setsRegular": 4,
        "repsMin": 8,
        "repsMax": 12,
    },
]
EXERCISES = [
    {"name": "Supino inclinado", "group": "Peito"},
    {"name": "Puxada aberta", "group": "Costas"},
    {"name": "Leg press", "group": "Quadríceps"},
    {"name": "Cadeira extensora", "group": "Quadríceps"},
]


def catalog(phase="Regular", last=None):
    result = {
        "today": TODAY.isoformat(),
        "phase": phase,
        "sessions": ["Upper", "Lower"],
        "exercises": EXERCISES,
        "plan": PLAN,
        "lastWorkout": last,
    }
    return {"ok": True, "result": result}


async def run(name, args="", **responses):
    sheet = FakeSheet(**responses)
    reply = await COMMANDS[name].run(Context(sheet=sheet, today=TODAY), args)
    return reply.text, sheet.calls


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("", TODAY),
        ("hoje", TODAY),
        ("Ontem", date(2026, 9, 20)),
        ("20/09", date(2026, 9, 20)),
        ("1/9", date(2026, 9, 1)),
        ("30/12", date(2025, 12, 30)),  # dd/mm after today is last year's
        ("2026-09-21", TODAY),
    ],
)
def test_parse_day_accepts_words_and_both_formats(text, expected):
    assert parse_day(text, TODAY) == expected


@pytest.mark.parametrize(
    ("text", "message"),
    [("amanhã", "Data inválida"), ("31/02", "Data inválida"), ("2026-13-01", "Data inválida")],
)
def test_parse_day_rejects_other_text(text, message):
    with pytest.raises(ValueError, match=message):
        parse_day(text, TODAY)


def test_parse_day_rejects_a_future_iso_date():
    with pytest.raises(ValueError, match="22/09/2026 é depois de hoje"):
        parse_day("2026-09-22", TODAY)


def test_parse_command_strips_the_bot_name_and_keeps_the_arguments():
    assert parse_command("/hoje@fitness_bot  ontem ") == ("hoje", "ontem")
    assert parse_command("/Ficha\nlower") == ("ficha", "lower")
    assert parse_command("/exercicios") == ("exercicios", "")
    assert parse_command("/nope") is None
    assert parse_command("peso 82 /hoje") is None


async def test_hoje_renders_the_day_like_a_confirmation():
    day = {
        "date": "2026-09-20",
        "diary": {"weightKg": 82.4, "muayThai": True},
        "workout": [
            {
                "session": "Upper",
                "phase": "Adaptação",
                "exercises": [
                    {
                        "name": "Supino inclinado",
                        "sets": [{"kg": 60, "reps": 8}],
                        "setsDone": 1,
                        "volume": 480,
                        "rir": 2,
                    }
                ],
            },
            {
                "session": "Lower",
                "phase": None,
                "exercises": [
                    {"name": "Leg press", "sets": [{"kg": 100, "reps": 10}], "setsDone": 1, "volume": 1000}
                ],
            },
        ],
    }
    text, calls = await run("hoje", "ontem", day_get=[{"ok": True, "result": day}])
    assert calls == [("day.get", {"date": "2026-09-20"})]
    assert text.splitlines() == [
        "20/09 · Peso kg 82,4 · Muay Thai Sim",
        "20/09 · Upper (Adaptação):",
        "• Supino inclinado 60×8 (RIR 2)",
        "20/09 · Lower:",
        "• Leg press 100×10",
    ]


async def test_hoje_says_when_nothing_was_logged():
    empty = {"ok": True, "result": {"date": "2026-09-21", "diary": {}, "workout": []}}
    assert (await run("hoje", "", day_get=[empty]))[0] == "Nada registrado em 21/09."


async def test_hoje_answers_bad_dates_without_calling_the_sheet():
    text, calls = await run("hoje", "semana passada")
    assert text.startswith("Data inválida")
    assert calls == []


async def test_hoje_reports_an_unreachable_sheet():
    down = {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": "HTTP 500"}]}
    assert (await run("hoje", "", day_get=[down]))[0] == SHEET_DOWN


async def test_ficha_lists_the_session_with_sets_of_the_current_phase():
    text, _ = await run("ficha", "upper", catalog=[catalog(phase="Adaptação")])
    assert text.splitlines() == ["Upper (Adaptação):", "• Supino inclinado 2×6–10", "• Puxada aberta 2×8"]
    text, _ = await run("ficha", "LOWER", catalog=[catalog()])
    assert text.splitlines() == ["Lower (Regular):", "• Leg press 4×8–12"]


async def test_ficha_without_argument_picks_the_session_after_the_last_one():
    text, _ = await run("ficha", catalog=[catalog(last={"date": "2026-09-19", "session": "Upper"})])
    assert text.splitlines()[0] == "Lower (Regular), depois de Upper em 19/09:"
    text, _ = await run("ficha", catalog=[catalog(last={"date": "2026-09-20", "session": "Lower"})])
    assert text.splitlines()[0] == "Upper (Regular), depois de Lower em 20/09:"  # wraps around
    text, _ = await run("ficha", catalog=[catalog()])
    assert text.splitlines()[0] == "Upper (Regular):"


async def test_ficha_lists_the_valid_sessions_for_an_unknown_one():
    text, _ = await run("ficha", "push", catalog=[catalog()])
    assert text == 'Sessão "push" não existe. Sessões: Upper, Lower.'


async def test_exercicios_groups_catalogue_names_and_filters_ignoring_accents():
    text, _ = await run("exercicios", catalog=[catalog()])
    assert text == (
        "Peito:\n• Supino inclinado\n\nCostas:\n• Puxada aberta\n\n"
        "Quadríceps:\n• Leg press\n• Cadeira extensora"
    )
    text, _ = await run("exercicios", "quadriceps", catalog=[catalog()])
    assert text == "Quadríceps:\n• Leg press\n• Cadeira extensora"
    text, _ = await run("exercicios", "ombro", catalog=[catalog()])
    assert text == 'Grupo "ombro" não existe. Grupos: Peito, Costas, Quadríceps.'


async def test_help_and_start_list_the_menu_commands():
    for name in ("help", "start"):
        text, calls = await run(name)
        assert calls == []
        assert "/hoje — " in text and "/exercicios — " in text and "/start" not in text


def test_menu_fits_telegram_limits():
    for name, description in menu():
        assert re.fullmatch(r"[a-z0-9_]{1,32}", name)
        assert 3 <= len(description) <= 256
    assert "start" not in dict(menu())
    assert help_text().startswith("Me conte o dia")


def test_set_webhook_script_sends_the_same_menu():
    match = re.search(r"^commands='(.*?)'$", SCRIPT.read_text(encoding="utf-8"), re.S | re.M)
    assert match, "commands='[...]' not found in scripts/set-webhook.sh"
    listed = [(c["command"], c["description"]) for c in json.loads(match[1])]
    assert listed == menu()
