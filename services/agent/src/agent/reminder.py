"""Scheduled pushes (`POST /remind`), independent of the HTTP server like webhook.py.

A Cloud Scheduler job per kind calls the agent's URL at /remind with the header
`X-Reminder-Token` and a JSON body `{"kind": "daily" | "weekly" | "nudge"}`:

  - daily:  today's diary lacks weight, sleep or steps → "Faltou registrar hoje: …" to each
            allowed chat; nothing missing → no message.
  - weekly: the /semana analysis (week.get) of the week containing today.
  - nudge:  proactive contextual Shaping check-in using today's diary/workout, next planned
            session + reference lift, water remaining, and weekly consistency.

Without REMINDER_TOKEN the endpoint does not exist (404). The sheet being down never turns into
a message: the job runs unattended, so a failure is logged and nothing is sent.

The messages hold what the person recorded, and the sheet's error messages can repeat it: a failure
is logged through logs.describe() (class, HTTP status, a listed code) and a chat as logs.ref().
"""

from __future__ import annotations

import hmac
import logging
import math
from collections.abc import Callable, Iterable
from datetime import date, datetime
from typing import Any, Protocol
from zoneinfo import ZoneInfo

import httpx

from agent import webhook
from agent.commands import CommandSheet, Reply, week_text
from agent.format import bold, escape, split
from agent.logs import describe, ref
from agent.settings import Settings
from agent.sheet_client import SheetClient
from agent.telegram import TelegramClient

log = logging.getLogger(__name__)

TOKEN_HEADER = "X-Reminder-Token"
PATH = "/remind"
KINDS = ("daily", "weekly", "nudge")
BAD_BODY = 'body must be {"kind": "daily" | "weekly" | "nudge"}'
FAILED = "reminder failed"
WATER_GOAL_L = 2.5

# Diary field → (word in the reminder, example of how to send it), in the order they are listed.
DAILY_FIELDS = {
    "weightKg": ("peso", "peso 82,4"),
    "sleepH": ("sono", "dormi 7h30"),
    "steps": ("passos", "8k passos"),
}


class Sender(Protocol):
    async def send_message(
        self,
        chat_id: int,
        text: str,
        *,
        html: bool = False,
        reply_markup: dict[str, Any] | None = None,
        reply_to: int | None = None,
    ) -> dict[str, Any]: ...


class ReminderFailed(RuntimeError):
    """The reminder could not be prepared or delivered for a reason other than the sheet being
    down; already logged through logs.describe(). It carries nothing of what failed: the server
    that would log an escaping exception prints its message and traceback."""


class SheetDown(RuntimeError):
    """The sheet did not answer (or refused); the reminder sends nothing. `code` is the sheet's
    error code, which logs.describe() prints only when it is a listed one; the sheet's message is
    not kept."""

    def __init__(self, code: object) -> None:
        super().__init__("the sheet failed")
        self.code = code


# ---- what to send --------------------------------------------------------------------------


def missing_fields(diary: dict[str, Any]) -> list[str]:
    """Diary keys of DAILY_FIELDS with no value. Any value the sheet holds counts as recorded,
    a hand-typed text included: the reminder asks for what is absent, not for what is odd."""
    return [key for key in DAILY_FIELDS if _blank(diary.get(key))]


def daily_text(missing: list[str]) -> str:
    words = ", ".join(DAILY_FIELDS[key][0] for key in missing)
    example = ", ".join(DAILY_FIELDS[key][1] for key in missing)
    return f"Faltou registrar hoje: {words}.\nÉ só mandar, por exemplo: {example}"


async def daily(sheet: CommandSheet, today: date) -> Reply | None:
    response = await sheet.day(today.isoformat())
    if not response.get("ok"):
        raise SheetDown(_code(response))
    missing = missing_fields(response["result"].get("diary") or {})
    return Reply(daily_text(missing)) if missing else None


async def weekly(sheet: CommandSheet, today: date) -> Reply:
    reply = await week_text(sheet, today)
    if reply.failed:
        raise SheetDown("unavailable" if reply.transient else "rejected")
    return reply


def nudge_text(
    today: date,
    *,
    diary: dict[str, Any],
    workout_done: bool,
    catalog: dict[str, Any] | None = None,
    week: dict[str, Any] | None = None,
) -> str | None:
    """Contextual Shaping nudge in Telegram HTML, or None when the day is already on track."""
    if not isinstance(diary, dict):
        raise TypeError("diary must be a dict")
    if catalog is not None and not isinstance(catalog, dict):
        raise TypeError("catalog must be a dict")
    if week is not None and not isinstance(week, dict):
        raise TypeError("week must be a dict")

    cat = catalog or {}
    wk = week or {}

    water_raw = diary.get("waterL")
    if _blank(water_raw):
        today_diary = cat.get("todayDiary")
        if isinstance(today_diary, dict):
            water_raw = today_diary.get("waterL")

    water_remaining = 0.0
    water_line: str | None = None
    if _blank(water_raw):
        water = 0.0
    else:
        parsed_water = _finite_number(water_raw)
        water = parsed_water if parsed_water is not None and parsed_water >= 0 else None
    if water is not None:
        remaining = round(WATER_GOAL_L - water, 2)
        if remaining >= 0.25:
            water_remaining = remaining
            if water == 0:
                water_line = f"• Água: 0 L registrados até agora (meta de {_liters(WATER_GOAL_L)})."
            else:
                water_line = (
                    f"• Água: {_liters(water)} de {_liters(WATER_GOAL_L)} (faltam {_liters(remaining)})."
                )

    missing = missing_fields(diary)
    missing_line: str | None = None
    if missing:
        words = ", ".join(DAILY_FIELDS[k][0] for k in missing)
        example = ", ".join(DAILY_FIELDS[k][1] for k in missing)
        missing_line = f"• Check-in do dia: faltou {words} (ex.: {example})."

    if workout_done and water_remaining < 0.25 and not missing:
        return None

    workout_line: str | None = None
    if not workout_done:
        next_raw = cat.get("nextSession")
        if isinstance(next_raw, str) and next_raw.strip():
            next_session = next_raw.strip()
            ref_part = ""
            for row in cat.get("plan") or []:
                if not isinstance(row, dict) or row.get("session") != next_session:
                    continue
                ex_name = row.get("exercise")
                last = row.get("lastWork")
                last_text = last.get("text") if isinstance(last, dict) else None
                if (
                    isinstance(ex_name, str)
                    and ex_name.strip()
                    and isinstance(last_text, str)
                    and last_text.strip()
                ):
                    ref_part = f" — ref. {escape(ex_name.strip())} ({escape(last_text.strip())})"
                    break
            if ref_part:
                workout_line = f"• Próximo treino: {bold(escape(next_session))}{ref_part}."
            else:
                workout_line = f"• Próximo treino da rotação: {bold(escape(next_session))}."

    week_line: str | None = None
    sessions = _finite_number(wk.get("sessions"))
    goal = _finite_number(wk.get("sessionsGoal"))
    progressions = _finite_number(wk.get("progressions"))
    if sessions is not None and goal is not None and sessions >= 0 and goal > 0:
        s_txt = _count_str(sessions)
        g_txt = _count_str(goal)
        prog_n = int(progressions) if progressions is not None and progressions > 0 else 0
        prog_suffix = f" ({prog_n} {'progressão' if prog_n == 1 else 'progressões'})" if prog_n > 0 else ""
        if sessions >= goal:
            week_line = f"• Semana: {s_txt} de {g_txt} treinos fechados{prog_suffix}!"
        elif sessions > 0:
            week_line = f"• Semana: {s_txt} de {g_txt} treinos concluídos{prog_suffix}."
        else:
            week_line = f"• Semana: 0 de {g_txt} treinos até agora — bora abrir a contagem?"

    bullets = [line for line in (workout_line, water_line, week_line, missing_line) if line]
    if not bullets:
        return None

    client = cat.get("client")
    raw_name = client.get("name") if isinstance(client, dict) else None
    first_name = raw_name.strip().split()[0] if isinstance(raw_name, str) and raw_name.strip() else ""
    who = f", {escape(first_name)}" if first_name else ""

    variant = today.toordinal() % 3
    if workout_done:
        openings = (
            f"Treino de hoje pago{who}! Só falta fechar o resto do dia:",
            f"Boa{who}! Treino já foi — falta pouco para gabaritar hoje:",
            f"Check no treino{who}! Shaping passando rápido antes de encerrar o dia:",
        )
    else:
        openings = (
            f"E aí{who}, bora colocar o bloco de hoje na conta?",
            f"Passando rápido{who}: olha como está o seu dia até aqui:",
            f"Salve{who}! Resumo rápido do Shaping para fechar o dia forte:",
        )
    return "\n".join([openings[variant], *bullets, "Manda áudio ou texto por aqui mesmo, ou abre o /app."])


async def nudge(sheet: CommandSheet, today: date) -> Reply | None:
    day_res = await sheet.day(today.isoformat())
    if not day_res.get("ok"):
        raise SheetDown(_code(day_res))
    day_result = day_res["result"]
    if not isinstance(day_result, dict):
        raise TypeError("bad day result")
    raw_diary = day_result.get("diary")
    diary = {} if raw_diary is None else raw_diary
    if not isinstance(diary, dict):
        raise TypeError("bad diary")
    raw_workout = day_result.get("workout")
    workout = [] if raw_workout is None else raw_workout
    if not isinstance(workout, list):
        raise TypeError("bad workout")

    cat_res = await sheet.catalog()
    catalog: dict[str, Any] = {}
    if cat_res.get("ok"):
        raw_cat = cat_res.get("result")
        catalog = {} if raw_cat is None else raw_cat
        if not isinstance(catalog, dict):
            raise TypeError("bad catalog")

    week_res = await sheet.week(today.isoformat())
    week: dict[str, Any] = {}
    if week_res.get("ok"):
        raw_week = week_res.get("result")
        week = {} if raw_week is None else raw_week
        if not isinstance(week, dict):
            raise TypeError("bad week")

    text = nudge_text(
        today,
        diary=diary,
        workout_done=len(workout) > 0,
        catalog=catalog,
        week=week,
    )
    return Reply(text, html=True) if text else None


# ---- sending -------------------------------------------------------------------------------


async def remind(
    kind: str, sheet: CommandSheet, telegram: Sender, chat_ids: Iterable[int], today: date
) -> tuple[int, int]:
    """(chats reached, chats tried). A chat that fails is logged and the others still get it.
    Raises ReminderFailed, sending nothing, when the reminder cannot be prepared for a reason
    other than the sheet being down (an answer the summary cannot read, a bug)."""
    try:
        if kind == "daily":
            reply = await daily(sheet, today)
        elif kind == "weekly":
            reply = await weekly(sheet, today)
        else:
            reply = await nudge(sheet, today)
    except SheetDown as err:
        log.warning("%s reminder skipped, sheet failed: %s", kind, describe(err))
        return 0, 0
    except Exception as error:
        # The error can repeat what the sheet holds; left alone it becomes a 500 whose traceback
        # the HTTP server logs.
        log.error("%s reminder not prepared: %s", kind, describe(error))
        raise ReminderFailed from None
    if reply is None:
        return 0, 0
    chunks = split(reply.text if reply.html else escape(reply.text))
    chats = sorted(chat_ids)
    sent = 0
    for chat_id in chats:
        try:
            for chunk in chunks:
                await telegram.send_message(chat_id, chunk, html=True)
            sent += 1
        except Exception as error:
            log.error(
                "could not send the %s reminder to chat ref %s: %s", kind, ref(chat_id), describe(error)
            )
    return sent, len(chats)


def http_client() -> httpx.AsyncClient:
    """Replaced by e2e/run.py to capture Telegram."""
    return httpx.AsyncClient()


async def deliver(
    settings: Settings, kind: str, clock: Callable[[], datetime] | None = None
) -> tuple[int, int]:
    now = clock() if clock else datetime.now(ZoneInfo(settings.TIMEZONE))
    async with http_client() as http:
        sheet = SheetClient(settings.SHEET_API_URL, settings.SHEET_API_KEY.get_secret_value(), http)
        telegram = TelegramClient(settings.TELEGRAM_BOT_TOKEN.get_secret_value(), http)
        return await remind(kind, sheet, telegram, settings.ALLOWED_CHAT_IDS, now.date())


# ---- HTTP ----------------------------------------------------------------------------------


def is_authorized(settings: Settings, given: str | None) -> bool:
    expected = settings.REMINDER_TOKEN
    if expected is None or not given:
        return False
    return hmac.compare_digest(given.encode(), expected.get_secret_value().encode())


async def process(token: str | None, body: Any) -> tuple[str, int]:
    """Returns (text, status): 404 without REMINDER_TOKEN, 403 for a wrong token, 400 for a bad
    body, 502 when there was something to send and no chat got it, 500 ("reminder failed") when
    it could not be prepared or delivered at all, otherwise 200. Never raises: the server would
    log the exception with its message and traceback."""
    settings = webhook.get_settings()
    if settings.REMINDER_TOKEN is None:
        return "not found", 404
    if not is_authorized(settings, token):
        return "forbidden", 403
    kind = body.get("kind") if isinstance(body, dict) else None
    if kind not in KINDS:
        return BAD_BODY, 400
    try:
        sent, tried = await deliver(settings, kind)
    except ReminderFailed:
        return FAILED, 500
    except Exception as error:
        log.error("%s reminder failed: %s", kind, describe(error))
        return FAILED, 500
    if tried == 0:
        return "nothing to send", 200
    status = 502 if sent == 0 else 200
    return (f"sent {sent}" if sent == tried else f"sent {sent} of {tried}"), status


def _blank(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def _code(response: dict[str, Any]) -> object:
    errors = response.get("errors")
    first = errors[0] if isinstance(errors, list) and errors else None
    return first.get("code") if isinstance(first, dict) else None


def _finite_number(value: Any) -> float | None:
    if isinstance(value, int | float) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return None


def _liters(value: float) -> str:
    rounded = round(float(value), 2)
    if rounded.is_integer():
        return f"{int(rounded)} L"
    return f"{rounded:.2f}".rstrip("0").replace(".", ",") + " L"


def _count_str(value: float) -> str:
    if float(value).is_integer():
        return str(int(value))
    return str(round(value, 1)).replace(".", ",")
