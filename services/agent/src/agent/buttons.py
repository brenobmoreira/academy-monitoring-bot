"""Inline buttons under a confirmation: ✅ Ok, ↩️ Desfazer, ✏️ Corrigir.

Nothing is stored between requests, so a button carries what its tap needs in `callback_data`
(at most 64 bytes, `<verb>:<arg>`): `ok`, `undo:<id1>,<id2>,…` (the message's writes, oldest
first) and `fix`. The handler acts on the tap (see Handler._button).
"""

from __future__ import annotations

import hashlib
import hmac
from typing import Any

from agent.format import escape

OK = "ok"
UNDO = "undo"
FIX = "fix"
RETRY = "retry"  # `retry:<id>`: replays a Mini App write the sheet could not take
VOICE_OK = "vok"
VOICE_FIX = "vfix"
VOICE_NO = "vno"
VOICE_VERBS = frozenset({VOICE_OK, VOICE_FIX, VOICE_NO})
DRAFT_OK = "dok"
DRAFT_MINIAPP = "dfix"
DRAFT_NO = "dno"
DRAFT_VERBS = frozenset({DRAFT_OK, DRAFT_MINIAPP, DRAFT_NO})
VERBS = frozenset({OK, UNDO, FIX, RETRY, *VOICE_VERBS, *DRAFT_VERBS})
MAX_DATA = 64  # bytes, Telegram's limit for callback_data

ENTENDI_HEADER = "🎙️ Entendi:"
FIX_PROMPT = "✏️ Envie a correção para esta mensagem"
FIX_PLACEHOLDER = "Ex.: na verdade foi 62 no supino"
VOICE_FIX_PROMPT = "✏️ Envie o texto corrigido respondendo a esta mensagem. Toque para copiar:"
VOICE_FIX_PLACEHOLDER = "Ex.: supino 80 por 8, 80 por 7"
QUOTE_LIMIT = 3500  # characters of the confirmation repeated in the prompt, so it fits one message


def keyboard(write_ids: tuple[str, ...] | list[str]) -> dict[str, Any]:
    """The markup for a reply that wrote something. ↩️ is left out when there are no ids (an
    older sheet deployment) or they do not fit in `callback_data`."""
    row = [{"text": "✅ Ok", "callback_data": OK}]
    undo = f"{UNDO}:{','.join(write_ids)}"
    if write_ids and len(undo.encode()) <= MAX_DATA:
        row.append({"text": "↩️ Desfazer", "callback_data": undo})
    row.append({"text": "✏️ Corrigir", "callback_data": FIX})
    return {"inline_keyboard": [row]}


def voice_keyboard(vid: str) -> dict[str, Any]:
    """The markup for a `🎙️ Entendi:` voice confirmation message (§4.1)."""
    if not vid or any(len(f"{verb}:{vid}".encode()) > MAX_DATA for verb in (VOICE_OK, VOICE_FIX, VOICE_NO)):
        raise ValueError("voice confirmation id does not fit in callback_data")
    row = [
        {"text": "✅ Confirmar", "callback_data": f"{VOICE_OK}:{vid}"},
        {"text": "✏️ Corrigir", "callback_data": f"{VOICE_FIX}:{vid}"},
        {"text": "✖️ Cancelar", "callback_data": f"{VOICE_NO}:{vid}"},
    ]
    return {"inline_keyboard": [row]}


def food_draft_keyboard(draft_id: str, *, include_miniapp: bool = True) -> dict[str, Any]:
    """The markup for a revisable food draft (`propose_food`, Onda 1 #4)."""
    if not draft_id or any(
        len(f"{verb}:{draft_id}".encode()) > MAX_DATA for verb in (DRAFT_OK, DRAFT_MINIAPP, DRAFT_NO)
    ):
        raise ValueError("food draft id does not fit in callback_data")
    row1 = [{"text": "✅ Registrar no diário", "callback_data": f"{DRAFT_OK}:{draft_id}"}]
    if include_miniapp:
        row1.append({"text": "✏️ Ajustar no Mini App", "callback_data": f"{DRAFT_MINIAPP}:{draft_id}"})
    row2 = [{"text": "✖️ Cancelar", "callback_data": f"{DRAFT_NO}:{draft_id}"}]
    return {"inline_keyboard": [row1, row2]}


def entendi_text(body: str) -> str:
    """Plain-text body of the `🎙️ Entendi:` message (§4.1)."""
    return f"{ENTENDI_HEADER}\n\n{body}"


def transcript_from(message: Any, expected_sha256: str) -> str | None:
    """Recovers and hash-checks the text after `🎙️ Entendi:\\n\\n` from `callback_query.message`.

    Returns None when the message is missing, inaccessible (`InaccessibleMessage`, `date == 0`),
    has no `Entendi` body, or its UTF-8 SHA-256 does not match `expected_sha256`.
    """
    if not isinstance(message, dict) or not isinstance(expected_sha256, str) or not expected_sha256:
        return None
    if "date" in message:
        date_val = message["date"]
        if not isinstance(date_val, int) or isinstance(date_val, bool) or date_val <= 0:
            return None
    text = message.get("text")
    prefix = f"{ENTENDI_HEADER}\n\n"
    if not isinstance(text, str) or not text.startswith(prefix):
        return None
    body = text[len(prefix) :]
    if not body:
        return None
    digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
    if not hmac.compare_digest(digest, expected_sha256):
        return None
    return body


def parse(data: str) -> tuple[str, list[str]]:
    """`undo:w1,w2` → ("undo", ["w1", "w2"]); `ok` → ("ok", [])."""
    verb, _, arg = data.partition(":")
    return verb, [i for i in arg.split(",") if i]


def action(data: str) -> str:
    """The verb of `data` when it is one of VERBS, else "other": what a log line may say about a
    tap. `callback_data` comes from the update, so it is never logged as it arrived."""
    verb = parse(data)[0]
    return verb if verb in VERBS else "other"


def fix_prompt(confirmation: str | None) -> tuple[str, dict[str, Any]]:
    """Text and markup of the ✏️ prompt. It repeats the confirmation because the user's answer
    arrives replying to the prompt, and `reply_to_message` is the only context that travels with it
    (Telegram does not nest a second level)."""
    text = FIX_PROMPT
    quoted = (confirmation or "").strip()
    if quoted:
        if len(quoted) > QUOTE_LIMIT:
            quoted = quoted[:QUOTE_LIMIT].rstrip() + "…"
        text = f"{FIX_PROMPT}:\n\n{quoted}"
    return text, {"force_reply": True, "input_field_placeholder": FIX_PLACEHOLDER}


def voice_fix_prompt(transcript: str) -> tuple[str, dict[str, Any]]:
    """HTML text and markup of the `vfix` prompt (§4.1), with the transcript in `<code>`."""
    quoted = transcript.strip()
    markup = {"force_reply": True, "input_field_placeholder": VOICE_FIX_PLACEHOLDER}
    if not quoted:
        return VOICE_FIX_PROMPT, markup
    truncated = len(quoted) > QUOTE_LIMIT
    if truncated:
        quoted = quoted[:QUOTE_LIMIT].rstrip()
    escaped = escape(quoted + ("…" if truncated else ""))
    while len(escaped) > QUOTE_LIMIT and quoted:
        quoted = quoted[:-1].rstrip()
        escaped = escape(quoted + "…")
    return f"{VOICE_FIX_PROMPT}\n\n<code>{escaped}</code>", markup
