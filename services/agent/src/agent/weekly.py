"""Weekly summary (`/semana`, and the weekly reminder): built in Python from `diary.range` and
`workout.range`, no model and no I/O.

Missing data is left out, never shown as zero: a line appears only when at least one day or row
carries the value it is computed from. The text is Telegram HTML; sheet-derived names are escaped.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from agent.format import bold, escape

NO_GROUP = "Sem grupo"


def week_bounds(today: date, weeks_back: int = 0) -> tuple[date, date]:
    """Monday and Sunday of the week containing `today`, or of `weeks_back` weeks before it."""
    start = today - timedelta(days=today.weekday() + 7 * weeks_back)
    return start, start + timedelta(days=6)


def period(start: date, end: date) -> str:
    return f"{start:%d/%m}–{end:%d/%m}"


def week_summary(start: date, end: date, days: list[dict[str, Any]], rows: list[dict[str, Any]]) -> str:
    """The summary text for `days` (`diary.range` result) and `rows` (`workout.range` result)."""
    lines = _diary_lines(days) + _workout_lines(rows)
    if not lines:
        return f"Sem registros na semana {period(start, end)}."
    return "\n".join([bold(f"Semana {period(start, end)}"), *lines])


# ---- diary ---------------------------------------------------------------------------------


def _diary_lines(days: list[dict[str, Any]]) -> list[str]:
    lines: list[str] = []
    weights = _numbers(days, "weightKg")
    if weights:
        line = f"Peso médio {_num(_mean(weights), 1)} kg ({_days(len(weights))})"
        if len(weights) > 1:
            (first_day, first), (last_day, last) = weights[0], weights[-1]
            line += (
                f" · {_ddmm(first_day)} {_num(first, 1)} → {_ddmm(last_day)} {_num(last, 1)}"
                f" ({_signed(last - first)} kg)"
            )
        lines.append(line)
    sleep = _numbers(days, "sleepH")
    if sleep:
        lines.append(f"Sono médio {_num(_mean(sleep), 1)} h ({_days(len(sleep))})")
    steps = _numbers(days, "steps")
    if steps:
        lines.append(f"Passos em média {_num(_mean(steps), 0)} ({_days(len(steps))})")
    for field, label in (("muayThai", "Muay Thai"), ("dietComplete", "Dieta completa")):
        answers = [d[field] for d in days if isinstance(d.get(field), bool)]
        if answers:
            lines.append(f"{label}: {sum(answers)} de {_days(len(answers))}")
    cardio = _numbers(days, "cardioMin")
    if cardio:
        lines.append(f"Cardio: {_num(sum(v for _, v in cardio), 0)} min ({_days(len(cardio))})")
    return lines


def _numbers(days: list[dict[str, Any]], field: str) -> list[tuple[str, float]]:
    """(date, value) of the days whose field is a number; a hand-typed text is not data here."""
    return [(d["date"], d[field]) for d in days if _is_number(d.get(field))]


def _mean(values: list[tuple[str, float]]) -> float:
    return sum(v for _, v in values) / len(values)


# ---- workout -------------------------------------------------------------------------------


def _workout_lines(rows: list[dict[str, Any]]) -> list[str]:
    lines: list[str] = []
    sessions: dict[tuple[str, str], None] = {}
    for row in rows:
        sessions[(row["date"], row.get("session") or "")] = None
    if sessions:
        done = ", ".join(f"{escape(name)} {_ddmm(day)}" if name else _ddmm(day) for day, name in sessions)
        lines.append(f"Treinos: {len(sessions)} ({done})")
    volume: dict[str, float] = {}
    for row in rows:
        if _is_number(row.get("volume")):
            group = row.get("group") or NO_GROUP
            volume[group] = volume.get(group, 0) + row["volume"]
    if volume:
        lines.append("Volume por grupo:")
        ranked = sorted(volume.items(), key=lambda item: -item[1])  # stable: ties keep sheet order
        lines += [f"• {escape(group)} {_num(total, 0)}" for group, total in ranked]
    prescribed = [r for r in rows if _is_number(r.get("prescribedSets")) and r["prescribedSets"] > 0]
    if prescribed:
        planned = sum(r["prescribedSets"] for r in prescribed)
        done_sets = sum(r["setsDone"] for r in prescribed if _is_number(r.get("setsDone")))
        lines.append(
            f"Adesão à ficha: {round(100 * done_sets / planned)}%"
            f" ({_num(done_sets, 0)} de {_num(planned, 0)} séries)"
        )
    return lines


# ---- numbers -------------------------------------------------------------------------------


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _num(value: float, digits: int) -> str:
    """Rounded, without a trailing ",0", with a decimal comma: 82.35 → "82,4", 8000.0 → "8000"."""
    rounded = round(value, digits)
    if float(rounded).is_integer():
        return str(int(rounded))
    return f"{rounded:.{digits}f}".replace(".", ",")


def _signed(diff: float) -> str:
    rounded = round(diff, 1)
    if rounded == 0:
        return "0"
    return ("+" if rounded > 0 else "-") + _num(abs(rounded), 1)


def _days(n: int) -> str:
    return f"{n} dia" if n == 1 else f"{n} dias"


def _ddmm(ymd: str) -> str:
    return escape(f"{ymd[8:10]}/{ymd[5:7]}")
