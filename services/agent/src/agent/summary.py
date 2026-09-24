"""Confirmation text built from what the sheet API reports it wrote, never from model output."""

from __future__ import annotations

from typing import Any

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
    parts = [f"{LABELS.get(k, k)} {_value(v)}" for k, v in group["fields"].items()]
    return [" · ".join([_day(group["date"]), *parts])]


def _workout(group: dict[str, Any]) -> list[str]:
    phase = f" ({group['phase']})" if group.get("phase") else ""  # hand-typed rows may lack it
    lines = [f"{_day(group['date'])} · {group['session']}{phase}:"]
    for ex in group["exercises"].values():
        sets = " ".join(f"{_value(s['kg'])}×{s['reps']}" for s in ex["sets"])
        extras = [f"RIR {ex['rir']}"] if ex.get("rir") is not None else []
        if ex.get("pain") is not None:
            extras.append(f"dor {ex['pain']}")
        lines.append(f"• {ex['name']} {sets}" + (f" ({', '.join(extras)})" if extras else ""))
    return lines


def _day(ymd: str) -> str:
    return f"{ymd[8:10]}/{ymd[5:7]}"


def _value(v: Any) -> str:
    if isinstance(v, bool):
        return "Sim" if v else "Não"
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).replace(".", ",") if isinstance(v, int | float) else str(v)
