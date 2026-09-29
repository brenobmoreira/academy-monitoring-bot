import pytest

from agent.summary import confirmation

pytestmark = pytest.mark.unit

DIARY = (
    "diary.upsert",
    {"date": "2026-09-21", "row": 6, "fields": {"weightKg": 82.4, "activity": "Muay Thai", "hunger": 3}},
)
WORKOUT = (
    "workout.upsert",
    {
        "date": "2026-09-21",
        "session": "Upper",
        "state": "Parcial",
        "exercises": [
            {
                "name": "Supino inclinado",
                "warmup": {"kg": 20, "reps": 12},
                "feeder": {"kg": 40, "reps": 5},
                "work": [{"kg": 60, "reps": 8, "rir": 2}, {"kg": 62.5, "reps": 8, "rir": 1}],
            },
            {"name": "Leg press", "work": [{"kg": 100, "reps": 10, "rir": None}], "pain": 1},
        ],
    },
)


def test_echoes_what_the_sheet_wrote():
    assert confirmation([DIARY, WORKOUT]) == [
        "<b>21/09</b> · Peso kg 82,4 · Atividade Muay Thai · Fome 3",
        "<b>21/09 · Upper (Parcial):</b>",
        "• <b>Supino inclinado</b> 60×8 RIR 2 · 62,5×8 RIR 1 (aquec. 20×12, feeder 40×5)",
        "• <b>Leg press</b> 100×10 (dor 1)",
    ]


def test_a_cleared_diary_field_says_so():
    cleared = ("diary.upsert", {"date": "2026-09-21", "fields": {"waistCm": None, "foodLog": "Completo"}})
    assert confirmation([cleared]) == ["<b>21/09</b> · Cintura cm apagado · Registro alimentar Completo"]


def test_merges_repeated_writes_of_the_same_day_and_session():
    fix = ("diary.upsert", {"date": "2026-09-21", "row": 6, "fields": {"weightKg": 82.1, "sleepH": 7.5}})
    more = (
        "workout.upsert",
        {
            **WORKOUT[1],
            "state": "Concluído",
            "next": "Lower",
            "exercises": [{"name": "Leg press", "work": [{"kg": 110, "reps": 8}]}],
        },
    )
    assert confirmation([DIARY, fix, WORKOUT, more]) == [
        "<b>21/09</b> · Peso kg 82,1 · Atividade Muay Thai · Fome 3 · Sono h 7,5",
        "<b>21/09 · Upper (Concluído):</b>",
        "• <b>Supino inclinado</b> 60×8 RIR 2 · 62,5×8 RIR 1 (aquec. 20×12, feeder 40×5)",
        "• <b>Leg press</b> 110×8",
        "Próxima sessão: Lower",
    ]


def test_nothing_written_gives_no_lines():
    assert confirmation([]) == []


PREVIOUS = {
    "date": "2026-09-18",
    "work": [{"kg": 60, "reps": 8, "rir": 2}, {"kg": 60, "reps": 7, "rir": 1}],
    "volume": 900,
}


def supino(work, previous, **extra):
    exercise = {"name": "Supino inclinado", "work": work, "previous": previous, **extra}
    return confirmation([("workout.upsert", {**WORKOUT[1], "exercises": [exercise]})])[1]


def test_compares_the_work_sets_with_the_previous_session():
    heavier = [{"kg": 60, "reps": 8}, {"kg": 62, "reps": 8}]
    assert supino(heavier, PREVIOUS, volume=976) == (
        "• <b>Supino inclinado</b> 60×8 · 62×8 · vs 18/09: 60×8 60×7, carga +2 kg, volume +76"
    )
    lighter = [{"kg": 57.5, "reps": 10}, {"kg": 57.5, "reps": 10}]
    assert supino(lighter, PREVIOUS, volume=1150) == (
        "• <b>Supino inclinado</b> 57,5×10 · 57,5×10 · vs 18/09: 60×8 60×7, carga -2,5 kg, volume +250"
    )
    assert supino(PREVIOUS["work"], PREVIOUS, volume=900).endswith(": 60×8 60×7, carga igual, volume igual")


def test_warm_up_and_feeder_never_enter_the_comparison():
    line = supino(
        [{"kg": 60, "reps": 8}],
        {**PREVIOUS, "work": [{"kg": 60, "reps": 8}], "volume": 480},
        warmup={"kg": 100, "reps": 20},
        feeder={"kg": 80, "reps": 5},
        volume=480,
    )
    assert line.endswith("vs 18/09: 60×8, carga igual, volume igual")


def test_volume_falls_back_to_the_work_sets_when_not_reported():
    assert supino([{"kg": 50, "reps": 10}], {**PREVIOUS, "volume": None}).endswith(
        "carga -10 kg, volume -400"
    )


def test_bodyweight_compares_total_reps():
    previous = {"date": "2026-09-18", "work": [{"kg": 0, "reps": 12}, {"kg": 0, "reps": 10}], "volume": 0}
    assert supino([{"kg": 0, "reps": 12}, {"kg": 0, "reps": 12}], previous, volume=0) == (
        "• <b>Supino inclinado</b> 0×12 · 0×12 · vs 18/09: 0×12 0×10, reps +2"
    )


def test_no_previous_session_adds_nothing():
    assert supino([{"kg": 60, "reps": 8}], None) == "• <b>Supino inclinado</b> 60×8"


FOOD = (
    "food.add",
    {
        "date": "2026-09-21",
        "meal": "Almoço",
        "items": [
            {
                "food": "Arroz branco cozido",
                "qty": 150,
                "unit": "g",
                "kcal": 192,
                "protein": 3.75,
                "calc": "Calculado",
                "source": "TACO/fonte confiável",
            },
            {
                "food": "Ovo inteiro cozido",
                "qty": 100,
                "unit": "g",
                "kcal": 146,
                "protein": 13.3,
                "calc": "Estimado",
                "source": "TACO/fonte confiável",
            },
            {
                "food": "Pastel de feira",
                "qty": None,
                "unit": None,
                "kcal": None,
                "protein": None,
                "calc": "Sem cálculo",
                "source": "Pendente",
            },
        ],
        "totals": {"kcal": 338, "protein": 17.1, "noCalcItems": 1, "estimatedItems": 1},
    },
)


def test_food_lines_show_macros_and_cálculo_fonte_when_estimated_or_without_calculation():
    assert confirmation([FOOD]) == [
        "<b>21/09 · Almoço:</b>",
        "• Arroz branco cozido 150 g · 192 kcal, P 3,8 g",
        "• Ovo inteiro cozido 100 g · 146 kcal, P 13,3 g (Estimado · Fonte: TACO/fonte confiável)",
        "• Pastel de feira · sem cálculo (Fonte: Pendente)",
        "Dia: 338 kcal · P 17 g · 1 sem cálculo · 1 estimado",
    ]


def test_food_writes_of_one_meal_merge_and_only_the_latest_totals_show():
    snack = (
        "food.add",
        {
            "date": "2026-09-21",
            "meal": "Lanche",
            "items": [
                {
                    "food": "Maçã",
                    "qty": 1,
                    "unit": "un",
                    "kcal": 80,
                    "protein": 0.3,
                    "calc": "Estimado",
                    "source": "Estimativa",
                }
            ],
            "totals": {"kcal": 418, "protein": 17.4, "noCalcItems": 1, "estimatedItems": 2},
        },
    )
    lines = confirmation([FOOD, snack])
    assert [line for line in lines if line.startswith("Dia:")] == [
        "Dia: 418 kcal · P 17 g · 1 sem cálculo · 2 estimados"
    ]
    assert lines[-1].startswith("Dia:")


def test_escapes_everything_that_came_from_the_sheet():
    notes = ("diary.upsert", {"date": "2026-09-21", "row": 6, "fields": {"notes": "dor <leve> & ok"}})
    odd = (
        "workout.upsert",
        {
            **WORKOUT[1],
            "session": "A&B",
            "exercises": [{"name": "Rosca <21>", "work": [{"kg": 10, "reps": 21}]}],
        },
    )
    assert confirmation([notes, odd]) == [
        "<b>21/09</b> · Observações dor &lt;leve&gt; &amp; ok",
        "<b>21/09 · A&amp;B (Parcial):</b>",
        "• <b>Rosca &lt;21&gt;</b> 10×21",
    ]
