"""Local end-to-end run: mocked Telegram webhook → Python agent → LLM → Apps Script JS → JSON trace.

    cd services/agent
    uv run python ../../e2e/run.py                 # scripted LLM, no network at all
    uv run python ../../e2e/run.py --real \\
        --message "peso 82,4 dormi 7h30"           # real Gemini (GOOGLE_API_KEY or Vertex env)

What is real: agent.main.telegram_webhook (secret check), Handler, Bot/ADK runner, tools,
SheetClient over HTTP, and the Apps Script code (apps/sheet/src) running in Node.
What is mocked: the Telegram Bot API (replies are captured), the spreadsheet (in-memory fake with
the test fixtures' tabs), and — without --real — the LLM, which replays a fixed script that
includes two rejected payloads so the correction loop shows up in the trace.

The trace is written to e2e/out/run-<timestamp>.json.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from collections.abc import AsyncGenerator
from datetime import datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
from dotenv import load_dotenv
from flask import Request
from google.adk.models import BaseLlm, Gemini, LlmRequest, LlmResponse
from google.genai import types

from agent import handler as handler_module
from agent import main
from agent.bot import Bot
from agent.settings import Settings

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "e2e" / "out"
ENV_FILE = ROOT / "services" / "agent" / ".env"
TZ = ZoneInfo("America/Sao_Paulo")
CHAT_ID = 42
SHEET_KEY = "local-sheet-key"
WEBHOOK_SECRET = "local-webhook-secret"
DEFAULT_MESSAGE = "peso 82,4 dormi 7h30. upper: supino inclinado 60x8 62,5x8 rir 2, puxada 50x10 50x9"

timeline: list[dict[str, Any]] = []


def record(kind: str, **data: Any) -> None:
    timeline.append({"step": len(timeline) + 1, "kind": kind, **data})


# ---- LLM ---------------------------------------------------------------------------------


def call(name: str, **args: Any) -> types.Content:
    return types.Content(
        role="model", parts=[types.Part(function_call=types.FunctionCall(name=name, args=args))]
    )


def say(text: str) -> types.Content:
    return types.Content(role="model", parts=[types.Part(text=text)])


def scripted_turns(today: str) -> list[types.Content]:
    """What a model would do with DEFAULT_MESSAGE, including two mistakes the sheet rejects."""
    supino = {"name": "Supino inclinado", "sets": [{"kg": 60, "reps": 8}, {"kg": 62.5, "reps": 8}], "rir": 2}
    return [
        call("get_catalog"),
        call("save_diary", date=today, fields={"weightKg": 82.4, "sleepH": "7h30"}),
        call("save_diary", date=today, fields={"weightKg": 82.4, "sleepH": 7.5}),
        call(
            "save_workout",
            date=today,
            session="Upper",
            exercises=[supino, {"name": "puxada", "sets": [{"kg": 50, "reps": 10}, {"kg": 50, "reps": 9}]}],
        ),
        call(
            "save_workout",
            date=today,
            session="Upper",
            exercises=[
                supino,
                {"name": "Puxada aberta", "sets": [{"kg": 50, "reps": 10}, {"kg": 50, "reps": 9}]},
            ],
        ),
        say("ok"),
    ]


class ScriptedLlm(BaseLlm):
    script: list[types.Content]

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        yield LlmResponse(content=self.script.pop(0))


class RecordingLlm(BaseLlm):
    """Wraps any model and records each request (what the model sees) and response."""

    inner: BaseLlm

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        config = llm_request.config
        first_call = not any(t["kind"] == "llm" for t in timeline)
        request: dict[str, Any] = {"model": self.inner.model, "new_input": parts(llm_request.contents[-1])}
        if first_call:
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


class RoutingTransport(httpx.AsyncBaseTransport):
    def __init__(self) -> None:
        self._real = httpx.AsyncHTTPTransport()

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        if request.url.host == "api.telegram.org":
            record("telegram_reply", method=request.url.path.rsplit("/", 1)[-1], body=body)
            return httpx.Response(200, json={"ok": True, "result": {"message_id": 2}}, request=request)
        response = await self._real.handle_async_request(request)
        await response.aread()
        record("sheet_api", request=body, response=json.loads(response.content))
        return response


async def handle_with_mocks(settings: Any, update: dict[str, Any]) -> None:
    """Same as agent.main._handle, with an HTTP client that captures Telegram."""
    async with httpx.AsyncClient(transport=RoutingTransport()) as http:
        await handler_module.build_handler(settings, http).handle_update(update)


# ---- run -----------------------------------------------------------------------------------


def start_sheet_server() -> tuple[subprocess.Popen[str], str]:
    proc = subprocess.Popen(
        ["node", str(ROOT / "e2e" / "sheet_server.js")],
        stdout=subprocess.PIPE,
        text=True,
        env={**os.environ, "SHEET_API_KEY": SHEET_KEY},
    )
    line = proc.stdout.readline() if proc.stdout else ""
    if not line.startswith("LISTENING "):
        proc.kill()
        sys.exit(f"sheet server did not start: {line!r}")
    return proc, f"http://127.0.0.1:{line.split()[1]}/"


def require_model_credentials(settings: Settings) -> None:
    where = ENV_FILE.relative_to(ROOT)
    if settings.GOOGLE_GENAI_USE_VERTEXAI:
        if not settings.GOOGLE_CLOUD_PROJECT:
            sys.exit(f"--real with Vertex needs GOOGLE_CLOUD_PROJECT in {where}")
    elif not settings.GOOGLE_API_KEY:
        sys.exit(f"--real needs GOOGLE_API_KEY (AI Studio) in {where}")


def main_run() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--real", action="store_true", help="call Gemini instead of the scripted model")
    parser.add_argument("--message", default=DEFAULT_MESSAGE, help="text to send (scripted mode ignores it)")
    args = parser.parse_args()
    message = args.message if args.real else DEFAULT_MESSAGE
    today = datetime.now(TZ).date().isoformat()
    # Model settings come from settings.yaml and services/agent/.env like in the real agent; the
    # Telegram and sheet values are replaced by local fakes below, so the run never reaches the
    # real bot or spreadsheet.
    load_dotenv(ENV_FILE)

    proc, sheet_url = start_sheet_server()
    try:
        os.environ.update(
            TELEGRAM_BOT_TOKEN="fake-bot-token",
            ALLOWED_CHAT_IDS=str(CHAT_ID),
            SHEET_API_URL=sheet_url,
            SHEET_API_KEY=SHEET_KEY,
            TELEGRAM_WEBHOOK_SECRET=WEBHOOK_SECRET,
        )
        main._settings.cache_clear()
        settings = main._settings()
        if args.real:
            require_model_credentials(settings)
        inner = (
            Gemini(model=settings.GEMINI_MODEL)
            if args.real
            else ScriptedLlm(model="scripted", script=scripted_turns(today))
        )
        llm = RecordingLlm(model=inner.model, inner=inner)
        handler_module.Bot = lambda sheet, _model, **kw: Bot(sheet, llm, **kw)  # type: ignore[assignment]
        main._handle = handle_with_mocks  # type: ignore[assignment]

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
        headers = {"X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET}
        started = time.monotonic()
        body, status = main.telegram_webhook(Request.from_values(method="POST", headers=headers, json=update))
        elapsed = round(time.monotonic() - started, 2)
        sheets = httpx.get(sheet_url + "__sheets").json()
    finally:
        proc.kill()

    reply = next((t["body"]["text"] for t in timeline if t["kind"] == "telegram_reply"), None)
    trace = {
        "scenario": {
            "llm": "gemini (real)" if args.real else "scripted (mock)",
            "message": message,
            "today": today,
            "spreadsheet": "in-memory fake seeded with apps/sheet/test/fixtures.js",
            "elapsed_s": elapsed,
        },
        "webhook": {
            "request": {"method": "POST", "headers": headers, "json": update},
            "response": {"status": status, "body": body},
        },
        "timeline": timeline,
        "reply_sent_to_telegram": reply.splitlines() if reply else None,
        "sheet_after": sheets,
    }
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"run-{datetime.now(TZ):%Y%m%d-%H%M%S}.json"
    path.write_text(json.dumps(trace, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    kinds = [t["kind"] for t in timeline]
    print(f"webhook → {status} {body} in {elapsed}s")
    print(f"llm calls: {kinds.count('llm')} · sheet api calls: {kinds.count('sheet_api')}")
    print("reply:\n  " + (reply or "(none)").replace("\n", "\n  "))
    print(f"trace: {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main_run()
