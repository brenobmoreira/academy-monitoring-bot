import pytest

from agent.buttons import FIX_PLACEHOLDER, FIX_PROMPT, MAX_DATA, QUOTE_LIMIT, fix_prompt, keyboard, parse

pytestmark = pytest.mark.unit


def data(markup):
    return [b["callback_data"] for b in markup["inline_keyboard"][0]]


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
