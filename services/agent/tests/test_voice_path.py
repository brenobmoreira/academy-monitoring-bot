"""End-to-end chat voice path (voice input design §3.2, §4.1, §8, task C4d).

Covers the real `Handler`, `Transcriber`, `MemoryBudget`, `VoiceConfirmations` and `Bot` together:
- audio (`voice` and `audio`) is transcribed once and answered with `🎙️ Entendi:`, never reaching
  `Bot.reply` inline; photos stay unchanged;
- the four C1 gaps (§8): `MEDIA_ENABLED=false` keeps captions, cross-provider agent fallbacks get
  plain text after `vok:<vid>`, non-audio transcription providers are refused at settings load,
  each `TranscribeError` maps to its §8 Portuguese reply, and `duration > VOICE_MAX_SECONDS` is
  refused before `getFile`;
- `caption + transcript` is formatted and SHA-256-verified bit-for-bit on `vok:<vid>` and `vfix:<vid>`;
- `build_handler` and `webhook.process` share the process `MemoryBudget` and `VoiceConfirmations`.
"""

from __future__ import annotations

import base64
import copy
import json
from datetime import datetime
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import litellm
import pytest
from google.adk.models.lite_llm import LiteLLMClient
from litellm.llms.custom_httpx.http_handler import AsyncHTTPHandler
from pydantic import SecretStr, ValidationError

from agent import buttons, webhook
from agent.bot import (
    MEDIA_DISABLED,
    MEDIA_UNREADABLE,
    VOICE_BUDGET,
    VOICE_EMPTY,
    VOICE_FAILED,
    VOICE_FORMAT,
    VOICE_TOO_LONG,
    Bot,
)
from agent.budget import MemoryBudget
from agent.handler import DOWNLOAD_FAILED, Handler, build_handler, too_large
from agent.llm import build_model
from agent.settings import Settings, TranscribeSettings
from agent.transcribe import MIN_BODY_BYTES, Transcriber
from agent.voice_confirm import VOICE_REGISTERING, VoiceConfirmations, sha256_hex

from .fakes import (
    OK_DIARY,
    FakeLiteLLMClient,
    FakeSheet,
    FakeTelegram,
    ScriptedLlm,
    call,
    file,
    media_update,
    say,
    text_response,
)

pytestmark = pytest.mark.unit

FAKE_OGG = b"OggS-fake-" + b"\x00" * MIN_BODY_BYTES
VOICE = {"file_id": "v1", "duration": 12, "mime_type": "audio/ogg", "file_size": len(FAKE_OGG)}
PHOTO = [{"file_id": "p1", "width": 800, "height": 600, "file_size": 4000}]
NOW = datetime(2026, 9, 21, 12, 0, tzinfo=ZoneInfo("America/Sao_Paulo"))


def settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "TELEGRAM_BOT_TOKEN": SecretStr("123456:fake-bot-token"),
        "TELEGRAM_WEBHOOK_SECRET": SecretStr("webhook-secret-token"),
        "ALLOWED_CHAT_IDS": frozenset({42}),
        "SHEET_API_URL": "https://sheet.example/exec",
        "SHEET_API_KEY": SecretStr("fake-sheet-api-key"),
        "LLM_MODEL": "gemini/gemini-3.8-flash",
        "LLM_API_KEY": SecretStr("fake-gemini-api-key"),
        "LLM_RETRIES": 0,
        "LLM_RETRY_WAIT_S": 0.0,
        "TRANSCRIBE_MODEL": "gemini/gemini-3.8-flash",
        "TRANSCRIBE_API_KEY": SecretStr("fake-transcribe-key"),
        "TRANSCRIBE_RETRIES": 0,
        "TRANSCRIBE_RETRY_WAIT_S": 0.0,
        "TRANSCRIBE_TIMEOUT_S": 5.0,
        "TRANSCRIBE_DEADLINE_S": 15.0,
        "VOICE_MAX_SECONDS": 90,
        "VOICE_DAILY_TOKENS": 120_000,
        "VOICE_GLOBAL_DAILY_TOKENS": 500_000,
        "VOICE_MIN_BITRATE_BPS": 6000,
        "TIMEZONE": "America/Sao_Paulo",
    }
    return Settings.model_construct(None, **{**base, **overrides})


def real_bot(script: list[Any], sheet: FakeSheet | None = None) -> tuple[Bot, ScriptedLlm, FakeSheet]:
    resolved_sheet = sheet or FakeSheet()
    llm = ScriptedLlm(model="scripted", script=script, requests=[])
    return Bot(resolved_sheet, llm, timezone="America/Sao_Paulo"), llm, resolved_sheet


def real_transcriber(
    script: list[Any],
    *,
    budget: MemoryBudget | None = None,
    **setting_overrides: Any,
) -> tuple[Transcriber, FakeLiteLLMClient, MemoryBudget]:
    s = settings(**setting_overrides)
    resolved_budget = budget or MemoryBudget(
        principal_daily=s.VOICE_DAILY_TOKENS,
        global_daily=s.VOICE_GLOBAL_DAILY_TOKENS,
        timezone=s.TIMEZONE,
    )
    client = FakeLiteLLMClient(script)
    return Transcriber(s, resolved_budget, client=client, clock=lambda: NOW), client, resolved_budget


def audio_blocks(messages: list[dict[str, Any]]) -> list[tuple[str, bytes]]:
    """(format, decoded bytes) of every `input_audio` block in the user messages."""
    found = []
    for message in messages:
        content = message["content"]
        if message["role"] == "user" and isinstance(content, list):
            found += [
                (p["input_audio"]["format"], base64.b64decode(p["input_audio"]["data"]))
                for p in content
                if p["type"] == "input_audio"
            ]
    return found


def extract_vid(tg: FakeTelegram, index: int = -1) -> str:
    markup = tg.options[index]["reply_markup"]
    data = markup["inline_keyboard"][0][0]["callback_data"]
    verb, _, vid = data.partition(":")
    assert verb == buttons.VOICE_OK
    return vid


def sent_entendi_tap(
    tg: FakeTelegram, verb: str = "vok", *, update_id: int = 99, index: int = -1
) -> dict[str, Any]:
    chat_id, text = tg.sent[index]
    vid = extract_vid(tg, index)
    message_id = len(tg.sent) if index == -1 else index + 1
    return {
        "update_id": update_id,
        "callback_query": {
            "id": f"cb-{update_id}",
            "data": f"{verb}:{vid}",
            "message": {
                "message_id": message_id,
                "date": 1_700_000_000,
                "chat": {"id": chat_id},
                "text": text,
            },
        },
    }


# ---- 1. Audio goes to Transcriber -> Entendi -> confirmed text to Bot; photos unchanged -----------


async def test_voice_and_audio_never_reach_bot_inline_and_confirm_runs_combined_caption_and_transcript():
    diary_result = OK_DIARY["result"]
    assert isinstance(diary_result, dict)
    diary_ok = {**OK_DIARY, "result": {**diary_result, "writeId": "w1"}}
    bot, llm, sheet = real_bot(
        [call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}), say("ok")],
        sheet=FakeSheet(diary_upsert=[diary_ok]),
    )
    transcriber, tx_client, _ = real_transcriber([text_response("peso 82,4 & dormi 7h30")])
    tg = FakeTelegram(files=file("v1", FAKE_OGG, "voice/f.oga"))
    confirmations = VoiceConfirmations()
    handler = Handler({42}, bot, tg, sheet=sheet, confirmations=confirmations, transcriber=transcriber)

    # Step 1: voice note with `<` and `&` in caption -> transcribed once, plain-text Entendi sent.
    await handler.handle_update(media_update(message_id=31, voice=VOICE, caption="  diário <hoje> & manhã  "))
    assert llm.requests == []
    assert len(tx_client.requests) == 1
    assert audio_blocks(tx_client.requests[0]["messages"]) == [("ogg", FAKE_OGG)]

    expected_body = "diário <hoje> & manhã\npeso 82,4 & dormi 7h30"
    assert tg.sent == [(42, buttons.entendi_text(expected_body))]
    vid = extract_vid(tg)
    assert tg.options[-1] == {
        "html": False,
        "reply_markup": buttons.voice_keyboard(vid),
        "reply_to": 31,
    }
    entry = confirmations.get(vid)
    assert entry is not None and entry.text_sha256 == sha256_hex(expected_body)

    # Step 2: tapping ✅ Confirmar verifies SHA-256 on the exact Entendi text and runs Bot on text.
    await handler.handle_update(sent_entendi_tap(tg, "vok", update_id=100))
    assert tg.answered == [("cb-100", VOICE_REGISTERING)]
    assert tg.edited == [(42, 1, None)]
    parts = llm.requests[0].contents[-1].parts
    assert parts is not None and len(parts) == 1 and parts[0].inline_data is None
    assert parts[0].text == expected_body
    assert sheet.request_ids[0] is not None and sheet.request_ids[0].startswith(f"tg:voice:{vid}:")
    assert tg.sent[-1] == (42, "<b>21/09</b> · Peso kg 82,4")
    assert tg.options[-1] == {"html": True, "reply_markup": buttons.keyboard(("w1",)), "reply_to": 1}
    settled = confirmations.get(vid)
    assert settled is not None and settled.state == "done"


async def test_vfix_on_entendi_with_caption_and_transcript_quotes_the_combined_text():
    bot, llm, _ = real_bot([say("ok")])
    m4a_bytes = b"m4a-fake-" + b"\x00" * MIN_BODY_BYTES
    transcriber, tx_client, _ = real_transcriber([text_response("supino <barra> 80 por 8")])
    tg = FakeTelegram(files=file("a1", m4a_bytes, "audio/a.m4a"))
    handler = Handler({42}, bot, tg, transcriber=transcriber)

    audio = {"file_id": "a1", "mime_type": "audio/mp4", "file_size": len(m4a_bytes), "duration": 10}
    await handler.handle_update(media_update(message_id=19, audio=audio, caption="treino Upper"))
    assert audio_blocks(tx_client.requests[0]["messages"]) == [("m4a", m4a_bytes)]
    assert llm.requests == []

    await handler.handle_update(sent_entendi_tap(tg, "vfix", update_id=101))
    assert llm.requests == []
    expected_prompt, expected_markup = buttons.voice_fix_prompt("treino Upper\nsupino <barra> 80 por 8")
    assert tg.sent[-1] == (42, expected_prompt)
    assert tg.options[-1]["reply_markup"] == expected_markup


@pytest.mark.parametrize(
    ("audio_field", "expected_format"),
    [
        ({"file_id": "a1", "file_size": MIN_BODY_BYTES + 10}, "mp3"),
        ({"file_id": "a1", "mime_type": "audio/mpeg", "file_size": MIN_BODY_BYTES + 10}, "mp3"),
        ({"file_id": "a1", "mime_type": "audio/mp4", "file_size": MIN_BODY_BYTES + 10}, "m4a"),
        ({"file_id": "a1", "mime_type": "audio/ogg; codecs=opus", "file_size": MIN_BODY_BYTES + 10}, "ogg"),
    ],
)
async def test_audio_reaches_transcriber_litellm_with_mapped_format_and_never_reaches_bot(
    audio_field: dict[str, Any], expected_format: str
):
    payload = b"audio-" + b"\x01" * MIN_BODY_BYTES
    bot, llm, _ = real_bot([say("ok")])
    transcriber, tx_client, _ = real_transcriber([text_response("almoço 150 g de arroz")])
    tg = FakeTelegram(files=file("a1", payload, "music/a.bin"))
    await Handler({42}, bot, tg, transcriber=transcriber).handle_update(media_update(audio=audio_field))

    assert llm.requests == []
    assert audio_blocks(tx_client.requests[0]["messages"]) == [(expected_format, payload)]
    assert tg.sent == [(42, buttons.entendi_text("almoço 150 g de arroz"))]


async def test_photo_path_remains_unchanged_and_still_reaches_bot_inline():
    bot, llm, _ = real_bot([say("ok")])
    transcriber, tx_client, _ = real_transcriber([text_response("should not run")])
    tg = FakeTelegram(files=file("p1", b"\xff\xd8jpeg-scale", "photos/p1.jpg"))
    await Handler({42}, bot, tg, transcriber=transcriber).handle_update(
        media_update(photo=PHOTO, caption="balança")
    )

    assert tx_client.requests == []
    photo_parts = llm.requests[0].contents[-1].parts
    assert photo_parts is not None
    inline, label = photo_parts
    assert inline.inline_data is not None
    assert (inline.inline_data.mime_type, inline.inline_data.data) == ("image/jpeg", b"\xff\xd8jpeg-scale")
    assert label.text == "[Anexo: foto]\nbalança"

    # MEDIA_UNREADABLE stays for photos rejected by the agent model (§8 row 3).
    reject_bot, _, _ = real_bot([ValueError("LiteLlm(BaseLlm) does not support content part image/jpeg")])
    reject_tg = FakeTelegram(files=file("p1", b"\xff\xd8jpeg", "photos/p1.jpg"))
    await Handler({42}, reject_bot, reject_tg, transcriber=transcriber).handle_update(
        media_update(photo=PHOTO)
    )
    assert reject_tg.sent == [(42, MEDIA_UNREADABLE)]


# ---- 2. C1 Gap 1 (§8): MEDIA_ENABLED=false runs captions as text and appends MEDIA_DISABLED -------


@pytest.mark.parametrize(
    "attachment",
    [
        {"voice": VOICE},
        {"audio": {"file_id": "a1", "duration": 120, "file_size": 99_000_000}},
        {"photo": PHOTO},
    ],
)
async def test_with_media_disabled_the_caption_is_still_processed(attachment: dict[str, Any]):
    diary_result = OK_DIARY["result"]
    assert isinstance(diary_result, dict)
    diary_ok = {**OK_DIARY, "result": {**diary_result, "writeId": "w7"}}
    bot, llm, sheet = real_bot(
        [call("save_diary", date="2026-09-21", fields={"weightKg": 82.4}), say("ok")],
        sheet=FakeSheet(diary_upsert=[diary_ok]),
    )
    tg = FakeTelegram()
    handler = Handler({42}, bot, tg, sheet=sheet, media_enabled=False)

    await handler.handle_update(
        {"update_id": 1, "message": {"chat": {"id": 42}, **attachment, "caption": "peso 82,4"}}
    )

    assert tg.fetched == []
    parts = llm.requests[0].contents[-1].parts
    assert (
        parts is not None
        and len(parts) == 1
        and parts[0].inline_data is None
        and parts[0].text == "peso 82,4"
    )
    assert tg.sent == [(42, f"<b>21/09</b> · Peso kg 82,4\n\n{MEDIA_DISABLED}")]
    assert tg.options[-1]["reply_markup"] == buttons.keyboard(("w7",))

    # Without a caption (or whitespace-only), only MEDIA_DISABLED is sent and the bot is not called.
    empty_tg = FakeTelegram()
    idle_bot, idle_llm, _ = real_bot([say("ok")])
    await Handler({42}, idle_bot, empty_tg, media_enabled=False).handle_update(
        {"update_id": 2, "message": {"chat": {"id": 42}, **attachment, "caption": "   "}}
    )
    assert empty_tg.fetched == []
    assert idle_llm.requests == []
    assert empty_tg.sent == [(42, MEDIA_DISABLED)]


async def test_with_media_disabled_a_command_caption_runs_the_command_and_appends_media_disabled():
    sheet = FakeSheet(
        day_get=[{"ok": True, "result": {"date": "2026-09-21", "diary": {}, "food": [], "workout": []}}]
    )
    bot, llm, _ = real_bot([say("ok")], sheet=sheet)
    tg = FakeTelegram()
    await Handler({42}, bot, tg, sheet=sheet, clock=lambda: NOW, media_enabled=False).handle_update(
        media_update(voice=VOICE, caption="/hoje")
    )

    assert tg.fetched == []
    assert llm.requests == []
    assert [op for op, _ in sheet.calls] == ["day.get"]
    assert tg.sent == [(42, f"Nada registrado em 21/09.\n\n{MEDIA_DISABLED}")]


# ---- 3. C1 Gap 2 (§8): Anthropic agent fallback gets plain text; non-audio transcribe refused -----


ANTHROPIC_OK = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "model": "claude-haiku-5-5",
    "content": [{"type": "text", "text": "ok"}],
    "stop_reason": "end_turn",
    "usage": {"input_tokens": 12, "output_tokens": 2},
}


class RealLiteLLM(LiteLLMClient):
    """Real `litellm.acompletion` for Anthropic with HTTP captured; primary `gemini/` fails 503."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.http: list[tuple[str, str, dict[str, Any]]] = []
        self._handler = AsyncHTTPHandler()
        self._created = self._handler.client
        self._injected = httpx.AsyncClient(transport=httpx.MockTransport(self._anthropic))
        self._handler.client = self._injected

    def _anthropic(self, request: httpx.Request) -> httpx.Response:
        self.http.append((request.method, str(request.url), json.loads(request.content)))
        return httpx.Response(200, json=ANTHROPIC_OK)

    async def aclose(self) -> None:
        await self._created.aclose()
        await self._injected.aclose()

    async def acompletion(self, model: Any, messages: Any, tools: Any, **kwargs: Any) -> Any:
        self.requests.append({"model": model, "messages": copy.deepcopy(messages)})
        if str(model).startswith("gemini/"):
            raise litellm.ServiceUnavailableError("busy", llm_provider="gemini", model=str(model))
        return await litellm.acompletion(
            model=model, messages=messages, tools=tools, client=self._handler, **kwargs
        )


@pytest.fixture
async def real_litellm():
    client = RealLiteLLM()
    try:
        yield client
    finally:
        await client.aclose()


async def test_a_fallback_of_another_provider_gets_the_transcript_as_text(real_litellm):
    agent_settings = settings(
        LLM_FALLBACK_MODEL="anthropic/claude-haiku-5-5",
        LLM_FALLBACK_API_KEY=SecretStr("anthropic-secret-key"),
    )
    bot = Bot(FakeSheet(), build_model(agent_settings, client=real_litellm), "UTC")
    transcriber, tx_client, _ = real_transcriber([text_response("supino 80 por 8")])
    tg = FakeTelegram(files=file("v1", FAKE_OGG, "voice/f.oga"))
    handler = Handler({42}, bot, tg, transcriber=transcriber)

    await handler.handle_update(media_update(voice=VOICE))
    assert len(tx_client.requests) == 1
    assert real_litellm.requests == []
    assert tg.sent == [(42, buttons.entendi_text("supino 80 por 8"))]

    await handler.handle_update(sent_entendi_tap(tg, "vok", update_id=102))
    primary, fallback = real_litellm.requests
    assert (primary["model"], fallback["model"]) == (
        "gemini/gemini-3.8-flash",
        "anthropic/claude-haiku-5-5",
    )
    assert audio_blocks(primary["messages"]) == audio_blocks(fallback["messages"]) == []
    [(method, url, body)] = real_litellm.http
    assert (method, url) == ("POST", "https://api.anthropic.com/v1/messages")
    assert body["model"] == "claude-haiku-5-5"
    assert body["messages"] == [{"role": "user", "content": [{"type": "text", "text": "supino 80 por 8"}]}]
    assert base64.b64encode(FAKE_OGG).decode() not in json.dumps(body)


@pytest.mark.parametrize(
    ("field", "bad_model"),
    [
        ("TRANSCRIBE_MODEL", "anthropic/claude-haiku-5-5"),
        ("TRANSCRIBE_MODEL", "openai/gpt-5.6"),
        ("TRANSCRIBE_FALLBACK_MODEL", "anthropic/claude-sonnet-5"),
    ],
)
def test_settings_refuse_a_transcribe_model_without_audio(field: str, bad_model: str):
    kwargs: dict[str, Any] = {
        "TRANSCRIBE_MODEL": "gemini/gemini-3.8-flash",
        "TRANSCRIBE_API_KEY": SecretStr("fake-gemini-api-key"),
        field: bad_model,
    }
    if field == "TRANSCRIBE_FALLBACK_MODEL":
        kwargs["TRANSCRIBE_FALLBACK_API_KEY"] = SecretStr("fake-fallback-api-key")
    with pytest.raises(ValidationError, match="gemini/<model> or vertex_ai/<model>"):
        TranscribeSettings(**kwargs)


# ---- 4. C1 Gap 3 & Gap 4 (§8): one end-to-end test per §8 message + duration before getFile -------


async def test_a_voice_note_over_the_duration_limit_is_refused_without_download():
    bot, llm, _ = real_bot([say("ok")])
    transcriber, tx_client, _ = real_transcriber([text_response("peso 82")])
    tg = FakeTelegram(files=file("v1", FAKE_OGG, "voice/f.oga"))
    handler = Handler({42}, bot, tg, transcriber=transcriber, voice_max_seconds=90)

    await handler.handle_update(
        {"update_id": 1, "message": {"chat": {"id": 42}, "voice": {**VOICE, "duration": 91}}}
    )
    await handler.handle_update(
        {"update_id": 2, "message": {"chat": {"id": 42}, "audio": {"file_id": "v1", "duration": 180}}}
    )
    assert tg.fetched == []
    assert tx_client.requests == []
    assert llm.requests == []
    assert tg.sent == [(42, VOICE_TOO_LONG), (42, VOICE_TOO_LONG)]


async def test_real_transcriber_errors_produce_exact_section_8_replies():
    bot, llm, _ = real_bot([say("ok")])

    # 1. unsupported_format -> VOICE_FORMAT
    tx, _, _ = real_transcriber([])
    tg_fmt = FakeTelegram(files=file("a1", FAKE_OGG, "audio/f.flac"))
    await Handler({42}, bot, tg_fmt, transcriber=tx).handle_update(
        media_update(audio={"file_id": "a1", "mime_type": "audio/flac", "file_size": len(FAKE_OGG)})
    )
    assert tg_fmt.sent == [(42, VOICE_FORMAT)]

    # 2. no_speech (< 1 KB and <vazio>) -> VOICE_EMPTY
    tx_empty, _, _ = real_transcriber([text_response("<vazio>")])
    tg_short = FakeTelegram(files=file("v1", b"tiny", "voice/short.oga"))
    await Handler({42}, bot, tg_short, transcriber=tx_empty).handle_update(
        media_update(voice={"file_id": "v1", "duration": 1, "mime_type": "audio/ogg", "file_size": 4})
    )
    tg_vazio = FakeTelegram(files=file("v1", FAKE_OGG, "voice/f.oga"))
    await Handler({42}, bot, tg_vazio, transcriber=tx_empty).handle_update(media_update(voice=VOICE))
    assert tg_short.sent == [(42, VOICE_EMPTY)]
    assert tg_vazio.sent == [(42, VOICE_EMPTY)]

    # 3. failed & timeout -> VOICE_FAILED (transient: retry with same update_id runs again when send failed)
    tx_fail, _, _ = real_transcriber(
        [
            litellm.ServiceUnavailableError("busy", llm_provider="gemini", model="gemini/gemini-3.8-flash"),
            litellm.Timeout("slow", model="gemini/gemini-3.8-flash", llm_provider="gemini"),
        ]
    )
    tg_fail = FakeTelegram(files=file("v1", FAKE_OGG, "voice/f.oga"))
    await Handler({42}, bot, tg_fail, transcriber=tx_fail).handle_update(
        {"update_id": 10, "message": {"chat": {"id": 42}, "voice": VOICE}}
    )
    await Handler({42}, bot, tg_fail, transcriber=tx_fail).handle_update(
        {"update_id": 11, "message": {"chat": {"id": 42}, "voice": VOICE}}
    )
    assert tg_fail.sent == [(42, VOICE_FAILED), (42, VOICE_FAILED)]

    # 4. budget_exhausted -> VOICE_BUDGET
    tiny_budget = MemoryBudget(principal_daily=100, global_daily=100, timezone="America/Sao_Paulo")
    tx_budget, budget_client, _ = real_transcriber([text_response("peso 82")], budget=tiny_budget)
    tg_budget = FakeTelegram(files=file("v1", FAKE_OGG, "voice/f.oga"))
    await Handler({42}, bot, tg_budget, transcriber=tx_budget).handle_update(media_update(voice=VOICE))
    assert budget_client.requests == []
    assert tg_budget.sent == [(42, VOICE_BUDGET)]
    assert llm.requests == []


# ---- 5. Process-level Budget & VoiceConfirmations in build_handler and webhook.process ------------


async def test_build_handler_and_webhook_share_budget_and_confirmations_across_requests(monkeypatch):
    s = settings(VOICE_DAILY_TOKENS=2_000, VOICE_GLOBAL_DAILY_TOKENS=2_000, VOICE_MAX_SECONDS=45)
    monkeypatch.setattr(webhook, "get_settings", lambda: s)
    monkeypatch.setattr(webhook, "_DEDUPLICATOR", webhook.UpdateDeduplicator())
    monkeypatch.setattr(webhook, "_CONFIRMATIONS", VoiceConfirmations())
    webhook._get_budget.cache_clear()

    sent_payloads: list[dict[str, Any]] = []

    def telegram_and_sheet_transport(request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url.endswith("/getFile"):
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "result": {"file_id": "v1", "file_size": len(FAKE_OGG), "file_path": "voice/f.oga"},
                },
            )
        if "/file/bot" in url:
            return httpx.Response(200, content=FAKE_OGG)
        if (
            url.endswith("/sendChatAction")
            or url.endswith("/answerCallbackQuery")
            or url.endswith("/editMessageReplyMarkup")
        ):
            return httpx.Response(200, json={"ok": True, "result": True})
        if url.endswith("/sendMessage"):
            body = json.loads(request.content)
            sent_payloads.append(body)
            return httpx.Response(
                200,
                json={
                    "ok": True,
                    "result": {
                        "message_id": len(sent_payloads),
                        "chat": {"id": body["chat_id"]},
                        "text": body["text"],
                    },
                },
            )
        return httpx.Response(200, json={"ok": True, "result": {}})

    tx_response = litellm.ModelResponse(
        choices=[{"message": {"role": "assistant", "content": "peso 82,4"}, "finish_reason": "stop"}],
        usage={"prompt_tokens": 1_500, "completion_tokens": 100},
    )
    tx_client = FakeLiteLLMClient([tx_response])
    llm = ScriptedLlm(model="scripted", script=[say("ok")], requests=[])

    real_build = build_handler

    def patched_build(cfg: Settings, _http: httpx.AsyncClient, **kwargs: Any) -> Handler:
        mock_http = httpx.AsyncClient(transport=httpx.MockTransport(telegram_and_sheet_transport))
        h = real_build(cfg, mock_http, **kwargs)
        assert h._voice_max_seconds == 45
        assert isinstance(h._transcriber, Transcriber)
        h._transcriber.client = tx_client
        h._bot = Bot(FakeSheet(), llm, timezone=cfg.TIMEZONE)
        return h

    monkeypatch.setattr(webhook, "build_handler", patched_build)

    # Request 1: voice note -> Entendi stored in webhook._CONFIRMATIONS, 1600 tokens charged to _get_budget.
    status = await webhook.process(
        "webhook-secret-token",
        {"update_id": 301, "message": {"message_id": 10, "chat": {"id": 42}, "voice": VOICE}},
    )
    assert status == ("ok", 200)
    entendi_msg = sent_payloads[-1]
    assert entendi_msg["text"] == buttons.entendi_text("peso 82,4")
    vid = entendi_msg["reply_markup"]["inline_keyboard"][0][0]["callback_data"].partition(":")[2]

    # Request 2: tap vok:<vid> in a brand-new webhook request -> finds vid in shared _CONFIRMATIONS!
    tap_body = {
        "update_id": 302,
        "callback_query": {
            "id": "cb-302",
            "data": f"vok:{vid}",
            "message": {
                "message_id": 1,
                "date": 1_700_000_000,
                "chat": {"id": 42},
                "text": entendi_msg["text"],
            },
        },
    }
    assert await webhook.process("webhook-secret-token", tap_body) == ("ok", 200)
    tap_parts = llm.requests[0].contents[-1].parts
    assert tap_parts is not None and tap_parts[0].text == "peso 82,4"

    # Request 3: second voice note needs reservation > remaining 400 tokens -> shared budget refuses!
    assert await webhook.process(
        "webhook-secret-token",
        {"update_id": 303, "message": {"message_id": 11, "chat": {"id": 42}, "voice": VOICE}},
    ) == ("ok", 200)
    assert sent_payloads[-1]["text"] == VOICE_BUDGET
    webhook._get_budget.cache_clear()


# ---- 6. Telegram file/getFile errors (preserved from C1) ------------------------------------------


async def test_a_file_that_getfile_reports_over_the_limit_is_not_downloaded():
    """The update carries no size, so only getFile tells; the download must not start."""
    bot, llm, _ = real_bot([say("ok")])
    big = {"file_id": "v1", "file_size": 20_000, "file_path": "voice/f.oga"}
    tg = FakeTelegram(files={"v1": (big, b"x")})
    await Handler({42}, bot, tg, media_max_bytes=10_000).handle_update(
        media_update(voice={**VOICE, "file_size": None})
    )
    assert tg.fetched == [("getFile", "v1")]
    assert tg.sent == [(42, too_large(10_000))]
    assert llm.requests == []


class GetFileFails(FakeTelegram):
    def __init__(self, result: Any = None, error: Exception | None = None) -> None:
        super().__init__()
        self._result, self._get_file_error = result, error

    async def get_file(self, file_id: str) -> dict[str, Any]:
        self.fetched.append(("getFile", file_id))
        if self._get_file_error:
            raise self._get_file_error
        return self._result


async def test_a_getfile_error_gets_the_download_warning_and_skips_the_model():
    bot, llm, _ = real_bot([say("ok")])
    tg = GetFileFails(error=RuntimeError("HTTP 400"))
    await Handler({42}, bot, tg).handle_update(media_update(voice=VOICE))
    assert tg.fetched == [("getFile", "v1")]
    assert tg.sent == [(42, DOWNLOAD_FAILED)]
    assert llm.requests == []


async def test_a_getfile_without_file_path_gets_the_download_warning_too():
    bot, llm, _ = real_bot([say("ok")])
    tg = GetFileFails(result={"file_id": "v1", "file_size": 9000})
    await Handler({42}, bot, tg).handle_update(media_update(voice=VOICE))
    assert tg.fetched == [("getFile", "v1")]
    assert tg.sent == [(42, DOWNLOAD_FAILED)]
    assert llm.requests == []


async def test_a_failed_file_fetch_does_not_burn_the_update_id_so_the_telegram_retry_is_processed():
    bot, llm, _ = real_bot([say("ok")])
    tg = GetFileFails(error=RuntimeError("HTTP 502"))
    handler = Handler({42}, bot, tg)
    await handler.handle_update(media_update(voice=VOICE))
    await handler.handle_update(media_update(voice=VOICE))
    assert tg.fetched == [("getFile", "v1")] * 2
    assert tg.sent == [(42, DOWNLOAD_FAILED)] * 2
    assert llm.requests == []
