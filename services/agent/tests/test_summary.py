import pytest

from agent.summary import confirmation

pytestmark = pytest.mark.unit

DIARY = (
    "diary.upsert",
    {"date": "2026-09-21", "row": 6, "fields": {"weightKg": 82.4, "muayThai": True, "hunger": 3}},
)
WORKOUT = (
    "workout.upsert",
    {
        "date": "2026-09-21",
        "session": "Upper",
        "phase": "Adaptação",
        "sessionId": "2026-09-21/Upper",
        "exercises": [
            {
                "name": "Supino inclinado",
                "row": 6,
                "sets": [{"kg": 60, "reps": 8}, {"kg": 62.5, "reps": 8}],
                "rir": 2,
            },
            {"name": "Leg press", "row": 7, "sets": [{"kg": 100, "reps": 10}], "pain": 1},
        ],
    },
)


def test_echoes_what_the_sheet_wrote():
    assert confirmation([DIARY, WORKOUT]) == [
        "<b>21/09</b> · Peso kg 82,4 · Muay Thai Sim · Fome 3",
        "<b>21/09 · Upper (Adaptação):</b>",
        "• <b>Supino inclinado</b> 60×8 62,5×8 (RIR 2)",
        "• <b>Leg press</b> 100×10 (dor 1)",
    ]


def test_merges_repeated_writes_of_the_same_day_and_session():
    fix = ("diary.upsert", {"date": "2026-09-21", "row": 6, "fields": {"weightKg": 82.1, "sleepH": 7.5}})
    more = (
        "workout.upsert",
        {**WORKOUT[1], "exercises": [{"name": "Leg press", "row": 7, "sets": [{"kg": 110, "reps": 8}]}]},
    )
    assert confirmation([DIARY, fix, WORKOUT, more]) == [
        "<b>21/09</b> · Peso kg 82,1 · Muay Thai Sim · Fome 3 · Sono h 7,5",
        "<b>21/09 · Upper (Adaptação):</b>",
        "• <b>Supino inclinado</b> 60×8 62,5×8 (RIR 2)",
        "• <b>Leg press</b> 110×8",
    ]


def test_nothing_written_gives_no_lines():
    assert confirmation([]) == []


PREVIOUS = {
    "date": "2026-09-18",
    "sets": [{"kg": 60, "reps": 8}, {"kg": 60, "reps": 7}],
    "volume": 900,
    "setsDone": 2,
}


def supino(sets, previous, **extra):
    exercise = {"name": "Supino inclinado", "row": 6, "sets": sets, "previous": previous, **extra}
    return confirmation([("workout.upsert", {**WORKOUT[1], "exercises": [exercise]})])[1]


def test_compares_each_exercise_with_its_previous_session():
    heavier = [{"kg": 60, "reps": 8}, {"kg": 62, "reps": 8}]
    assert supino(heavier, PREVIOUS, volume=976, rir=2) == (
        "• <b>Supino inclinado</b> 60×8 62×8 (RIR 2) · vs 18/09: 60×8 60×7, carga +2 kg, volume +76"
    )
    lighter = [{"kg": 57.5, "reps": 10}, {"kg": 57.5, "reps": 10}]
    assert supino(lighter, PREVIOUS, volume=1150) == (
        "• <b>Supino inclinado</b> 57,5×10 57,5×10 · vs 18/09: 60×8 60×7, carga -2,5 kg, volume +250"
    )
    assert supino(PREVIOUS["sets"], PREVIOUS, volume=900).endswith(": 60×8 60×7, carga igual, volume igual")


def test_volume_falls_back_to_the_sets_when_not_reported():
    assert supino([{"kg": 50, "reps": 10}], {**PREVIOUS, "volume": None}).endswith(
        "carga -10 kg, volume -400"
    )


def test_bodyweight_compares_total_reps():
    previous = {"date": "2026-09-18", "sets": [{"kg": 0, "reps": 12}, {"kg": 0, "reps": 10}], "volume": 0}
    assert supino([{"kg": 0, "reps": 12}, {"kg": 0, "reps": 12}], previous, volume=0) == (
        "• <b>Supino inclinado</b> 0×12 0×12 · vs 18/09: 0×12 0×10, reps +2"
    )


def test_no_previous_session_adds_nothing():
    assert supino([{"kg": 60, "reps": 8}], None) == "• <b>Supino inclinado</b> 60×8"


def test_escapes_everything_that_came_from_the_sheet():
    notes = ("diary.upsert", {"date": "2026-09-21", "row": 6, "fields": {"notes": "dor <leve> & ok"}})
    odd = (
        "workout.upsert",
        {
            **WORKOUT[1],
            "session": "A&B",
            "exercises": [{"name": "Rosca <21>", "row": 8, "sets": [{"kg": 10, "reps": 21}]}],
        },
    )
    assert confirmation([notes, odd]) == [
        "<b>21/09</b> · Observações dor &lt;leve&gt; &amp; ok",
        "<b>21/09 · A&amp;B (Adaptação):</b>",
        "• <b>Rosca &lt;21&gt;</b> 10×21",
    ]
