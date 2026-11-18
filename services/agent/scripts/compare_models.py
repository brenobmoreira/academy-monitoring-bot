"""Development tool, run once by hand with a real key: measures Gemini on the bot's two tasks.

    uv run python scripts/compare_models.py AUDIO_DIR --out OUT_DIR

It never runs in tests or in the bot. See compare_models.md for the step by step.

- Transcription (B, the main part): the bot's real `Transcriber` on each audio of AUDIO_DIR, every
  audio twice per model and thinking level.
- Chat (A): the bot's real agent (`Bot` + `build_model`, the LLM_MODEL path) on 5 synthetic
  Portuguese messages, against an in-memory sheet. The real sheet is never touched.

It also checks three numbers of the voice work (C4b): TRANSCRIBE_PROMPT_TOKENS against the
provider's `usage.prompt_tokens`, whether `temperature=0` is sent and gives stable text, and
whether `max_tokens` (600) is enough now that thinking is always on and counts inside it.

Secrets and content:
- the key is read only from GEMINI_API_KEY, never printed, logged or saved; errors are printed as
  their class (`logs.describe`), never their message (provider errors can echo the request);
- the transcripts go to OUT_DIR/transcripts.txt only; the terminal and results.md carry metrics
  (audios are named a01, a02...), so no content reaches a log. OUT_DIR must be outside any git
  repository: this repository is public.

Thinking level: LiteLLM's `reasoning_effort` ("low" | "medium" | "high"). For `gemini-3*` models it
becomes `thinkingConfig.thinkingLevel` (+ includeThoughts=true), see
litellm/llms/vertex_ai/gemini/vertex_and_google_ai_studio_gemini.py
(`_map_reasoning_effort_to_thinking_level`).
Models outside `gemini-3*` get a `thinkingBudget` from it instead: check `sent_config` in results.md
before trusting a model that is not a 3.x one. The bot itself sends no `reasoning_effort`, so it runs at
the model's default (medium for gemini-3.8-flash). Official docs:
https://ai.google.dev/gemini-api/docs/thinking
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import difflib
import json
import logging
import os
import re
import statistics
import sys
import time
import warnings
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from google.adk.models.lite_llm import LiteLLMClient

from agent import logs
from agent.bot import Bot
from agent.budget import MemoryBudget
from agent.llm import build_model
from agent.logs import describe
from agent.settings import Settings, TranscribeSettings
from agent.transcribe import (
    MAX_TOKENS,
    TRANSCRIBE_PROMPT,
    TRANSCRIBE_PROMPT_TOKENS,
    Audio,
    TranscribeError,
    Transcriber,
)

KEY_VARIABLE = "GEMINI_API_KEY"
DEFAULT_MODELS = ("gemini/gemini-3.8-flash",)
DEFAULT_LEVELS = ("low", "medium")
# "default" sends no reasoning_effort at all: what the bot does today (the model's own default level).
DEFAULT_LEVEL = "default"
LEVEL_CHOICES = ("low", "medium", "high", DEFAULT_LEVEL)
AUDIO_TYPES = {".webm": "audio/webm", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".mp3": "audio/mpeg"}
# A voice note is a few hundred KB; Telegram's own limit for the bot is MEDIA_MAX_BYTES (5 MB).
MAX_AUDIO_BYTES = 5_000_000
TRUNCATED = frozenset({"length", "max_tokens"})
# How far the measured text tokens may be from TRANSCRIBE_PROMPT_TOKENS before the constant is
# worth changing (it bounds a reservation: a few tokens either way change nothing).
PROMPT_TOKENS_TOLERANCE = 10
CHAT_TIMEOUT_S = 60.0
TIMEZONE = "America/Sao_Paulo"
# A fixed "now" so "ontem" and "hoje" mean the same on every run (a Wednesday).
NOW = datetime(2026, 11, 18, 12, 0, tzinfo=ZoneInfo(TIMEZONE))

# --- Prices ---------------------------------------------------------------------------------------
# Source: https://ai.google.dev/gemini-api/docs/pricing, "Gemini 3.8 Flash", Standard, Paid Tier,
# USD per 1M tokens, read on 2026-11-15. Input is one price for text, image, video and audio; the
# output price includes thinking tokens. The page lists a price through 2026-12-31 and another
# from 2027-01-01. Edit here (and the date above) if the page changes; a model not listed has no
# cost estimate ("n/d").
PRICING_SOURCE = (
    "https://ai.google.dev/gemini-api/docs/pricing "
    "(Gemini 3.8 Flash, Standard, Paid Tier, read on 2026-11-15)"
)


@dataclass(frozen=True)
class Price:
    since: date
    input_per_m: float
    output_per_m: float  # includes thinking tokens


PRICES: dict[str, tuple[Price, ...]] = {
    "gemini/gemini-3.8-flash": (
        Price(date.min, 0.75, 3.75),
        Price(date(2027, 1, 1), 1.50, 7.50),
    ),
}


def price_in_effect(model: str, today: date) -> Price | None:
    current = None
    for price in PRICES.get(model, ()):
        if price.since <= today:
            current = price
    return current


def next_price(model: str, today: date) -> Price | None:
    return next((p for p in PRICES.get(model, ()) if p.since > today), None)


def estimate_cost(
    prompt_tokens: float | None, completion_tokens: float | None, price: Price | None
) -> float | None:
    """USD of one call. `completion_tokens` already includes the thinking tokens (LiteLLM adds
    Gemini's `thoughtsTokenCount` to it), and the output price covers them."""
    if price is None or prompt_tokens is None or completion_tokens is None:
        return None
    return (prompt_tokens * price.input_per_m + completion_tokens * price.output_per_m) / 1_000_000


# --- Metrics of one model call ----------------------------------------------------------------------


@dataclass
class CallMetrics:
    latency_s: float
    prompt_tokens: int | None = None
    completion_tokens: int | None = None  # includes thinking tokens
    reasoning_tokens: int | None = None
    audio_tokens: int | None = None  # part of prompt_tokens, when the provider reports it
    finish_reason: str | None = None
    tool_calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    error: str | None = None  # the class of the exception (logs.describe), never its message

    @property
    def truncated(self) -> bool:
        return is_truncated(self.finish_reason)


def is_truncated(finish_reason: str | None) -> bool:
    """The answer stopped at max_tokens (LiteLLM says "length"; Gemini's own name is MAX_TOKENS)."""
    return finish_reason is not None and finish_reason.lower() in TRUNCATED


def _get(obj: Any, name: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _count(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def metrics_from_response(response: Any, latency_s: float) -> CallMetrics:
    usage = _get(response, "usage")
    choices = _get(response, "choices")
    first = choices[0] if isinstance(choices, list | tuple) and choices else None
    message = _get(first, "message")
    tool_calls: list[tuple[str, dict[str, Any]]] = []
    for tc in _get(message, "tool_calls") or []:
        function = _get(tc, "function")
        raw = _get(function, "arguments")
        try:
            args = json.loads(raw) if isinstance(raw, str) else dict(raw or {})
        except (ValueError, TypeError):
            args = {}
        tool_calls.append((str(_get(function, "name")), args if isinstance(args, dict) else {}))
    finish = _get(first, "finish_reason")
    return CallMetrics(
        latency_s=latency_s,
        prompt_tokens=_count(_get(usage, "prompt_tokens")),
        completion_tokens=_count(_get(usage, "completion_tokens")),
        reasoning_tokens=_count(_get(_get(usage, "completion_tokens_details"), "reasoning_tokens")),
        audio_tokens=_count(_get(_get(usage, "prompt_tokens_details"), "audio_tokens")),
        finish_reason=str(finish) if finish is not None else None,
        tool_calls=tool_calls,
    )


class MeteringClient(LiteLLMClient):
    """Sits between the bot's code and LiteLLM: adds `reasoning_effort` (the thinking level) to
    every call and records latency, usage, finish reason and tool calls of each one."""

    def __init__(self, inner: LiteLLMClient, reasoning_effort: str | None) -> None:
        self.inner = inner
        self.reasoning_effort = reasoning_effort
        self.calls: list[CallMetrics] = []

    async def acompletion(self, model: Any, messages: Any, tools: Any, **kwargs: Any) -> Any:
        if self.reasoning_effort and self.reasoning_effort != DEFAULT_LEVEL:
            kwargs["reasoning_effort"] = self.reasoning_effort
        start = time.perf_counter()
        try:
            response = await self.inner.acompletion(model=model, messages=messages, tools=tools, **kwargs)
        except (Exception, asyncio.CancelledError) as err:
            self.calls.append(CallMetrics(time.perf_counter() - start, error=describe(err)))
            raise
        self.calls.append(metrics_from_response(response, time.perf_counter() - start))
        return response

    def take(self) -> list[CallMetrics]:
        calls, self.calls = self.calls, []
        return calls


# --- Transcription (B) ------------------------------------------------------------------------------


@dataclass(frozen=True)
class AudioFile:
    id: str  # a01, a02...: what the terminal and results.md call it
    path: Path
    mime_type: str


def discover_audio(folder: Path) -> tuple[list[AudioFile], int]:
    """The audios of a folder (webm, ogg, m4a, mp3; not in subfolders) and how many were skipped
    for being larger than MAX_AUDIO_BYTES."""
    files = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in AUDIO_TYPES)
    kept = [p for p in files if p.stat().st_size <= MAX_AUDIO_BYTES]
    audios = [AudioFile(f"a{i:02d}", p, AUDIO_TYPES[p.suffix.lower()]) for i, p in enumerate(kept, start=1)]
    return audios, len(files) - len(kept)


@dataclass
class TranscribeRun:
    audio_id: str
    model: str
    level: str
    rep: int
    latency_s: float
    error: str | None = None  # TranscribeError code
    metrics: CallMetrics | None = None
    chars: int | None = None
    # The transcript itself: written to transcripts.txt only, never rendered.
    text: str | None = field(default=None, repr=False)

    @property
    def ok(self) -> bool:
        return self.error is None

    @property
    def truncated(self) -> bool:
        return self.metrics is not None and self.metrics.truncated

    @property
    def text_tokens(self) -> int | None:
        """Prompt tokens that are not audio: our system prompt (the user turn is only audio)."""
        m = self.metrics
        if m is None or m.prompt_tokens is None or m.audio_tokens is None:
            return None
        return m.prompt_tokens - m.audio_tokens


async def transcribe_runs(
    audios: list[AudioFile],
    model: str,
    level: str,
    reps: int,
    inner: LiteLLMClient,
    on_run: Callable[[TranscribeRun], None],
) -> list[TranscribeRun]:
    """Each audio `reps` times through the real Transcriber (one attempt per call: no retries, no
    fallback, so every run is one request)."""
    settings = TranscribeSettings(TRANSCRIBE_MODEL=model, TRANSCRIBE_RETRIES=0)
    metering = MeteringClient(inner, level)
    budget = MemoryBudget(principal_daily=10**12, global_daily=10**12, timezone=TIMEZONE)
    transcriber = Transcriber(settings, budget, client=metering)
    runs: list[TranscribeRun] = []
    for audio in audios:
        data = audio.path.read_bytes()
        for rep in range(1, reps + 1):
            start = time.perf_counter()
            run = TranscribeRun(audio.id, model, level, rep, 0.0)
            try:
                transcript = await transcriber.transcribe(
                    Audio(audio.mime_type, data), principal_key="compare_models"
                )
                run.text = transcript.text
                run.chars = len(transcript.text)
            except TranscribeError as err:
                run.error = err.code
            except Exception as err:  # not expected: the class only
                run.error = describe(err)
            run.latency_s = time.perf_counter() - start
            calls = metering.take()
            run.metrics = calls[-1] if calls else None
            runs.append(run)
            on_run(run)
    return runs


async def probe_prompt_tokens(model: str, inner: LiteLLMClient) -> int | None:
    """Prompt tokens the provider counts for the transcription system prompt plus a one-character
    user turn (a request needs one). No audio, so nothing to subtract."""
    metering = MeteringClient(inner, "low")
    messages = [
        {"role": "system", "content": TRANSCRIBE_PROMPT},
        {"role": "user", "content": "."},
    ]
    with contextlib.suppress(Exception):  # a failure leaves its class in metering.calls
        await metering.acompletion(
            model,
            messages,
            None,
            temperature=0,
            max_tokens=MAX_TOKENS,
            drop_params=True,
            timeout=30,
            num_retries=0,
            max_retries=0,
        )
    calls = metering.take()
    return calls[-1].prompt_tokens if calls else None


def stability(runs: list[TranscribeRun]) -> tuple[int, int, float | None]:
    """(identical pairs, pairs, lowest similarity): each repeat of an (audio, model, level) against
    its first run, over the runs that produced text."""
    first: dict[tuple[str, str, str], str] = {}
    identical = pairs = 0
    lowest: float | None = None
    for run in runs:
        if run.text is None:
            continue
        key = (run.audio_id, run.model, run.level)
        if key not in first:
            first[key] = run.text
            continue
        pairs += 1
        ratio = difflib.SequenceMatcher(None, first[key], run.text).ratio()
        identical += run.text == first[key]
        lowest = ratio if lowest is None else min(lowest, ratio)
    return identical, pairs, lowest


# --- Chat (A): the real agent against an in-memory sheet ------------------------------------------------

SESSIONS = ("Upper", "Lower")
EXERCISES = {
    "Supino reto": "Peito",
    "Remada curvada": "Costas",
    "Rosca direta": "Bíceps",
    "Agachamento": "Pernas",
}
# name -> (kcal, protein g) per 100 g
FOODS = {
    "Arroz branco cozido": (130, 2.5),
    "Frango grelhado": (165, 31.0),
    "Ovo cozido": (155, 13.0),
    "Banana": (89, 1.1),
}
MEALS = [
    "Café da manhã",
    "Lanche da manhã",
    "Almoço",
    "Lanche",
    "Pré-treino",
    "Pós-treino",
    "Jantar",
    "Ceia",
    "Outro",
]
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


class MemorySheet:
    """The sheet API of tools.SheetApi, in memory: same answers' shape as apps/sheet4/src/api.js (the
    catalog is a small subset), validation errors with suggestions for unknown names and dates, and a
    record of every accepted write. Nothing leaves the process."""

    def __init__(
        self,
        today: date,
        *,
        recent_workout: dict[str, Any] | None = None,
        today_diary: dict[str, Any] | None = None,
    ) -> None:
        self.today = today
        self.today_diary = today_diary
        self.writes: list[tuple[str, dict[str, Any]]] = []
        self.ops: list[str] = []
        self.diary: dict[str, dict[str, Any]] = {}
        # (date, session) -> exercise name -> {"name", "work", ...}
        self.workouts: dict[tuple[str, str], dict[str, dict[str, Any]]] = {}
        self.food: dict[tuple[str, str], list[dict[str, Any]]] = {}
        self._seed: list[dict[str, Any]] = []
        if recent_workout is not None:
            day, session = recent_workout["date"], recent_workout["session"]
            self.workouts[(day, session)] = {e["name"]: e for e in recent_workout["exercises"]}
            self._seed.append(
                {
                    "writeId": "w0",
                    "at": f"{day}T14:55:00.000Z",
                    "action": f"Bot: treino {session} {day[8:10]}/{day[5:7]}/{day[:4]}",
                    "op": "workout.upsert",
                    "date": day,
                    "session": session,
                    "exercises": [e["name"] for e in recent_workout["exercises"]],
                }
            )

    # -- helpers
    def _fail(
        self, path: str, code: str, message: str, suggestions: list[str] | None = None
    ) -> dict[str, Any]:
        error: dict[str, Any] = {"path": path, "code": code, "message": message}
        if suggestions:
            error["suggestions"] = suggestions
        return {"ok": False, "errors": [error]}

    def _bad_date(self, value: str, path: str = "args.date") -> dict[str, Any] | None:
        if not isinstance(value, str) or not _DATE.fullmatch(value):
            return self._fail(path, "invalid_date", "use yyyy-MM-dd")
        return None

    def _write(self, op: str, args: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        self.writes.append((op, args))
        return {"ok": True, "result": {**result, "writeId": f"w{len(self.writes)}"}}

    def _recent(self) -> list[dict[str, Any]]:
        made = []
        for i, (op, args) in enumerate(self.writes, start=1):
            if op == "workout.upsert":
                meta = {
                    "op": op,
                    "date": args["date"],
                    "session": args["session"],
                    "exercises": [e["name"] for e in args["exercises"]],
                }
                text = f"Bot: treino {args['session']}"
            elif op == "food.add":
                meta = {"op": op, "date": args["date"], "meal": args["meal"]}
                text = f"Bot: alimentação {args['meal']}"
            else:
                meta = {"op": op, "date": args.get("date")}
                text = f"Bot: {op}"
            made.append({"writeId": f"w{i}", "at": NOW.isoformat(), "action": text, **meta})
        return [*reversed(made), *self._seed]

    # -- reads
    async def catalog(self) -> dict[str, Any]:
        self.ops.append("catalog")
        result: dict[str, Any] = {
            "today": self.today.isoformat(),
            "timezone": TIMEZONE,
            "phase": {"objective": {"name": "Recomposição"}, "goal": {"kcal": 2400, "protein": 160}},
            "sessions": list(SESSIONS),
            "nextSession": SESSIONS[0],
            "lastWorkout": None,
            "todayDiary": self.today_diary,
            "progressionSuggestions": [],
            "exercises": [{"name": n, "group": g} for n, g in EXERCISES.items()],
            "plan": [],
            "foods": list(FOODS),
            "favorites": [],
            "meals": list(MEALS),
            "units": ["g", "ml", "un"],
            "foodLog": ["Não informado", "Parcial", "Completo"],
            "recent": self._recent(),
        }
        return {"ok": True, "result": result}

    async def exercise_history(self, name: str, limit: int | None = None) -> dict[str, Any]:
        self.ops.append("exercise.history")
        return {"ok": True, "result": {"name": name, "sessions": []}}

    async def diary_range(self, date_from: str, date_to: str) -> dict[str, Any]:
        self.ops.append("diary.range")
        days = [{"date": d, **f} for d, f in sorted(self.diary.items()) if date_from <= d <= date_to]
        return {"ok": True, "result": {"from": date_from, "to": date_to, "days": days}}

    async def workout_range(self, date_from: str, date_to: str) -> dict[str, Any]:
        self.ops.append("workout.range")
        return {"ok": True, "result": {"from": date_from, "to": date_to, "sessions": []}}

    async def phase(self, date: str) -> dict[str, Any]:
        self.ops.append("phase.get")
        return {"ok": True, "result": {"date": date}}

    async def week(self, date: str) -> dict[str, Any]:
        self.ops.append("week.get")
        return {"ok": True, "result": {"date": date}}

    # -- writes
    async def upsert_diary(self, date: str, fields: dict[str, Any]) -> dict[str, Any]:
        self.ops.append("diary.upsert")
        if (bad := self._bad_date(date)) is not None:
            return bad
        self.diary.setdefault(date, {}).update(fields)
        return self._write("diary.upsert", {"date": date, "fields": fields}, {"date": date, "fields": fields})

    async def upsert_measures(self, date: str, fields: dict[str, Any]) -> dict[str, Any]:
        self.ops.append("measures.upsert")
        if (bad := self._bad_date(date)) is not None:
            return bad
        return self._write(
            "measures.upsert", {"date": date, "fields": fields}, {"date": date, "fields": fields}
        )

    async def upsert_workout(
        self, date: str, session: str, exercises: list[dict[str, Any]], complete: bool | None = None
    ) -> dict[str, Any]:
        self.ops.append("workout.upsert")
        if (bad := self._bad_date(date)) is not None:
            return bad
        if session not in SESSIONS:
            return self._fail("args.session", "unknown_session", "sessão fora do catálogo", list(SESSIONS))
        for i, ex in enumerate(exercises):
            if ex.get("name") not in EXERCISES:
                return self._fail(
                    f"args.exercises[{i}].name",
                    "unknown_exercise",
                    "exercício fora do catálogo",
                    list(EXERCISES),
                )
        stored = self.workouts.setdefault((date, session), {})
        for ex in exercises:
            stored[ex["name"]] = {**stored.get(ex["name"], {}), **ex}
        args: dict[str, Any] = {"date": date, "session": session, "exercises": exercises}
        if complete is not None:
            args["complete"] = complete
        result = {
            "date": date,
            "session": session,
            "state": "Concluído" if complete else "Parcial",
            "exercises": [{**ex, "previous": None} for ex in exercises],
        }
        return self._write("workout.upsert", args, result)

    async def add_food(self, date: str, meal: str, items: list[dict[str, Any]]) -> dict[str, Any]:
        self.ops.append("food.add")
        if (bad := self._bad_date(date)) is not None:
            return bad
        if meal not in MEALS:
            return self._fail("args.meal", "unknown_meal", "refeição fora da lista", MEALS)
        done: list[dict[str, Any]] = []
        for i, item in enumerate(items):
            name = item.get("food")
            if name is not None and name not in FOODS:
                return self._fail(
                    f"args.items[{i}].food", "unknown_food", "alimento fora do catálogo", list(FOODS)
                )
            qty, unit = item.get("qty"), item.get("unit")
            line: dict[str, Any] = {**item, "food": name or item.get("favorite") or item.get("description")}
            if name is not None and qty and unit in ("g", "ml"):
                kcal, protein = FOODS[name]
                line.update(
                    kcal=round(qty * kcal / 100), protein=round(qty * protein / 100, 1), calc="Calculado"
                )
            else:
                line["calc"] = "Sem cálculo"
            done.append(line)
        self.food.setdefault((date, meal), []).extend(items)
        totals = {"kcal": sum(i["kcal"] for i in done if "kcal" in i)}
        return self._write(
            "food.add",
            {"date": date, "meal": meal, "items": items},
            {"date": date, "meal": meal, "items": done, "totals": totals},
        )

    async def copy_food(self, date_from: str, date_to: str, meal: str | None = None) -> dict[str, Any]:
        self.ops.append("food.copy")
        if (bad := self._bad_date(date_from, "args.from")) is not None:
            return bad
        if (bad := self._bad_date(date_to, "args.to")) is not None:
            return bad
        args: dict[str, Any] = {"from": date_from, "to": date_to}
        if meal is not None:
            args["meal"] = meal
        return self._write("food.copy", args, {"date": date_to, "meal": meal or "Todas", "items": []})


@dataclass(frozen=True)
class ChatCase:
    id: str
    message: str
    expected: str  # in words, for the reader of results.md
    check: Callable[[MemorySheet], str | None]  # None = as expected, else why not
    recent_workout: dict[str, Any] | None = None
    today_diary: dict[str, Any] | None = None


def _only_ops(sheet: MemorySheet, *allowed: str) -> str | None:
    other = sorted({op for op, _ in sheet.writes if op not in allowed})
    return f"gravou {', '.join(other)}" if other else None


def _check_meal_yesterday(sheet: MemorySheet) -> str | None:
    if (extra := _only_ops(sheet, "food.add")) is not None:
        return extra
    got = {
        (args["date"], args["meal"], i.get("food"), i.get("qty"), i.get("unit") or "g")
        for op, args in sheet.writes
        for i in args["items"]
    }
    want = {
        ("2026-11-17", "Jantar", "Frango grelhado", 200, "g"),
        ("2026-11-17", "Jantar", "Arroz branco cozido", 150, "g"),
    }
    if got != want:
        return "itens gravados diferem do esperado (data, refeição, alimento do catálogo, quantidade)"
    return None


def _check_workout(sheet: MemorySheet) -> str | None:
    if (extra := _only_ops(sheet, "workout.upsert")) is not None:
        return extra
    ex = sheet.workouts.get(("2026-11-18", "Upper"), {}).get("Supino reto")
    if ex is None:
        return "nenhum Supino reto gravado em Upper, 2026-11-18"
    work = [(s.get("kg"), s.get("reps"), s.get("rir")) for s in ex.get("work", [])]
    if work != [(80, 8, 2), (80, 7, 1)]:
        return "work sets diferem de 80×8 RIR 2 e 80×7 RIR 1"
    if ex.get("warmup") or ex.get("feeder"):
        return "classificou série como aquecimento ou feeder sem a pessoa dizer"
    return None


def _check_correction(sheet: MemorySheet) -> str | None:
    if not sheet.writes:
        return "não gravou a correção"
    if (extra := _only_ops(sheet, "workout.upsert")) is not None:
        return extra
    if any(args["date"] != "2026-11-18" or args["session"] != "Upper" for _, args in sheet.writes):
        return "gravou em outra data ou sessão que não a da gravação recente"
    ex = sheet.workouts.get(("2026-11-18", "Upper"), {}).get("Supino reto")
    work = [(s.get("kg"), s.get("reps")) for s in (ex or {}).get("work", [])]
    return None if work == [(82, 8)] else "Supino reto não ficou com 82×8"


def _check_nothing_written(sheet: MemorySheet) -> str | None:
    return f"gravou {len(sheet.writes)} vez(es) e não devia" if sheet.writes else None


CASES: tuple[ChatCase, ...] = (
    ChatCase(
        "c1",
        "ontem no jantar comi 200g de frango e 150g de arroz",
        "food.add em 2026-11-17, Jantar: Frango grelhado 200 g e Arroz branco cozido 150 g",
        _check_meal_yesterday,
    ),
    ChatCase(
        "c2",
        "treino upper hoje: supino reto 80 por 8 rir 2 e 80 por 7 rir 1",
        "workout.upsert Upper, 2026-11-18, Supino reto: 80×8 RIR 2 e 80×7 RIR 1",
        _check_workout,
    ),
    ChatCase(
        "c3",
        "na verdade foi 82 por 8 no supino",
        "correção da gravação recente: workout.upsert Upper, 2026-11-18, Supino reto 82×8",
        _check_correction,
        recent_workout={
            "date": "2026-11-18",
            "session": "Upper",
            "exercises": [{"name": "Supino reto", "work": [{"kg": 80, "reps": 8}]}],
        },
    ),
    ChatCase(
        "c4",
        "o que comi hoje?",
        "pergunta: nenhuma gravação",
        _check_nothing_written,
        today_diary={"foodLog": "Parcial"},
    ),
    ChatCase(
        "c5",
        "e mais 3x10 de rosca",
        "ambígua (sem carga, sem gravação recente): nenhuma gravação",
        _check_nothing_written,
    ),
)


@dataclass
class ChatRun:
    case_id: str
    model: str
    level: str
    passed: bool
    reason: str | None
    latency_s: float
    calls: list[CallMetrics]
    tools: list[str]
    error: str | None = None
    answer_failed: bool = False

    def total(self, name: str) -> int | None:
        values = [getattr(c, name) for c in self.calls]
        known = [v for v in values if v is not None]
        return sum(known) if known else None

    @property
    def truncated(self) -> bool:
        return any(c.truncated for c in self.calls)


def format_tool_call(name: str, args: dict[str, Any]) -> str:
    text = f"{name}({json.dumps(args, ensure_ascii=False, separators=(',', ':'))})"
    return text if len(text) <= 200 else text[:197] + "..."


async def run_chat_case(case: ChatCase, model: str, level: str, inner: LiteLLMClient) -> ChatRun:
    """One message through the bot's real agent path (`Bot` and `build_model`, as LLM_MODEL does)."""
    metering = MeteringClient(inner, level)
    sheet = MemorySheet(NOW.date(), recent_workout=case.recent_workout, today_diary=case.today_diary)
    settings = Settings.model_construct(
        LLM_MODEL=model, LLM_RETRIES=0, LLM_RETRY_WAIT_S=0.0, LLM_TIMEOUT_S=CHAT_TIMEOUT_S
    )
    bot = Bot(
        sheet,
        build_model(settings, client=metering),
        TIMEZONE,
        clock=lambda: NOW,
        max_llm_calls=settings.MAX_LLM_CALLS,
    )
    error: str | None = None
    failed = False
    start = time.perf_counter()
    try:
        answer = await bot.reply(case.message)
        failed = answer.failed
    except Exception as err:
        error = describe(err)
    latency = time.perf_counter() - start
    calls = metering.take()
    tools = [format_tool_call(n, a) for c in calls for n, a in c.tool_calls]
    reason = "erro durante a execução" if error else case.check(sheet)
    return ChatRun(
        case.id, model, level, reason is None and not failed, reason, latency, calls, tools, error, failed
    )


# --- Report --------------------------------------------------------------------------------------------


@dataclass
class Report:
    models: list[str]
    levels: list[str]
    today: date
    transcribe: list[TranscribeRun] = field(default_factory=list)
    chat: list[ChatRun] = field(default_factory=list)
    probes: dict[str, int | None] = field(default_factory=dict)
    sent_config: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    audio_count: int = 0
    skipped_audio: int = 0


def sent_config(model: str, level: str) -> dict[str, Any]:
    """The generation parameters LiteLLM maps for the transcription call (offline, no key)."""
    from litellm.utils import get_optional_params

    provider, _, bare = model.partition("/")
    extra: dict[str, Any] = {} if level == DEFAULT_LEVEL else {"reasoning_effort": level}
    try:
        return dict(
            get_optional_params(
                model=bare,
                custom_llm_provider=provider,
                temperature=0,
                max_tokens=MAX_TOKENS,
                drop_params=True,
                **extra,
            )
        )
    except Exception as err:
        return {"error": describe(err)}


def _mean(values: list[float | int | None]) -> float | None:
    known = [v for v in values if v is not None]
    return statistics.fmean(known) if known else None


def _fmt(value: float | int | None, digits: int = 1) -> str:
    if value is None:
        return "n/d"
    return f"{value:.{digits}f}"


def _usd(value: float | None) -> str:
    return "n/d" if value is None else f"US$ {value:.4f}"


def format_table(headers: list[str], rows: list[list[str]]) -> str:
    widths = [max(len(h), *(len(r[i]) for r in rows)) if rows else len(h) for i, h in enumerate(headers)]

    def line(cells: list[str]) -> str:
        return "  ".join(c.ljust(w) for c, w in zip(cells, widths, strict=True)).rstrip()

    return "\n".join([line(headers), line(["-" * w for w in widths]), *(line(r) for r in rows)])


def markdown_table(headers: list[str], rows: list[list[str]]) -> str:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(c.replace("|", "\\|") for c in r) + " |" for r in rows]
    return "\n".join(out)


def _costs(model: str, today: date, prompt: float | None, completion: float | None) -> tuple[str, str]:
    """Cost of an average call at today's price, and at the next scheduled one ("-" if none)."""
    now = estimate_cost(prompt, completion, price_in_effect(model, today))
    later_price = next_price(model, today)
    later = estimate_cost(prompt, completion, later_price)
    return _usd(now), (_usd(later) if later_price else "-")


def transcribe_summary(report: Report) -> tuple[list[str], list[list[str]]]:
    later = next((p for m in report.models if (p := next_price(m, report.today))), None)
    headers = [
        "modelo",
        "thinking",
        "execuções",
        "ok",
        "latência s",
        "prompt tok",
        "completion tok",
        "reasoning tok",
        "cortes",
        "estável",
        "custo/áudio",
        f"custo/áudio desde {later.since}" if later else "custo/áudio (preço futuro)",
    ]
    rows: list[list[str]] = []
    for model in report.models:
        for level in report.levels:
            runs = [r for r in report.transcribe if r.model == model and r.level == level]
            if not runs:
                continue
            metrics = [r.metrics for r in runs if r.metrics is not None]
            prompt = _mean([m.prompt_tokens for m in metrics])
            completion = _mean([m.completion_tokens for m in metrics])
            same, pairs, lowest = stability(runs)
            now, later_cost = _costs(model, report.today, prompt, completion)
            rows.append(
                [
                    model,
                    level,
                    str(len(runs)),
                    str(sum(r.ok for r in runs)),
                    _fmt(_mean([r.latency_s for r in runs]), 2),
                    _fmt(prompt, 0),
                    _fmt(completion, 0),
                    _fmt(_mean([m.reasoning_tokens for m in metrics]), 0),
                    str(sum(r.truncated for r in runs)),
                    f"{same}/{pairs}"
                    + (f" (min {lowest:.2f})" if lowest is not None and same < pairs else ""),
                    now,
                    later_cost,
                ]
            )
    return headers, rows


def chat_summary(report: Report) -> tuple[list[str], list[list[str]]]:
    later = next((p for m in report.models if (p := next_price(m, report.today))), None)
    headers = [
        "modelo",
        "thinking",
        "mensagens",
        "acertos",
        "latência s",
        "prompt tok",
        "completion tok",
        "reasoning tok",
        "cortes",
        "custo/mensagem",
        f"custo/mensagem desde {later.since}" if later else "custo/mensagem (preço futuro)",
    ]
    rows: list[list[str]] = []
    for model in report.models:
        for level in report.levels:
            runs = [r for r in report.chat if r.model == model and r.level == level]
            if not runs:
                continue
            prompt = _mean([r.total("prompt_tokens") for r in runs])
            completion = _mean([r.total("completion_tokens") for r in runs])
            now, later_cost = _costs(model, report.today, prompt, completion)
            rows.append(
                [
                    model,
                    level,
                    str(len(runs)),
                    f"{sum(r.passed for r in runs)}/{len(runs)}",
                    _fmt(_mean([r.latency_s for r in runs]), 2),
                    _fmt(prompt, 0),
                    _fmt(completion, 0),
                    _fmt(_mean([r.total("reasoning_tokens") for r in runs]), 0),
                    str(sum(r.truncated for r in runs)),
                    now,
                    later_cost,
                ]
            )
    return headers, rows


def chat_detail(report: Report) -> tuple[list[str], list[list[str]]]:
    headers = [
        "caso",
        "modelo",
        "thinking",
        "resultado",
        "motivo",
        "ferramentas chamadas",
        "latência s",
        "tokens in/out",
    ]
    rows = []
    for r in report.chat:
        rows.append(
            [
                r.case_id,
                r.model,
                r.level,
                "ok" if r.passed else "FALHOU",
                r.reason or r.error or ("modelo falhou" if r.answer_failed else ""),
                " → ".join(r.tools) or "(nenhuma)",
                _fmt(r.latency_s, 2),
                f"{_fmt(r.total('prompt_tokens'), 0)}/{_fmt(r.total('completion_tokens'), 0)}",
            ]
        )
    return headers, rows


def transcribe_detail(report: Report) -> tuple[list[str], list[list[str]]]:
    headers = [
        "áudio",
        "modelo",
        "thinking",
        "#",
        "resultado",
        "latência s",
        "prompt",
        "texto*",
        "completion",
        "reasoning",
        "finish",
        "custo",
    ]
    rows = []
    for r in report.transcribe:
        m = r.metrics
        cost = estimate_cost(
            m.prompt_tokens if m else None,
            m.completion_tokens if m else None,
            price_in_effect(r.model, report.today),
        )
        rows.append(
            [
                r.audio_id,
                r.model,
                r.level,
                str(r.rep),
                "ok" if r.ok else (r.error or "erro"),
                _fmt(r.latency_s, 2),
                _fmt(m.prompt_tokens if m else None, 0),
                _fmt(r.text_tokens, 0),
                _fmt(m.completion_tokens if m else None, 0),
                _fmt(m.reasoning_tokens if m else None, 0),
                (m.finish_reason or "n/d") if m else "n/d",
                _usd(cost),
            ]
        )
    return headers, rows


def checks_section(report: Report) -> list[str]:
    """The three numbers of the voice work, as lines of text."""
    lines = [f"### 1. TRANSCRIBE_PROMPT_TOKENS = {TRANSCRIBE_PROMPT_TOKENS}", ""]
    for model in report.models:
        text_tokens = [
            r.text_tokens for r in report.transcribe if r.model == model and r.text_tokens is not None
        ]
        probe = report.probes.get(model)
        if text_tokens:
            measured = int(statistics.median(text_tokens))
            lines.append(
                f"- `{model}`: o provedor contou {measured} tokens de texto nas chamadas com áudio "
                f"(`prompt_tokens` − `audio_tokens`, mediana de {len(text_tokens)}): "
                f"{_verdict(measured)}."
            )
        else:
            lines.append(f"- `{model}`: o provedor não informou `audio_tokens`; só a sonda abaixo.")
        if probe is not None:
            lines.append(
                f"  Sonda sem áudio (prompt do sistema + 1 caractere): {probe} tokens, "
                f"{_verdict(probe)} (o caractere de usuário soma 1 a 3 tokens)."
            )
        elif model in report.probes:
            lines.append("  A sonda sem áudio falhou.")
    lines += ["", "### 2. temperature=0", ""]
    for (model, level), cfg in report.sent_config.items():
        lines.append(
            f"- `{model}` thinking `{level}`: LiteLLM monta `{json.dumps(cfg, ensure_ascii=False)}`."
        )
    same, pairs, lowest = stability(report.transcribe)
    if pairs:
        low = f" (menor semelhança {lowest:.3f})" if lowest is not None and same < pairs else ""
        lines.append(
            f"- Saída idêntica em {same} de {pairs} repetições{low}. Igualdade total sustenta que o "
            "valor é respeitado; diferenças não provam o contrário (a decodificação pode não ser "
            "determinística)."
        )
    lines += [
        (
            "- No LiteLLM >= 1.110, `drop_params=True` descarta `temperature` nos modelos "
            "Gemini 3+ (`supports_sampling_params=False`) mantendo `temperature=0` nos demais."
        ),
        "",
        f"### 3. max_tokens = {MAX_TOKENS}",
        "",
        "Com thinking sempre ligado, os tokens de raciocínio contam dentro de `max_tokens`. "
        "`completion` abaixo inclui o raciocínio.",
        "",
    ]
    rows = []
    for model in report.models:
        for level in report.levels:
            runs = [r for r in report.transcribe if r.model == model and r.level == level and r.metrics]
            if not runs:
                continue
            done = [m.completion_tokens for r in runs if (m := r.metrics) and m.completion_tokens is not None]
            peak = max(done, default=None)
            cut = sum(r.truncated for r in runs)
            verdict = "não basta" if cut else ("basta" if peak is not None else "n/d")
            rows.append(
                [
                    model,
                    level,
                    str(len(runs)),
                    str(cut),
                    _fmt(peak, 0),
                    "n/d" if peak is None else str(MAX_TOKENS - peak),
                    verdict,
                ]
            )
    lines.append(
        markdown_table(
            ["modelo", "thinking", "execuções", "cortadas", "maior completion", "folga", "veredito"], rows
        )
    )
    lines += [
        "",
        "Atenção: o `Transcriber` não olha `finish_reason`. Uma resposta cortada passa como transcrição "
        "(texto incompleto) ou, se o raciocínio comeu todo o limite, chega vazia e vira `no_speech`.",
    ]
    return lines


def _verdict(measured: int) -> str:
    diff = measured - TRANSCRIBE_PROMPT_TOKENS
    if abs(diff) <= PROMPT_TOKENS_TOLERANCE:
        prefix = f"diferença {diff:+d} em relação à constante"
        return f"{prefix}, dentro de ±{PROMPT_TOKENS_TOLERANCE}: constante ok"
    return f"diferença {diff:+d} em relação à constante: ajustar para cerca de {measured}"


def render_results(report: Report, generated_at: datetime) -> str:
    th, tr = transcribe_summary(report)
    ch, cr = chat_summary(report)
    cdh, cdr = chat_detail(report)
    tdh, tdr = transcribe_detail(report)
    prices = []
    for model in report.models:
        for p in PRICES.get(model, ()):
            since = "até 2026-12-31" if p.since == date.min else f"desde {p.since}"
            prices.append(
                f"- `{model}` {since}: entrada US$ {p.input_per_m}/M, "
                f"saída (com thinking) US$ {p.output_per_m}/M"
            )
        if model not in PRICES:
            prices.append(f"- `{model}`: sem preço na tabela do script, custo n/d")
    parts = [
        "# Comparação de modelos: resultados",
        "",
        (
            f"Gerado em {generated_at:%Y-%m-%d %H:%M} · "
            f"modelos: {', '.join(f'`{m}`' for m in report.models)} · "
            f"thinking: {', '.join(report.levels)} · {report.audio_count} áudio(s)"
            + (f" (+{report.skipped_audio} ignorado(s) por tamanho)" if report.skipped_audio else "")
        ),
        "",
        "Este arquivo só tem métricas. As transcrições estão em `transcripts.txt`, nesta mesma pasta.",
        "",
        "## Resumo: transcrição (B)",
        "",
        markdown_table(th, tr) if tr else "_não executada_",
        "",
        "## Resumo: chat (A)",
        "",
        markdown_table(ch, cr) if cr else "_não executado_",
        "",
        "## Os três números da C4b",
        "",
        *checks_section(report),
        "",
        "## Detalhe: chat",
        "",
        *[f"- **{c.id}** `{c.message}` → esperado: {c.expected}" for c in CASES],
        "",
        markdown_table(cdh, cdr) if cdr else "_não executado_",
        "",
        "## Detalhe: transcrição",
        "",
        markdown_table(tdh, tdr) if tdr else "_não executada_",
        "",
        "\\* texto = `prompt_tokens` − `audio_tokens` (o prompt do sistema).",
        "",
        "## Preços usados",
        "",
        f"Fonte: {PRICING_SOURCE}.",
        "",
        *prices,
        "",
        (
            "Custo = `prompt_tokens` × entrada + `completion_tokens` × saída; "
            "`completion_tokens` já inclui o raciocínio. Estimativa, não fatura."
        ),
        "",
    ]
    return "\n".join(parts)


# --- Running -----------------------------------------------------------------------------------

# Rough sizes for --dry-run only (a 60 s audio; the agent's instruction, tools and catalog are
# about 5k tokens per model call and a message takes about 3 calls).
ASSUMED_TRANSCRIBE = (2400, 500)
ASSUMED_CHAT = (15_000, 1_500)


def dry_run(args: argparse.Namespace, audios: list[AudioFile], skipped: int, today: date) -> int:
    n_t = len(audios) * args.runs * len(args.models) * len(args.levels) if not args.skip_transcribe else 0
    n_c = len(CASES) * len(args.models) * len(args.levels) if not args.skip_chat else 0
    print(f"áudios: {len(audios)} (ignorados por tamanho: {skipped})")
    print(f"transcrições: {n_t} · mensagens de chat: {n_c} · sondas de prompt: {len(args.models)}")
    for model in args.models:

        def total(price: Price | None) -> float | None:
            per_t = estimate_cost(*ASSUMED_TRANSCRIBE, price)
            per_c = estimate_cost(*ASSUMED_CHAT, price)
            if per_t is None or per_c is None:
                return None
            return (per_t * len(audios) * args.runs + per_c * len(CASES)) * len(args.levels)

        now, later = total(price_in_effect(model, today)), next_price(model, today)
        if now is None:
            print(f"{model}: sem preço na tabela, custo n/d")
            continue
        text = f"{model}: cerca de US$ {now:.2f} hoje"
        if later is not None and (after := total(later)) is not None:
            text += f", US$ {after:.2f} a partir de {later.since}"
        print(text + " (ordem de grandeza, com tamanhos assumidos; nada foi chamado)")
    return 0


@contextmanager
def quiet_loggers() -> Iterator[None]:
    """LiteLLM's loggers and Python warnings off while running (they repeat on every call, and a
    provider error log is the one place a request could be echoed); restored on the way out."""
    loggers = [logging.getLogger(n) for n in ("LiteLLM", "LiteLLM Router", "LiteLLM Proxy")]
    previous = [lg.level for lg in loggers]
    for lg in loggers:
        lg.setLevel(logging.CRITICAL + 1)
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            yield
    finally:
        for lg, level in zip(loggers, previous, strict=True):
            lg.setLevel(level)


def inside_git_repository(path: Path) -> bool:
    resolved = path.resolve()
    return any((p / ".git").exists() for p in [resolved, *resolved.parents])


def parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Mede o Gemini nas duas tarefas do bot (transcrição e chat). Veja compare_models.md."
    )
    parser.add_argument(
        "audio_dir", nargs="?", type=Path, help="pasta com os seus áudios (webm, ogg, m4a, mp3; até 90 s)"
    )
    parser.add_argument(
        "--out",
        type=Path,
        help="pasta de saída (results.md e transcripts.txt), fora de qualquer repositório git",
    )
    parser.add_argument(
        "--models", nargs="+", default=list(DEFAULT_MODELS), help=f"padrão: {' '.join(DEFAULT_MODELS)}"
    )
    parser.add_argument(
        "--levels",
        nargs="+",
        choices=LEVEL_CHOICES,
        default=list(DEFAULT_LEVELS),
        help="nível de thinking (reasoning_effort); 'default' não envia nada, como o bot faz hoje",
    )
    parser.add_argument(
        "--runs",
        type=int,
        default=2,
        help="vezes que cada áudio é transcrito, por modelo e nível (padrão 2)",
    )
    parser.add_argument("--skip-chat", action="store_true")
    parser.add_argument("--skip-transcribe", action="store_true")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="só mostra o plano e a estimativa de custo; não pede a chave nem chama a API",
    )
    return parser.parse_args(argv)


def _fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 2


async def run_all(
    args: argparse.Namespace,
    audios: list[AudioFile],
    skipped: int,
    inner: LiteLLMClient,
    today: date,
    out: Path,
) -> Report:
    report = Report(
        list(args.models), list(args.levels), today, audio_count=len(audios), skipped_audio=skipped
    )
    transcripts = out / "transcripts.txt"

    def on_run(run: TranscribeRun) -> None:
        m = run.metrics
        cost = estimate_cost(
            m.prompt_tokens if m else None,
            m.completion_tokens if m else None,
            price_in_effect(run.model, today),
        )
        print(
            f"  {run.audio_id} {run.model} {run.level} #{run.rep}: {'ok' if run.ok else run.error} "
            f"{run.latency_s:.1f}s tok {_fmt(m.prompt_tokens if m else None, 0)}"
            f"+{_fmt(m.completion_tokens if m else None, 0)} "
            f"finish={(m.finish_reason if m else None) or 'n/d'} {_usd(cost)}",
            flush=True,
        )
        if run.text is not None:
            with transcripts.open("a", encoding="utf-8") as fh:
                fh.write(f"## {run.audio_id} · {run.model} · {run.level} · #{run.rep}\n{run.text}\n\n")

    for model in args.models:
        if not args.skip_transcribe:
            print(f"Transcrição, sonda de prompt: {model}", flush=True)
            report.probes[model] = await probe_prompt_tokens(model, inner)
        for level in args.levels:
            report.sent_config[(model, level)] = sent_config(model, level)
            if not args.skip_transcribe:
                print(f"Transcrição: {model} thinking={level}", flush=True)
                report.transcribe += await transcribe_runs(audios, model, level, args.runs, inner, on_run)
            if not args.skip_chat:
                print(f"Chat: {model} thinking={level}", flush=True)
                for case in CASES:
                    run = await run_chat_case(case, model, level, inner)
                    report.chat.append(run)
                    print(
                        f"  {run.case_id}: {'ok' if run.passed else 'FALHOU'} {run.latency_s:.1f}s "
                        f"tok {_fmt(run.total('prompt_tokens'), 0)}"
                        f"+{_fmt(run.total('completion_tokens'), 0)} "
                        f"ferramentas: {', '.join(t.split('(')[0] for t in run.tools) or '(nenhuma)'}",
                        flush=True,
                    )
    return report


def main(
    argv: list[str] | None = None, *, inner: LiteLLMClient | None = None, today: date | None = None
) -> int:
    args = parse_args(argv)
    today = today or datetime.now(UTC).astimezone(ZoneInfo(TIMEZONE)).date()
    audios: list[AudioFile] = []
    skipped = 0
    if not args.skip_transcribe:
        if args.audio_dir is None or not args.audio_dir.is_dir():
            return _fail("Informe a pasta de áudios (AUDIO_DIR) ou use --skip-transcribe.")
        audios, skipped = discover_audio(args.audio_dir)
        if not audios:
            return _fail("Nenhum áudio webm, ogg, m4a ou mp3 (até 5 MB) na pasta.")
    if args.runs < 1:
        return _fail("--runs precisa ser pelo menos 1.")
    if args.dry_run:
        return dry_run(args, audios, skipped, today)
    if args.out is None:
        return _fail("Informe --out, a pasta onde ficam results.md e transcripts.txt.")
    if inside_git_repository(args.out):
        return _fail(
            "--out está dentro de um repositório git. O repositório é público: use uma pasta fora dele."
        )
    if not os.environ.get(KEY_VARIABLE, "").strip():
        return _fail(
            f"{KEY_VARIABLE} não está definida. Defina-a no terminal (a chave nunca é salva nem impressa)."
        )
    try:
        for model in args.models:
            TranscribeSettings(TRANSCRIBE_MODEL=model)
    except ValueError:
        return _fail("Modelo inválido para a transcrição: use gemini/<modelo> ou vertex_ai/<modelo>.")
    # The bot's own log safety: masks the key and keeps the content of ADK, LiteLLM and httpx records out
    # of any log line (a provider error can echo the request, key included).
    logs.register_secrets([os.environ[KEY_VARIABLE]])
    logs.install()
    args.out.mkdir(parents=True, exist_ok=True)
    # The key to the ids a01, a02...: the file names stay in this local file only.
    names = "".join(f"{a.id} = {a.path.name}\n" for a in audios)
    (args.out / "transcripts.txt").write_text(names + "\n", encoding="utf-8")

    with quiet_loggers():
        report = asyncio.run(run_all(args, audios, skipped, inner or LiteLLMClient(), today, args.out))

    (args.out / "results.md").write_text(render_results(report, datetime.now()), encoding="utf-8")
    print()
    for title, (headers, rows) in (
        ("Transcrição", transcribe_summary(report)),
        ("Chat", chat_summary(report)),
    ):
        if rows:
            print(f"{title}\n{format_table(headers, rows)}\n")
    print(f"Resultados: {args.out / 'results.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
