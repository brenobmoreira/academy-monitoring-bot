"""Fakes shared by the unit tests: a sheet API that records calls, a scripted LLM and a Telegram client."""

import json
from collections.abc import AsyncGenerator
from typing import Any

from google.adk.models import BaseLlm, LlmRequest, LlmResponse
from google.adk.models.lite_llm import LiteLLMClient
from google.genai import types

from agent.sheet_client import current_request_id

OK_DIARY = {"ok": True, "result": {"date": "2026-09-21", "row": 6, "fields": {"weightKg": 82.4}}}


class FakeSheet:
    """Answers each op from a queue (or a default) and records every call."""

    def __init__(self, **responses: list[dict[str, Any]]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.request_ids: list[str | None] = []

    def _next(self, op: str, args: dict[str, Any]) -> dict[str, Any]:
        self.calls.append((op, args))
        self.request_ids.append(current_request_id())
        queue = self.responses.get(op.replace(".", "_"))
        return queue.pop(0) if queue else {"ok": True, "result": {}}

    async def catalog(self):
        return self._next("catalog", {})

    async def upsert_diary(self, date, fields):
        return self._next("diary.upsert", {"date": date, "fields": fields})

    async def upsert_workout(self, date, session, exercises, complete=None):
        args = {"date": date, "session": session, "exercises": exercises}
        if complete is not None:
            args["complete"] = complete
        return self._next("workout.upsert", args)

    async def add_food(self, date, meal, items):
        return self._next("food.add", {"date": date, "meal": meal, "items": items})

    async def copy_food(self, date_from, date_to, meal=None):
        args = {"from": date_from, "to": date_to}
        if meal is not None:
            args["meal"] = meal
        return self._next("food.copy", args)

    async def upsert_measures(self, date, fields):
        return self._next("measures.upsert", {"date": date, "fields": fields})

    async def exercise_history(self, name, limit=None):
        args = {"name": name} if limit is None else {"name": name, "limit": limit}
        return self._next("exercise.history", args)

    async def diary_range(self, date_from, date_to):
        return self._next("diary.range", {"from": date_from, "to": date_to})

    async def workout_range(self, date_from, date_to):
        return self._next("workout.range", {"from": date_from, "to": date_to})

    async def undo(self, write_id=None):
        return self._next("write.undo", {} if write_id is None else {"writeId": write_id})

    async def day(self, date):
        return self._next("day.get", {"date": date})

    async def phase(self, date):
        return self._next("phase.get", {"date": date})

    async def week(self, date):
        return self._next("week.get", {"date": date})


class ScriptedLlm(BaseLlm):
    """Replays model turns in order (an exception in the script is raised) and keeps every
    request it received."""

    script: list[types.Content | Exception] = []
    requests: list[LlmRequest] = []

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        self.requests.append(llm_request)
        turn = self.script.pop(0)
        if isinstance(turn, Exception):
            raise turn
        yield LlmResponse(content=turn)


def call(name: str, **args: Any) -> types.Content:
    return types.Content(
        role="model", parts=[types.Part(function_call=types.FunctionCall(name=name, args=args))]
    )


def say(text: str) -> types.Content:
    return types.Content(role="model", parts=[types.Part(text=text)])


class FakeLiteLLMClient(LiteLLMClient):
    """Stands in for litellm.acompletion: replays OpenAI-style responses (an exception in the
    script is raised), records each request."""

    def __init__(self, script: list[Any]) -> None:
        self.script = script
        self.requests: list[dict[str, Any]] = []

    async def acompletion(self, model: Any, messages: Any, tools: Any, **kwargs: Any) -> Any:
        self.requests.append({"model": model, "messages": messages, "tools": tools, **kwargs})
        response = self.script.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


def tool_call_response(name: str, args: dict[str, Any], call_id: str = "c1") -> Any:
    from litellm import ModelResponse

    function = {"name": name, "arguments": json.dumps(args)}
    message = {
        "role": "assistant",
        "content": None,
        "tool_calls": [{"id": call_id, "type": "function", "function": function}],
    }
    return ModelResponse(choices=[{"message": message, "finish_reason": "tool_calls"}])


def text_response(text: str) -> Any:
    from litellm import ModelResponse

    return ModelResponse(
        choices=[{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}]
    )


class FakeTelegram:
    def __init__(
        self, error=None, action_error=None, events=None, edit_error=None, files=None, download_error=None
    ):
        self.sent = []
        self.actions = []
        self.options = []
        self.answered = []
        self.edited = []
        self.fetched = []
        self._files = files or {}  # file_id -> (File object, bytes)
        self._download_error = download_error
        self._error = error
        self._action_error = action_error
        self._edit_error = edit_error
        self._events = events if events is not None else []

    async def send_message(self, chat_id, text, *, html=False, reply_markup=None, reply_to=None):
        if self._error:
            raise self._error
        self.sent.append((chat_id, text))
        self.options.append({"html": html, "reply_markup": reply_markup, "reply_to": reply_to})
        return {"message_id": len(self.sent), "chat": {"id": chat_id}, "text": text}

    async def send_chat_action(self, chat_id, action="typing"):
        self.actions.append((chat_id, action))
        self._events.append(action)
        if self._action_error:
            raise self._action_error

    async def answer_callback_query(self, callback_query_id, text=None):
        self.answered.append((callback_query_id, text))

    async def edit_message_reply_markup(self, chat_id, message_id, reply_markup=None):
        if self._edit_error:
            raise self._edit_error
        self.edited.append((chat_id, message_id, reply_markup))

    async def get_file(self, file_id):
        self.fetched.append(("getFile", file_id))
        return self._files[file_id][0]

    async def download_file(self, file_path):
        self.fetched.append(("download", file_path))
        if self._download_error:
            raise self._download_error
        return next(data for info, data in self._files.values() if info["file_path"] == file_path)


def media_update(chat_id=42, **fields):
    return {"update_id": 2, "message": {"chat": {"id": chat_id}, **fields}}


def file(file_id, data, path=None):
    info = {"file_id": file_id, "file_size": len(data), "file_path": path or f"files/{file_id}"}
    return {file_id: (info, data)}
