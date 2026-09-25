from datetime import date

import pytest

from agent.weekly import week_bounds, week_summary

pytestmark = pytest.mark.unit

MON, SUN = date(2026, 9, 21), date(2026, 9, 27)


def row(day, session, exercise, group, done, volume, prescribed):
    return {
        "date": day,
        "session": session,
        "exercise": exercise,
        "group": group,
        "setsDone": done,
        "volume": volume,
        "prescribedSets": prescribed,
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
    days = [
        {"date": "2026-09-21", "weightKg": 82.4, "sleepH": 7.5, "steps": 8000, "muayThai": True},
        {"date": "2026-09-22", "sleepH": 6, "muayThai": False, "dietComplete": True, "cardioMin": 30},
        {"date": "2026-09-23", "weightKg": 82.0, "steps": 10001, "dietComplete": False},
        {"date": "2026-09-24", "weightKg": 81.9, "muayThai": True, "cardioMin": 45.5},
    ]
    rows = [
        row("2026-09-21", "Upper", "Supino inclinado", "Peito", 3, 1440, 3),
        row("2026-09-21", "Upper", "Puxada aberta", "Costas", 2, 1000, 3),
        row("2026-09-23", "Lower", "Leg press", "Quadríceps", 4, 4000, 4),
        row("2026-09-24", "Upper", "Supino inclinado", "Peito", 3, 1500, None),  # no prescription
    ]
    assert week_summary(MON, SUN, days, rows).splitlines() == [
        "<b>Semana 21/09–27/09</b>",
        "Peso médio 82,1 kg (3 dias) · 21/09 82,4 → 24/09 81,9 (-0,5 kg)",
        "Sono médio 6,8 h (2 dias)",
        "Passos em média 9000 (2 dias)",
        "Muay Thai: 2 de 3 dias",
        "Dieta completa: 1 de 2 dias",
        "Cardio: 76 min (2 dias)",
        "Treinos: 3 (Upper 21/09, Lower 23/09, Upper 24/09)",
        "Volume por grupo:",
        "• Quadríceps 4000",
        "• Peito 2940",
        "• Costas 1000",
        "Adesão à ficha: 90% (9 de 10 séries)",
    ]


def test_lines_without_data_are_left_out():
    days = [{"date": "2026-09-22", "weightKg": 80}]
    assert week_summary(MON, SUN, days, []) == "<b>Semana 21/09–27/09</b>\nPeso médio 80 kg (1 dia)"


def test_values_typed_as_text_and_empty_cells_are_not_data():
    days = [{"date": "2026-09-22", "weightKg": "oitenta", "sleepH": True, "notes": "viagem"}]
    rows = [row("2026-09-22", "Upper", "Remada", None, None, None, None)]
    assert week_summary(MON, SUN, days, rows).splitlines() == [
        "<b>Semana 21/09–27/09</b>",
        "Treinos: 1 (Upper 22/09)",
    ]


def test_adherence_counts_an_empty_sets_done_as_zero_and_groups_default():
    rows = [
        row("2026-09-22", "", "Remada", None, None, 500, 3),
        row("2026-09-22", "", "Rosca", None, 1, 200, 3),
    ]
    assert week_summary(MON, SUN, [], rows).splitlines()[1:] == [
        "Treinos: 1 (22/09)",
        "Volume por grupo:",
        "• Sem grupo 700",
        "Adesão à ficha: 17% (1 de 6 séries)",
    ]


def test_weight_delta_of_zero_and_recorded_no_answers():
    days = [
        {"date": "2026-09-21", "weightKg": 80.0, "muayThai": False},
        {"date": "2026-09-27", "weightKg": 80.04, "dietComplete": False},
    ]
    assert week_summary(MON, SUN, days, []).splitlines()[1:] == [
        "Peso médio 80 kg (2 dias) · 21/09 80 → 27/09 80 (0 kg)",
        "Muay Thai: 0 de 1 dia",  # a recorded "Não" is data, so zero is shown
        "Dieta completa: 0 de 1 dia",
    ]


def test_sheet_text_is_escaped():
    rows = [row("2026-09-22", "A<b>&", "Rosca", "Bra<ço>", 1, 100, None)]
    text = week_summary(MON, SUN, [], rows)
    assert "Treinos: 1 (A&lt;b&gt;&amp; 22/09)" in text
    assert "• Bra&lt;ço&gt; 100" in text


def test_empty_week():
    assert week_summary(MON, SUN, [], []) == "Sem registros na semana 21/09–27/09."
    only_notes = [{"date": "2026-09-22", "notes": "descanso"}]
    assert week_summary(MON, SUN, only_notes, []) == "Sem registros na semana 21/09–27/09."


def test_period_across_the_new_year():
    text = week_summary(date(2026, 12, 28), date(2027, 1, 3), [], [])
    assert text == "Sem registros na semana 28/12–03/01."
