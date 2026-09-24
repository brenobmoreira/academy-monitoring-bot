"""Confirmation text built from what the sheet API reports it wrote, never from model output.

The lines are Telegram HTML: every value that came from the sheet is escaped.
"""

from __future__ import annotations

from typing import Any

from agent.format import bold, escape

LABELS = {
    "weightKg": "Peso kg",
    "sleepH": "Sono h",
    "steps": "Passos",
    "cardioMin": "Cardio min",
    "muayThai": "Muay Thai",
    "dietComplete": "Dieta completa",
    "waistCm": "Cintura cm",
    "hunger": "Fome",
    "fatigue": "Cansaço",
    "notes": "Observações",
}

Write = tuple[str, dict[str, Any]]


def confirmation(writes: list[Write]) -> list[str]:
    """One line per diary day and one block per workout session; repeated writes are merged."""
    groups: dict[tuple[str, ...], dict[str, Any]] = {}
    for op, result in writes:
        if op == "diary.upsert":
            group = groups.setdefault(("diary", result["date"]), {"date": result["date"], "fields": {}})
            group["fields"].update(result["fields"])
        elif op == "workout.upsert":
            key = ("workout", result["date"], result["session"])
            group = groups.setdefault(key, {**result, "exercises": {}})
            group["phase"] = result["phase"]
            for ex in result["exercises"]:
                group["exercises"][ex["name"]] = ex
    lines: list[str] = []
    for key, group in groups.items():
        lines.extend(_diary(group) if key[0] == "diary" else _workout(group))
    return lines


def _diary(group: dict[str, Any]) -> list[str]:
    parts = [f"{escape(LABELS.get(k, k))} {_value(v)}" for k, v in group["fields"].items()]
    return [" · ".join([bold(_day(group["date"])), *parts])]


def _workout(group: dict[str, Any]) -> list[str]:
    lines = [bold(f"{_day(group['date'])} · {escape(group['session'])} ({escape(group['phase'])}):")]
    for ex in group["exercises"].values():
        sets = _sets(ex["sets"])
        extras = [f"RIR {escape(ex['rir'])}"] if ex.get("rir") is not None else []
        if ex.get("pain") is not None:
            extras.append(f"dor {escape(ex['pain'])}")
        lines.append(
            f"• {bold(escape(ex['name']))} {sets}"
            + (f" ({', '.join(extras)})" if extras else "")
            + _versus(ex)
        )
    return lines


def _sets(sets: list[dict[str, Any]]) -> str:
    return " ".join(f"{_value(s['kg'])}×{s['reps']}" for s in sets)


def _versus(ex: dict[str, Any]) -> str:
    """` · vs 18/09: 60×8 60×7, carga +2 kg, volume +76`: the exercise's previous session and how
    the top-set load and the volume moved; with no load either time (bodyweight), total reps."""
    prev = ex.get("previous")
    if not prev:
        return ""
    top, prev_top = _top(ex["sets"]), _top(prev["sets"])
    if top or prev_top:
        deltas = [f"carga {_delta(top - prev_top, ' kg')}", f"volume {_delta(_volume(ex) - _volume(prev))}"]
    else:
        deltas = [f"reps {_delta(_reps(ex['sets']) - _reps(prev['sets']))}"]
    return f" · vs {_day(prev['date'])}: " + ", ".join(filter(None, [_sets(prev["sets"]), *deltas]))


def _top(sets: list[dict[str, Any]]) -> float:
    return max((s["kg"] or 0 for s in sets), default=0)


def _reps(sets: list[dict[str, Any]]) -> int:
    return sum(s["reps"] for s in sets)


def _volume(ex: dict[str, Any]) -> float:
    """The volume the sheet reported, or kg×reps over the sets when it did not."""
    if ex.get("volume") is not None:
        return ex["volume"]
    return sum((s["kg"] or 0) * s["reps"] for s in ex["sets"])


def _delta(diff: float, unit: str = "") -> str:
    if diff == 0:
        return "igual"
    return ("+" if diff > 0 else "-") + _value(round(abs(diff), 2)) + unit


def _day(ymd: str) -> str:
    return escape(f"{ymd[8:10]}/{ymd[5:7]}")


def _value(v: Any) -> str:
    if isinstance(v, bool):
        return "Sim" if v else "Não"
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).replace(".", ",") if isinstance(v, int | float) else escape(v)
