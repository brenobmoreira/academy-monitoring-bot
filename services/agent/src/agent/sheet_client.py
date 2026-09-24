"""Client for the Apps Script sheet API (apps/sheet/src/api.js).

Every call returns the API body as-is: {"ok": true, "result": ...} or {"ok": false, "errors": [...]}.
Failures to reach the API are folded into the same shape with code "unavailable", so callers
(the agent's tools) handle one format only.
"""

from __future__ import annotations

from typing import Any

import httpx

Response = dict[str, Any]


class SheetClient:
    def __init__(self, url: str, key: str, http: httpx.AsyncClient) -> None:
        self._url = url
        self._key = key
        self._http = http

    async def call(self, op: str, args: dict[str, Any]) -> Response:
        # Apps Script answers a POST with a 302 to script.googleusercontent.com, whose GET holds
        # the body; following redirects is part of the protocol, not a fallback.
        try:
            response = await self._http.post(
                self._url,
                json={"key": self._key, "op": op, "args": args},
                follow_redirects=True,
                timeout=30.0,
            )
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

    async def upsert_diary(self, date: str, fields: dict[str, Any]) -> Response:
        return await self.call("diary.upsert", {"date": date, "fields": fields})

    async def upsert_workout(
        self, date: str, session: str, exercises: list[dict[str, Any]], phase: str | None = None
    ) -> Response:
        args: dict[str, Any] = {"date": date, "session": session, "exercises": exercises}
        if phase is not None:
            args["phase"] = phase
        return await self.call("workout.upsert", args)

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


def _unavailable(message: str) -> Response:
    return {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": message}]}
