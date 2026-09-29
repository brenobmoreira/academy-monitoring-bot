from datetime import date

import pytest

from agent.weekly import week_bounds, week_summary

pytestmark = pytest.mark.unit

WEEK = {
    "source": "stored",
    "closed": True,
    "start": "2026-09-21",
    "end": "2026-09-27",
    "objective": "O002",
    "goal": "M002",
    "plan": "F002",
    "transition": "Objetivo O001 → O002 em 23/09/2026",
    "weighIns": 5,
    "weightAvg": 82.14,
    "weightDelta": 0.2,
    "weightDeltaPct": 0.24,
    "targetRange": "0,1 a 0,3 %/sem (padrão)",
    "waistCm": 84,
    "waistDelta": -0.5,
    "completeDays": 4,
    "foodCoverage": "4 de 7 dias",
    "kcalAvg": 2680,
    "proteinAvg": 148.4,
    "kcalAdherence": 0.75,
    "proteinAdherence": 1,
    "noCalcItems": 2,
    "sessions": 3,
    "sessionsGoal": 4,
    "workVolume": 12500.5,
    "progressions": 3,
    "regressions": 1,
    "sleepAvg": 7.25,
    "hungerAvg": 3,
    "fatigueAvg": 2.5,
    "painMax": 2,
    "stepsAvg": 8123,
    "cardioMin": 60,
    "status": "No caminho",
    "recommendation": "MANTER",
    "recommendationReason": "Peso subindo dentro da faixa.",
    "nextReview": "2026-10-04",
    "sufficiency": "Peso ok · Alimentação 4 de 7 · Cintura ok",
}


@pytest.mark.parametrize(
    ("today", "back", "expected"),
    [
        (date(2026, 9, 21), 0, (date(2026, 9, 21), date(2026, 9, 27))),  # Monday
        (date(2026, 9, 24), 0, (date(2026, 9, 21), date(2026, 9, 27))),
        (date(2026, 9, 27), 0, (date(2026, 9, 21), date(2026, 9, 27))),  # Sunday
        (date(2026, 9, 24), 1, (date(2026, 9, 14), date(2026, 9, 20))),
        (date(2026, 9, 24), 12, (date(2026, 6, 29), date(2026, 7, 5))),
        (date(2027, 1, 1), 0, (date(2026, 12, 28), date(2027, 1, 3))),  # across the new year
        (date(2027, 1, 5), 1, (date(2026, 12, 28), date(2027, 1, 3))),
    ],
)
def test_week_bounds_are_monday_to_sunday(today, back, expected):
    assert week_bounds(today, back) == expected


def test_full_week_summary():
    assert week_summary(WEEK).splitlines() == [
        "<b>Semana 21/09–27/09</b> · O002 · M002 · F002",
        "Situação: <b>No caminho</b>",
        "Recomendação: <b>MANTER</b> — Peso subindo dentro da faixa. (próxima revisão 04/10)",
        "Transição: Objetivo O001 → O002 em 23/09/2026",
        "Peso médio 7d 82,14 kg (5 pesagens) · +0,2 kg (+0,24%/sem) · alvo 0,1 a 0,3 %/sem (padrão)",
        "Cintura 84 cm (-0,5)",
        "Alimentação: 4 de 7 dias completos · 2680 kcal · P 148 g · kcal na meta 75% · proteína na meta 100%"
        " · 2 sem cálculo",
        "Treinos: 3 de 4 concluídos · volume work 12500 · 3 exercícios progrediram · 1 regrediu",
        "Recuperação: sono 7,2 h · fome 3 · cansaço 2,5 · dor máx 2 · passos 8123 · cardio 60 min",
        "Dados: Peso ok · Alimentação 4 de 7 · Cintura ok",
    ]


def test_unknown_values_are_left_out_never_zero():
    week = {
        "start": "2026-09-21",
        "end": "2026-09-27",
        "closed": False,
        "weightAvg": None,
        "sessions": 0,
        "status": "Dados insuficientes",
        "recommendation": "DADOS INSUFICIENTES",
        "foodCoverage": "0 de 2 dias",
    }
    assert week_summary(week).splitlines() == [
        "<b>Semana 21/09–27/09 (em andamento)</b>",
        "Situação: <b>Dados insuficientes</b>",
        "Recomendação: <b>DADOS INSUFICIENTES</b>",
        "Alimentação: 0 de 2 dias completos",
        "Treinos: 0 concluídos",
    ]


def test_sheet_text_is_escaped():
    text = week_summary({**WEEK, "recommendationReason": "a <b> & c", "objective": "O<1>"})
    assert "— a &lt;b&gt; &amp; c" in text
    assert "O&lt;1&gt;" in text


def test_period_across_the_new_year():
    text = week_summary({"start": "2026-12-28", "end": "2027-01-03", "closed": True})
    assert text == "<b>Semana 28/12–03/01</b>"
