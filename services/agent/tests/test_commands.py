import json
import re
from datetime import date
from pathlib import Path
from typing import Any

import pytest

from agent.commands import (
    COMMANDS,
    SHEET_DOWN,
    Context,
    help_text,
    menu,
    parse_command,
    parse_day,
    week_text,
)

from .fakes import FakeSheet

pytestmark = pytest.mark.unit

TODAY = date(2026, 9, 21)
SCRIPT = Path(__file__).resolve().parents[3] / "scripts" / "set-webhook.sh"

PLAN = [
    {
        "session": "Upper",
        "exercise": "Supino inclinado",
        "sets": 2,
        "repsMin": 6,
        "repsMax": 10,
        "prescription": "2×6–10 · RIR 0–1 · 150 s",
    },
    {
        "session": "Upper",
        "exercise": "Puxada aberta",
        "sets": 2,
        "repsMin": 8,
        "repsMax": 8,
        "prescription": "2×8 · RIR 0–1",
    },
    {
        "session": "Lower",
        "exercise": "Leg press",
        "sets": 4,
        "repsMin": 8,
        "repsMax": 12,
        "prescription": "4×8–12",
    },
]
EXERCISES = [
    {"name": "Supino inclinado", "group": "Peito"},
    {"name": "Puxada aberta", "group": "Costas"},
    {"name": "Leg press", "group": "Quadríceps"},
    {"name": "Cadeira extensora", "group": "Quadríceps"},
]


def catalog(training="Regular", last=None, next_session="Upper", plan_id="F002"):
    result = {
        "today": TODAY.isoformat(),
        "phase": {"date": TODAY.isoformat(), "plan": {"id": plan_id} if plan_id else None},
        "trainingPhase": training,
        "sessions": ["Upper", "Lower"],
        "nextSession": next_session,
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
        "dayState": "Parcial",
        "diary": {"weightKg": 82.4, "activity": "Muay Thai"},
        "totals": {"kcal": 192, "protein": 3.8, "noCalcItems": 0, "estimatedItems": 0},
        "food": [
            {
                "meal": "Almoço",
                "food": "Arroz branco cozido",
                "qty": 150,
                "unit": "g",
                "kcal": 192,
                "protein": 3.75,
                "calc": "Calculado",
                "source": "TACO/fonte confiável",
            },
        ],
        "workout": [
            {
                "session": "Upper",
                "state": "Concluído",
                "exercises": [
                    {
                        "name": "Supino inclinado",
                        "warmup": {"kg": 20, "reps": 12},
                        "work": [{"kg": 60, "reps": 8, "rir": 2}],
                        "volume": 480,
                    },
                ],
            },
            {
                "session": "Lower",
                "state": "Parcial",
                "exercises": [
                    {"name": "Leg press", "work": [{"kg": 100, "reps": 10, "rir": None}], "volume": 1000}
                ],
            },
        ],
    }
    text, calls = await run("hoje", "ontem", day_get=[{"ok": True, "result": day}])
    assert calls == [("day.get", {"date": "2026-09-20"})]
    assert text.splitlines() == [
        "<b>20/09</b> · Peso kg 82,4 · Atividade Muay Thai",
        "<b>20/09 · Almoço:</b>",
        "• Arroz branco cozido 150 g · 192 kcal, P 3,8 g",
        "Dia: 192 kcal · P 4 g",
        "<b>20/09 · Upper (Concluído):</b>",
        "• <b>Supino inclinado</b> 60×8 RIR 2 (aquec. 20×12)",
        "<b>20/09 · Lower (Parcial):</b>",
        "• <b>Leg press</b> 100×10",
        "Estado do dia: Parcial",
    ]


async def test_hoje_says_when_nothing_was_logged():
    empty = {"ok": True, "result": {"date": "2026-09-21", "diary": None, "food": [], "workout": []}}
    assert (await run("hoje", "", day_get=[empty]))[0] == "Nada registrado em 21/09."


async def test_hoje_answers_bad_dates_without_calling_the_sheet():
    text, calls = await run("hoje", "semana passada")
    assert text.startswith("Data inválida")
    assert calls == []


async def test_hoje_reports_an_unreachable_sheet():
    down = {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": "HTTP 500"}]}
    assert (await run("hoje", "", day_get=[down]))[0] == SHEET_DOWN


async def test_ficha_lists_the_session_with_the_prescription_of_the_plan_in_force():
    text, _ = await run("ficha", "upper", catalog=[catalog(training="Adaptação")])
    assert text.splitlines() == [
        "Upper (ficha F002, Adaptação):",
        "• Supino inclinado 2×6–10 · RIR 0–1 · 150 s",
        "• Puxada aberta 2×8 · RIR 0–1",
    ]
    text, _ = await run("ficha", "LOWER", catalog=[catalog()])
    assert text.splitlines() == ["Lower (ficha F002, Regular):", "• Leg press 4×8–12"]


async def test_ficha_without_argument_shows_the_next_session_of_the_rotation():
    last = {"date": "2026-09-19", "session": "Upper", "state": "Concluído"}
    text, _ = await run("ficha", catalog=[catalog(last=last, next_session="Lower")])
    assert text.splitlines()[0] == "Lower (ficha F002, Regular), próxima depois de Upper em 19/09:"
    partial = {"date": "2026-09-20", "session": "Lower", "state": "Parcial"}
    text, _ = await run("ficha", catalog=[catalog(last=partial, next_session="Lower")])
    assert text.splitlines()[0] == "Lower (ficha F002, Regular); Lower de 20/09 ainda está parcial:"
    text, _ = await run("ficha", catalog=[catalog()])
    assert text.splitlines()[0] == "Upper (ficha F002, Regular):"


async def test_ficha_lists_the_valid_sessions_for_an_unknown_one():
    text, _ = await run("ficha", "push", catalog=[catalog()])
    assert text == 'Sessão "push" não existe. Sessões: Upper, Lower.'


async def test_ficha_without_a_plan_in_force_says_so():
    text, _ = await run("ficha", catalog=[catalog(plan_id=None)])
    assert text == "Nenhuma ficha em vigor hoje."


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


WEEK = {
    "source": "stored",
    "closed": True,
    "start": "2026-09-14",
    "end": "2026-09-20",
    "objective": "O001",
    "goal": "M001",
    "plan": "F002",
    "weighIns": 4,
    "weightAvg": 82.35,
    "weightDelta": -0.3,
    "weightDeltaPct": -0.36,
    "targetRange": "-0,5 a 0,25 %/sem (padrão)",
    "status": "No caminho",
    "recommendation": "MANTER",
    "recommendationReason": "Peso estável e cintura caindo.",
    "nextReview": "2026-09-27",
    "sufficiency": "Peso ok · Alimentação 4 de 7",
}


def week_response(**changes):
    return {"week_get": [{"ok": True, "result": {**WEEK, **changes}}]}


async def test_semana_asks_the_sheet_for_the_week_containing_today():
    text, calls = await run("semana", **week_response(start="2026-09-21", end="2026-09-27", closed=False))
    assert calls == [("week.get", {"date": "2026-09-21"})]
    assert text.splitlines()[:3] == [
        "<b>Semana 21/09–27/09 (em andamento)</b> · O001 · M001 · F002",
        "Situação: <b>No caminho</b>",
        "Recomendação: <b>MANTER</b> — Peso estável e cintura caindo. (próxima revisão 27/09)",
    ]


async def test_semana_n_goes_back_n_weeks():
    text, calls = await run("semana", " 1 ", **week_response())
    assert calls == [("week.get", {"date": "2026-09-14"})]
    assert text.startswith("<b>Semana 14/09–20/09</b>")
    _, calls = await run("semana", "12", **week_response())
    assert calls == [("week.get", {"date": "2026-06-29"})]


@pytest.mark.parametrize("args", ["13", "-1", "passada", "1.5", "²"])
async def test_semana_rejects_other_arguments_without_calling_the_sheet(args):
    text, calls = await run("semana", args)
    assert text.startswith("Use /semana para esta semana ou /semana n (0 a 12)")
    assert calls == []


async def test_semana_reports_sheet_errors():
    down = {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": "HTTP 500"}]}
    text, _ = await run("semana", week_get=[down])
    assert text == SHEET_DOWN
    bad = {"ok": False, "errors": [{"path": "args.date", "code": "date_in_future", "message": "Data futura"}]}
    text, _ = await run("semana", week_get=[bad])
    assert text == "⚠ A planilha recusou o pedido: Data futura"


async def test_week_text_is_html():
    reply = await week_text(FakeSheet(**week_response()), date(2026, 9, 14))
    assert reply.html
    assert (
        "Peso médio 7d 82,35 kg (4 pesagens) · -0,3 kg (-0,36%/sem) · alvo -0,5 a 0,25 %/sem (padrão)"
        in reply.text
    )


PHASE: dict[str, Any] = {
    "date": "2026-09-21",
    "objective": {
        "id": "O002",
        "name": "Ganho controlado",
        "analysisType": "ganho_controlado",
        "label": "Ganho controlado",
        "start": "2026-09-14",
        "end": None,
        "weeks": 2,
        "startWeightKg": 82.1,
        "startWaistCm": None,
        "expectation": None,
    },
    "goal": {
        "id": "M002",
        "start": "2026-09-14",
        "kcal": 2700,
        "protein": 150,
        "proteinMin": 140,
        "proteinMax": 160,
        "fat": 70,
        "carbs": 367.5,
        "fiber": None,
        "strengthPerWeek": 4,
    },
    "plan": {"id": "F002", "start": "2026-08-28", "sessions": ["Upper", "Lower"], "trainingPhase": "Regular"},
    "recommendation": {
        "week": "2026-09-14",
        "status": "Atenção",
        "code": "REVISAR MACROS",
        "reason": "Proteína abaixo da faixa.",
        "nextReview": "2026-09-27",
    },
}


async def test_fase_shows_the_objective_in_force_since_when_targets_and_last_recommendation():
    text, calls = await run("fase", phase_get=[{"ok": True, "result": PHASE}])
    assert calls == [("phase.get", {"date": "2026-09-21"})]
    assert text.splitlines() == [
        "<b>Objetivo O002 · Ganho controlado</b>",
        "Desde 14/09/2026 · semana 2 · análise: Ganho controlado",
        "peso inicial 82,1 kg",
        "Meta M002 (desde 14/09/2026): 2700 kcal · P 150 g (140–160) · G 70 g · C 367,5 g · 4 treinos/sem",
        "Ficha F002 (desde 28/08/2026): Upper, Lower · Regular",
        "Última análise (semana de 14/09): Atenção · <b>REVISAR MACROS</b> — Proteína abaixo da faixa."
        " (próxima revisão 27/09)",
    ]


async def test_fase_on_a_past_date_asks_for_that_date():
    old = {
        **PHASE,
        "date": "2026-08-01",
        "objective": {**PHASE["objective"], "id": "O001", "end": "2026-09-13"},
        "recommendation": None,
    }
    text, calls = await run("fase", "01/08", phase_get=[{"ok": True, "result": old}])
    assert calls == [("phase.get", {"date": "2026-08-01"})]
    assert text.splitlines()[0] == "<b>Objetivo O001 · Ganho controlado em 01/08/2026</b>"
    assert "até 13/09/2026" in text.splitlines()[1]
    assert text.splitlines()[-1] == "Ainda sem análise semanal gravada nesta fase."
    empty = {"date": "2026-01-01", "objective": None, "goal": None, "plan": None, "recommendation": None}
    text, _ = await run("fase", "2026-01-01", phase_get=[{"ok": True, "result": empty}])
    assert text == "Nenhum objetivo em vigor em 01/01/2026."
    text, calls = await run("fase", "amanhã")
    assert text.startswith("Data inválida") and calls == []
