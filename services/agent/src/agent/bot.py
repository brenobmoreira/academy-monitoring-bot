"""One Telegram message in, one reply out: an ADK agent with the sheet tools, run single-turn."""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import datetime
from typing import NamedTuple
from zoneinfo import ZoneInfo

from google.adk.agents import LlmAgent
from google.adk.agents.callback_context import CallbackContext
from google.adk.agents.invocation_context import LlmCallsLimitExceededError
from google.adk.agents.run_config import RunConfig
from google.adk.models import BaseLlm, LlmRequest
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.genai import types

from agent.format import escape
from agent.summary import confirmation
from agent.tools import Journal, SheetApi, build_tools

log = logging.getLogger(__name__)

APP_NAME = "fitness-log"
WEEKDAYS = [
    "segunda-feira",
    "terça-feira",
    "quarta-feira",
    "quinta-feira",
    "sexta-feira",
    "sábado",
    "domingo",
]

# What the user sees when the run cannot finish normally (see Bot.reply).
MODEL_FAILED = "⚠ O modelo não respondeu agora. Nada novo foi gravado além do que aparece acima."
MODEL_FAILED_NOTHING_WRITTEN = "⚠ O modelo não respondeu agora. Nada foi gravado."
SHEET_FAILED = "⚠ A planilha não respondeu. Tente de novo em alguns minutos."
MEDIA_UNREADABLE = "Não consegui ler o áudio/foto com o modelo configurado; envie em texto."

INSTRUCTION = """\
Você registra o diário de saúde e treino de uma pessoa numa planilha do Google, a partir de \
mensagens curtas em português do Brasil.
Hoje é {today} ({weekday}), fuso {timezone}.

Ferramentas:
- get_catalog: sessões, nomes exatos dos exercícios, ficha e fase atual.
- save_diary: dados do dia (peso, sono, passos, cardio, Muay Thai, dieta, cintura, fome, \
cansaço, observações).
- save_workout: exercícios de musculação com séries.
- get_exercise_history: sessões anteriores de um exercício.
- get_diary_history: dados do Diário num período (até 92 dias), para perguntas como "como está \
meu peso nas últimas 2 semanas?".

Regras:
1. Datas sempre em yyyy-MM-dd. Resolva "ontem", "sábado" etc. a partir de hoje. Sem data na \
mensagem, use hoje.
2. Grave só o que a mensagem diz. Nunca invente, estime ou complete valores.
3. Sono em horas decimais (7h30 = 7.5). "8k passos" = 8000. Sim/não viram true/false.
4. "60x8 62x8" são duas séries: 60 kg × 8 e 62 kg × 8. "3x10 40kg" são três séries de 10 com \
40 kg. Peso corporal é kg 0.
5. Antes de save_workout ou get_exercise_history, chame get_catalog e use exatamente os nomes \
de sessão e exercício de lá. Sem sessão na mensagem, deduza pela ficha a partir dos exercícios.
6. Não informe phase; a planilha usa a fase atual.
7. Se uma ferramenta devolver ok=false, leia cada erro (path, message, suggestions), corrija \
exatamente esses campos e chame de novo. Se não houver como corrigir sem inventar (ex.: \
exercício sem correspondente no catálogo), grave o resto sem esse item e diga o que ficou de fora.
8. Se o erro tiver code "unavailable" ou "internal", não insista: diga que a planilha não \
respondeu.
9. Não faça perguntas de volta: grave o que for inequívoco e explique em uma frase o que não gravou.
10. Resposta final curta, em português. O sistema já envia a confirmação do que foi gravado: \
não repita os valores. Se tudo foi gravado sem ressalvas, responda apenas "ok". Para perguntas \
(ex.: histórico), responda com os dados das ferramentas.
11. Para perguntas sobre um período, resolva-o a partir de hoje ("últimas 2 semanas" = de 13 \
dias atrás até hoje; "este mês" = do dia 1 até hoje) e chame get_diary_history. Responda só \
com os dias e campos que vierem: dia ausente não foi registrado; nunca invente, estime ou \
preencha dias ou valores que faltam, e diga quantos dias com dado a resposta cobre.
12. Mensagem com áudio: transcreva o que foi dito e aplique as mesmas regras ao texto. Com foto \
(balança, tela de app de passos, sono ou treino): leia os valores mostrados e aplique as mesmas \
regras. Nunca adivinhe um dígito ilegível ou um trecho inaudível: grave o resto e diga o que não \
deu para ler. Se a mensagem indica áudio ou foto anexados mas você não recebeu o conteúdo, não \
grave nada e responda que não conseguiu ler o áudio/foto.
"""


def instruction(now: datetime) -> str:
    return INSTRUCTION.format(
        today=now.date().isoformat(), weekday=WEEKDAYS[now.weekday()], timezone=now.tzinfo or "UTC"
    )


class Media(NamedTuple):
    """A file sent with the message (voice, audio, photo), passed to the model inline."""

    mime_type: str
    data: bytes


def media_label(media: list[Media]) -> str:
    """The text line that tells the model what is attached, so it can say so when a provider
    drops the content silently (LiteLLM leaves out `input_audio` for Anthropic, for instance)."""
    kinds = ["áudio" if m.mime_type.startswith("audio/") else "foto" for m in media]
    return "[Anexo: " + ", ".join(kinds) + "]"


def media_rejected(error: Exception) -> bool:
    """Whether a model error means the provider or ADK's conversion refused the media, as opposed
    to a transient failure: ADK raises ValueError for a MIME type it cannot convert, providers
    answer 400/422 (LiteLLM's BadRequestError, its subclasses, UnprocessableEntityError)."""
    if isinstance(error, ValueError):
        return True
    try:
        import litellm
    except ImportError:  # pragma: no cover - litellm ships with google-adk[extensions]
        return False
    return isinstance(error, litellm.BadRequestError | litellm.UnprocessableEntityError)


class Bot:
    def __init__(
        self,
        sheet: SheetApi,
        model: str | BaseLlm,
        timezone: str,
        clock: Callable[[], datetime] | None = None,
        max_llm_calls: int = 8,
    ) -> None:
        self._sheet = sheet
        self._model = model
        self._zone = ZoneInfo(timezone)
        self._clock = clock or (lambda: datetime.now(self._zone))
        self._max_llm_calls = max_llm_calls

    async def reply(self, text: str, user_id: str = "telegram", *, media: list[Media] | None = None) -> str:
        """Runs the agent on one message. No memory between messages: each one is a fresh session.

        `media` (voice, audio, photo) goes to the model as inline data after a line naming it,
        followed by `text` (the caption, possibly empty).

        A failed model call (provider error, timeout) and a sheet that did not answer get their
        own replies, always after the confirmation of what was written before; a model error
        that rejects the media gets MEDIA_UNREADABLE. Any other error propagates to the handler.
        """
        journal = Journal()
        model_errors: list[Exception] = []

        def on_model_error(
            callback_context: CallbackContext, llm_request: LlmRequest, error: Exception
        ) -> None:
            # Only marks the error as the model's; returning None lets ADK re-raise it.
            model_errors.append(error)

        now = self._clock()
        agent = LlmAgent(
            name="fitness_logger",
            model=self._model,
            # A callable instruction is not treated as a template, so literal braces are safe.
            instruction=lambda _ctx: instruction(now),
            tools=build_tools(self._sheet, journal),
            on_model_error_callback=on_model_error,
        )
        sessions = InMemorySessionService()
        runner = Runner(app_name=APP_NAME, agent=agent, session_service=sessions)
        session = await sessions.create_session(app_name=APP_NAME, user_id=user_id)
        parts = [types.Part(text=text)]
        if media:
            label = media_label(media)
            parts = [types.Part(inline_data=types.Blob(mime_type=m.mime_type, data=m.data)) for m in media]
            parts.append(types.Part(text=f"{label}\n{text}" if text.strip() else label))
        message = types.Content(role="user", parts=parts)
        final, note = "", ""
        try:
            async for event in runner.run_async(
                user_id=user_id,
                session_id=session.id,
                new_message=message,
                run_config=RunConfig(max_llm_calls=self._max_llm_calls),
            ):
                if event.is_final_response() and event.content and event.content.parts:
                    final = "".join(p.text or "" for p in event.content.parts if not p.thought)
        except LlmCallsLimitExceededError:
            log.warning("LLM call budget exhausted for message %r", text)
            note = "Parei no limite de tentativas; o que não aparece acima não foi gravado."
        except Exception as err:
            if err not in model_errors:
                raise
            if media and media_rejected(err):
                log.exception("model rejected the media of message %r", text)
                note = MEDIA_UNREADABLE
            else:
                log.exception("model call failed for message %r", text)
                note = MODEL_FAILED if journal.writes else MODEL_FAILED_NOTHING_WRITTEN
        if journal.sheet_failed and not journal.writes:
            log.warning("sheet unavailable for message %r: %s", text, journal.error_codes)
            return SHEET_FAILED
        return compose(confirmation(journal.writes), final, note)


def compose(lines: list[str], model_text: str, note: str = "") -> str:
    """The HTML reply: confirmation lines (already HTML), then the escaped model text and the note."""
    text = model_text.strip()
    if lines and text.lower().rstrip(".!") == "ok":
        text = ""
    text = escape(text)
    blocks = ["\n".join(lines)] if lines else []
    blocks += [b for b in (text, note) if b]
    return "\n\n".join(blocks) or "Nada gravado."
