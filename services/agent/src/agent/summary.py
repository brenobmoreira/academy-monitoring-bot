"""Confirmation text built from what the sheet API reports it wrote, never from model output.

Workouts show work sets (with their RIR) apart from warm-up and feeder, and compare only work
sets with the exercise's previous session: warm-up and feeder never enter a volume or a delta.
Food lines show the macros the sheet computed and, when a line is an estimate or has no
calculation, its Cálculo and Fonte.

The lines are Telegram HTML: every value that came from the sheet is escaped.
"""

from __future__ import annotations

from typing import Any

from agent.format import bold, escape

LABELS = {
    "weightKg": "Peso kg",
    "waistCm": "Cintura cm",
    "sleepH": "Sono h",
    "steps": "Passos",
    "cardioMin": "Cardio min",
    "activityMin": "Atividade min",
    "activity": "Atividade",
    "hunger": "Fome",
    "fatigue": "Cansaço",
    "pain": "Dor",
    "foodLog": "Registro alimentar",
    "notes": "Observações",
}
CALCULATED = "Calculado"
NO_CALC = "Sem cálculo"
DONE = "Concluído"

Write = tuple[str, dict[str, Any]]


def confirmation(writes: list[Write]) -> list[str]:
    """One line per diary day, one block per workout session and per meal; repeated writes merge."""
    groups: dict[tuple[str, ...], dict[str, Any]] = {}
    for op, result in writes:
        if op == "diary.upsert":
            group = groups.setdefault(("diary", result["date"]), {"date": result["date"], "fields": {}})
            group["fields"].update(result.get("fields") or {})
        elif op == "workout.upsert":
            key = ("workout", result["date"], result["session"])
            group = groups.setdefault(key, {**result, "exercises": {}})
            group.update({k: v for k, v in result.items() if k != "exercises"})
            for ex in result.get("exercises") or []:
                group["exercises"][ex["name"]] = ex
        elif op == "food.add":
            key = ("food", result["date"], result["meal"])
            group = groups.setdefault(key, {"date": result["date"], "meal": result["meal"], "items": []})
            group["items"].extend(result.get("items") or [])
            # The day totals of the latest write of that date are the current ones.
            for other in groups.values():
                if other.get("date") == result["date"] and "items" in other:
                    other.pop("totals", None)
            group["totals"] = result.get("totals")
    lines: list[str] = []
    for key, group in groups.items():
        if key[0] == "diary":
            lines.extend(_diary(group))
        elif key[0] == "workout":
            lines.extend(_workout(group))
        else:
            lines.extend(_food(group))
    return lines


# ---- diary ---------------------------------------------------------------------------------


def _diary(group: dict[str, Any]) -> list[str]:
    parts = [
        f"{escape(LABELS.get(k, k))} {'apagado' if v is None else _value(v)}"
        for k, v in group["fields"].items()
    ]
    return [" · ".join([bold(_day(group["date"])), *parts])]


# ---- workout -------------------------------------------------------------------------------


def _workout(group: dict[str, Any]) -> list[str]:
    state = f" ({escape(group['state'])})" if group.get("state") else ""
    lines = [bold(f"{_day(group['date'])} · {escape(group['session'])}{state}:")]
    for ex in group["exercises"].values():
        extras = []
        for key, label in (("warmup", "aquec."), ("feeder", "feeder")):
            if ex.get(key):
                extras.append(f"{label} {_pair(ex[key])}")
        if ex.get("pain") is not None:
            extras.append(f"dor {escape(ex['pain'])}")
        lines.append(
            f"• {bold(escape(ex['name']))} {_work(ex.get('work') or [])}".rstrip()
            + (f" ({', '.join(extras)})" if extras else "")
            + _versus(ex)
        )
    if group.get("state") == DONE and group.get("next"):
        lines.append(f"Próxima sessão: {escape(group['next'])}")
    return lines


def _pair(s: dict[str, Any]) -> str:
    return f"{_value(s['kg'])}×{s['reps']}"


def _work(sets: list[dict[str, Any]]) -> str:
    """Work sets with their RIR: `60×8 RIR 2 · 62,5×8 RIR 1`."""
    return " · ".join(
        _pair(s) + (f" RIR {_value(s['rir'])}" if s.get("rir") is not None else "") for s in sets
    )


def _versus(ex: dict[str, Any]) -> str:
    """` · vs 18/09: 60×8 60×7, carga +2 kg, volume +76`: the previous session of the exercise
    (work sets only) and how the top work set and the work volume moved; with no load either time
    (bodyweight), total reps."""
    prev = ex.get("previous")
    work = ex.get("work") or []
    if not prev or not work:
        return ""
    prev_work = prev.get("work") or []
    top, prev_top = _top(work), _top(prev_work)
    if top or prev_top:
        deltas = [f"carga {_delta(top - prev_top, ' kg')}", f"volume {_delta(_volume(ex) - _volume(prev))}"]
    else:
        deltas = [f"reps {_delta(_reps(work) - _reps(prev_work))}"]
    sets = " ".join(_pair(s) for s in prev_work)
    return f" · vs {_day(prev['date'])}: " + ", ".join(filter(None, [sets, *deltas]))


def _top(sets: list[dict[str, Any]]) -> float:
    return max((s["kg"] or 0 for s in sets), default=0)


def _reps(sets: list[dict[str, Any]]) -> int:
    return sum(s["reps"] for s in sets)


def _volume(ex: dict[str, Any]) -> float:
    """The work volume the sheet reported, or kg×reps over the work sets when it did not."""
    if ex.get("volume") is not None:
        return ex["volume"]
    return sum((s["kg"] or 0) * s["reps"] for s in ex.get("work") or [])


# ---- food ----------------------------------------------------------------------------------


def _food(group: dict[str, Any]) -> list[str]:
    lines = [bold(f"{_day(group['date'])} · {escape(group['meal'])}:")]
    for item in group["items"]:
        amount = (
            f" {_value(item['qty'])} {escape(item.get('unit') or '')}".rstrip() if item.get("qty") else ""
        )
        calc = item.get("calc")
        if calc == NO_CALC:
            what = "sem cálculo"
        else:
            what = f"{_num(item.get('kcal'), 0)} kcal, P {_num(item.get('protein'), 1)} g"
        source = f"Fonte: {escape(item['source'])}" if item.get("source") else ""
        tag = ""
        if calc == NO_CALC and source:
            tag = f" ({source})"
        elif calc and calc != CALCULATED:
            tag = f" ({' · '.join(filter(None, [escape(calc), source]))})"
        lines.append(f"• {escape(item['food'])}{amount} · {what}{tag}")
    totals = group.get("totals")
    if totals:
        lines.append(_totals(totals))
    return lines


def _totals(t: dict[str, Any]) -> str:
    parts = []
    if t.get("kcal") is not None:
        parts.append(f"{_num(t['kcal'], 0)} kcal")
        parts.append(f"P {_num(t.get('protein'), 0)} g")
    else:
        parts.append("sem itens calculáveis")
    if t.get("noCalcItems"):
        parts.append(f"{t['noCalcItems']} sem cálculo")
    if t.get("estimatedItems"):
        n = t["estimatedItems"]
        parts.append(f"{n} estimado{'' if n == 1 else 's'}")
    return "Dia: " + " · ".join(parts)


# ---- values --------------------------------------------------------------------------------


def _delta(diff: float, unit: str = "") -> str:
    if diff == 0:
        return "igual"
    return ("+" if diff > 0 else "-") + _value(round(abs(diff), 2)) + unit


def _day(ymd: str) -> str:
    return escape(f"{ymd[8:10]}/{ymd[5:7]}")


def _num(v: Any, digits: int) -> str:
    if not isinstance(v, int | float) or isinstance(v, bool):
        return "?"
    return _value(round(float(v), digits))


def _value(v: Any) -> str:
    if isinstance(v, bool):
        return "Sim" if v else "Não"
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return str(v).replace(".", ",") if isinstance(v, int | float) else escape(v)
