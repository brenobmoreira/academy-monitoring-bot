"""Local end-to-end run: mocked Telegram webhook → Python agent → LLM → Apps Script JS → JSON trace.

    cd services/agent
    uv run python ../../e2e/run.py                      # scripted LLM + voice, no network at all
    uv run python ../../e2e/run.py --server uvicorn     # same, through the ASGI app
    uv run python ../../e2e/run.py --real \\
        --message "peso 82,4 dormi 7h30"                # real model: LLM_MODEL + LLM_API_KEY

What is real: the chosen HTTP entry point (Functions Framework or ASGI) with its secret check,
`webhook.process` / `webhook.handle_update` with its process-wide state (`UpdateDeduplicator`,
`VoiceConfirmations`, `MemoryBudget`), `Handler`, `Transcriber`, `Bot`/ADK runner, tools, the
LiteLLM adapter, `SheetClient` over HTTP, and the sheet 4.0 Apps Script code (`apps/sheet4/src`)
running in Node.

What is mocked: the Telegram Bot API and file download endpoint (replies and callbacks are captured
locally), the spreadsheet (in-memory fake built by `e2e/sheet_server.js` with a synthetic client),
and — without `--real` — the providers behind LiteLLM (agent + audio transcription), which replay a
fixed multi-stage script and assert the end-to-end contracts (`writeState: "none"` rejections and
agent self-correction, chat voice confirmation + duplicate-tap guard, Mini App `t: "text"` voice
submission + `TextSubmissions` idempotency, `POST /remind {"kind": "daily"}`, and exact final rows
in `Diário`, `Registro de treino` and `Alimentação`).

`SHEET_SRC=legacy` serves the old `apps/sheet` code instead (manual `--real` use only; scripted
assertions target sheet 4.0).

The trace is written to `e2e/out/run-<timestamp>.json`.
"""

from __future__ import annotations

import argparse
import base64
import contextlib
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import AsyncGenerator, Callable
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from flask import Request
from google.adk.models import BaseLlm, LlmRequest, LlmResponse
from google.adk.models.lite_llm import LiteLLMClient
from google.genai import types
from litellm import ModelResponse
from starlette.testclient import TestClient
from werkzeug.test import EnvironBuilder

from agent import asgi, buttons, main, reminder, webhook
from agent import handler as handler_module
from agent.handler import Handler, UpdateDeduplicator
from agent.llm import build_model
from agent.settings import Settings
from agent.text_submissions import DONE_REPLY, TextSubmissions
from agent.transcribe import build_transcriber
from agent.voice_confirm import VOICE_ALREADY_SENT, VOICE_REGISTERING, VoiceConfirmations

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "e2e" / "out"
ENV_FILE = ROOT / "services" / "agent" / ".env"
TZ = ZoneInfo("America/Sao_Paulo")
CHAT_ID = 42
SHEET_KEY = "local-sheet-key"
WEBHOOK_SECRET = "local-webhook-secret"
REMINDER_TOKEN = "local-reminder-token"
TRANSCRIBE_KEY = "local-transcribe-key"
DEFAULT_MESSAGE = "peso 82,4 dormi 7h30. upper: supino inclinado 60x8 62,5x8 rir 2, puxada 50x10 50x9"
VOICE_FILE_ID = "fake-voice-file-1"
VOICE_FILE_PATH = "voice/e2e-note.oga"
# Synthetic Ogg header + zero padding (>= transcribe.MIN_BODY_BYTES = 1024 bytes).
FAKE_OGG = b"OggS" + b"\x00" * 2044
VOICE_TRANSCRIPT = "bebi 2,5 litros de água"
MINIAPP_SUBMISSION_ID = "0123456789abcdef0123456789abcdef"
MINIAPP_VOICE_TEXT = "lanche 100g peito de frango cozido"

timeline: list[dict[str, Any]] = []
_recorded_setup = False
_next_step = 0


def _reset_trace() -> None:
    global _recorded_setup, _next_step
    timeline.clear()
    _recorded_setup = False
    _next_step = 0


def record(kind: str, **data: Any) -> None:
    global _next_step
    _next_step += 1
    timeline.append({"step": _next_step, "kind": kind, **data})


def take_steps(start: int) -> list[dict[str, Any]]:
    steps = timeline[start:]
    del timeline[start:]
    return steps


# ---- LLM & Transcription ------------------------------------------------------------------


def call(name: str, **args: Any) -> ModelResponse:
    function = {"name": name, "arguments": json.dumps(args)}
    tool_call = {"id": f"call-{name}-{time.monotonic_ns()}", "type": "function", "function": function}
    message = {"role": "assistant", "content": None, "tool_calls": [tool_call]}
    return ModelResponse(choices=[{"message": message, "finish_reason": "tool_calls"}])


def say(text: str) -> ModelResponse:
    return ModelResponse(
        choices=[{"message": {"role": "assistant", "content": text}, "finish_reason": "stop"}]
    )


def scripted_turns(today: str) -> list[ModelResponse]:
    """Full scripted agent conversation across all stages (typed, chat voice, Mini App voice)."""
    supino = {
        "name": "Supino inclinado",
        "warmup": {"kg": 20, "reps": 12},
        "work": [{"kg": 60, "reps": 8, "rir": 2}, {"kg": 62.5, "reps": 8, "rir": 1}],
    }
    puxada = {"work": [{"kg": 50, "reps": 10}, {"kg": 50, "reps": 9}]}
    lunch = [
        {"food": "Arroz branco cozido", "qty": 150, "unit": "g"},
        {"food": "Ovo inteiro cozido", "qty": 2, "unit": "un"},
    ]
    snack = [{"food": "Peito de frango cozido", "qty": 100, "unit": "g"}]
    return [
        # Stage 1: typed DEFAULT_MESSAGE (2 rejected writes with writeState=="none", then fixed).
        call("get_catalog"),
        call("save_diary", date=today, fields={"weightKg": 82.4, "sleepH": "7h30"}),
        call("save_diary", date=today, fields={"weightKg": 82.4, "sleepH": 7.5}),
        call("save_workout", date=today, session="Upper", exercises=[supino, {"name": "puxada", **puxada}]),
        call(
            "save_workout",
            date=today,
            session="Upper",
            exercises=[supino, {"name": "Puxada aberta", **puxada}],
        ),
        call("save_food", date=today, meal="Almoço", items=lunch),
        say("ok"),
        # Stage 2b: confirmed chat voice note ("bebi 2,5 litros de água", keeping steps empty).
        call("save_diary", date=today, fields={"waterL": 2.5}),
        say("ok"),
        # Stage 3a: Mini App voice text submission ("lanche 100g peito de frango cozido").
        call("get_catalog"),
        call("save_food", date=today, meal="Lanche", items=snack),
        say("ok"),
    ]


def scripted_transcriptions() -> list[ModelResponse]:
    """Scripted Gemini audio-native response for `Transcriber`."""
    return [
        ModelResponse(
            choices=[
                {"message": {"role": "assistant", "content": VOICE_TRANSCRIPT}, "finish_reason": "stop"}
            ],
            usage={
                "prompt_tokens": 614,
                "completion_tokens": 12,
                "prompt_tokens_details": {"audio_tokens": 160},
            },
        )
    ]


class ScriptedProvider(LiteLLMClient):
    """Replaces the provider call inside LiteLLM; everything above it (ADK, LiteLlm) is real."""

    def __init__(self, script: list[ModelResponse]) -> None:
        self.script = script

    async def acompletion(self, model: Any, messages: Any, tools: Any, **kwargs: Any) -> ModelResponse:
        if not self.script:
            raise AssertionError("unexpected agent LLM call: scripted turns exhausted")
        return self.script.pop(0)


class ScriptedTranscribeClient(LiteLLMClient):
    """Replaces the HTTP call inside `Transcriber`, keeping `MeteredClient` + `RetryingClient` real."""

    def __init__(self, script: list[ModelResponse]) -> None:
        self.script = script

    async def acompletion(self, model: Any, messages: Any, tools: Any, **kwargs: Any) -> ModelResponse:
        if not self.script:
            raise AssertionError("unexpected transcription LLM call: scripted turns exhausted")
        audio_info: dict[str, Any] = {}
        for msg in messages or []:
            if isinstance(msg, dict) and isinstance(msg.get("content"), list):
                for item in msg["content"]:
                    if isinstance(item, dict) and isinstance(item.get("input_audio"), dict):
                        raw_b64 = item["input_audio"].get("data", "")
                        audio_info = {
                            "format": item["input_audio"].get("format"),
                            "bytes": len(base64.b64decode(raw_b64)),
                        }
        response = self.script.pop(0)
        first_choice = response.choices[0] if response.choices else None
        text = getattr(getattr(first_choice, "message", None), "content", None)
        usage = getattr(response, "usage", None)
        record(
            "transcribe_llm",
            request={"model": str(model), "audio": audio_info},
            response={
                "text": text,
                "usage": {
                    "prompt_tokens": getattr(usage, "prompt_tokens", None),
                    "completion_tokens": getattr(usage, "completion_tokens", None),
                },
            },
        )
        return response


class RecordingLlm(BaseLlm):
    """Wraps any model and records each request (what the model sees) and response."""

    inner: BaseLlm

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        global _recorded_setup
        config = llm_request.config
        request: dict[str, Any] = {"model": self.inner.model, "new_input": parts(llm_request.contents[-1])}
        if not _recorded_setup:
            _recorded_setup = True
            request["system_instruction"] = str(config.system_instruction or "").splitlines()
            request["tools"] = [
                d.name
                for tool in (config.tools or [])
                for d in (getattr(tool, "function_declarations", None) or [])
            ]
        async for response in self.inner.generate_content_async(llm_request, stream):
            record("llm", request=request, response=parts(response.content) if response.content else None)
            yield response


def parts(content: types.Content) -> list[dict[str, Any]]:
    out = []
    for p in content.parts or []:
        if p.function_call:
            out.append({"function_call": {"name": p.function_call.name, "args": p.function_call.args}})
        elif p.function_response:
            out.append(
                {
                    "function_response": {
                        "name": p.function_response.name,
                        "response": p.function_response.response,
                    }
                }
            )
        elif p.text and not p.thought:
            out.append({"text": p.text})
    return out


# ---- HTTP: real sheet server, captured Telegram ------------------------------------------


@dataclass
class TelegramState:
    next_message_id: int = 100
    files: dict[str, tuple[str, bytes]] = field(
        default_factory=lambda: {VOICE_FILE_ID: (VOICE_FILE_PATH, FAKE_OGG)}
    )
    sent_messages: list[dict[str, Any]] = field(default_factory=list)


class RoutingTransport(httpx.AsyncBaseTransport):
    def __init__(self, state: TelegramState) -> None:
        self._state = state
        self._real = httpx.AsyncHTTPTransport()

    async def aclose(self) -> None:
        await self._real.aclose()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.telegram.org":
            return self._handle_telegram(request)
        body = json.loads(request.content) if request.content else None
        response = await self._real.handle_async_request(request)
        await response.aread()
        record("sheet_api", request=body, response=json.loads(response.content))
        return response

    def _handle_telegram(self, request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/file/bot"):
            file_path = request.url.path.split("/", 3)[3]
            matched = next((data for path, data in self._state.files.values() if path == file_path), None)
            if matched is None:
                return httpx.Response(404, text="not found", request=request)
            record(
                "telegram_reply", method="downloadFile", body={"file_path": file_path, "size": len(matched)}
            )
            return httpx.Response(
                200, content=matched, headers={"content-type": "audio/ogg"}, request=request
            )

        method = request.url.path.rsplit("/", 1)[-1]
        body = json.loads(request.content) if request.content else {}
        record("telegram_reply", method=method, body=body)
        if method == "getFile":
            entry = self._state.files.get(str(body.get("file_id", "")))
            if entry is None:
                return httpx.Response(
                    400, json={"ok": False, "error_code": 400, "description": "bad file_id"}, request=request
                )
            file_path, data = entry
            result = {"file_id": body["file_id"], "file_size": len(data), "file_path": file_path}
            return httpx.Response(200, json={"ok": True, "result": result}, request=request)
        if method == "sendMessage":
            mid = self._state.next_message_id
            self._state.next_message_id += 1
            sent: dict[str, Any] = {
                "message_id": mid,
                "date": int(time.time()),
                "chat": {"id": body["chat_id"], "type": "private"},
                "from": {"id": 999, "is_bot": True, "first_name": "Bot"},
                "text": body["text"],
            }
            if "reply_markup" in body:
                sent["reply_markup"] = body["reply_markup"]
            self._state.sent_messages.append(sent)
            return httpx.Response(200, json={"ok": True, "result": sent}, request=request)
        return httpx.Response(200, json={"ok": True, "result": True}, request=request)


class _WebhookHttpx:
    """Drop-in for `webhook.httpx` so `webhook.handle_update` stays completely real."""

    def __init__(self, state: TelegramState) -> None:
        self._state = state

    def AsyncClient(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=RoutingTransport(self._state))


# ---- run & assertions ----------------------------------------------------------------------


def start_sheet_server() -> tuple[subprocess.Popen[str], str]:
    proc = subprocess.Popen(
        ["node", str(ROOT / "e2e" / "sheet_server.js")],
        stdout=subprocess.PIPE,
        text=True,
        # Apps Script runs in the script's time zone; the fakes report America/Sao_Paulo.
        env={**os.environ, "SHEET_API_KEY": SHEET_KEY, "TZ": str(TZ)},
    )
    line = proc.stdout.readline() if proc.stdout else ""
    if not line.startswith("LISTENING "):
        proc.kill()
        sys.exit(f"sheet server did not start: {line!r}")
    return proc, f"http://127.0.0.1:{line.split()[1]}/"


def require_model_credentials(settings: Settings) -> None:
    if settings.LLM_API_KEY is None and not settings.LLM_MODEL.startswith(("vertex_ai/", "ollama/")):
        sys.exit(f"--real needs LLM_API_KEY for {settings.LLM_MODEL} in {ENV_FILE.relative_to(ROOT)}")


def make_poster(
    server: str, client: TestClient | None
) -> Callable[[dict[str, str], dict[str, Any], str], tuple[str, int]]:
    def post(headers: dict[str, str], body: dict[str, Any], path: str = "/") -> tuple[str, int]:
        if server == "uvicorn":
            assert client is not None
            response = client.post(path, headers=headers, json=body)
            return response.text, response.status_code
        environ = EnvironBuilder(
            path=path,
            method="POST",
            headers=list(headers.items()),
            json=body,
        ).get_environ()
        return main.telegram_webhook(Request(environ))

    return post


def joined_send_messages(steps: list[dict[str, Any]]) -> tuple[str | None, dict[str, Any] | None]:
    sends = [t["body"] for t in steps if t["kind"] == "telegram_reply" and t["method"] == "sendMessage"]
    text = "\n".join(b["text"] for b in sends) or None
    keyboard = sends[-1].get("reply_markup") if sends else None
    return text, keyboard


def callback_toasts(steps: list[dict[str, Any]]) -> list[str | None]:
    return [
        t["body"].get("text")
        for t in steps
        if t["kind"] == "telegram_reply" and t["method"] == "answerCallbackQuery"
    ]


def assert_stage1_typed_and_writestate(
    status: int, body: str, steps: list[dict[str, Any]], reply: str | None, keyboard: dict[str, Any] | None
) -> list[dict[str, Any]]:
    assert (status, body) == (200, "ok"), f"Stage 1 webhook failed: {(status, body)!r}"
    llm_steps = [t for t in steps if t["kind"] == "llm"]
    sheet_steps = [t for t in steps if t["kind"] == "sheet_api"]
    assert len(llm_steps) == 7, f"Expected 7 LLM calls in Stage 1, got {len(llm_steps)}"
    assert len(sheet_steps) == 6, f"Expected 6 sheet_api calls in Stage 1, got {len(sheet_steps)}"

    rejected = [s for s in sheet_steps if s["response"].get("ok") is False]
    assert len(rejected) == 2, f"Expected 2 rejected writes in Stage 1, got {len(rejected)}"
    for idx, expected_op, expected_code in (
        (0, "diary.upsert", "wrong_type"),
        (1, "workout.upsert", "not_in_catalog"),
    ):
        call_entry = rejected[idx]
        resp = call_entry["response"]
        assert call_entry["request"]["op"] == expected_op, (
            f"Unexpected op on rejection #{idx + 1}: {call_entry}"
        )
        assert resp.get("writeState") == "none", (
            f"Expected writeState=='none' on rejection #{idx + 1}: {resp}"
        )
        codes = [e.get("code") for e in resp.get("errors", [])]
        assert expected_code in codes, f"Expected {expected_code!r} in rejection #{idx + 1} errors: {resp}"

    accepted_writes = [
        s for s in sheet_steps if s["request"]["op"] != "catalog" and s["response"].get("ok") is True
    ]
    assert [s["request"]["op"] for s in accepted_writes] == [
        "diary.upsert",
        "workout.upsert",
        "food.add",
    ], f"Unexpected accepted writes in Stage 1: {[s['request']['op'] for s in accepted_writes]}"

    assert reply and "Peso kg 82,4" in reply and "Sono h 7,5" in reply, f"Missing diary summary: {reply!r}"
    assert "Supino inclinado" in reply and "Puxada aberta" in reply, f"Missing workout summary: {reply!r}"
    assert "Almoço" in reply and "Arroz branco cozido" in reply, f"Missing food summary: {reply!r}"
    assert keyboard is not None, "Expected inline confirmation buttons on Stage 1 reply"
    row = keyboard.get("inline_keyboard", [[]])[0]
    verbs = [b["callback_data"].partition(":")[0] for b in row]
    assert verbs == [buttons.OK, buttons.UNDO, buttons.FIX], f"Unexpected Stage 1 buttons: {row}"
    return [
        {
            "op": r["request"]["op"],
            "writeState": r["response"]["writeState"],
            "codes": [e.get("code") for e in r["response"].get("errors", [])],
        }
        for r in rejected
    ]


def run_scripted_voice_and_miniapp(
    post: Callable[[dict[str, str], dict[str, Any], str], tuple[str, int]],
    headers: dict[str, str],
    telegram_state: TelegramState,
    settings: Settings,
    today: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    now_unix = int(time.time())

    # ---- Stage 2: Chat Voice (`C4b` + `C4c2` + `C4d`) --------------------------------------
    mark = len(timeline)
    sent_before_voice = len(telegram_state.sent_messages)
    voice_update = {
        "update_id": 1002,
        "message": {
            "message_id": 2,
            "date": now_unix,
            "chat": {"id": CHAT_ID, "type": "private"},
            "from": {"id": CHAT_ID, "is_bot": False, "first_name": "Local"},
            "voice": {
                "file_id": VOICE_FILE_ID,
                "file_unique_id": "fake-voice-uniq-1",
                "duration": 5,
                "mime_type": "audio/ogg",
                "file_size": len(FAKE_OGG),
            },
        },
    }
    voice_body, voice_status = post(headers, voice_update, "/")
    voice_steps = take_steps(mark)

    assert (voice_status, voice_body) == (200, "ok"), (
        f"Stage 2a voice webhook failed: {(voice_status, voice_body)!r}"
    )
    assert [t for t in voice_steps if t["kind"] == "llm"] == [], (
        "Agent LLM must not run before voice confirmation"
    )
    assert [t for t in voice_steps if t["kind"] == "sheet_api"] == [], (
        "Sheet API must not run before confirmation"
    )
    tx_steps = [t for t in voice_steps if t["kind"] == "transcribe_llm"]
    assert len(tx_steps) == 1, f"Expected 1 transcribe_llm call, got {len(tx_steps)}"
    tg_methods = [t["method"] for t in voice_steps if t["kind"] == "telegram_reply"]
    assert "getFile" in tg_methods and "downloadFile" in tg_methods, f"Expected file download in {tg_methods}"

    budget = webhook._get_budget(
        settings.VOICE_DAILY_TOKENS, settings.VOICE_GLOBAL_DAILY_TOKENS, settings.TIMEZONE
    )
    used_tokens = budget.used(f"telegram:{CHAT_ID}", datetime.now(TZ))
    assert used_tokens == (626, 626), f"Expected (626, 626) settled transcription tokens, got {used_tokens}"

    new_sent = telegram_state.sent_messages[sent_before_voice:]
    assert len(new_sent) == 1, f"Expected 1 Entendi message, got {len(new_sent)}"
    entendi_sent = new_sent[0]
    expected_entendi = f"🎙️ Entendi:\n\n{VOICE_TRANSCRIPT}"
    assert entendi_sent["text"] == expected_entendi, f"Unexpected Entendi text: {entendi_sent['text']!r}"
    entendi_send_call = next(
        t["body"] for t in voice_steps if t["kind"] == "telegram_reply" and t["method"] == "sendMessage"
    )
    assert "parse_mode" not in entendi_send_call, "Entendi message must be sent as plain text (no parse_mode)"

    voice_kb = entendi_sent.get("reply_markup", {}).get("inline_keyboard", [])
    assert len(voice_kb) == 1 and len(voice_kb[0]) == 3, f"Expected 3 voice buttons, got {voice_kb}"
    cb_data = [b["callback_data"] for b in voice_kb[0]]
    vid = cb_data[0].partition(":")[2]
    assert re.fullmatch(r"[0-9a-f]{16}", vid), f"Invalid 16-hex vid: {vid!r}"
    assert cb_data == [
        f"{buttons.VOICE_OK}:{vid}",
        f"{buttons.VOICE_FIX}:{vid}",
        f"{buttons.VOICE_NO}:{vid}",
    ], f"Unexpected voice callback_data: {cb_data}"

    pending_entry = webhook._CONFIRMATIONS.get(vid)
    assert pending_entry is not None and pending_entry.state == "pending", (
        f"Expected pending vid: {pending_entry}"
    )
    assert pending_entry.message_id == entendi_sent["message_id"]

    # Stage 2b: tap `vok:<vid>` carrying the captured `Entendi` message -> writes waterL=2.5.
    mark = len(timeline)
    vok_message = {k: v for k, v in entendi_sent.items() if k != "reply_markup"}
    vok_update_1 = {
        "update_id": 1003,
        "callback_query": {
            "id": "cb-vok-1",
            "from": {"id": CHAT_ID, "is_bot": False, "first_name": "Local"},
            "message": vok_message,
            "data": f"{buttons.VOICE_OK}:{vid}",
        },
    }
    vok1_body, vok1_status = post(headers, vok_update_1, "/")
    vok1_steps = take_steps(mark)

    assert (vok1_status, vok1_body) == (200, "ok"), f"Stage 2b vok tap failed: {(vok1_status, vok1_body)!r}"
    assert callback_toasts(vok1_steps) == [VOICE_REGISTERING], (
        f"Expected toast {VOICE_REGISTERING!r}, got {callback_toasts(vok1_steps)}"
    )
    vok1_sheet = [t for t in vok1_steps if t["kind"] == "sheet_api"]
    assert len(vok1_sheet) == 1, f"Expected 1 sheet_api call on vok tap, got {len(vok1_sheet)}"
    assert vok1_sheet[0]["request"]["op"] == "diary.upsert"
    assert vok1_sheet[0]["request"]["args"] == {"date": today, "fields": {"waterL": 2.5}}
    assert str(vok1_sheet[0]["request"].get("requestId", "")).startswith(f"tg:voice:{vid}:diary.upsert:")
    assert vok1_sheet[0]["response"].get("ok") is True, (
        f"Expected ok=True on voice diary write: {vok1_sheet[0]}"
    )
    done_entry = webhook._CONFIRMATIONS.get(vid)
    assert done_entry is not None and done_entry.state == "done", f"Expected done vid state: {done_entry}"
    vok1_reply, _ = joined_send_messages(vok1_steps)
    assert vok1_reply and "Água L 2,5" in vok1_reply, f"Missing Água L confirmation: {vok1_reply!r}"

    # Stage 2c: second tap `vok:<vid>` (new update_id, same vid) -> blocked without LLM or sheet calls.
    mark = len(timeline)
    vok_update_2 = {
        "update_id": 1004,
        "callback_query": {
            "id": "cb-vok-2",
            "from": {"id": CHAT_ID, "is_bot": False, "first_name": "Local"},
            "message": vok_message,
            "data": f"{buttons.VOICE_OK}:{vid}",
        },
    }
    vok2_body, vok2_status = post(headers, vok_update_2, "/")
    vok2_steps = take_steps(mark)

    assert (vok2_status, vok2_body) == (200, "ok"), (
        f"Stage 2c duplicate vok failed: {(vok2_status, vok2_body)!r}"
    )
    assert callback_toasts(vok2_steps) == [VOICE_ALREADY_SENT], (
        f"Expected duplicate vok toast {VOICE_ALREADY_SENT!r}, got {callback_toasts(vok2_steps)}"
    )
    assert [t for t in vok2_steps if t["kind"] in ("llm", "transcribe_llm", "sheet_api")] == [], (
        f"Duplicate vok must make zero LLM/sheet calls, got {vok2_steps}"
    )
    vok2_reply, _ = joined_send_messages(vok2_steps)
    assert vok2_reply is None, f"Duplicate vok must not send a chat message, got {vok2_reply!r}"

    voice_trace = {
        "voice_update": {
            "request": {"method": "POST", "headers": headers, "json": voice_update},
            "response": {"status": voice_status, "body": voice_body},
            "vid": vid,
            "entendi_text": entendi_sent["text"],
            "reply_markup": entendi_sent.get("reply_markup"),
            "timeline": voice_steps,
        },
        "confirm_tap": {
            "request": {"method": "POST", "headers": headers, "json": vok_update_1},
            "response": {"status": vok1_status, "body": vok1_body},
            "reply_sent_to_telegram": vok1_reply.splitlines(),
            "timeline": vok1_steps,
        },
        "duplicate_tap": {
            "request": {"method": "POST", "headers": headers, "json": vok_update_2},
            "response": {"status": vok2_status, "body": vok2_body},
            "callback_toast": VOICE_ALREADY_SENT,
            "timeline": vok2_steps,
        },
    }

    # ---- Stage 3: Mini App Voice (`C7` — `web_app_data` `t:"text"` + `TextSubmissions`) ----
    miniapp_payload = {
        "v": 1,
        "t": "text",
        "id": MINIAPP_SUBMISSION_ID,
        "src": "voice",
        "text": MINIAPP_VOICE_TEXT,
    }
    raw_web_app_data = json.dumps(miniapp_payload, ensure_ascii=False)

    mark = len(timeline)
    miniapp_update_1 = {
        "update_id": 1005,
        "message": {
            "message_id": 3,
            "date": now_unix,
            "chat": {"id": CHAT_ID, "type": "private"},
            "from": {"id": CHAT_ID, "is_bot": False, "first_name": "Local"},
            "web_app_data": {"button_text": "🍽️ Refeição", "data": raw_web_app_data},
        },
    }
    ma1_body, ma1_status = post(headers, miniapp_update_1, "/")
    ma1_steps = take_steps(mark)

    assert (ma1_status, ma1_body) == (200, "ok"), f"Stage 3a Mini App text failed: {(ma1_status, ma1_body)!r}"
    ma1_sheet = [t for t in ma1_steps if t["kind"] == "sheet_api"]
    assert [s["request"]["op"] for s in ma1_sheet] == ["catalog", "food.add"], (
        f"Expected ['catalog', 'food.add'] in Stage 3a, got {[s['request']['op'] for s in ma1_sheet]}"
    )
    food_write = ma1_sheet[1]
    assert food_write["response"].get("ok") is True, f"Expected ok=True on Mini App food.add: {food_write}"
    expected_prefix = f"tg:{CHAT_ID}:miniapp:text:{MINIAPP_SUBMISSION_ID}:food.add:"
    actual_req_id = str(food_write["request"].get("requestId", ""))
    assert actual_req_id.startswith(expected_prefix), (
        f"Expected requestId starting with {expected_prefix!r}, got {actual_req_id!r}"
    )
    ma1_reply, _ = joined_send_messages(ma1_steps)
    assert ma1_reply and "Lanche" in ma1_reply and "Peito de frango cozido" in ma1_reply, (
        f"Unexpected Stage 3a Mini App reply: {ma1_reply!r}"
    )

    # Stage 3b: new update_id, same submission_id + same text -> stopped by TextSubmissions.
    mark = len(timeline)
    miniapp_update_2 = {
        "update_id": 1006,
        "message": {
            "message_id": 4,
            "date": now_unix,
            "chat": {"id": CHAT_ID, "type": "private"},
            "from": {"id": CHAT_ID, "is_bot": False, "first_name": "Local"},
            "web_app_data": {"button_text": "🍽️ Refeição", "data": raw_web_app_data},
        },
    }
    ma2_body, ma2_status = post(headers, miniapp_update_2, "/")
    ma2_steps = take_steps(mark)

    assert (ma2_status, ma2_body) == (200, "ok"), (
        f"Stage 3b duplicate Mini App failed: {(ma2_status, ma2_body)!r}"
    )
    assert [t for t in ma2_steps if t["kind"] in ("llm", "transcribe_llm", "sheet_api")] == [], (
        f"Duplicate Mini App submission must make zero LLM/sheet calls, got {ma2_steps}"
    )
    ma2_reply, _ = joined_send_messages(ma2_steps)
    assert ma2_reply == DONE_REPLY, f"Expected DONE_REPLY {DONE_REPLY!r}, got {ma2_reply!r}"

    miniapp_trace = {
        "submission": {
            "request": {"method": "POST", "headers": headers, "json": miniapp_update_1},
            "response": {"status": ma1_status, "body": ma1_body},
            "payload": miniapp_payload,
            "reply_sent_to_telegram": ma1_reply.splitlines(),
            "timeline": ma1_steps,
        },
        "duplicate_submission": {
            "request": {"method": "POST", "headers": headers, "json": miniapp_update_2},
            "response": {"status": ma2_status, "body": ma2_body},
            "reply_sent_to_telegram": ma2_reply.splitlines(),
            "timeline": ma2_steps,
        },
    }
    return voice_trace, miniapp_trace


def assert_reminder_and_final_sheets(
    remind_status: int,
    remind_text: str,
    reminded: list[str],
    sheets: dict[str, list[dict[str, Any]]],
    today: str,
    provider: ScriptedProvider,
    transcribe_provider: ScriptedTranscribeClient,
) -> dict[str, int]:
    assert provider.script == [], f"Unconsumed scripted agent turns: {len(provider.script)}"
    assert transcribe_provider.script == [], (
        f"Unconsumed scripted transcription turns: {len(transcribe_provider.script)}"
    )
    assert remind_status == 200 and remind_text == "sent 1", (
        f"Expected /remind daily -> (200, 'sent 1'), got {(remind_status, remind_text)!r}"
    )
    expected_remind = "Faltou registrar hoje: passos.\nÉ só mandar, por exemplo: 8k passos"
    assert reminded == [expected_remind], f"Unexpected daily reminder messages: {reminded!r}"

    diary_rows = sheets.get("Diário", [])
    workout_rows = sheets.get("Registro de treino", [])
    food_rows = sheets.get("Alimentação", [])

    assert len(diary_rows) == 1, f"Expected 1 Diário row, got {len(diary_rows)}: {diary_rows}"
    diary = diary_rows[0]
    assert diary.get("Data") == today
    assert diary.get("Peso kg") == 82.4
    assert diary.get("Sono h") == 7.5
    assert diary.get("Água L") == 2.5
    assert "Passos" not in diary, f"Steps must remain empty before reminder: {diary}"
    assert diary.get("kcal") == 501, f"Expected 501 kcal (338 lunch + 163 snack), got {diary.get('kcal')}"

    assert len(workout_rows) == 2, f"Expected 2 workout rows, got {len(workout_rows)}: {workout_rows}"
    assert [r.get("Exercício") for r in workout_rows] == ["Supino inclinado", "Puxada aberta"]
    assert all(r.get("Data") == today and r.get("Sessão") == "Upper" for r in workout_rows)

    assert len(food_rows) == 3, (
        f"Expected 3 food rows (no duplicate from retry), got {len(food_rows)}: {food_rows}"
    )
    assert [(r.get("Refeição"), r.get("Alimento"), r.get("Quantidade")) for r in food_rows] == [
        ("Almoço", "Arroz branco cozido", 150),
        ("Almoço", "Ovo inteiro cozido", 100),
        ("Lanche", "Peito de frango cozido", 100),
    ]
    return {
        "Diário": len(diary_rows),
        "Registro de treino": len(workout_rows),
        "Alimentação": len(food_rows),
    }


def main_run() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--real", action="store_true", help="call LLM_MODEL instead of the scripted provider")
    parser.add_argument(
        "--server",
        choices=["functions", "uvicorn"],
        default="functions",
        help="entry point: Functions Framework (Cloud Run functions) or the ASGI app (uvicorn)",
    )
    parser.add_argument("--message", default=DEFAULT_MESSAGE, help="text to send (scripted mode ignores it)")
    args = parser.parse_args()
    message = args.message if args.real else DEFAULT_MESSAGE
    today = datetime.now(TZ).date().isoformat()
    _reset_trace()
    # Model settings come from settings.yaml and services/agent/.env like in the real agent; the
    # Telegram and sheet values are replaced by local fakes below, so the run never reaches the
    # real bot or spreadsheet.
    load_dotenv(ENV_FILE)

    orig_webhook_httpx = webhook.httpx
    orig_webhook_build_handler = webhook.build_handler
    orig_handler_build_model = handler_module.build_model
    orig_reminder_http_client = reminder.http_client

    proc, sheet_url = start_sheet_server()
    try:
        os.environ.update(
            TELEGRAM_BOT_TOKEN="fake-bot-token",
            ALLOWED_CHAT_IDS=str(CHAT_ID),
            SHEET_API_URL=sheet_url,
            SHEET_API_KEY=SHEET_KEY,
            TELEGRAM_WEBHOOK_SECRET=WEBHOOK_SECRET,
            REMINDER_TOKEN=REMINDER_TOKEN,
        )
        if not args.real:
            os.environ.update(
                MEDIA_ENABLED="true",
                TRANSCRIBE_MODEL="gemini/gemini-3.8-flash",
                TRANSCRIBE_API_KEY=TRANSCRIBE_KEY,
                VOICE_API_URL="",
                APP_AUTH_SECRET="",
            )

        webhook.get_settings.cache_clear()
        webhook._get_budget.cache_clear()
        webhook._DEDUPLICATOR = UpdateDeduplicator()
        webhook._CONFIRMATIONS = VoiceConfirmations()
        settings = webhook.get_settings()
        if args.real:
            require_model_credentials(settings)

        telegram_state = TelegramState()
        provider = None if args.real else ScriptedProvider(scripted_turns(today))
        transcribe_provider = None if args.real else ScriptedTranscribeClient(scripted_transcriptions())
        # Shared across requests while webhook.py on origin/main does not yet pass text_submissions;
        # setdefault below yields immediately if webhook.handle_update passes its own instance.
        shared_text_submissions = TextSubmissions()

        def build_e2e_model(cfg: Settings) -> Any:
            inner = build_model(cfg, client=provider)
            return RecordingLlm(model=inner.model, inner=inner)

        def build_e2e_handler(cfg: Settings, http: httpx.AsyncClient, **kwargs: Any) -> Handler:
            if not args.real:
                assert kwargs.get("deduplicator") is webhook._DEDUPLICATOR
                assert kwargs.get("confirmations") is webhook._CONFIRMATIONS
                expected_budget = webhook._get_budget(
                    cfg.VOICE_DAILY_TOKENS, cfg.VOICE_GLOBAL_DAILY_TOKENS, cfg.TIMEZONE
                )
                assert kwargs.get("budget") is expected_budget
                assert transcribe_provider is not None
                kwargs["transcriber"] = build_transcriber(cfg, expected_budget, client=transcribe_provider)
                kwargs.setdefault("text_submissions", shared_text_submissions)
            return orig_webhook_build_handler(cfg, http, **kwargs)

        webhook.httpx = _WebhookHttpx(telegram_state)  # ty: ignore[invalid-assignment]
        webhook.build_handler = build_e2e_handler  # ty: ignore[invalid-assignment]
        handler_module.build_model = build_e2e_model  # ty: ignore[invalid-assignment]
        reminder.http_client = lambda: httpx.AsyncClient(  # ty: ignore[invalid-assignment]
            transport=RoutingTransport(telegram_state)
        )

        headers = {webhook.SECRET_HEADER: WEBHOOK_SECRET}
        update = {
            "update_id": 1001,
            "message": {
                "message_id": 1,
                "date": int(time.time()),
                "chat": {"id": CHAT_ID, "type": "private"},
                "from": {"id": CHAT_ID, "is_bot": False, "first_name": "Local"},
                "text": message,
            },
        }

        with contextlib.ExitStack() as stack:
            asgi_client = stack.enter_context(TestClient(asgi.app)) if args.server == "uvicorn" else None
            post = make_poster(args.server, asgi_client)

            started = time.monotonic()
            body, status = post(headers, update, "/")
            stage1_steps = take_steps(0)
            stage1_reply, stage1_keyboard = joined_send_messages(stage1_steps)

            voice_trace: dict[str, Any] | None = None
            miniapp_trace: dict[str, Any] | None = None
            rejected_summary: list[dict[str, Any]] | None = None
            if not args.real:
                rejected_summary = assert_stage1_typed_and_writestate(
                    status, body, stage1_steps, stage1_reply, stage1_keyboard
                )
                voice_trace, miniapp_trace = run_scripted_voice_and_miniapp(
                    post, headers, telegram_state, settings, today
                )

            elapsed = round(time.monotonic() - started, 2)

            # Daily reminder at the end: weight, sleep and water are logged, steps are still missing.
            remind_headers = {reminder.TOKEN_HEADER: REMINDER_TOKEN}
            remind_body = {"kind": "daily"}
            remind_text, remind_status = post(remind_headers, remind_body, reminder.PATH)
            reminder_steps = take_steps(0)

        sheets = httpx.get(sheet_url + "__sheets").json()
    finally:
        webhook.httpx = orig_webhook_httpx
        webhook.build_handler = orig_webhook_build_handler
        handler_module.build_model = orig_handler_build_model
        reminder.http_client = orig_reminder_http_client
        proc.kill()

    reminded = [
        t["body"]["text"]
        for t in reminder_steps
        if t["kind"] == "telegram_reply" and t["method"] == "sendMessage"
    ]

    assertions_trace: dict[str, Any] | None = None
    if not args.real:
        assert provider is not None and transcribe_provider is not None
        row_counts = assert_reminder_and_final_sheets(
            remind_status, remind_text, reminded, sheets, today, provider, transcribe_provider
        )
        assertions_trace = {
            "write_state_rejections": rejected_summary,
            "voice_chat_confirmed": True,
            "voice_chat_duplicate_blocked": True,
            "miniapp_voice_saved": True,
            "miniapp_voice_duplicate_blocked": True,
            "daily_reminder_missing_steps": True,
            "sheet_row_counts": row_counts,
        }

    trace: dict[str, Any] = {
        "scenario": {
            "mode": "real" if args.real else "scripted",
            "llm": f"{settings.LLM_MODEL} via LiteLLM" + ("" if args.real else " (provider scripted)"),
            "transcribe_model": None if args.real else f"{settings.TRANSCRIBE_MODEL} (provider scripted)",
            "server": "uvicorn (ASGI)" if args.server == "uvicorn" else "Functions Framework",
            "message": message,
            "today": today,
            "spreadsheet": "in-memory fake: apps/sheet4/src + synthetic client (e2e/sheet_server.js)",
            "elapsed_s": elapsed,
        },
        "webhook": {
            "request": {"method": "POST", "headers": headers, "json": update},
            "response": {"status": status, "body": body},
        },
        "timeline": stage1_steps,
        "reply_sent_to_telegram": stage1_reply.splitlines() if stage1_reply else None,
        "reply_markup": stage1_keyboard,
    }
    if voice_trace is not None:
        trace["voice_chat"] = voice_trace
    if miniapp_trace is not None:
        trace["miniapp_voice"] = miniapp_trace
    trace["reminder"] = {
        "request": {"path": reminder.PATH, "headers": remind_headers, "json": remind_body},
        "response": {"status": remind_status, "body": remind_text},
        "timeline": reminder_steps,
    }
    if assertions_trace is not None:
        trace["assertions"] = assertions_trace
    trace["sheet_after"] = sheets

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"run-{datetime.now(TZ):%Y%m%d-%H%M%S}.json"
    path.write_text(json.dumps(trace, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    all_steps = list(stage1_steps)
    if voice_trace is not None:
        for sub in voice_trace.values():
            all_steps.extend(sub["timeline"])
    if miniapp_trace is not None:
        for sub in miniapp_trace.values():
            all_steps.extend(sub["timeline"])
    kinds = [t["kind"] for t in all_steps]

    print(f"webhook → {status} {body} in {elapsed}s")
    print(
        f"llm calls: {kinds.count('llm')}"
        + (f" · transcribe calls: {kinds.count('transcribe_llm')}" if not args.real else "")
        + f" · sheet api calls: {kinds.count('sheet_api')}"
    )
    print("reply:\n  " + (stage1_reply or "(none)").replace("\n", "\n  "))
    if stage1_keyboard:
        row = stage1_keyboard.get("inline_keyboard", [[]])[0]
        print("buttons: " + " · ".join(f"{b['text']} [{b['callback_data']}]" for b in row))
    if not args.real and voice_trace is not None and miniapp_trace is not None:
        print(
            f"voice chat → Entendi [{voice_trace['voice_update']['vid']}] → vok saved Água L 2,5 "
            f"→ duplicate vok blocked ({voice_trace['duplicate_tap']['callback_toast']!r})"
        )
        print(f"miniapp voice → web_app_data t='text' saved Lanche → duplicate id blocked ({DONE_REPLY!r})")
    print(f"remind daily → {remind_status} {remind_text}: " + (" / ".join(reminded) or "(no message)"))
    print(f"trace: {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main_run()
