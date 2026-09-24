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
