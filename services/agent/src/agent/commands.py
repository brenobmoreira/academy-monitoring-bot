"""Slash commands, answered straight from the sheet API without the model.

`COMMANDS` is the registry: the handler dispatches any message whose first word (without
`@botname`) names one, and the same list becomes Telegram's command menu, published by
`uv run agent-commands` and by `scripts/set-webhook.sh set` (kept equal by a test).

    uv run agent-commands        # setMyCommands with the registry; reads the same settings
"""

from __future__ import annotations

import asyncio
import logging
import re
import unicodedata
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any, Protocol

import httpx

from agent.format import bold, escape
from agent.settings import Settings
from agent.summary import confirmation
from agent.telegram import TelegramClient
from agent.undo import undo_last
from agent.weekly import week_bounds, week_summary

log = logging.getLogger(__name__)

EXAMPLES = (
    "Me conte o dia em texto livre, por exemplo:\n"
    "• peso 82,4, cintura 84, dormi 7h30, 8k passos, 60 min de luta\n"
    "• upper: supino inclinado aquecimento 20x12, 60x8 rir 2, 62,5x8 rir 1\n"
    "• almoço: arroz 150 g, frango 120 g, salada\n"
    "• ontem fome 3 cansaço 4, dieta completa\n"
    "• como foi meu supino inclinado nas últimas semanas?\n"
    "Eu gravo na planilha e confirmo o que foi gravado."
)
SHEET_DOWN = "⚠ A planilha não respondeu. Tente de novo em alguns minutos."
MAX_WEEKS_BACK = 12


class CommandSheet(Protocol):
    async def catalog(self) -> dict[str, Any]: ...
    async def day(self, date: str) -> dict[str, Any]: ...
    async def undo(self, write_id: str | None = None) -> dict[str, Any]: ...
    async def phase(self, date: str) -> dict[str, Any]: ...
    async def week(self, date: str) -> dict[str, Any]: ...


@dataclass(frozen=True)
class Reply:
    text: str
    html: bool = False
    reply_markup: dict[str, Any] | None = None
    failed: bool = False  # the sheet API refused or did not answer (see sheet_failure)


@dataclass(frozen=True)
class Context:
    """What a command may use: the sheet API and today's date in the configured TIMEZONE."""

    sheet: CommandSheet | None
    today: date
    chat_id: int = 0

    def api(self) -> CommandSheet:
        if self.sheet is None:
            raise RuntimeError("this handler has no sheet API")
        return self.sheet


@dataclass(frozen=True)
class Command:
    description: str  # shown in Telegram's menu (3-256 characters)
    run: Callable[[Context, str], Awaitable[Reply]]
    menu: bool = True  # False keeps it out of the menu and the help text


COMMANDS: dict[str, Command] = {}


def command(name: str, description: str, *, menu: bool = True):
    def register(run: Callable[[Context, str], Awaitable[Reply]]):
        COMMANDS[name] = Command(description, run, menu)
        return run

    return register


def parse_command(text: str) -> tuple[str, str] | None:
    """(name, args) when the first word is a registered command, `/hoje@my_bot ontem` included."""
    words = text.split(maxsplit=1)
    if not words or not words[0].startswith("/"):
        return None
    name = words[0][1:].split("@")[0].lower()
    return (name, words[1].strip() if len(words) > 1 else "") if name in COMMANDS else None


def menu() -> list[tuple[str, str]]:
    """(name, description) of every listed command, for setMyCommands and the help text."""
    return [(name, c.description) for name, c in COMMANDS.items() if c.menu]


def help_text() -> str:
    return EXAMPLES + "\n\nComandos:\n" + "\n".join(f"/{name} — {text}" for name, text in menu())


# ---- commands ------------------------------------------------------------------------------


@command("hoje", "O que está registrado no dia: /hoje, /hoje ontem, /hoje 21/09")
async def hoje(ctx: Context, args: str) -> Reply:
    try:
        day = parse_day(args, ctx.today)
    except ValueError as err:
        return Reply(str(err))
    response = await ctx.api().day(day.isoformat())
    if not response.get("ok"):
        return sheet_failure(response)
    result = response["result"]
    lines = confirmation(day_writes(result))
    if not lines:
        return Reply(f"Nada registrado em {day:%d/%m}.")
    if result.get("dayState"):
        lines.append(f"Estado do dia: {escape(result['dayState'])}")
    return Reply("\n".join(lines), html=True)  # confirmation() is already Telegram HTML


def day_writes(result: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """A `day.get` result as the writes confirmation() formats: diary, meals, sessions."""
    date = result["date"]
    writes: list[tuple[str, dict[str, Any]]] = []
    if result.get("diary"):
        writes.append(("diary.upsert", {"date": date, "fields": result["diary"]}))
    meals: dict[str, list[dict[str, Any]]] = {}
    for item in result.get("food") or []:
        meals.setdefault(item.get("meal") or "Sem refeição", []).append(item)
    for meal, items in meals.items():
        writes.append(
            ("food.add", {"date": date, "meal": meal, "items": items, "totals": result.get("totals")})
        )
    writes += [("workout.upsert", {"date": date, **session}) for session in result.get("workout") or []]
    return writes


@command("ficha", "Exercícios de uma sessão da ficha vigente; sem nome, a próxima da rotação")
async def ficha(ctx: Context, args: str) -> Reply:
    response = await ctx.api().catalog()
    if not response.get("ok"):
        return sheet_failure(response)
    catalog = response["result"]
    sessions: list[str] = catalog.get("sessions") or []
    plan = (catalog.get("phase") or {}).get("plan") or {}
    if not plan:
        return Reply("Nenhuma ficha em vigor hoje.")
    last = catalog.get("lastWorkout")
    note = ""
    if args:
        session = next((s for s in sessions if normalize(s) == normalize(args)), None)
        if session is None:
            return Reply(f'Sessão "{args}" não existe. Sessões: {", ".join(sessions)}.')
    else:
        session = catalog.get("nextSession") or (sessions[0] if sessions else "")
        if last and last.get("state") == "Concluído":
            note = f", próxima depois de {last['session']} em {_ddmm(last['date'])}"
        elif last:
            note = f"; {last['session']} de {_ddmm(last['date'])} ainda está parcial"
    rows = [r for r in catalog.get("plan") or [] if normalize(r["session"]) == normalize(session)]
    if not rows:
        return Reply(f"A ficha {plan.get('id')} não tem exercícios em {session}.")
    detail = ", ".join(filter(None, [f"ficha {plan.get('id')}", catalog.get("trainingPhase")]))
    header = f"{session} ({detail}){note}:"
    lines = [f"• {r['exercise']} {r.get('prescription') or ''}".rstrip() for r in rows]
    return Reply("\n".join([header, *lines]))


@command("exercicios", "Nomes exatos dos exercícios por grupo; /exercicios peito filtra")
async def exercicios(ctx: Context, args: str) -> Reply:
    response = await ctx.api().catalog()
    if not response.get("ok"):
        return sheet_failure(response)
    groups: dict[str, list[str]] = {}
    for ex in response["result"]["exercises"]:
        groups.setdefault(ex.get("group") or "Sem grupo", []).append(ex["name"])
    if not groups:
        return Reply("O catálogo de exercícios está vazio.")
    if args:
        chosen = {g: names for g, names in groups.items() if normalize(g) == normalize(args)}
        if not chosen:
            return Reply(f'Grupo "{args}" não existe. Grupos: {", ".join(groups)}.')
        groups = chosen
    blocks = [f"{group}:\n" + "\n".join(f"• {name}" for name in names) for group, names in groups.items()]
    return Reply("\n\n".join(blocks))


@command("semana", "Análise da semana (seg–dom): situação e recomendação; /semana 1 é a passada")
async def semana(ctx: Context, args: str) -> Reply:
    word = args.strip()
    if word and not (re.fullmatch(r"[0-9]{1,2}", word) and int(word) <= MAX_WEEKS_BACK):
        return Reply(
            f"Use /semana para esta semana ou /semana n (0 a {MAX_WEEKS_BACK}) para n semanas atrás."
        )
    start, _ = week_bounds(ctx.today, int(word or 0))
    return await week_text(ctx.api(), start)


async def week_text(sheet: CommandSheet, day: date) -> Reply:
    """The weekly analysis of the week containing `day`; also sent by the weekly reminder."""
    response = await sheet.week(day.isoformat())
    if not response.get("ok"):
        return sheet_failure(response)
    return Reply(week_summary(response["result"]), html=True)


@command("fase", "Objetivo em vigor, desde quando, metas e última recomendação; /fase 01/08 numa data")
async def fase(ctx: Context, args: str) -> Reply:
    try:
        day = parse_day(args, ctx.today)
    except ValueError as err:
        return Reply(str(err))
    response = await ctx.api().phase(day.isoformat())
    if not response.get("ok"):
        return sheet_failure(response)
    return Reply(phase_text(response["result"], day != ctx.today), html=True)


def phase_text(phase: dict[str, Any], past: bool = False) -> str:
    """Objective, goal targets, plan and the last weekly analysis of a `phase.get` result."""
    when = f" em {_dmy(phase['date'])}" if past else ""
    objective = phase.get("objective")
    if not objective:
        return f"Nenhum objetivo em vigor{when}."
    lines = [bold(f"Objetivo {escape(objective['id'])} · {escape(objective.get('name') or '')}{when}")]
    since = f"Desde {_dmy(objective['start'])}"
    if objective.get("end"):
        since += f" até {_dmy(objective['end'])}"
    if objective.get("weeks"):
        since += f" · semana {objective['weeks']}"
    kind = objective.get("label") or objective.get("analysisType")
    if kind:
        since += f" · análise: {escape(kind)}"
    lines.append(since)
    baseline = []
    if _is_number(objective.get("startWeightKg")):
        baseline.append(f"peso inicial {_fmt(objective['startWeightKg'])} kg")
    if _is_number(objective.get("startWaistCm")):
        baseline.append(f"cintura inicial {_fmt(objective['startWaistCm'])} cm")
    if objective.get("expectation"):
        baseline.append(f"expectativa: {escape(objective['expectation'])}")
    if baseline:
        lines.append(" · ".join(baseline))
    goal = phase.get("goal")
    if goal:
        lines.append(f"Meta {escape(goal['id'])} (desde {_dmy(goal['start'])}): {goal_text(goal)}")
    plan = phase.get("plan")
    if plan:
        sessions = ", ".join(escape(s) for s in plan.get("sessions") or [])
        detail = " · ".join(filter(None, [sessions, escape(plan.get("trainingPhase") or "")]))
        lines.append(
            f"Ficha {escape(plan['id'])} (desde {_dmy(plan['start'])})" + (f": {detail}" if detail else "")
        )
    rec = phase.get("recommendation")
    if rec:
        text = f"Última análise (semana de {_ddmm(rec['week'])}): {escape(rec.get('status') or '—')}"
        if rec.get("code"):
            text += f" · {bold(escape(rec['code']))}"
        if rec.get("reason"):
            text += f" — {escape(rec['reason'])}"
        if rec.get("nextReview"):
            text += f" (próxima revisão {_ddmm(rec['nextReview'])})"
        lines.append(text)
    else:
        lines.append("Ainda sem análise semanal gravada nesta fase.")
    return "\n".join(lines)


def goal_text(goal: dict[str, Any]) -> str:
    parts = []
    if _is_number(goal.get("kcal")):
        parts.append(f"{_fmt(goal['kcal'])} kcal")
    if _is_number(goal.get("protein")):
        low, high = goal.get("proteinMin"), goal.get("proteinMax")
        band = f" ({_fmt(low)}–{_fmt(high)})" if _is_number(low) and _is_number(high) else ""
        parts.append(f"P {_fmt(goal['protein'])} g{band}")
    for key, label in (("fat", "G"), ("carbs", "C"), ("fiber", "fibra")):
        if _is_number(goal.get(key)):
            parts.append(f"{label} {_fmt(goal[key])} g")
    if _is_number(goal.get("strengthPerWeek")):
        parts.append(f"{_fmt(goal['strengthPerWeek'])} treinos/sem")
    if _is_number(goal.get("stepsPerDay")):
        parts.append(f"{_fmt(goal['stepsPerDay'])} passos/dia")
    return " · ".join(parts) or "sem alvos numéricos"


@command("desfazer", "Desfaz a última gravação na planilha (do bot ou do menu)")
async def desfazer(ctx: Context, args: str) -> Reply:
    return Reply(await undo_last(ctx.api()))


@command("help", "Exemplos de mensagem e esta lista de comandos")
async def help_(ctx: Context, args: str) -> Reply:
    return Reply(help_text())


@command("start", "Início", menu=False)
async def start(ctx: Context, args: str) -> Reply:
    return Reply(help_text())


# ---- helpers -------------------------------------------------------------------------------


def parse_day(text: str, today: date) -> date:
    """Empty or `hoje`, `ontem`, `dd/mm` (the latest such day not after today) or `yyyy-mm-dd`.

    Raises ValueError with the Portuguese reply for anything else or a future day.
    """
    word = text.strip().lower()
    invalid = ValueError(f'Data inválida "{text.strip()}". Use ontem, dd/mm ou aaaa-mm-dd.')
    if word in ("", "hoje"):
        return today
    if word == "ontem":
        return today - timedelta(days=1)
    try:
        if m := re.fullmatch(r"(\d{1,2})/(\d{1,2})", word):
            day = date(today.year, int(m[2]), int(m[1]))
            return day if day <= today else day.replace(year=today.year - 1)
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", word):
            day = date.fromisoformat(word)
        else:
            raise invalid
    except ValueError:
        raise invalid from None
    if day > today:
        raise ValueError(f"{day:%d/%m/%Y} é depois de hoje.")
    return day


def sheet_failure(response: dict[str, Any]) -> Reply:
    error = (response.get("errors") or [{}])[0]
    if error.get("code") in ("unavailable", "internal"):
        return Reply(SHEET_DOWN, failed=True)
    return Reply(f"⚠ A planilha recusou o pedido: {error.get('message', '')}", failed=True)


def normalize(text: str) -> str:
    """Lowercase, accent-free, single-spaced; same rule as Exercises.normalize in Apps Script."""
    plain = "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c))
    return " ".join(plain.lower().split())


def _ddmm(ymd: str) -> str:
    return f"{ymd[8:10]}/{ymd[5:7]}"


def _dmy(ymd: str) -> str:
    return f"{ymd[8:10]}/{ymd[5:7]}/{ymd[:4]}"


def _is_number(value: Any) -> bool:
    return isinstance(value, int | float) and not isinstance(value, bool)


def _fmt(value: Any) -> str:
    """82.0 → "82", 313.75 → "313,75"."""
    if float(value).is_integer():
        return str(int(value))
    return str(round(value, 2)).replace(".", ",")


# ---- CLI -----------------------------------------------------------------------------------


async def publish(settings: Settings) -> None:
    async with httpx.AsyncClient() as http:
        await TelegramClient(settings.TELEGRAM_BOT_TOKEN.get_secret_value(), http).set_my_commands(menu())


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(publish(Settings.load()))
    log.info("command menu set: %s", ", ".join(f"/{name}" for name, _ in menu()))
