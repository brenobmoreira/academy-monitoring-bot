"""How a voice/audio message travels today: Telegram update → Handler → Bot → model request.

These tests pin the CURRENT behaviour, good or bad; they change nothing. The pieces are tested one
by one in test_handler.py (Handler with a fake Bot), test_bot.py (Bot with a scripted model) and
test_llm.py (LiteLLM request shape). This file covers what none of them does: the real Handler and
the real Bot together, the mime-to-format mapping of `audio`, the Telegram file errors that the
others skip, and the fallback model of another provider. Tests named `test_gap_*` record a
behaviour that is probably unwanted: each docstring states the DESIRED behaviour, and the
assertions must be inverted (not deleted) when the gap is fixed.

Already covered elsewhere, not repeated here:
- file above MEDIA_MAX_BYTES refused without download, friendly reply:
  test_handler.py::test_a_file_over_the_limit_is_refused_without_downloading and
  ::test_a_download_larger_than_telegram_announced_is_refused
- MEDIA_ENABLED=false answers MEDIA_UNREADABLE, nothing downloaded:
  test_handler.py::test_media_disabled_answers_with_the_text_hint_without_downloading
- the download (not getFile) failing: test_handler.py::
  test_a_failed_download_gets_its_own_warning_and_skips_the_bot and
  test_a_download_that_outlives_the_deadline_gets_the_download_failure_reply
- `voice` as ogg input_audio at LiteLLM: test_llm.py::
  test_a_voice_message_reaches_litellm_as_input_audio_in_ogg_format
"""

import base64
import copy
import json
from typing import Any

import httpx
import litellm
import pytest
from google.adk.models.lite_llm import LiteLLMClient
from litellm.llms.custom_httpx.http_handler import AsyncHTTPHandler
from pydantic import SecretStr

from agent.bot import MEDIA_UNREADABLE, Bot, Media
from agent.handler import DOWNLOAD_FAILED, Handler, too_large
from agent.llm import build_model
from agent.settings import Settings

from .fakes import (
    FakeLiteLLMClient,
    FakeSheet,
    FakeTelegram,
    ScriptedLlm,
    file,
    media_update,
    say,
    text_response,
)

pytestmark = pytest.mark.unit

VOICE = {"file_id": "v1", "duration": 3, "mime_type": "audio/ogg", "file_size": 9000}
FAKE_OGG = b"OggS-fake"  # not a recording: only bytes to follow through the pipeline


def real_bot(script):
    llm = ScriptedLlm(model="scripted", script=script, requests=[])
    return Bot(FakeSheet(), llm, timezone="America/Sao_Paulo"), llm


def user_parts(llm):
    return llm.requests[0].contents[-1].parts


# 1. voice and audio reach the model as inline media next to "[Anexo: áudio]"


async def test_a_voice_message_reaches_the_model_inline_with_the_audio_label():
    bot, llm = real_bot([say("ok")])
    tg = FakeTelegram(files=file("v1", FAKE_OGG, "voice/f.oga"))
    await Handler({42}, bot, tg).handle_update(media_update(voice=VOICE))
    inline, label = user_parts(llm)
    assert (inline.inline_data.mime_type, inline.inline_data.data) == ("audio/ogg", FAKE_OGG)
    assert label.text == "[Anexo: áudio]"
    assert len(llm.requests[0].contents[-1].parts) == 2


async def test_an_audio_file_without_mime_type_is_taken_as_mpeg_and_labelled():
    bot, llm = real_bot([say("ok")])
    tg = FakeTelegram(files=file("a1", b"ID3-fake", "music/a.mp3"))
    await Handler({42}, bot, tg).handle_update(media_update(audio={"file_id": "a1", "file_size": 8}))
    inline, label = user_parts(llm)
    assert (inline.inline_data.mime_type, inline.inline_data.data) == ("audio/mpeg", b"ID3-fake")
    assert label.text == "[Anexo: áudio]"


@pytest.mark.parametrize(("mime_type", "litellm_format"), [("audio/mpeg", "mp3"), ("audio/mp4", "mp4")])
async def test_audio_reaches_litellm_as_input_audio_with_the_format_of_its_mime_type(
    mime_type, litellm_format
):
    client = FakeLiteLLMClient([text_response("ok")])
    bot = Bot(FakeSheet(), build_model(settings(), client=client), "UTC")
    await bot.reply("", media=[Media(mime_type, b"abc")])
    user = [m for m in client.requests[0]["messages"] if m["role"] == "user"][-1]["content"]
    assert user[0] == {"type": "input_audio", "input_audio": {"data": "YWJj", "format": litellm_format}}
    assert user[1] == {"type": "text", "text": "[Anexo: áudio]"}


# 2. size limit: only what the existing tests do not cover


async def test_a_file_that_getfile_reports_over_the_limit_is_not_downloaded():
    """The update carries no size, so only getFile tells; the download must not start."""
    bot, llm = real_bot([say("ok")])
    big = {"file_id": "v1", "file_size": 20_000, "file_path": "voice/f.oga"}
    tg = FakeTelegram(files={"v1": (big, b"x")})
    await Handler({42}, bot, tg, media_max_bytes=10_000).handle_update(
        media_update(voice={**VOICE, "file_size": None})
    )
    assert tg.fetched == [("getFile", "v1")]
    assert tg.sent == [(42, too_large(10_000))]
    assert llm.requests == []


# 4. caption and audio travel together


async def test_the_caption_of_an_audio_goes_in_the_same_text_part_after_the_label():
    bot, llm = real_bot([say("ok")])
    tg = FakeTelegram(files=file("a1", b"m4a-fake"))
    audio = {"file_id": "a1", "mime_type": "audio/mp4", "file_size": 8}
    await Handler({42}, bot, tg).handle_update(media_update(audio=audio, caption="treino de hoje"))
    inline, text = user_parts(llm)
    assert (inline.inline_data.mime_type, inline.inline_data.data) == ("audio/mp4", b"m4a-fake")
    assert text.text == "[Anexo: áudio]\ntreino de hoje"


# 3. MEDIA_ENABLED=false: the part not covered by test_handler.py


async def test_gap_with_media_disabled_the_caption_is_dropped_too():
    """CURRENT: "peso 82,4" typed as the caption of a voice message is not processed: the person
    gets only the media notice, and a retry as text is needed.

    DESIRED: the caption is handled as an ordinary text message (the bot runs on it) and the reply
    also says the attachment was ignored because media is off. When fixed, invert the assertions:
    the bot is called with "peso 82,4" and no media, and nothing is downloaded."""
    bot, llm = real_bot([say("ok")])
    tg = FakeTelegram()
    update = media_update(voice=VOICE, caption="peso 82,4")
    await Handler({42}, bot, tg, media_enabled=False).handle_update(update)
    assert llm.requests == []
    assert tg.fetched == []
    assert tg.sent == [(42, MEDIA_UNREADABLE)]


# 5. main model fails, fallback of another provider drops the audio


def settings(**overrides: Any) -> Settings:
    base: dict[str, Any] = {
        "TELEGRAM_BOT_TOKEN": SecretStr("tok"),
        "ALLOWED_CHAT_IDS": frozenset({42}),
        "SHEET_API_URL": "https://x/exec",
        "SHEET_API_KEY": SecretStr("k"),
        "LLM_MODEL": "gemini/gemini-3.8-flash",
        "LLM_RETRIES": 0,
        "LLM_RETRY_WAIT_S": 0,
    }
    return Settings.model_construct(None, **{**base, **overrides})


ANTHROPIC_OK = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "model": "claude-haiku-5-5",
    "content": [{"type": "text", "text": "ok"}],
    "stop_reason": "end_turn",
    "usage": {"input_tokens": 1, "output_tokens": 1},
}


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


class RealLiteLLM(LiteLLMClient):
    """The real `litellm.acompletion` (its provider selection and message conversion) with the HTTP
    transport replaced: what goes out to Anthropic is captured instead of sent. Only the primary's
    overload is simulated, before LiteLLM (any `gemini/` model fails with 503).

    `requests` keeps a deep copy of each call from the retry layer; `http` the (method, URL, JSON
    body) that left. `aclose` closes both HTTP clients: the one LiteLLM's handler creates on its
    own and the one injected in its place."""

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


async def test_gap_a_fallback_of_another_provider_gets_the_audio_dropped_and_nobody_is_told(real_litellm):
    """CURRENT: the primary (Gemini) is overloaded and the fallback (Anthropic) receives the same
    request, audio included; LiteLLM's real conversion for Anthropic then leaves the audio out of the
    HTTP body, so that model sees only "[Anexo: áudio]". Nothing in our code notices: the reply is
    whatever that model says (here the "ok" the prompt asks for after a clean save), not `failed`,
    not MEDIA_UNREADABLE. The only protection is prompt rule 16 plus the label.

    DESIRED: audio never goes silently to a model that cannot take it: the fallback is skipped or
    the person gets MEDIA_UNREADABLE (or the audio is transcribed first). When fixed, invert the
    last assertions: no "ok", `answer.text == MEDIA_UNREADABLE` (or an audio block in the body)."""
    client = real_litellm
    model = build_model(
        settings(
            LLM_FALLBACK_MODEL="anthropic/claude-haiku-5-5", LLM_FALLBACK_API_KEY=SecretStr("anthropic-key")
        ),
        client=client,
    )

    answer = await Bot(FakeSheet(), model, "UTC").reply("", media=[Media("audio/ogg", FAKE_OGG)])

    primary, fallback = client.requests
    assert (primary["model"], fallback["model"]) == ("gemini/gemini-3.8-flash", "anthropic/claude-haiku-5-5")
    # The retry layer hands the same audio (format and bytes) to both models, unadapted.
    assert audio_blocks(primary["messages"]) == audio_blocks(fallback["messages"]) == [("ogg", FAKE_OGG)]
    # What actually left for Anthropic: one call, no audio, only the label.
    [(method, url, body)] = client.http
    assert (method, url) == ("POST", "https://api.anthropic.com/v1/messages")
    assert body["model"] == "claude-haiku-5-5"
    assert body["messages"] == [{"role": "user", "content": [{"type": "text", "text": "[Anexo: áudio]"}]}]
    assert base64.b64encode(FAKE_OGG).decode() not in json.dumps(body)
    assert (answer.text, answer.failed, answer.wrote) == ("ok", False, False)


# 6. getFile failing (the download failing is covered in test_handler.py)


class GetFileFails(FakeTelegram):
    def __init__(self, result: Any = None, error: Exception | None = None) -> None:
        super().__init__()
        self._result, self._get_file_error = result, error

    async def get_file(self, file_id):
        self.fetched.append(("getFile", file_id))
        if self._get_file_error:
            raise self._get_file_error
        return self._result


async def test_a_getfile_error_gets_the_download_warning_and_skips_the_model():
    bot, llm = real_bot([say("ok")])
    tg = GetFileFails(error=RuntimeError("HTTP 400"))
    await Handler({42}, bot, tg).handle_update(media_update(voice=VOICE))
    assert tg.fetched == [("getFile", "v1")]  # no download attempted
    assert tg.sent == [(42, DOWNLOAD_FAILED)]
    assert llm.requests == []


async def test_a_getfile_without_file_path_gets_the_download_warning_too():
    bot, llm = real_bot([say("ok")])
    tg = GetFileFails(result={"file_id": "v1", "file_size": 9000})
    await Handler({42}, bot, tg).handle_update(media_update(voice=VOICE))
    assert tg.fetched == [("getFile", "v1")]
    assert tg.sent == [(42, DOWNLOAD_FAILED)]
    assert llm.requests == []


async def test_a_failed_file_fetch_does_not_burn_the_update_id_so_the_telegram_retry_is_processed():
    bot, llm = real_bot([say("ok")])
    tg = GetFileFails(error=RuntimeError("HTTP 502"))
    handler = Handler({42}, bot, tg)
    await handler.handle_update(media_update(voice=VOICE))
    await handler.handle_update(media_update(voice=VOICE))  # same update_id (2)
    assert tg.fetched == [("getFile", "v1")] * 2
    assert tg.sent == [(42, DOWNLOAD_FAILED)] * 2
