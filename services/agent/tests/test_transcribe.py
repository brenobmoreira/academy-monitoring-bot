"""Transcription (voice spec §3) and its use of the budget (§5.6). Audio, keys and ids are synthetic."""

import asyncio
import base64
import logging
import math
import time
from datetime import datetime
from types import SimpleNamespace
from typing import Any
from zoneinfo import ZoneInfo

import litellm
import pytest
from google.adk.models.lite_llm import LiteLLMClient
from pydantic import SecretStr

from agent.budget import MemoryBudget
from agent.settings import TranscribeSettings
from agent.transcribe import (
    TRANSCRIBE_PROMPT,
    TRANSCRIBE_PROMPT_TOKENS,
    Audio,
    TranscribeError,
    Transcriber,
    Usage,
    audio_format,
    build_transcriber,
    implied_audio_tokens,
    reservation_tokens,
)

from .fakes import FakeLiteLLMClient, text_response

pytestmark = pytest.mark.unit

NOON = datetime(2030, 3, 5, 12, 0, tzinfo=ZoneInfo("America/Sao_Paulo"))
AUDIO_SENTINEL = b"SENTINEL-AUDIO-7f3a"
TEXT_SENTINEL = "SENTINELA-TEXTO-91c2"
PRINCIPAL = "test:principal-1"
MODEL = "gemini/test-primary"
FALLBACK = "gemini/test-fallback"


def cfg(**overrides: Any) -> TranscribeSettings:
    base: dict[str, Any] = {
        "TRANSCRIBE_MODEL": MODEL,
        "TRANSCRIBE_API_KEY": SecretStr("primary-key-123"),
        "TRANSCRIBE_RETRY_WAIT_S": 0.0,
    }
    return TranscribeSettings.model_construct(**{**base, **overrides})


def with_fallback(**overrides: Any) -> TranscribeSettings:
    return cfg(TRANSCRIBE_FALLBACK_MODEL=FALLBACK, **overrides)


def ogg(size: int = 2048, trusted: int | None = None, mime: str = "audio/ogg") -> Audio:
    body = (AUDIO_SENTINEL * (size // len(AUDIO_SENTINEL) + 1))[:size]
    return Audio(mime, body, trusted)


def reply(text: str = "peso 82,5", prompt: int = 500, completion: int = 20, audio: int | None = None) -> Any:
    details = SimpleNamespace(audio_tokens=audio) if audio is not None else None
    usage = SimpleNamespace(prompt_tokens=prompt, completion_tokens=completion, prompt_tokens_details=details)
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))], usage=usage)


def reply_with_usage(usage: Any, text: str = "peso 82,5") -> Any:
    return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=text))], usage=usage)


class StatusError(Exception):
    def __init__(self, status_code: int) -> None:
        super().__init__("provider said no")
        self.status_code = status_code


def unavailable() -> Exception:
    return litellm.ServiceUnavailableError(message="busy", model="m", llm_provider="gemini")


def timed_out() -> Exception:
    return litellm.Timeout(message="slow", model="m", llm_provider="gemini")


class HangClient(LiteLLMClient):
    """A provider that never answers."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []

    async def acompletion(self, model: Any, messages: Any, tools: Any, **kwargs: Any) -> Any:
        self.requests.append({"model": model, **kwargs})
        await asyncio.Event().wait()


class RecordingBudget:
    """MemoryBudget that remembers what was asked of it."""

    def __init__(self, **limits: int) -> None:
        self.inner = MemoryBudget(
            principal_daily=limits.get("principal", 1_000_000),
            global_daily=limits.get("process", 1_000_000),
            timezone="America/Sao_Paulo",
        )
        self.reserved: list[int] = []

    def reserve(self, principal_key: str, tokens: int, now: datetime):
        self.reserved.append(tokens)
        return self.inner.reserve(principal_key, tokens, now)

    def used(self) -> int:
        return self.inner.used(PRINCIPAL, NOON)[0]


def make(
    script: list[Any] | None = None,
    settings: TranscribeSettings | None = None,
    budget: RecordingBudget | None = None,
    client: LiteLLMClient | None = None,
) -> tuple[Transcriber, Any, RecordingBudget]:
    fake = client or FakeLiteLLMClient(script if script is not None else [reply()])
    budget = budget or RecordingBudget()
    t = Transcriber(settings or cfg(), budget, client=fake, clock=lambda: NOON)
    return t, fake, budget


async def run(t: Transcriber, audio: Audio | None = None, **kwargs: Any):
    return await t.transcribe(audio or ogg(), principal_key=PRINCIPAL, **kwargs)


async def error_of(t: Transcriber, audio: Audio | None = None, **kwargs: Any) -> TranscribeError:
    with pytest.raises(TranscribeError) as caught:
        await run(t, audio, **kwargs)
    return caught.value


# --- formats ----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("mime", "fmt"),
    [
        ("audio/ogg", "ogg"),
        ("audio/opus", "ogg"),
        ("audio/webm", "webm"),
        ("audio/mp4", "m4a"),
        ("audio/m4a", "m4a"),
        ("audio/x-m4a", "m4a"),
        ("audio/aac", "aac"),
        ("audio/mpeg", "mp3"),
        ("audio/mp3", "mp3"),
        ("audio/wav", "wav"),
        ("audio/x-wav", "wav"),
        ("audio/wave", "wav"),
        ("audio/webm;codecs=opus", "webm"),
        ("Audio/OGG; codecs=opus", "ogg"),
        ("  audio/mp4 ", "m4a"),
    ],
)
def test_every_mime_of_the_spec_maps_to_its_format(mime, fmt):
    assert audio_format(mime) == fmt


@pytest.mark.parametrize(
    "mime", ["", "video/mp4", "audio/amr", "audio/flac", "application/octet-stream", "ogg"]
)
def test_any_other_mime_has_no_format(mime):
    assert audio_format(mime) is None


async def test_an_unsupported_format_is_refused_with_no_reservation_and_no_call():
    t, fake, budget = make()
    err = await error_of(t, ogg(mime="audio/amr"))
    assert (err.code, err.transient) == ("unsupported_format", False)
    assert fake.requests == []
    assert budget.reserved == []


async def test_each_accepted_mime_is_sent_with_its_format():
    for mime, fmt in [("audio/mp4", "m4a"), ("audio/webm;codecs=opus", "webm"), ("audio/mpeg", "mp3")]:
        t, fake, _ = make()
        await run(t, ogg(mime=mime))
        part = fake.requests[0]["messages"][1]["content"][0]
        assert part["input_audio"]["format"] == fmt


# --- the request ------------------------------------------------------------------------------


async def test_the_request_has_the_prompt_one_audio_part_and_fixed_parameters():
    t, fake, _ = make(settings=cfg(TRANSCRIBE_API_BASE="https://proxy.example/v1"))
    audio = ogg(3000)
    await run(t, audio)
    request = fake.requests[0]
    assert request["model"] == MODEL
    assert request["messages"][0] == {"role": "system", "content": TRANSCRIBE_PROMPT}
    assert request["messages"][1] == {
        "role": "user",
        "content": [
            {
                "type": "input_audio",
                "input_audio": {"data": base64.b64encode(audio.data).decode(), "format": "ogg"},
            }
        ],
    }
    assert len(request["messages"]) == 2
    assert request["temperature"] == 0
    assert request["max_tokens"] == 600
    assert request["timeout"] == 15
    assert request["api_key"] == "primary-key-123"
    assert request["api_base"] == "https://proxy.example/v1"
    assert request["tools"] is None
    assert request["num_retries"] == 0
    assert request["max_retries"] == 0


async def test_without_a_key_or_base_none_is_sent():
    t, fake, _ = make(settings=cfg(TRANSCRIBE_API_KEY=None))
    await run(t)
    assert "api_key" not in fake.requests[0]
    assert "api_base" not in fake.requests[0]


def test_the_prompt_pins_the_rules_the_spec_gives():
    assert "<vazio>" in TRANSCRIBE_PROMPT
    assert "[inaudível]" in TRANSCRIBE_PROMPT
    assert "82,5" in TRANSCRIBE_PROMPT
    assert TRANSCRIBE_PROMPT.startswith("Você transcreve áudios curtos em português do Brasil")


def test_the_prompt_token_estimate_is_a_conservative_count_of_the_prompt():
    chars = len(TRANSCRIBE_PROMPT)
    assert chars / 4 <= TRANSCRIBE_PROMPT_TOKENS <= chars / 2.5


# --- the result -------------------------------------------------------------------------------


async def test_a_transcript_carries_text_model_usage_and_fallback_flag():
    t, _, _ = make([reply("  peso 82,5  ", prompt=500, completion=20, audio=320)])
    result = await run(t)
    assert result.text == "peso 82,5"
    assert result.model == MODEL
    assert result.fallback is False
    assert result.usage == Usage(500, 20, 320)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('"peso 82,5"', "peso 82,5"),
        ("'peso 82,5'", "peso 82,5"),
        ("“peso 82,5”", "peso 82,5"),
        ('  "peso 82,5" \n', "peso 82,5"),
        ('"um" e "dois"', '"um" e "dois"'),
        ("supino [inaudível] por 8", "supino [inaudível] por 8"),
    ],
)
async def test_whitespace_and_one_pair_of_quotes_are_stripped(raw, expected):
    t, _, _ = make([reply(raw)])
    assert (await run(t)).text == expected


@pytest.mark.parametrize(
    "raw",
    [
        "<vazio>",
        "  <vazio>\n",
        '"<vazio>"',
        "",
        "   ",
        "[inaudível]",
        "[inaudível] [inaudível]",
        "\n[inaudível]\n",
    ],
)
async def test_no_speech_answers_are_recognised(raw):
    t, _, budget = make([reply(raw, prompt=400, completion=3)])
    err = await error_of(t)
    assert (err.code, err.transient) == ("no_speech", False)
    assert budget.used() == 403  # the attempt was paid for


async def test_more_than_2000_characters_is_a_looping_model():
    t, _, _ = make([reply("a" * 2001)])
    err = await error_of(t)
    assert (err.code, err.transient) == ("failed", True)
    t, _, _ = make([reply("a" * 2000)])
    assert len((await run(t)).text) == 2000


@pytest.mark.parametrize("response", [SimpleNamespace(choices=[]), SimpleNamespace(), None, "text"])
async def test_a_response_without_text_is_a_failure(response):
    t, _, _ = make([response])
    assert (await error_of(t)).code == "failed"


async def test_a_body_under_one_kilobyte_is_no_speech_without_a_model_call():
    t, fake, budget = make()
    err = await error_of(t, ogg(1023))
    assert (err.code, err.transient) == ("no_speech", False)
    assert fake.requests == []
    assert budget.reserved == []
    await run(t, ogg(1024))
    assert len(fake.requests) == 1


async def test_real_litellm_response_objects_are_understood():
    response = litellm.ModelResponse(
        choices=[{"message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
        usage={"prompt_tokens": 700, "completion_tokens": 9, "total_tokens": 709},
    )
    t, _, budget = make([response])
    result = await run(t)
    assert result.text == "ok"
    assert result.usage is not None
    assert result.usage[:2] == (700, 9)
    assert budget.used() == 709


# --- usage ------------------------------------------------------------------------------------


async def test_full_usage_fills_usage_and_settles_at_the_actual_amount():
    t, _, budget = make([reply(prompt=500, completion=20, audio=320)])
    result = await run(t)
    assert result.usage == Usage(500, 20, 320)
    assert budget.used() == 520
    assert t.counters["usage_missing"] == 0


async def test_no_usage_object_settles_at_the_reservation_and_is_counted():
    t, _, budget = make([text_response("peso 82,5")])
    result = await run(t, ogg(2048, trusted=20))
    assert result.usage is None
    assert result.text == "peso 82,5"
    assert budget.used() == budget.reserved[0]
    assert t.counters["usage_missing"] == 1


@pytest.mark.parametrize(
    "usage",
    [
        SimpleNamespace(prompt_tokens=100),
        SimpleNamespace(completion_tokens=10),
        SimpleNamespace(prompt_tokens="100", completion_tokens=10),
        SimpleNamespace(prompt_tokens=100, completion_tokens="10"),
        SimpleNamespace(prompt_tokens=100.5, completion_tokens=10),
        SimpleNamespace(prompt_tokens=100, completion_tokens=None),
        SimpleNamespace(prompt_tokens=-1, completion_tokens=10),
        SimpleNamespace(prompt_tokens=100, completion_tokens=-10),
        SimpleNamespace(prompt_tokens=True, completion_tokens=10),
        SimpleNamespace(prompt_tokens=0, completion_tokens=0),
        {"prompt_tokens": 100},
        {},
        "100 tokens",
    ],
)
async def test_a_partial_or_malformed_usage_counts_as_unavailable(usage):
    t, _, budget = make([reply_with_usage(usage)])
    result = await run(t, ogg(2048, trusted=20))
    assert result.usage is None
    assert budget.used() == budget.reserved[0]
    assert t.counters["usage_missing"] == 1


async def test_a_usage_given_as_a_dict_is_read():
    t, _, budget = make([reply_with_usage({"prompt_tokens": 400, "completion_tokens": 6})])
    result = await run(t)
    assert result.usage == Usage(400, 6, None)
    assert budget.used() == 406


async def test_usage_without_audio_tokens_keeps_the_rest_and_is_counted():
    t, _, budget = make([reply(prompt=500, completion=20, audio=None)])
    result = await run(t)
    assert result.usage == Usage(500, 20, None)
    assert budget.used() == 520
    assert t.counters["usage_missing"] == 1


def test_implied_audio_tokens():
    assert implied_audio_tokens(None) is None
    assert implied_audio_tokens(Usage(900, 10, 640)) == 640
    assert implied_audio_tokens(Usage(TRANSCRIBE_PROMPT_TOKENS + 640, 10, None)) == 640


def test_implied_audio_tokens_is_never_negative():
    assert implied_audio_tokens(Usage(10, 10, None)) == 0
    assert implied_audio_tokens(Usage(0, 0, None)) == 0


# --- the reservation per attempt (E) ----------------------------------------------------------


def test_e_for_a_trusted_duration_is_32_tokens_a_second_plus_prompt_plus_max_tokens():
    e = reservation_tokens(ogg(2048, trusted=20), min_bitrate_bps=6000)
    assert e == 32 * 20 + TRANSCRIBE_PROMPT_TOKENS + 600
    assert 1500 <= e <= 1700  # "about 1 600" (spec §5.6)


def test_e_without_a_trusted_duration_comes_from_the_size_at_the_lowest_bitrate():
    page = reservation_tokens(ogg(360_000), min_bitrate_bps=6000)
    assert page == 32 * math.ceil(360_000 * 8 / 6000) + TRANSCRIBE_PROMPT_TOKENS + 600
    assert 16_000 <= page <= 16_800  # "about 16 400"
    big = reservation_tokens(ogg(1_500_000), min_bitrate_bps=6000)
    assert big == 32 * 2000 + TRANSCRIBE_PROMPT_TOKENS + 600
    assert 64_000 <= big <= 66_000  # "about 65 000"


def test_e_uses_the_configured_minimum_bitrate():
    low = reservation_tokens(ogg(360_000), min_bitrate_bps=6000)
    high = reservation_tokens(ogg(360_000), min_bitrate_bps=12_000)
    assert high == 32 * 240 + TRANSCRIBE_PROMPT_TOKENS + 600
    assert high < low


def test_a_trusted_duration_of_zero_or_less_is_not_trusted():
    by_size = reservation_tokens(ogg(60_000), min_bitrate_bps=6000)
    assert reservation_tokens(ogg(60_000, trusted=0), min_bitrate_bps=6000) == by_size
    assert reservation_tokens(ogg(60_000, trusted=-5), min_bitrate_bps=6000) == by_size


async def test_the_attempt_reserves_e_from_trusted_seconds_when_given():
    t, _, budget = make()
    await run(t, ogg(2048, trusted=20))
    assert budget.reserved == [32 * 20 + TRANSCRIBE_PROMPT_TOKENS + 600]


async def test_the_attempt_reserves_e_from_the_body_at_6_kbps_otherwise():
    t, _, budget = make(settings=cfg(VOICE_MIN_BITRATE_BPS=6000))
    await run(t, ogg(360_000))
    assert budget.reserved == [32 * 480 + TRANSCRIBE_PROMPT_TOKENS + 600]


async def test_a_crafted_body_cannot_declare_its_way_to_a_small_reservation():
    # No trusted duration (the HTTP path): a 1.5 MB body reserves for 2000 s, whatever it claims.
    t, _, budget = make()
    await run(t, ogg(1_500_000))
    assert budget.reserved == [32 * 2000 + TRANSCRIBE_PROMPT_TOKENS + 600]


# --- settlement -------------------------------------------------------------------------------


async def test_actual_usage_above_the_reservation_is_charged_in_full():
    t, _, budget = make([reply(prompt=9000, completion=100)])
    await run(t, ogg(2048, trusted=1))
    assert budget.reserved[0] < 9100
    assert budget.used() == 9100


async def test_actual_usage_below_the_reservation_is_what_is_charged():
    t, _, budget = make([reply(prompt=400, completion=10)])
    await run(t, ogg(2048, trusted=60))
    assert budget.used() == 410


@pytest.mark.parametrize(
    "make_error",
    [
        lambda: litellm.BadRequestError(message="x", model="m", llm_provider="gemini"),
        lambda: litellm.AuthenticationError(message="x", model="m", llm_provider="gemini"),
        lambda: StatusError(403),
        lambda: litellm.NotFoundError(message="x", model="m", llm_provider="gemini"),
        lambda: StatusError(413),
        lambda: StatusError(415),
        lambda: litellm.RateLimitError(message="x", model="m", llm_provider="gemini"),
    ],
    ids=["400", "401", "403", "404", "413", "415", "429"],
)
async def test_an_error_answered_before_processing_releases_the_reservation(make_error):
    t, fake, budget = make([make_error()], settings=cfg(TRANSCRIBE_RETRIES=0))
    err = await error_of(t)
    assert err.code == "failed"
    assert len(fake.requests) == 1
    assert len(budget.reserved) == 1
    assert budget.used() == 0


@pytest.mark.parametrize(
    "make_error",
    [
        unavailable,
        lambda: litellm.InternalServerError(message="x", model="m", llm_provider="gemini"),
        lambda: litellm.APIConnectionError(message="x", model="m", llm_provider="gemini"),
        lambda: StatusError(422),
        lambda: StatusError(502),
        lambda: ConnectionResetError("lost"),
        lambda: ValueError("odd"),
    ],
    ids=["503", "500", "connection", "422", "502", "reset", "other"],
)
async def test_an_unknown_outcome_settles_the_reservation_in_full(make_error):
    t, _, budget = make([make_error()], settings=cfg(TRANSCRIBE_RETRIES=0))
    err = await error_of(t)
    assert (err.code, err.transient) == ("failed", True)
    assert budget.used() == budget.reserved[0]


async def test_a_provider_timeout_settles_in_full_and_is_a_timeout():
    t, _, budget = make([timed_out()], settings=cfg(TRANSCRIBE_RETRIES=0))
    err = await error_of(t)
    assert (err.code, err.transient) == ("timeout", True)
    assert budget.used() == budget.reserved[0]


async def test_a_released_attempt_followed_by_success_is_charged_only_for_the_success():
    t, _, budget = make(
        [
            litellm.RateLimitError(message="x", model="m", llm_provider="gemini"),
            reply(prompt=500, completion=20),
        ]
    )
    await run(t)
    assert len(budget.reserved) == 2
    assert budget.used() == 520


# --- attempts: up to four (llm.py: retries + 1 per model, primary then fallback) ---------------


async def test_with_a_fallback_a_request_makes_up_to_four_attempts_each_reserved_and_settled():
    t, fake, budget = make([unavailable() for _ in range(4)], settings=with_fallback(TRANSCRIBE_RETRIES=1))
    err = await error_of(t, ogg(2048, trusted=10))
    assert (err.code, err.transient) == ("failed", True)
    assert [r["model"] for r in fake.requests] == [MODEL, MODEL, FALLBACK, FALLBACK]
    e = 32 * 10 + TRANSCRIBE_PROMPT_TOKENS + 600
    assert budget.reserved == [e, e, e, e]
    assert budget.used() == 4 * e


async def test_without_a_fallback_it_is_two_attempts():
    t, fake, budget = make([unavailable(), unavailable()], settings=cfg(TRANSCRIBE_RETRIES=1))
    await error_of(t, ogg(2048, trusted=10))
    assert len(fake.requests) == 2
    assert budget.used() == 2 * (32 * 10 + TRANSCRIBE_PROMPT_TOKENS + 600)


async def test_a_timeout_skips_to_the_fallback_and_both_attempts_are_charged():
    t, fake, budget = make([timed_out(), reply()], settings=with_fallback(TRANSCRIBE_RETRIES=1))
    result = await run(t, ogg(2048, trusted=10))
    assert [r["model"] for r in fake.requests] == [MODEL, FALLBACK]
    assert result.fallback is True
    assert result.model == FALLBACK
    e = 32 * 10 + TRANSCRIBE_PROMPT_TOKENS + 600
    assert budget.used() == e + 520  # the timed-out attempt at E, the answer at its actual usage


async def test_the_fallback_gets_its_own_key_and_never_the_primary_base():
    settings = with_fallback(
        TRANSCRIBE_API_BASE="https://proxy.example/v1",
        TRANSCRIBE_FALLBACK_API_KEY=SecretStr("fallback-key-12"),
    )
    t, fake, _ = make([unavailable(), unavailable(), reply()], settings=settings)
    await run(t)
    primary, fallback = fake.requests[0], fake.requests[2]
    assert primary["api_key"] == "primary-key-123"
    assert primary["api_base"] == "https://proxy.example/v1"
    assert fallback["model"] == FALLBACK
    assert fallback["api_key"] == "fallback-key-12"
    assert "api_base" not in fallback


async def test_the_fallback_of_the_same_provider_uses_the_primary_key():
    t, fake, _ = make([unavailable(), unavailable(), reply()], settings=with_fallback())
    await run(t)
    assert fake.requests[2]["api_key"] == "primary-key-123"


# --- the budget refuses -----------------------------------------------------------------------


async def test_a_budget_refusing_before_the_first_attempt_makes_no_call():
    budget = RecordingBudget(principal=100)
    t, fake, _ = make(budget=budget)
    err = await error_of(t, ogg(2048, trusted=20))
    assert (err.code, err.transient) == ("budget_exhausted", True)
    assert fake.requests == []
    assert budget.used() == 0


async def test_a_budget_refusing_before_the_fallback_stops_there_and_keeps_the_charge():
    e = 32 * 10 + TRANSCRIBE_PROMPT_TOKENS + 600
    budget = RecordingBudget(principal=e + e // 2)
    t, fake, _ = make([timed_out()], settings=with_fallback(TRANSCRIBE_RETRIES=0), budget=budget)
    err = await error_of(t, ogg(2048, trusted=10))
    assert (err.code, err.transient) == ("budget_exhausted", True)
    assert len(fake.requests) == 1
    assert budget.used() == e  # the first attempt stays charged


async def test_a_budget_refusing_before_a_retry_stops_there_too():
    e = 32 * 10 + TRANSCRIBE_PROMPT_TOKENS + 600
    budget = RecordingBudget(process=e + 10)
    t, fake, _ = make([unavailable()], settings=cfg(TRANSCRIBE_RETRIES=2), budget=budget)
    err = await error_of(t, ogg(2048, trusted=10))
    assert err.code == "budget_exhausted"
    assert len(fake.requests) == 1
    assert budget.used() == e


async def test_a_real_memory_budget_is_shared_between_calls_of_one_principal():
    budget = RecordingBudget(principal=3000)
    t, _, _ = make([reply(prompt=1000, completion=100)] * 5, budget=budget)
    await run(t, ogg(2048, trusted=10))
    await run(t, ogg(2048, trusted=10))
    assert budget.used() == 2200
    assert (await error_of(t, ogg(2048, trusted=10))).code == "budget_exhausted"


# --- the deadline -----------------------------------------------------------------------------


async def test_a_deadline_of_zero_or_less_is_a_timeout_with_no_reservation_and_no_call():
    for deadline in (0, 0.0, -1, -0.5):
        t, fake, budget = make()
        err = await error_of(t, deadline_s=deadline)
        assert (err.code, err.transient) == ("timeout", True)
        assert fake.requests == []
        assert budget.reserved == []


async def test_without_a_per_call_deadline_the_setting_is_the_limit():
    hang = HangClient()
    t, _, budget = make(client=hang, settings=cfg(TRANSCRIBE_DEADLINE_S=0.05, TRANSCRIBE_TIMEOUT_S=0.05))
    started = time.monotonic()
    err = await asyncio.wait_for(error_of(t, ogg(2048, trusted=10), deadline_s=None), 5)
    assert time.monotonic() - started < 2
    assert (err.code, err.transient) == ("timeout", True)
    assert budget.used() == budget.reserved[0]  # the cancelled attempt is paid, unknown: E


async def test_a_smaller_per_call_deadline_wins():
    hang = HangClient()
    t, _, budget = make(client=hang, settings=cfg(TRANSCRIBE_DEADLINE_S=60))
    started = time.monotonic()
    err = await error_of(t, ogg(2048, trusted=10), deadline_s=0.05)
    assert time.monotonic() - started < 2
    assert err.code == "timeout"
    assert budget.used() == budget.reserved[0]


async def test_a_larger_per_call_deadline_does_not_extend_the_setting():
    hang = HangClient()
    t, _, _ = make(client=hang, settings=cfg(TRANSCRIBE_DEADLINE_S=0.05, TRANSCRIBE_TIMEOUT_S=0.05))
    started = time.monotonic()
    err = await asyncio.wait_for(error_of(t, deadline_s=500), 5)
    assert time.monotonic() - started < 2
    assert err.code == "timeout"


async def test_a_provider_that_never_answers_ends_at_the_deadline_despite_retries_and_a_fallback():
    hang = HangClient()
    settings = with_fallback(TRANSCRIBE_DEADLINE_S=0.1, TRANSCRIBE_TIMEOUT_S=0.1, TRANSCRIBE_RETRIES=3)
    t, _, budget = make(client=hang, settings=settings)
    started = time.monotonic()
    err = await error_of(t, ogg(2048, trusted=10))
    assert time.monotonic() - started < 2
    assert (err.code, err.transient) == ("timeout", True)
    assert len(hang.requests) == 1  # the attempt in flight was cancelled; nothing else started
    e = 32 * 10 + TRANSCRIBE_PROMPT_TOKENS + 600
    assert budget.used() == e


async def test_the_deadline_also_covers_the_wait_between_retries():
    t, fake, budget = make(
        [unavailable()],
        settings=cfg(TRANSCRIBE_RETRY_WAIT_S=30, TRANSCRIBE_RETRIES=2, TRANSCRIBE_DEADLINE_S=0.2),
    )
    started = time.monotonic()
    err = await error_of(t, ogg(2048, trusted=10))
    assert time.monotonic() - started < 3
    assert err.code == "timeout"
    assert len(fake.requests) == 1
    assert budget.used() == 32 * 10 + TRANSCRIBE_PROMPT_TOKENS + 600


# --- logging (voice spec §10) -----------------------------------------------------------------


def leaky(cause_text: str) -> Exception:
    err = litellm.ServiceUnavailableError(message=cause_text, model="m", llm_provider="gemini")
    err.body = cause_text  # type: ignore[attr-defined]
    err.__cause__ = RuntimeError(cause_text)
    return err


def everything_logged(caplog: pytest.LogCaptureFixture) -> str:
    return "\n".join(
        f"{r.getMessage()}|{r.args!r}|{r.exc_text}|{r.stack_info}|{r.exc_info!r}" for r in caplog.records
    )


async def test_a_failure_logs_the_class_of_the_error_and_never_its_content(caplog):
    caplog.set_level(logging.DEBUG)
    leak = f"{AUDIO_SENTINEL.decode()} {TEXT_SENTINEL} {base64.b64encode(AUDIO_SENTINEL).decode()}"
    t, _, _ = make([leaky(leak) for _ in range(2)], settings=cfg(TRANSCRIBE_RETRIES=1))
    err = await error_of(t)
    logged = everything_logged(caplog)
    assert err.code == "failed"
    assert AUDIO_SENTINEL.decode() not in logged
    assert TEXT_SENTINEL not in logged
    assert base64.b64encode(AUDIO_SENTINEL).decode() not in logged
    ours = [r.getMessage() for r in caplog.records if r.name == "agent.transcribe"]
    assert any("ServiceUnavailableError" in m and "code=failed" in m for m in ours)
    assert str(err) == "failed"
    assert all(r.exc_info is None for r in caplog.records)


async def test_a_success_logs_no_transcript_and_no_audio(caplog):
    caplog.set_level(logging.DEBUG)
    t, _, _ = make([reply(text=f"supino {TEXT_SENTINEL}")])
    result = await run(t)
    assert TEXT_SENTINEL in result.text
    logged = everything_logged(caplog)
    assert TEXT_SENTINEL not in logged
    assert AUDIO_SENTINEL.decode() not in logged
    assert PRINCIPAL not in logged


async def test_no_speech_and_a_deadline_log_nothing_sensitive(caplog):
    caplog.set_level(logging.DEBUG)
    t, _, _ = make(client=HangClient(), settings=cfg(TRANSCRIBE_DEADLINE_S=0.05, TRANSCRIBE_TIMEOUT_S=0.05))
    await error_of(t)
    assert AUDIO_SENTINEL.decode() not in everything_logged(caplog)


# --- assembly ---------------------------------------------------------------------------------


def test_build_transcriber_assembles_from_settings():
    budget = RecordingBudget()
    t = build_transcriber(cfg(), budget, client=FakeLiteLLMClient([]))
    assert isinstance(t, Transcriber)
