"""Speech to text for voice notes (voice input design, §3), shared by the bot and the voice service.

One call: audio in, text out, through an audio-native model (Gemini, via LiteLLM). It runs inside the
caller's deadline and inside a token budget:

- every model attempt (the primary, each retry, the fallback: up to four) reserves the most it can
  cost, `E`, against the budget, then settles at what it did cost (`MeteredClient`);
- the whole call, waits and fallback included, ends at the deadline;
- what an attempt cost is never guessed down: no usage, or an outcome we cannot know (timeout, 5xx,
  connection lost, cancelled by the deadline), settles at `E`.

Nothing here logs audio, transcripts, principals or exception text (spec §10): an exception is
logged through `logs.describe()`.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import math
from collections import Counter
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any, Literal, NamedTuple

import litellm
from google.adk.models.lite_llm import LiteLLMClient

from agent.budget import Budget
from agent.llm import RetryingClient
from agent.logs import describe
from agent.settings import TranscribeSettings

log = logging.getLogger(__name__)

# Gemini bills audio at 32 tokens a second (spec §2).
AUDIO_TOKENS_PER_SECOND = 32
MAX_TOKENS = 600
# Longer than this is a looping model (90 s of speech is about 1500 characters).
MAX_TRANSCRIPT_CHARS = 2000
# Under this size there is no speech to send (spec §3.5).
MIN_BODY_BYTES = 1024
# Errors the provider answers before processing anything: the attempt cost nothing.
RELEASE_STATUSES = frozenset({400, 401, 403, 404, 413, 415, 429})

TRANSCRIBE_PROMPT = """\
Você transcreve áudios curtos em português do Brasil, gravados por uma pessoa que registra o
próprio treino de musculação, a alimentação e dados do dia (peso, sono, passos, água).

Regras:
1. Escreva exatamente o que foi dito, na ordem em que foi dito. Não resuma, não interprete, não
   corrija o conteúdo, não complete o que faltou e não responda a perguntas feitas no áudio.
2. Números sempre em algarismos, com vírgula decimal: "oitenta e dois e meio" → "82,5";
   "sete e meia" (horas de sono) → "7h30"; "oito mil passos" → "8000 passos".
3. Mantenha a forma falada de séries e cargas: "oitenta por oito" → "80 por 8"; "três de dez"
   → "3 de 10"; "rir dois" → "RIR 2". Não converta unidades.
4. Grafias usuais: supino, crucifixo, remada, puxada, desenvolvimento, elevação lateral,
   agachamento, leg press, stiff, terra, rosca, tríceps, panturrilha, RIR, aquecimento, feeder,
   work set, drop set, quilo (kg), grama (g), ml, colher de sopa, concha, fatia, unidade, whey,
   creatina, arroz, feijão, frango, ovo, batata-doce, aveia, banana, iogurte.
5. Trecho que não deu para entender: escreva [inaudível] no lugar dele. Nunca adivinhe um número.
6. Se não houver fala nenhuma, responda exatamente: <vazio>
7. Responda só com a transcrição, sem aspas, sem comentários e sem formatação.
"""
# Text tokens of TRANSCRIBE_PROMPT: 454, counted with LiteLLM's token_counter for the configured
# Gemini model (a generic tokenizer, offline; the provider's own `usage` for a real call is the check
# to make before the first deploy). It bounds the reservation and is the baseline of
# implied_audio_tokens(): too high only makes both more lenient.
TRANSCRIBE_PROMPT_TOKENS = 454

NO_SPEECH_MARK = "<vazio>"
UNINTELLIGIBLE = "[inaudível]"

# MIME (parameters stripped, lower case) -> LiteLLM `input_audio.format` (spec §3.2).
_FORMATS = {
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/webm": "webm",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/wave": "wav",
}
_QUOTES = (('"', '"'), ("'", "'"), ("“", "”"))
_TRANSIENT_CODES = frozenset({"failed", "timeout", "budget_exhausted"})

ErrorCode = Literal[
    "unsupported_format", "too_long", "no_speech", "failed", "timeout", "budget_exhausted", "disabled"
]


class Audio(NamedTuple):
    mime_type: str
    data: bytes
    # Seconds from a source we trust (Telegram's `duration`); sizes the reservation. Never from a client.
    trusted_seconds: int | None = None


class Usage(NamedTuple):
    prompt_tokens: int
    completion_tokens: int
    audio_tokens: int | None  # when the provider reports it


class Transcript(NamedTuple):
    text: str
    model: str  # the model that answered (primary or fallback)
    usage: Usage | None  # of the answering attempt; None = the provider sent no usable usage
    fallback: bool


class TranscribeError(Exception):
    """`code` is a closed list; the message is the code, never anything from the request."""

    def __init__(self, code: ErrorCode) -> None:
        super().__init__(code)
        self.code: ErrorCode = code
        self.transient = code in _TRANSIENT_CODES


def audio_format(mime_type: str) -> str | None:
    """LiteLLM's format for a MIME type, or None when the type is not accepted."""
    return _FORMATS.get(mime_type.split(";", 1)[0].strip().lower())


def reservation_tokens(audio: Audio, *, min_bitrate_bps: int) -> int:
    """`E`: the most one attempt can cost (spec §5.6). The audio's length is bounded by Telegram's
    duration when it is given, else by the body at the lowest bitrate an accepted format has: a client
    can claim any duration, the bytes cannot lie about how long they can last."""
    if audio.trusted_seconds is not None and audio.trusted_seconds > 0:
        seconds = audio.trusted_seconds
    else:
        seconds = math.ceil(len(audio.data) * 8 / min_bitrate_bps)
    return AUDIO_TOKENS_PER_SECOND * seconds + TRANSCRIBE_PROMPT_TOKENS + MAX_TOKENS


def implied_audio_tokens(usage: Usage | None) -> int | None:
    """The audio tokens of an attempt: reported, else the prompt tokens beyond our own prompt; None
    when there is no usage. Never negative."""
    if usage is None:
        return None
    if usage.audio_tokens is not None:
        return usage.audio_tokens
    return max(0, usage.prompt_tokens - TRANSCRIBE_PROMPT_TOKENS)


def _field(obj: Any, name: str) -> Any:
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def _count(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def parse_usage(response: Any) -> Usage | None:
    """Usage from a provider response; None unless prompt and completion tokens are both
    non-negative integers (a partial object is unavailable, values are never guessed). A prompt
    of 0 is unavailable too: our own system prompt makes it impossible, so it is a filled-in default."""
    usage = _field(response, "usage")
    if usage is None:
        return None
    prompt = _count(_field(usage, "prompt_tokens"))
    completion = _count(_field(usage, "completion_tokens"))
    if prompt is None or completion is None or prompt == 0:
        return None
    audio = _count(_field(_field(usage, "prompt_tokens_details"), "audio_tokens"))
    return Usage(prompt, completion, audio)


def _response_text(response: Any) -> str | None:
    choices = _field(response, "choices")
    if not isinstance(choices, list | tuple) or not choices:
        return None
    content = _field(_field(choices[0], "message"), "content")
    return content if isinstance(content, str) else None


def _clean(text: str) -> str:
    """Whitespace and one surrounding pair of quotes off (only when the quote is not also inside)."""
    text = text.strip()
    for opening, closing in _QUOTES:
        if len(text) >= 2 and text[0] == opening and text[-1] == closing:
            inner = text[1:-1]
            if opening not in inner and closing not in inner:
                return inner.strip()
    return text


def _is_no_speech(text: str) -> bool:
    return text == "" or text == NO_SPEECH_MARK or all(token == UNINTELLIGIBLE for token in text.split())


class BudgetRefused(Exception):
    """The budget would not cover another attempt (raised through RetryingClient, which re-raises
    anything it does not retry)."""


class MeteredClient(LiteLLMClient):
    """Reserves `tokens` (E) before each attempt and settles it after, whatever the outcome."""

    def __init__(
        self,
        inner: LiteLLMClient,
        budget: Budget,
        principal_key: str,
        tokens: int,
        clock: Callable[[], datetime],
    ) -> None:
        self.inner = inner
        self.budget = budget
        self.principal_key = principal_key
        self.tokens = tokens
        self.clock = clock
        # One entry per attempt: "released" or the tokens it was settled at (no content, no ids).
        self.settled: list[str] = []
        self.model: str | None = None  # of the last answered attempt
        self.usage: Usage | None = None  # of the last answered attempt

    async def acompletion(self, model: Any, messages: Any, tools: Any, **kwargs: Any) -> Any:
        reservation = self.budget.reserve(self.principal_key, self.tokens, self.clock())
        if reservation is None:
            raise BudgetRefused
        try:
            response = await self.inner.acompletion(model=model, messages=messages, tools=tools, **kwargs)
        except asyncio.CancelledError:
            # The deadline cancelled a request that may have been billed: paid, unknown.
            reservation.settle(self.tokens)
            self.settled.append(str(self.tokens))
            raise
        except Exception as err:
            if getattr(err, "status_code", None) in RELEASE_STATUSES:
                reservation.release()
                self.settled.append("released")
            else:
                reservation.settle(self.tokens)
                self.settled.append(str(self.tokens))
            raise
        usage = parse_usage(response)
        # What the provider says it counted (it can pass E for a long file); without it, E.
        charged = usage.prompt_tokens + usage.completion_tokens if usage is not None else self.tokens
        reservation.settle(charged)
        self.settled.append(str(charged))
        self.model = str(model)
        self.usage = usage
        return response


class Transcriber:
    def __init__(
        self,
        settings: TranscribeSettings,
        budget: Budget,
        *,
        client: LiteLLMClient | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self.settings = settings
        self.budget = budget
        self.client = client or LiteLLMClient()
        self.clock = clock or (lambda: datetime.now(UTC))
        # Counts without content (spec §10.4); `usage_missing`: no usage, or no audio tokens in it.
        self.counters: Counter[str] = Counter()

    def _effective_deadline(self, deadline_s: float | None) -> float:
        limit = self.settings.TRANSCRIBE_DEADLINE_S
        return limit if deadline_s is None else min(limit, deadline_s)

    def _request(self, audio: Audio, fmt: str) -> tuple[list[dict[str, Any]], dict[str, Any]]:
        s = self.settings
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": TRANSCRIBE_PROMPT},
            {
                "role": "user",
                "content": [
                    {
                        "type": "input_audio",
                        "input_audio": {"data": base64.b64encode(audio.data).decode("ascii"), "format": fmt},
                    }
                ],
            },
        ]
        kwargs: dict[str, Any] = {
            "temperature": 0,
            "max_tokens": MAX_TOKENS,
            "drop_params": True,
            "timeout": s.TRANSCRIBE_TIMEOUT_S,
        }
        key = s.transcribe_api_key()
        if key:
            kwargs["api_key"] = key
        if s.TRANSCRIBE_API_BASE:
            kwargs["api_base"] = s.TRANSCRIBE_API_BASE
        return messages, kwargs

    async def transcribe(
        self, audio: Audio, *, principal_key: str, deadline_s: float | None = None
    ) -> Transcript:
        s = self.settings
        fmt = audio_format(audio.mime_type)
        if fmt is None:
            raise TranscribeError("unsupported_format")
        if len(audio.data) < MIN_BODY_BYTES:
            raise TranscribeError("no_speech")
        effective = self._effective_deadline(deadline_s)
        if effective <= 0:
            raise TranscribeError("timeout")

        tokens = reservation_tokens(audio, min_bitrate_bps=s.VOICE_MIN_BITRATE_BPS)
        metered = MeteredClient(self.client, self.budget, principal_key, tokens, self.clock)
        client = RetryingClient(
            inner=metered,
            retries=s.TRANSCRIBE_RETRIES,
            wait_s=s.TRANSCRIBE_RETRY_WAIT_S,
            fallback_model=s.TRANSCRIBE_FALLBACK_MODEL,
            fallback_api_key=s.transcribe_fallback_api_key(),
        )
        messages, kwargs = self._request(audio, fmt)

        try:
            async with asyncio.timeout(effective):
                response = await client.acompletion(s.TRANSCRIBE_MODEL, messages, None, **kwargs)
        except BudgetRefused as err:
            raise self._failed("budget_exhausted", metered, err) from err
        except (TimeoutError, litellm.Timeout) as err:
            raise self._failed("timeout", metered, err) from err
        except Exception as err:
            raise self._failed("failed", metered, err) from err

        usage = metered.usage
        if usage is None or usage.audio_tokens is None:
            self.counters["usage_missing"] += 1

        raw = _response_text(response)
        if raw is None:
            raise self._failed("failed", metered, None)
        text = _clean(raw)
        if len(text) > MAX_TRANSCRIPT_CHARS:
            raise self._failed("failed", metered, None)
        if _is_no_speech(text):
            raise self._failed("no_speech", metered, None)

        model = metered.model or s.TRANSCRIBE_MODEL
        fallback = model != s.TRANSCRIBE_MODEL
        log.info(
            "transcribed: model=%s fallback=%s attempts=%d settled=%s tokens=%s",
            model,
            fallback,
            len(metered.settled),
            ",".join(metered.settled),
            f"{usage.prompt_tokens}+{usage.completion_tokens}" if usage else "unavailable",
        )
        return Transcript(text, model, usage, fallback)

    def _failed(
        self, code: ErrorCode, metered: MeteredClient, cause: BaseException | None
    ) -> TranscribeError:
        """The error to raise, after logging it without any content: its code, how each attempt was
        settled and the class chain of the cause."""
        log.warning(
            "transcription failed: code=%s attempts=%d settled=%s cause=%s",
            code,
            len(metered.settled),
            ",".join(metered.settled),
            describe(cause) if cause is not None else "none",
        )
        return TranscribeError(code)


def build_transcriber(
    settings: TranscribeSettings,
    budget: Budget,
    *,
    client: LiteLLMClient | None = None,
    clock: Callable[[], datetime] | None = None,
) -> Transcriber:
    return Transcriber(settings, budget, client=client, clock=clock)
