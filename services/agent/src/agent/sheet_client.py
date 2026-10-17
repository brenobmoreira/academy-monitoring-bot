"""Client for the Apps Script sheet API (sheet 4.0: apps/sheet4/src/api.js).

Every call returns the API body as-is: {"ok": true, "result": ...} or {"ok": false, "errors": [...]}.
Failures to reach the API are folded into the same shape with code "unavailable", so callers
(the agent's tools) handle one format only.
"""

from __future__ import annotations

import logging
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Any

import httpx

log = logging.getLogger(__name__)

Response = dict[str, Any]

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
        body = await self._post(payload)
        if effective_id and _rejected_request_id(body):
            log.warning("sheet Web App rejected requestId (unknown_field); retrying without requestId")
            body = await self._post({"key": self._key, "op": op, "args": args})
        return body

    async def _post(self, payload: dict[str, Any]) -> Response:
        try:
            response = await self._http.post(self._url, json=payload, follow_redirects=True, timeout=30.0)
        except httpx.HTTPError as err:
            return _unavailable(f"falha de rede ao chamar a planilha: {err!r}")
        if response.status_code != 200:
            return _unavailable(f"planilha respondeu HTTP {response.status_code}")
        try:
            body = response.json()
        except ValueError:
            return _unavailable(
                "resposta da planilha não é JSON; confira se o Web App está publicado para "
                "'Qualquer pessoa' e se a URL termina em /exec"
            )
        if not isinstance(body, dict) or "ok" not in body:
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


def _unavailable(message: str) -> Response:
    return {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": message}]}
