"""Inline buttons under a confirmation: ✅ Ok, ↩️ Desfazer, ✏️ Corrigir.

Nothing is stored between requests, so a button carries what its tap needs in `callback_data`
(at most 64 bytes, `<verb>:<arg>`): `ok`, `undo:<id1>,<id2>,…` (the message's writes, oldest
first) and `fix`. The handler acts on the tap (see Handler._button).
"""

from __future__ import annotations

from typing import Any

OK = "ok"
UNDO = "undo"
FIX = "fix"
MAX_DATA = 64  # bytes, Telegram's limit for callback_data

FIX_PROMPT = "✏️ Envie a correção para esta mensagem"
FIX_PLACEHOLDER = "Ex.: na verdade foi 62 no supino"
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


def parse(data: str) -> tuple[str, list[str]]:
    """`undo:w1,w2` → ("undo", ["w1", "w2"]); `ok` → ("ok", [])."""
    verb, _, arg = data.partition(":")
    return verb, [i for i in arg.split(",") if i]


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
