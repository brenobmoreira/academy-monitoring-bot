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

from agent.settings import Settings
from agent.summary import confirmation
from agent.telegram import TelegramClient
from agent.undo import undo_last
from agent.weekly import week_bounds, week_summary

log = logging.getLogger(__name__)

EXAMPLES = (
    "Me conte o dia em texto livre, por exemplo:\n"
    "• peso 82,4, dormi 7h30, 8k passos, muay sim\n"
    "• upper: supino inclinado 60x8 62x8 rir 2, puxada aberta 50x10 50x9\n"
    "• ontem fome 3 cansaço 4\n"
    "• como foi meu supino inclinado nas últimas semanas?\n"
    "Eu gravo na planilha e confirmo o que foi gravado."
)
SHEET_DOWN = "⚠ A planilha não respondeu. Tente de novo em alguns minutos."
ADAPTATION = "Adaptação"
MAX_WEEKS_BACK = 12


class CommandSheet(Protocol):
    async def catalog(self) -> dict[str, Any]: ...
    async def day(self, date: str) -> dict[str, Any]: ...
    async def undo(self, write_id: str | None = None) -> dict[str, Any]: ...
    async def diary_range(self, date_from: str, date_to: str) -> dict[str, Any]: ...
    async def workout_range(self, date_from: str, date_to: str) -> dict[str, Any]: ...


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
    writes: list[tuple[str, dict[str, Any]]] = []
    if result["diary"]:
        writes.append(("diary.upsert", {"date": result["date"], "fields": result["diary"]}))
    writes += [("workout.upsert", {"date": result["date"], **session}) for session in result["workout"]]
    lines = confirmation(writes)
    if not lines:
        return Reply(f"Nada registrado em {day:%d/%m}.")
    return Reply("\n".join(lines), html=True)  # confirmation() is already Telegram HTML


@command("ficha", "Exercícios de uma sessão da ficha; sem nome, a próxima a fazer")
async def ficha(ctx: Context, args: str) -> Reply:
    response = await ctx.api().catalog()
    if not response.get("ok"):
        return sheet_failure(response)
    catalog = response["result"]
    sessions: list[str] = catalog["sessions"]
    last = catalog.get("lastWorkout")
    note = ""
    if args:
        session = next((s for s in sessions if normalize(s) == normalize(args)), None)
        if session is None:
            return Reply(f'Sessão "{args}" não existe. Sessões: {", ".join(sessions)}.')
    else:
        session = next_session(sessions, last)
        if last:
            note = f", depois de {last['session']} em {_ddmm(last['date'])}"
    phase = catalog.get("phase") or ""
    adaptation = normalize(phase) == normalize(ADAPTATION)
    rows = [r for r in catalog["plan"] if r["session"] == session]
    if not rows:
        return Reply(f"A ficha não tem exercícios em {session}.")
    header = f"{session} ({phase}){note}:" if phase else f"{session}{note}:"
    sets = "setsAdaptation" if adaptation else "setsRegular"
    lines = [f"• {r['exercise']} {prescription(r[sets], r)}".rstrip() for r in rows]
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


@command("semana", "Resumo da semana (seg–dom); /semana 1 é a semana passada")
async def semana(ctx: Context, args: str) -> Reply:
    word = args.strip()
    if word and not (re.fullmatch(r"[0-9]{1,2}", word) and int(word) <= MAX_WEEKS_BACK):
        return Reply(
            f"Use /semana para esta semana ou /semana n (0 a {MAX_WEEKS_BACK}) para n semanas atrás."
        )
    start, end = week_bounds(ctx.today, int(word or 0))
    return await week_text(ctx.api(), start, end)


async def week_text(sheet: CommandSheet, start: date, end: date) -> Reply:
    """The weekly summary for `start`..`end` (inclusive); also sent by the weekly reminder."""
    days, rows = await asyncio.gather(
        sheet.diary_range(start.isoformat(), end.isoformat()),
        sheet.workout_range(start.isoformat(), end.isoformat()),
    )
    for response in (days, rows):
        if not response.get("ok"):
            return sheet_failure(response)
    return Reply(week_summary(start, end, days["result"]["days"], rows["result"]["rows"]), html=True)


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


def next_session(sessions: list[str], last: dict[str, Any] | None) -> str:
    """The session after the last logged one in plan order (wrapping), or the first one."""
    names = [normalize(s) for s in sessions]
    if last and normalize(last["session"]) in names:
        return sessions[(names.index(normalize(last["session"])) + 1) % len(sessions)]
    return sessions[0]


def prescription(sets: int, row: dict[str, Any]) -> str:
    low, high = row.get("repsMin") or 0, row.get("repsMax") or 0
    reps = f"{low}–{high}" if low and high and low != high else str(low or high or "")
    if sets and reps:
        return f"{sets}×{reps}"
    return f"{sets} séries" if sets else reps


def sheet_failure(response: dict[str, Any]) -> Reply:
    error = (response.get("errors") or [{}])[0]
    if error.get("code") in ("unavailable", "internal"):
        return Reply(SHEET_DOWN, failed=True)
    return Reply(f"⚠ A planilha recusou o pedido: {error.get('message', '')}", failed=True)


def normalize(text: str) -> str:
    """Lowercase, accent-free, single-spaced; same rule as WorkoutPlan.normalize in Apps Script."""
    plain = "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c))
    return " ".join(plain.lower().split())


def _ddmm(ymd: str) -> str:
    return f"{ymd[8:10]}/{ymd[5:7]}"


# ---- CLI -----------------------------------------------------------------------------------


async def publish(settings: Settings) -> None:
    async with httpx.AsyncClient() as http:
        await TelegramClient(settings.TELEGRAM_BOT_TOKEN.get_secret_value(), http).set_my_commands(menu())


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    asyncio.run(publish(Settings.load()))
    log.info("command menu set: %s", ", ".join(f"/{name}" for name, _ in menu()))
