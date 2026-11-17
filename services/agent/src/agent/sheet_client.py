"""Client for the Apps Script sheet API (sheet 4.0: apps/sheet4/src/api.js).

Every call returns the API body as-is: {"ok": true, "result": ...} or {"ok": false, "errors": [...]}.
Failures to reach the API are folded into the same shape with code "unavailable", so callers
(the agent's tools) handle one format only.

A mutating call (MUTATING_OPS) also has an outcome, read from its response with `write_outcome`:
`committed`, `not_committed` or `uncertain`. `not_committed` only when the failure is proven to
happen before any write; every other failure is `uncertain`, comes back as the single error
"write_uncertain" and is never retried here (docs/specs/2026-11-14-voice-input-design.md, §4.3).
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any, Literal

import httpx

from agent.logs import describe, safe_code

log = logging.getLogger(__name__)

Response = dict[str, Any]

WriteOutcome = Literal["committed", "not_committed", "uncertain"]

# Every other op is a read and keeps "unavailable" for any failure.
MUTATING_OPS = frozenset(
    {"diary.upsert", "workout.upsert", "food.add", "food.copy", "measures.upsert", "write.undo"}
)

# Error codes the Web App produces only before a write begins, each with where it is born in
# apps/sheet4/src. The list is closed: `rejected`, `internal`, `invalid`, the migration guards and
# any code not listed here can follow a write (a listener that throws after the commit, a rollback
# whose revert failed), so they are `uncertain`. Adding a code needs the same proof and its name in
# tests/test_write_outcome.py.
PRE_WRITE_CODES = frozenset(
    {
        "invalid_json",  # api.js:137, body parse in SheetApi.handle
        "unauthorized",  # api.js:148, key check in handle
        "unknown_op",  # api.js:163, op lookup in SheetApi.run
        # api.js:140, 151 (envelope), validateRequestId_ (api.js:206-217) and ApiValidator
        "wrong_type",
        "unknown_field",
        "empty",
        "too_long",
        # ApiValidator (api_validator.js) only; returned, never thrown, by exec at api.js:168
        "required",
        "out_of_range",
        "invalid_date",
        "date_in_future",
        "invalid_range",
        "not_in_catalog",
        "incomplete_food",
        "duplicate",
        "invalid_unit",
        # api.js:177 (request id used by another write) and core_log.js:376 (undo conflict, thrown
        # before the first revert at core_log.js:378)
        "conflict",
        # core_log.js:337, 348-350, thrown by Undo.last / Undo.action before Undo.apply_
        "nothing_to_undo",
        "not_found",
        "already_undone",
        "not_latest",
        # core_log.js:40, the script lock was not taken, before exec runs (api.js:197); also what
        # this client answers when the request provably never reached doPost
        "unavailable",
    }
)

UNCERTAIN_CODE = "write_uncertain"

# Statuses Google's front end answers to the POST itself, before doPost runs: malformed, access,
# unknown deployment, method, size.
_PRE_SCRIPT_STATUSES = frozenset({400, 401, 403, 404, 405, 413, 414, 415})

# No connection was made, so nothing was sent.
_NOT_SENT = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout, httpx.UnsupportedProtocol)

_UNCERTAIN_MESSAGE = (
    "não sei se a planilha gravou: a resposta não chegou ou veio com erro depois de a gravação "
    "começar. Não repita nem refaça esta gravação; diga que ela pode ter entrado na planilha."
)


def write_outcome(response: Response) -> WriteOutcome:
    """The outcome of a mutating call, from the sheet's body or from what `SheetClient` returned.

    `ok: true` is `committed`. `ok: false` is `not_committed` only with `writeState: "none"`, or
    with no `writeState` and every error's code in PRE_WRITE_CODES. Anything else is `uncertain`."""
    ok = response.get("ok")
    if ok is True:
        return "committed"
    if ok is not False:
        return "uncertain"
    if "writeState" in response:
        # Sent only by a sheet with task S1: "none" is its proof that nothing remains written, and
        # "unknown" wins even over a pre-write code.
        return "not_committed" if response["writeState"] == "none" else "uncertain"
    errors = response.get("errors")
    if not isinstance(errors, list) or not errors:
        return "uncertain"
    for error in errors:
        code = error.get("code") if isinstance(error, dict) else None
        if not isinstance(code, str) or code not in PRE_WRITE_CODES:
            return "uncertain"
    return "not_committed"


def settle_write(response: Response) -> Response:
    """What a caller sees of a mutating call: the response itself when its outcome is proven, and
    the single "write_uncertain" error otherwise, so the sheet's own errors are not read as a
    refusal to fix and retry."""
    return _uncertain() if write_outcome(response) == "uncertain" else response


_current_request_id: ContextVar[str | None] = ContextVar("sheet_request_id", default=None)


@contextmanager
def request_id_scope(request_id: str | None) -> Iterator[None]:
    """Binds a deterministic requestId to SheetClient calls made inside the block."""
    token = _current_request_id.set(request_id)
    try:
        yield
    finally:
        _current_request_id.reset(token)


def current_request_id() -> str | None:
    return _current_request_id.get()


def _rejected_request_id(body: Response) -> bool:
    if body.get("ok") is not False:
        return False
    errors = body.get("errors")
    if not isinstance(errors, list):
        return False
    return any(
        isinstance(e, dict) and e.get("path") == "requestId" and e.get("code") == "unknown_field"
        for e in errors
    )


class SheetClient:
    def __init__(self, url: str, key: str, http: httpx.AsyncClient) -> None:
        self._url = url
        self._key = key
        self._http = http

    async def call(self, op: str, args: dict[str, Any], *, request_id: str | None = None) -> Response:
        # Apps Script answers a POST with a 302 to script.googleusercontent.com, whose GET holds
        # the body; following redirects is part of the protocol, not a fallback.
        effective_id = request_id if request_id is not None else _current_request_id.get()
        payload: dict[str, Any] = {"key": self._key, "op": op, "args": args}
        if effective_id:
            payload["requestId"] = effective_id
        if op not in MUTATING_OPS:
            body = await self._post(payload)
            if effective_id and _rejected_request_id(body):
                log.warning("sheet Web App rejected requestId (unknown_field); retrying without requestId")
                body = await self._post({"key": self._key, "op": op, "args": args})
            return body
        body = await self._post(payload, mutating=True)
        # An older sheet deployment refuses the field before anything else; the retry is a second
        # request with its own outcome. A refusal that is not proven (mixed codes, writeState) is
        # uncertain like any other and is not retried.
        if effective_id and _rejected_request_id(body) and write_outcome(body) == "not_committed":
            log.warning("sheet Web App rejected requestId (unknown_field); retrying without requestId")
            body = await self._post({"key": self._key, "op": op, "args": args}, mutating=True)
        if write_outcome(body) != "uncertain":
            return body
        if "errors" in body and not _is_uncertain_envelope(body):
            log.warning("sheet write %s answered ok=false with %s: uncertain", op, _codes(body))
        return _uncertain()

    async def _post(self, payload: dict[str, Any], *, mutating: bool = False) -> Response:
        """One POST (and the GET of its redirect). For a read every failure is "unavailable"; for
        a write only the failures proven to precede doPost are, and the rest is "write_uncertain"
        (the transport table of §4.3.1)."""
        # Each failure is logged here with the operation (a name written in this file) and the HTTP
        # status: the libraries' own records of the request are silenced or rewritten (logs.py).
        op = payload["op"]
        # The request is built here so that it can be recognised afterwards: httpx builds a new
        # object for every redirect it follows, so a failure belongs to the original POST only
        # when it names this very object. Method and URL do not tell: a 307/308 back to the same
        # URL repeats the POST after the script already ran.
        original = self._http.build_request("POST", self._url, json=payload, timeout=30.0)
        try:
            response = await self._http.send(original, follow_redirects=True)
        except httpx.HTTPError as err:
            log.warning("sheet call %s got no answer: %s", op, describe(err))
            if mutating and not (isinstance(err, _NOT_SENT) and _request_of(err) is original):
                # The request may have left, or the script already ran and its redirect failed.
                return _uncertain()
            return _unavailable(f"falha de rede ao chamar a planilha: {err!r}")
        # A redirect means the POST was answered: the script ran before anything that follows.
        redirected = bool(response.history) or response.request is not original
        if response.status_code != 200:
            log.warning("sheet call %s answered HTTP %d", op, response.status_code)
            if mutating and (redirected or response.status_code not in _PRE_SCRIPT_STATUSES):
                return _uncertain()
            return _unavailable(f"planilha respondeu HTTP {response.status_code}")
        try:
            body = response.json()
        except ValueError:
            log.warning("sheet call %s answered HTTP 200 without JSON", op)
            if mutating:
                return _uncertain()
            return _unavailable(
                "resposta da planilha não é JSON; confira se o Web App está publicado para "
                "'Qualquer pessoa' e se a URL termina em /exec"
            )
        if not isinstance(body, dict) or "ok" not in body:
            log.warning("sheet call %s answered HTTP 200 without the API envelope", op)
            if mutating:
                return _uncertain()
            return _unavailable("resposta da planilha fora do formato {ok, ...}")
        return body

    async def catalog(self) -> Response:
        return await self.call("catalog", {})

    async def upsert_diary(
        self, date: str, fields: dict[str, Any], *, request_id: str | None = None
    ) -> Response:
        return await self.call("diary.upsert", {"date": date, "fields": fields}, request_id=request_id)

    async def upsert_workout(
        self,
        date: str,
        session: str,
        exercises: list[dict[str, Any]],
        complete: bool | None = None,
        *,
        request_id: str | None = None,
    ) -> Response:
        """Exercises as {name, warmup?, feeder?, work: [{kg, reps, rir?}] (1-2), pain?, note?,
        equipment?}; `complete` concludes the session (Estado sessão Concluído)."""
        args: dict[str, Any] = {"date": date, "session": session, "exercises": exercises}
        if complete is not None:
            args["complete"] = complete
        return await self.call("workout.upsert", args, request_id=request_id)

    async def add_food(
        self,
        date: str,
        meal: str,
        items: list[dict[str, Any]],
        *,
        request_id: str | None = None,
    ) -> Response:
        """Items as {food, qty, unit?} | {favorite, portions?} | {description} (sem cálculo)."""
        return await self.call(
            "food.add", {"date": date, "meal": meal, "items": items}, request_id=request_id
        )

    async def copy_food(
        self,
        date_from: str,
        date_to: str,
        meal: str | None = None,
        *,
        request_id: str | None = None,
    ) -> Response:
        """Copies a meal (or all meals when `meal` is None) from `date_from` to `date_to`."""
        args: dict[str, Any] = {"from": date_from, "to": date_to}
        if meal is not None:
            args["meal"] = meal
        return await self.call("food.copy", args, request_id=request_id)

    async def upsert_measures(
        self, date: str, fields: dict[str, Any], *, request_id: str | None = None
    ) -> Response:
        return await self.call("measures.upsert", {"date": date, "fields": fields}, request_id=request_id)

    async def exercise_history(self, name: str, limit: int | None = None) -> Response:
        args: dict[str, Any] = {"name": name}
        if limit is not None:
            args["limit"] = limit
        return await self.call("exercise.history", args)

    async def diary_range(self, date_from: str, date_to: str) -> Response:
        return await self.call("diary.range", {"from": date_from, "to": date_to})

    async def workout_range(self, date_from: str, date_to: str) -> Response:
        return await self.call("workout.range", {"from": date_from, "to": date_to})

    async def undo(self, write_id: str | None = None) -> Response:
        return await self.call("write.undo", {} if write_id is None else {"writeId": write_id})

    async def day(self, date: str) -> Response:
        return await self.call("day.get", {"date": date})

    async def phase(self, date: str) -> Response:
        """Objective, goal and plan in force on `date`, with their targets."""
        return await self.call("phase.get", {"date": date})

    async def week(self, date: str) -> Response:
        """Weekly analysis (Semanas) of the week containing `date`."""
        return await self.call("week.get", {"date": date})


def _request_of(err: httpx.HTTPError) -> httpx.Request | None:
    """The request that failed, or None when the exception names none (the property raises)."""
    try:
        return err.request
    except (RuntimeError, AttributeError):
        return None


def _is_uncertain_envelope(body: Response) -> bool:
    errors = body.get("errors")
    return isinstance(errors, list) and any(
        isinstance(e, dict) and e.get("code") == UNCERTAIN_CODE for e in errors
    )


def _codes(body: Response) -> str:
    """The error codes and writeState of a body for a log line: members of closed sets, never text."""
    errors = body.get("errors")
    codes = (
        [safe_code(e.get("code") if isinstance(e, dict) else None) for e in errors]
        if isinstance(errors, list)
        else []
    )
    shown = f"codes [{', '.join(codes)}]"
    if "writeState" in body:
        state = body["writeState"]
        shown += f" writeState={state if state in ('none', 'unknown') else 'other'}"
    return shown


def _uncertain() -> Response:
    return {"ok": False, "errors": [{"path": "", "code": UNCERTAIN_CODE, "message": _UNCERTAIN_MESSAGE}]}


def _unavailable(message: str) -> Response:
    return {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": message}]}
