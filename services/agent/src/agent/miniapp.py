"""Telegram Mini App (treino and refeição forms) without the model.

Two directions, see docs/specs/2026-11-09-miniapp-design.md:

* bot → page: `keyboard_markup` turns the sheet's catalog into a reply keyboard whose two web_app
  buttons carry the catalog in the URL fragment (raw deflate + base64url).
* page → bot: `handle` validates the `web_app_data` payload with strict pydantic models that
  mirror apps/sheet4/src/api_validator.js (workoutUpsert / foodAdd), calls the sheet and builds the
  confirmation from the sheet's response only.

Where this file and api_validator.js disagree, the validator wins (the sheet is the last gate).
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import math
import re
import secrets
import threading
import time
import unicodedata
import zlib
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date
from typing import Annotated, Any, ClassVar, Literal, Protocol

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Discriminator,
    Field,
    Tag,
    TypeAdapter,
    ValidationError,
    ValidationInfo,
    field_validator,
    model_validator,
)

from agent import buttons
from agent.commands import Reply
from agent.sheet_client import request_id_scope
from agent.summary import confirmation
from agent.tools import OUTAGE_CODES

log = logging.getLogger(__name__)

MAX_PAYLOAD_BYTES = 4096
MINIAPP_URL_MAX = 4096
MIN_DATE = "2000-01-01"  # Dates.MIN_KEY
MEASUREMENTS = ("Pesada", "Rótulo", "Estimada")
WORKOUT_BUTTON = "🏋️ Treino"
FOOD_BUTTON = "🍽️ Refeição"
NOTHING_SAVED = "⚠ Não gravei nada:"
DROPPED_LABELS = {"l": "últimas cargas", "p": "prescrições", "foods": "lista de alimentos"}

_STRICT = ConfigDict(extra="forbid", strict=True)
_DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}")


# ---- field types (the checks of ApiChecker_.value) ----------------------------------------------


FORMULA_FREE = "=+-@"  # a cell starting with one of these may be run as a formula by the sheet
FORMULA_NAME = "=+@"  # catalogue names: the sheet matches them, so only the sure formulas are refused


def _text(max_length: int, *, name: bool = False) -> Callable[[str], str]:
    """Check for non-empty text of at most `max_length` characters that cannot be read as a formula.
    `name`: a catalogue name or session (the sheet also matches it); a leading "-" is left to it."""
    bad = FORMULA_NAME if name else FORMULA_FREE

    def check(value: str) -> str:
        if not value.strip():
            raise ValueError("texto vazio; omita o campo")
        if len(value) > max_length:
            raise ValueError(f"máximo {max_length} caracteres, recebido {len(value)}")
        if value.lstrip()[0] in bad:
            raise ValueError(f"texto não pode começar com {_listing(bad)}")
        return value

    return check


def _listing(chars: str) -> str:
    return ", ".join(chars[:-1]) + " ou " + chars[-1]


def _range(low: float, high: float):
    def check(value: int | float) -> int | float:
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("esperado número finito")
        if not low <= value <= high:
            raise ValueError(f"deve estar entre {low:g} e {high:g}, recebido {value:g}")
        return value

    return check


def _whole(value: Any) -> Any:
    """A whole JSON number: 8.0 counts as 8 (Number.isInteger in the validator)."""
    return int(value) if isinstance(value, float) and value.is_integer() else value


# Numbers are JSON numbers (no bool, no string); ints stay ints.
Name = Annotated[str, AfterValidator(_text(10_000, name=True))]  # the sheet matches it; no length limit there
Meal = Annotated[str, AfterValidator(_text(60))]
Note = Annotated[str, AfterValidator(_text(200))]
Equipment = Annotated[str, AfterValidator(_text(100))]
Unit = Annotated[str, AfterValidator(_text(20))]
Kg = Annotated[int | float, AfterValidator(_range(0, 1000))]
Reps = Annotated[int, BeforeValidator(_whole), AfterValidator(_range(1, 100))]
Rir = Annotated[int | float, AfterValidator(_range(0, 10))]
Pain = Annotated[int, BeforeValidator(_whole), AfterValidator(_range(0, 10))]
Qty = Annotated[int | float, AfterValidator(_range(0.001, 100000))]
Portions = Annotated[int | float, AfterValidator(_range(0.01, 50))]


class _Model(BaseModel):
    """Strict model. A value that is present is never null (absent is not null), as in the
    validator, where only work[].rir may be null."""

    model_config = _STRICT
    NULLABLE: ClassVar[frozenset[str]] = frozenset()

    @field_validator("*", mode="before")
    @classmethod
    def _no_null(cls, value: Any, info: ValidationInfo) -> Any:
        if value is None and info.field_name not in cls.NULLABLE:
            raise ValueError("null não é aceito; omita o campo")
        return value


class WarmupSet(_Model):
    kg: Kg
    reps: Reps


class WorkSet(WarmupSet):
    # The validator checks rir as a number (0..10), not an integer; null means "not informed".
    NULLABLE: ClassVar[frozenset[str]] = frozenset({"rir"})
    rir: Rir | None = None


class Exercise(_Model):
    name: Name
    work: Annotated[list[WorkSet], Field(min_length=1, max_length=2)]
    warmup: WarmupSet | None = None
    feeder: WarmupSet | None = None
    pain: Pain | None = None
    note: Note | None = None
    equipment: Equipment | None = None


def _check_date(value: str, info: ValidationInfo) -> str:
    ok = False
    if _DATE_RE.fullmatch(value):
        try:
            ok = date.fromisoformat(value).isoformat() == value and value >= MIN_DATE
        except ValueError:
            ok = False
    if not ok:
        raise ValueError(f"data inválida {value!r}; use yyyy-MM-dd (a partir de {MIN_DATE})")
    today = (info.context or {}).get("today")
    if today is not None and value > today.isoformat():
        raise ValueError(f"data {value} é depois de hoje ({today.isoformat()})")
    return value


Day = Annotated[str, AfterValidator(_check_date)]


class WorkoutArgs(_Model):
    date: Day
    session: Name
    exercises: list[Exercise]
    complete: bool = False

    @model_validator(mode="after")
    def _count(self) -> WorkoutArgs:
        low = 0 if self.complete is True else 1
        if not low <= len(self.exercises) <= 15:
            raise ValueError(f"exercises deve ter entre {low} e 15 itens, recebido {len(self.exercises)}")
        seen: list[str] = []
        for i, ex in enumerate(self.exercises):
            key = _normalize(ex.name)
            if key in seen:
                raise ValueError(
                    f"exercises[{i}].name: exercício repetido ({ex.name}); junte as séries num só item"
                )
            seen.append(key)
        return self


class FoodItem(_Model):
    food: Name
    qty: Qty
    unit: Unit | None = None
    measure: Literal["Pesada", "Rótulo", "Estimada"] | None = None
    note: Note | None = None


class FavoriteItem(_Model):
    favorite: Name
    portions: Portions | None = None


class DescriptionItem(_Model):
    description: Note
    qty: Qty | None = None
    unit: Unit | None = None
    note: Note | None = None


def _item_tag(value: Any) -> str | None:
    """Which form an item takes; None (error) unless exactly one of food/favorite/description."""
    if not isinstance(value, dict):
        return None
    forms = [k for k in ("food", "favorite", "description") if k in value]
    return f"item_{forms[0]}" if len(forms) == 1 else None


Item = Annotated[
    Annotated[FoodItem, Tag("item_food")]
    | Annotated[FavoriteItem, Tag("item_favorite")]
    | Annotated[DescriptionItem, Tag("item_description")],
    Discriminator(_item_tag),
]


class FoodArgs(_Model):
    date: Day
    meal: Meal
    items: Annotated[list[Item], Field(min_length=1, max_length=20)]

    @field_validator("meal")
    @classmethod
    def _trim(cls, value: str) -> str:
        return value.strip()


class _Versioned(_Model):
    @field_validator("v", mode="before", check_fields=False)
    @classmethod
    def _not_a_bool(cls, value: Any) -> Any:
        if isinstance(value, bool):  # True == 1 for a Literal[1]
            raise ValueError("versão não suportada; esperado 1")
        return value


_SUBMISSION_RE = re.compile(r"[0-9a-f]{32}")


def _check_submission(value: str) -> str:
    if not _SUBMISSION_RE.fullmatch(value):
        raise ValueError("id do envio inválido; esperado 32 caracteres hexadecimais minúsculos")
    return value


# The page's id of one draft (random, 128 bits): kept with the draft and with the "last sent"
# history, so restoring and resending reaches the sheet under the same request id.
SubmissionId = Annotated[str, AfterValidator(_check_submission)]


class WorkoutPayload(_Versioned):
    v: Literal[1]
    t: Literal["workout"]
    id: SubmissionId
    args: WorkoutArgs


class FoodPayload(_Versioned):
    v: Literal[1]
    t: Literal["food"]
    id: SubmissionId
    args: FoodArgs


Payload = WorkoutPayload | FoodPayload


def _payload_tag(value: Any) -> str | None:
    t = value.get("t") if isinstance(value, dict) else None
    return t if t in ("workout", "food") else None


# Tagged by a function, not a field: the `t` field itself takes no before-validators.
_PAYLOAD = TypeAdapter(
    Annotated[
        Annotated[WorkoutPayload, Tag("workout")] | Annotated[FoodPayload, Tag("food")],
        Discriminator(_payload_tag),
    ]
)


# ---- parsing --------------------------------------------------------------------------------------


def _normalize(text: str) -> str:
    plain = "".join(c for c in unicodedata.normalize("NFD", text) if not unicodedata.combining(c))
    return " ".join(plain.lower().split())


def _path(loc: tuple[int | str, ...]) -> str:
    out = ""
    for i, part in enumerate(loc):
        if isinstance(part, int):
            out += f"[{part}]"
        elif (i == 0 and part in ("workout", "food")) or part == "float" or part.startswith("item_"):
            continue  # union tags, not fields
        else:
            out += f".{part}" if out else part
    return out


def _message(error: Any) -> str:
    kind = error["type"]
    ctx = error.get("ctx") or {}
    if kind == "extra_forbidden":
        return "campo desconhecido"
    if kind == "missing":
        return "campo obrigatório"
    if kind in ("int_type", "int_parsing", "int_from_float"):
        return f"esperado número inteiro (JSON, ponto decimal), recebido {_show(error.get('input'))}"
    if kind in ("float_type", "float_parsing", "finite_number"):
        return f"esperado número (JSON, ponto decimal), recebido {_show(error.get('input'))}"
    if kind == "string_type":
        return f"esperado texto, recebido {_show(error.get('input'))}"
    if kind == "bool_type":
        return f"esperado booleano true/false, recebido {_show(error.get('input'))}"
    if kind in ("greater_than_equal", "less_than_equal"):
        return f"fora do intervalo permitido, recebido {_show(error.get('input'))}"
    if kind in ("too_short", "too_long"):
        low, high = ctx.get("min_length"), ctx.get("max_length")
        return f"quantidade de itens fora do permitido ({low if low is not None else 0} a {high})"
    if kind in ("literal_error", "union_tag_invalid", "union_tag_not_found"):
        if kind != "literal_error" and ctx.get("discriminator") == "_payload_tag()":
            return "t deve ser workout ou food"
        if kind != "literal_error":
            return "cada item tem exatamente um de: food (+ qty), favorite ou description"
        return f"valor inválido {_show(error.get('input'))}; aceitos: {ctx.get('expected', '')}"
    if kind in ("model_type", "dict_type"):
        return f"esperado objeto, recebido {_show(error.get('input'))}"
    if kind in ("list_type", "tuple_type"):
        return f"esperado lista, recebido {_show(error.get('input'))}"
    if kind == "value_error":
        return str(ctx.get("error", error["msg"])).removeprefix("Value error, ")
    return error["msg"]


def _show(value: Any) -> str:
    text = json.dumps(value, ensure_ascii=False, default=str)
    return text if len(text) <= 60 else text[:57] + "..."


def parse_payload(raw: str, today: date) -> tuple[Payload | None, list[str]]:
    """(payload, []) or (None, readable PT-BR error lines). Nothing is coerced."""
    if len(raw.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        return None, [f"dados passam de {MAX_PAYLOAD_BYTES} bytes"]
    try:
        data = json.loads(raw)
    except ValueError:
        return None, ["os dados do formulário não são um JSON válido"]
    if not isinstance(data, dict):
        return None, ["os dados do formulário devem ser um objeto"]
    try:
        return _PAYLOAD.validate_python(data, context={"today": today}), []
    except ValidationError as err:
        lines = []
        for e in err.errors():
            if e["loc"] and e["loc"][-1] == "int":  # the `int | float` union reports the same value twice
                continue
            path = _path(e["loc"]) or "(raiz)"
            lines.append(f"{path}: {_message(e)}")
        return None, lines


def request_id(chat_id: int | None, submission: str, op: str) -> str | None:
    """The sheet's idempotency key: one page draft (chat, draft id) is one write however often
    it arrives (retry tap, or a restored resend after a bot restart). The args are not part of
    it on purpose: a restored draft resent with different content is refused by the sheet
    (requestId conflict) instead of becoming a second, slightly different row. A fresh draft has
    a fresh id, so the same meal logged twice on purpose is two writes."""
    if chat_id is None:
        return None
    return f"tg:{chat_id}:miniapp:{op}:{submission}"


ALREADY_SAVED = (
    "⚠ Não gravei nada: este formulário já foi enviado antes, com outro conteúdo. Confira o que está "
    "registrado com /hoje (ou /hoje e a data). Para registrar esta versão, limpe o formulário e "
    "preencha de novo. Se a versão anterior ainda estiver na planilha e for para trocar: use /desfazer "
    "antes, mas só se ela foi a última gravação; senão, corrija direto na planilha."
)


# ---- page → bot -----------------------------------------------------------------------------------


class MiniappSheet(Protocol):
    async def upsert_workout(
        self, date: str, session: str, exercises: list[dict[str, Any]], complete: bool | None = None
    ) -> dict[str, Any]: ...
    async def add_food(self, date: str, meal: str, items: list[dict[str, Any]]) -> dict[str, Any]: ...


RETRY_DELAYS: tuple[float, ...] = (0.5, 1.5)  # pauses between the 3 attempts at one sheet call
PENDING_MAX = 20
PENDING_TTL_S = 24 * 3600
UNAVAILABLE = "⚠ Planilha indisponível, nada confirmado."
EXPIRED = (
    "Esse botão expirou. Para conferir se entrou, abra o formulário, toque em “Restaurar último envio” "
    "e envie de novo sem mudar nada: se já tiver sido gravado, a planilha não grava duas vezes."
)


@dataclass(frozen=True)
class Pending:
    """A validated write the sheet could not take: replayed with the same request_id, so the
    sheet's requestId dedup keeps it from landing twice if the first attempt got through.
    Only the chat that sent it can replay it."""

    op: str
    args: dict[str, Any]
    request_id: str | None
    chat_id: int | None


class PendingStore:
    """Bounded, in-memory (per process) store of writes waiting for a retry tap."""

    def __init__(
        self,
        max_size: int = PENDING_MAX,
        ttl_s: float = PENDING_TTL_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max = max_size
        self._ttl = ttl_s
        self._clock = clock
        self._items: OrderedDict[str, tuple[float, Pending]] = OrderedDict()
        self._lock = threading.Lock()

    def put(self, pending: Pending) -> str:
        with self._lock:
            self._purge()
            key = secrets.token_urlsafe(6)
            self._items[key] = (self._clock() + self._ttl, pending)
            while len(self._items) > self._max:
                self._items.popitem(last=False)
            return key

    def get(self, key: str, chat_id: int | None) -> Pending | None:
        """The write behind `key`, only for the chat that created it (None otherwise)."""
        with self._lock:
            self._purge()
            item = self._items.get(key)
            if item is None or chat_id is None or item[1].chat_id != chat_id:
                return None
            return item[1]

    def discard(self, key: str) -> None:
        with self._lock:
            self._items.pop(key, None)

    def _purge(self) -> None:
        now = self._clock()
        for key in [k for k, (until, _) in self._items.items() if until <= now]:
            del self._items[key]


def _outage(response: dict[str, Any]) -> bool:
    errors = response.get("errors")
    return response.get("ok") is False and any(
        isinstance(e, dict) and str(e.get("code", "")) in OUTAGE_CODES
        for e in (errors if isinstance(errors, list) else [])
    )


async def _write(sheet: MiniappSheet, pending: Pending) -> dict[str, Any]:
    """The sheet call, up to 3 attempts while the sheet is unavailable, all with one request_id."""
    response: dict[str, Any] = {}
    for attempt in range(len(RETRY_DELAYS) + 1):
        if attempt:
            await asyncio.sleep(RETRY_DELAYS[attempt - 1])
        args = pending.args
        with request_id_scope(pending.request_id):
            if pending.op == "workout.upsert":
                response = await sheet.upsert_workout(
                    args["date"], args["session"], args["exercises"], args.get("complete")
                )
            else:
                response = await sheet.add_food(args["date"], args["meal"], args["items"])
        if not _outage(response):
            break
    return response


def retry_markup(key: str) -> dict[str, Any]:
    return {"inline_keyboard": [[{"text": "🔁 Tentar de novo", "callback_data": f"{buttons.RETRY}:{key}"}]]}


async def _run(sheet: MiniappSheet, pending: Pending, store: PendingStore | None) -> Reply:
    response = await _write(sheet, pending)
    if _outage(response):
        markup = retry_markup(store.put(pending)) if store is not None else None
        return Reply(UNAVAILABLE, reply_markup=markup, failed=True, transient=True)
    return reply_for(pending.op, response)


async def handle(
    sheet: MiniappSheet,
    raw: str,
    chat_id: int | None,
    today: date,
    pending: PendingStore | None = None,
) -> Reply:
    payload, problems = parse_payload(raw, today)
    if payload is None:
        return Reply("\n".join([NOTHING_SAVED, *(f"• {p}" for p in problems)]))
    # What the page sent, now validated field by field (extra="forbid": nothing else is in there).
    args = json.loads(raw)["args"]
    op = "workout.upsert" if isinstance(payload, WorkoutPayload) else "food.add"
    key = request_id(chat_id, payload.id, op)
    return await _run(sheet, Pending(op, args, key, chat_id), pending)


async def retry(sheet: MiniappSheet, key: str, store: PendingStore, chat_id: int | None) -> Reply:
    """The 🔁 button: replays the stored write with its original request_id, in its own chat only."""
    pending = store.get(key, chat_id)
    if pending is None:
        return Reply(EXPIRED)
    reply = await _run(sheet, pending, None)
    if not reply.transient:
        store.discard(key)
    return reply


def reply_for(op: str, response: dict[str, Any]) -> Reply:
    if not response.get("ok"):
        errors = [e for e in (response.get("errors") or []) if isinstance(e, dict)]
        if any(str(e.get("code", "")) in OUTAGE_CODES for e in errors):
            return Reply(UNAVAILABLE, failed=True, transient=True)
        if any(e.get("path") == "requestId" and e.get("code") == "conflict" for e in errors):
            return Reply(ALREADY_SAVED, failed=True)
        lines = [NOTHING_SAVED]
        for e in errors:
            line = f"• {e.get('path') or '(raiz)'}: {e.get('message', '')}"
            if e.get("suggestions"):
                line += f" Você quis dizer: {', '.join(str(s) for s in e['suggestions'])}"
            lines.append(line)
        return Reply("\n".join(lines), failed=True)
    result = response.get("result") or {}
    try:
        text = "\n".join(confirmation([(op, result)]))
    except (KeyError, TypeError, ValueError):
        log.exception("could not build the confirmation of %s", op)
        return Reply("✅ A planilha aceitou, mas não consegui montar o resumo. Confira com /hoje.")
    write_id = result.get("writeId")
    markup = buttons.keyboard([write_id]) if write_id else None
    return Reply(text, html=True, reply_markup=markup)


# ---- bot → page -----------------------------------------------------------------------------------


def _names(values: Any) -> list[str]:
    return [v for v in values if isinstance(v, str) and v] if isinstance(values, list) else []


WEEK_GROUPS_MAX = 20


def _week(values: Any) -> list[list[Any]]:
    """`recentGroups` as [[group, work sets]] for the body map; anything malformed is left out."""
    out: list[list[Any]] = []
    for row in values if isinstance(values, list) else []:
        if not isinstance(row, dict):
            continue
        group, sets = row.get("group"), row.get("sets")
        if isinstance(group, str) and group and type(sets) is int and sets > 0:
            out.append([group, sets])
    return out[:WEEK_GROUPS_MAX]


def catalog_v1(result: dict[str, Any]) -> dict[str, Any]:
    """The catalog the page receives (short keys, empty fields omitted) from `catalog` result."""
    out: dict[str, Any] = {"v": 1}
    client = result.get("client")
    pairs = (
        ("today", result.get("today")),
        ("tz", result.get("timezone")),
        ("client", client.get("name") if isinstance(client, dict) else None),
        ("next", result.get("nextSession")),
        ("sessions", _names(result.get("sessions"))),
    )
    out.update({k: v for k, v in pairs if v})
    plan = []
    for row in result.get("plan") or []:
        if not isinstance(row, dict) or not row.get("exercise"):
            continue
        last = row.get("lastWork")
        item = {
            "s": row.get("session"),
            "e": row.get("exercise"),
            "g": row.get("group"),
            "p": row.get("prescription"),
            "l": last.get("text") if isinstance(last, dict) else None,
        }
        plan.append({k: v for k, v in item.items() if v})
    if plan:
        out["plan"] = plan
    exercises = [
        [e["name"], e.get("group") or ""]
        for e in result.get("exercises") or []
        if isinstance(e, dict) and e.get("name")
    ]
    for key, value in (
        ("ex", exercises),
        ("wk", _week(result.get("recentGroups"))),
        ("foods", _names(result.get("foods"))),
        ("fav", _names(result.get("favorites"))),
        ("meals", _names(result.get("meals"))),
        ("units", _names(result.get("units"))),
    ):
        if value:
            out[key] = value
    return out


def encode_catalog(catalog: dict[str, Any]) -> str:
    compact = json.dumps(catalog, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    deflate = zlib.compressobj(9, zlib.DEFLATED, -15)
    packed = deflate.compress(compact) + deflate.flush()
    return base64.urlsafe_b64encode(packed).rstrip(b"=").decode("ascii")


def _trim(catalog: dict[str, Any], key: str) -> bool:
    """Drops `key` (`l`/`p` of every plan row, or the top-level `foods`); True if it changed."""
    if key == "foods":
        return catalog.pop("foods", None) is not None
    changed = False
    for row in catalog.get("plan") or []:
        changed = row.pop(key, None) is not None or changed
    return changed


class CatalogTooLarge(ValueError):
    """Even without last works, prescriptions and foods the URL does not fit."""

    def __init__(self, length: int, max_len: int) -> None:
        super().__init__(f"link de {length} caracteres, máximo {max_len}")
        self.length = length
        self.max_len = max_len


def keyboard_markup(
    miniapp_url: str, catalog_result: dict[str, Any], max_len: int = MINIAPP_URL_MAX
) -> tuple[dict[str, Any], list[str]]:
    """(reply keyboard, dropped): the two web_app buttons with the catalog in the fragment, trimmed
    (last works, then prescriptions, then foods) until the longest URL fits `max_len`;
    raises CatalogTooLarge when it still does not."""
    catalog = catalog_v1(catalog_result)
    dropped: list[str] = []

    def urls() -> tuple[str, str]:
        blob = encode_catalog(catalog)
        return f"{miniapp_url}#v=workout&c={blob}", f"{miniapp_url}#v=food&c={blob}"

    for key in ("l", "p", "foods"):
        if max(len(u) for u in urls()) <= max_len:
            break
        if _trim(catalog, key):
            dropped.append(key)
    workout_url, food_url = urls()
    longest = max(len(workout_url), len(food_url))
    if longest > max_len:
        raise CatalogTooLarge(longest, max_len)
    markup = {
        "keyboard": [
            [
                {"text": WORKOUT_BUTTON, "web_app": {"url": workout_url}},
                {"text": FOOD_BUTTON, "web_app": {"url": food_url}},
            ]
        ],
        "is_persistent": True,
        "resize_keyboard": True,
    }
    return markup, dropped
