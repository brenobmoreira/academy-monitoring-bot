import hashlib

import pytest

from agent.buttons import (
    ENTENDI_HEADER,
    FIX_PLACEHOLDER,
    FIX_PROMPT,
    MAX_DATA,
    QUOTE_LIMIT,
    VOICE_FIX_PLACEHOLDER,
    VOICE_FIX_PROMPT,
    action,
    entendi_text,
    fix_prompt,
    keyboard,
    parse,
    transcript_from,
    voice_fix_prompt,
    voice_keyboard,
)

pytestmark = pytest.mark.unit


def data(markup):
    return [b["callback_data"] for b in markup["inline_keyboard"][0]]


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def test_one_row_with_ok_undo_and_fix():
    markup = keyboard(("a1", "b2"))
    assert [b["text"] for b in markup["inline_keyboard"][0]] == ["✅ Ok", "↩️ Desfazer", "✏️ Corrigir"]
    assert data(markup) == ["ok", "undo:a1,b2", "fix"]


def test_undo_is_left_out_without_ids():
    assert data(keyboard(())) == ["ok", "fix"]


def test_undo_is_left_out_when_the_ids_do_not_fit_64_bytes():
    fits = ["x" * 19, "y" * 19, "z" * 19]  # "undo:" + 57 + 2 commas = 64
    assert len(("undo:" + ",".join(fits)).encode()) == MAX_DATA
    assert "undo:" + ",".join(fits) in data(keyboard(fits))
    assert data(keyboard([*fits[:2], "z" * 20])) == ["ok", "fix"]


def test_parse_splits_the_verb_and_the_ids():
    assert parse("undo:w1,w2") == ("undo", ["w1", "w2"])
    assert parse("ok") == ("ok", [])
    assert parse("undo:") == ("undo", [])


def test_fix_prompt_forces_a_reply_and_quotes_the_confirmation():
    text, markup = fix_prompt("21/09 · Peso kg 82,4")
    assert text == f"{FIX_PROMPT}:\n\n21/09 · Peso kg 82,4"
    assert markup == {"force_reply": True, "input_field_placeholder": FIX_PLACEHOLDER}
    assert len(FIX_PLACEHOLDER) <= 64


def test_fix_prompt_without_text_and_with_a_long_confirmation():
    assert fix_prompt(None)[0] == FIX_PROMPT
    text, _ = fix_prompt("x" * 5000)
    assert text.endswith("…")
    assert len(text) <= len(FIX_PROMPT) + 3 + QUOTE_LIMIT + 1


def test_voice_keyboard_carries_vid_within_telegram_limit():
    vid = "0123456789abcdef"
    markup = voice_keyboard(vid)
    row = markup["inline_keyboard"][0]
    assert [b["text"] for b in row] == ["✅ Confirmar", "✏️ Corrigir", "✖️ Cancelar"]
    assert data(markup) == [f"vok:{vid}", f"vfix:{vid}", f"vno:{vid}"]
    assert all(len(d.encode()) <= MAX_DATA for d in data(markup))
    assert [action(d) for d in data(markup)] == ["vok", "vfix", "vno"]
    with pytest.raises(ValueError):
        voice_keyboard("")
    with pytest.raises(ValueError):
        voice_keyboard("x" * 60)


def test_transcript_from_verifies_header_accessibility_and_sha256():
    body = "almoço\n150 g de arroz e 120 g de frango"
    digest = sha(body)
    valid = {"message_id": 9, "date": 1_700_000_000, "text": entendi_text(body)}
    assert transcript_from(valid, digest) == body
    assert transcript_from({"message_id": 9, "text": entendi_text(body)}, digest) == body

    # Tampered text, wrong header, empty body, missing message, or InaccessibleMessage (date == 0)
    assert transcript_from({"message_id": 9, "text": entendi_text(body + "!")}, digest) is None
    assert transcript_from({"message_id": 9, "text": body}, digest) is None
    assert transcript_from({"message_id": 9, "text": f"{ENTENDI_HEADER}\n\n"}, sha("")) is None
    assert transcript_from({"message_id": 9, "date": 0, "text": entendi_text(body)}, digest) is None
    assert transcript_from({"message_id": 9, "date": True, "text": entendi_text(body)}, digest) is None
    assert transcript_from(None, digest) is None


def test_voice_fix_prompt_escapes_transcript_inside_code_and_bounds_length():
    text, markup = voice_fix_prompt("supino <barra> & 80x8")
    assert text == f"{VOICE_FIX_PROMPT}\n\n<code>supino &lt;barra&gt; &amp; 80x8</code>"
    assert markup == {"force_reply": True, "input_field_placeholder": VOICE_FIX_PLACEHOLDER}
    assert len(VOICE_FIX_PLACEHOLDER) <= 64

    long_html, _ = voice_fix_prompt("&" * 2000)
    assert long_html.startswith(f"{VOICE_FIX_PROMPT}\n\n<code>")
    assert long_html.endswith("…</code>")
    assert len(long_html) < 4096
