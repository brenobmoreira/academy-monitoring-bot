"""How a voice/audio message travels today: Telegram update → Handler → Bot → model request.

These tests pin the CURRENT behaviour, good or bad; they change nothing. The pieces are tested one
by one in test_handler.py (Handler with a fake Bot), test_bot.py (Bot with a scripted model) and
test_llm.py (LiteLLM request shape). This file covers what none of them does: the real Handler and
the real Bot together, the mime-to-format mapping of `audio`, the Telegram file errors that the
others skip, and the fallback model of another provider. Tests named `test_gap_*` record a
behaviour that is probably unwanted (see the report of the change that added this file).

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

from typing import Any

import litellm
import pytest
from pydantic import SecretStr

from agent.bot import MEDIA_UNREADABLE, Bot, Media
from agent.handler import DOWNLOAD_FAILED, Handler, too_large
from agent.llm import build_model
from agent.settings import Settings

from .fakes import FakeLiteLLMClient, FakeSheet, ScriptedLlm, say, text_response
from .test_handler import FakeTelegram, file, media_update

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


@pytest.mark.parametrize(
    ("mime_type", "litellm_format"), [("audio/ogg", "ogg"), ("audio/mpeg", "mp3"), ("audio/mp4", "mp4")]
)
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
    gets only the media notice, and a retry as text is needed."""
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


class ProviderView(FakeLiteLLMClient):
    """Records what LiteLLM would really send to Anthropic: its own message conversion, run on the
    request the fallback receives (the real provider call is the only thing replaced)."""

    def __init__(self, script: list[Any]) -> None:
        super().__init__(script)
        self.anthropic_saw: list[Any] = []

    async def acompletion(self, model: Any, messages: Any, tools: Any, **kwargs: Any) -> Any:
        if str(model).startswith("anthropic/"):
            from litellm.litellm_core_utils.prompt_templates.factory import anthropic_messages_pt

            users = [m for m in messages if m["role"] == "user"]
            self.anthropic_saw = anthropic_messages_pt(
                users, model="claude-haiku-5-5", llm_provider="anthropic"
            )
        return await super().acompletion(model, messages, tools, **kwargs)


async def test_gap_a_fallback_of_another_provider_gets_the_audio_dropped_and_nobody_is_told():
    """CURRENT: the primary (Gemini) is overloaded, the fallback (Anthropic) receives the same
    messages, with `input_audio`; LiteLLM's conversion for Anthropic removes it, so the model sees
    only "[Anexo: áudio]". No code notices: the reply is whatever that model says (here the "ok" the
    prompt asks for after a clean save), not failed, not MEDIA_UNREADABLE. The only protection is
    prompt rule 16 plus the label."""
    overloaded = litellm.ServiceUnavailableError("busy", llm_provider="gemini", model="gemini-3.8-flash")
    client = ProviderView([overloaded, text_response("ok")])
    model = build_model(settings(LLM_FALLBACK_MODEL="anthropic/claude-haiku-5-5"), client=client)

    answer = await Bot(FakeSheet(), model, "UTC").reply("", media=[Media("audio/ogg", FAKE_OGG)])

    primary, fallback = client.requests
    assert (primary["model"], fallback["model"]) == ("gemini/gemini-3.8-flash", "anthropic/claude-haiku-5-5")
    assert primary["messages"] == fallback["messages"]  # RetryingClient does not adapt the media
    sent = [m for m in fallback["messages"] if m["role"] == "user"][-1]["content"]
    assert sent[0]["type"] == "input_audio"
    assert client.anthropic_saw == [{"role": "user", "content": [{"type": "text", "text": "[Anexo: áudio]"}]}]
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
