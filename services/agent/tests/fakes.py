"""Fakes shared by the unit tests: a sheet API that records calls and a scripted LLM."""

from collections.abc import AsyncGenerator
from typing import Any

from google.adk.models import BaseLlm, LlmRequest, LlmResponse
from google.genai import types

OK_DIARY = {"ok": True, "result": {"date": "2026-09-21", "row": 6, "fields": {"weightKg": 82.4}}}


class FakeSheet:
    """Answers each op from a queue (or a default) and records every call."""

    def __init__(self, **responses: list[dict[str, Any]]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def _next(self, op: str, args: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((op, args))
        queue = self.responses.get(op.replace(".", "_"))
        return queue.pop(0) if queue else {"ok": True, "result": {}}

    async def catalog(self):
        return self._next("catalog", {})

    async def upsert_diary(self, date, fields):
        return self._next("diary.upsert", {"date": date, "fields": fields})

    async def upsert_workout(self, date, session, exercises, phase=None):
        args = {"date": date, "session": session, "exercises": exercises}
        if phase is not None:
            args["phase"] = phase
        return self._next("workout.upsert", args)

    async def exercise_history(self, name, limit=None):
        args = {"name": name} if limit is None else {"name": name, "limit": limit}
        return self._next("exercise.history", args)


class ScriptedLlm(BaseLlm):
    """Replays model turns in order and keeps every request it received."""

    script: list[types.Content] = []
    requests: list[LlmRequest] = []

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.requests.append(llm_request)
        yield LlmResponse(content=self.script.pop(0))


def call(name: str, **args: Any) -> types.Content:
    return types.Content(
        role="model", parts=[types.Part(function_call=types.FunctionCall(name=name, args=args))]
    )


def say(text: str) -> types.Content:
    return types.Content(role="model", parts=[types.Part(text=text)])
