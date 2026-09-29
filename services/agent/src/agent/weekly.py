"""Weekly summary (`/semana`, and the weekly reminder): the sheet's own weekly analysis
(`week.get`, one `Semanas` row: stored as values for a closed week, computed for the running one)
formatted in Python, no model.

The analysis already carries the objective, goal and plan of that week, its status
(No caminho | Atenção | Fora do esperado | Dados insuficientes) and the recommendation. Missing
data is left out, never shown as zero. The text is Telegram HTML; sheet-derived text is escaped.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any

from agent.format import bold, escape


def week_bounds(today: date, weeks_back: int = 0) -> tuple[date, date]:
    """Monday and Sunday of the week containing `today`, or of `weeks_back` weeks before it."""
    start = today - timedelta(days=today.weekday() + 7 * weeks_back)
    return start, start + timedelta(days=6)


def period(start: date, end: date) -> str:
    return f"{start:%d/%m}–{end:%d/%m}"


def week_summary(week: dict[str, Any]) -> str:
    """The summary text of a `week.get` result."""
    start, end = date.fromisoformat(week["start"]), date.fromisoformat(week["end"])
    ids = " · ".join(escape(week[k]) for k in ("objective", "goal", "plan") if week.get(k))
    title = f"Semana {period(start, end)}" + ("" if week.get("closed") else " (em andamento)")
    lines = [bold(title) + (f" · {ids}" if ids else "")]
    if week.get("status"):
        lines.append(f"Situação: {bold(escape(week['status']))}")
    if week.get("recommendation"):
        rec = f"Recomendação: {bold(escape(week['recommendation']))}"
        if week.get("recommendationReason"):
            rec += f" — {escape(week['recommendationReason'])}"
        if week.get("nextReview"):
            rec += f" (próxima revisão {_ddmm(week['nextReview'])})"
        lines.append(rec)
    if week.get("transition"):
        lines.append(f"Transição: {escape(week['transition'])}")
    lines += _weight(week) + _food(week) + _training(week) + _recovery(week)
    if week.get("sufficiency"):
        lines.append(f"Dados: {escape(week['sufficiency'])}")
    return "\n".join(lines)


def _weight(w: dict[str, Any]) -> list[str]:
    lines = []
    if _is_number(w.get("weightAvg")):
        line = f"Peso médio 7d {_num(w['weightAvg'], 2)} kg"
        if _is_number(w.get("weighIns")):
            line += f" ({_count(w['weighIns'], 'pesagem', 'pesagens')})"
        if _is_number(w.get("weightDelta")):
            line += f" · {_signed(w['weightDelta'], 2)} kg"
        if _is_number(w.get("weightDeltaPct")):
            line += f" ({_signed(w['weightDeltaPct'], 2)}%/sem)"
        if w.get("targetRange"):
            line += f" · alvo {escape(w['targetRange'])}"
        lines.append(line)
    if _is_number(w.get("waistCm")):
        delta = f" ({_signed(w['waistDelta'], 1)})" if _is_number(w.get("waistDelta")) else ""
        lines.append(f"Cintura {_num(w['waistCm'], 1)} cm{delta}")
    return lines


def _food(w: dict[str, Any]) -> list[str]:
    parts = []
    if w.get("foodCoverage"):
        parts.append(f"{escape(w['foodCoverage'])} completos")
    if _is_number(w.get("kcalAvg")):
        parts.append(f"{_num(w['kcalAvg'], 0)} kcal")
    if _is_number(w.get("proteinAvg")):
        parts.append(f"P {_num(w['proteinAvg'], 0)} g")
    for key, label in (("kcalAdherence", "kcal"), ("proteinAdherence", "proteína")):
        if _is_number(w.get(key)):
            parts.append(f"{label} na meta {round(100 * w[key])}%")
    if w.get("noCalcItems"):
        parts.append(f"{w['noCalcItems']} sem cálculo")
    return ["Alimentação: " + " · ".join(parts)] if parts else []


def _training(w: dict[str, Any]) -> list[str]:
    parts = []
    if _is_number(w.get("sessions")):
        goal = f" de {_num(w['sessionsGoal'], 0)}" if _is_number(w.get("sessionsGoal")) else ""
        parts.append(f"{_num(w['sessions'], 0)}{goal} concluídos")
    if _is_number(w.get("workVolume")):
        parts.append(f"volume work {_num(w['workVolume'], 0)}")
    if _is_number(w.get("progressions")):
        parts.append(f"{_count(w['progressions'], 'exercício progrediu', 'exercícios progrediram')}")
    if _is_number(w.get("regressions")) and w["regressions"]:
        parts.append(f"{_count(w['regressions'], 'regrediu', 'regrediram')}")
    return ["Treinos: " + " · ".join(parts)] if parts else []


def _recovery(w: dict[str, Any]) -> list[str]:
    parts = []
    for key, label, unit, digits in (
        ("sleepAvg", "sono", " h", 1),
        ("hungerAvg", "fome", "", 1),
        ("fatigueAvg", "cansaço", "", 1),
        ("painMax", "dor máx", "", 0),
        ("stepsAvg", "passos", "", 0),
        ("cardioMin", "cardio", " min", 0),
    ):
        if _is_number(w.get(key)):
            parts.append(f"{label} {_num(w[key], digits)}{unit}")
    return ["Recuperação: " + " · ".join(parts)] if parts else []


# ---- numbers -------------------------------------------------------------------------------


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _num(value: float, digits: int) -> str:
    """Rounded, without a trailing ",0", with a decimal comma: 82.35 → "82,4", 8000.0 → "8000"."""
    rounded = round(value, digits)
    if float(rounded).is_integer():
        return str(int(rounded))
    return f"{rounded:.{digits}f}".rstrip("0").replace(".", ",")


def _signed(diff: float, digits: int) -> str:
    rounded = round(diff, digits)
    if rounded == 0:
        return "0"
    return ("+" if rounded > 0 else "-") + _num(abs(rounded), digits)


def _count(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


def _ddmm(ymd: str) -> str:
    return escape(f"{ymd[8:10]}/{ymd[5:7]}")
