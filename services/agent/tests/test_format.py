import pytest

from agent.format import bold, escape, split

pytestmark = pytest.mark.unit


def test_escape_leaves_quotes_and_escapes_markup():
    assert escape('Supino <reto> & "banco"') == 'Supino &lt;reto&gt; &amp; "banco"'
    assert escape(7.5) == "7.5"
    assert bold(escape("a<b")) == "<b>a&lt;b</b>"


def test_short_text_is_one_chunk():
    assert split("21/09 · Peso kg 82\n\nok") == ["21/09 · Peso kg 82\n\nok"]


def test_cuts_on_line_boundaries():
    assert split("aaaa\nbbbb\ncc", limit=9) == ["aaaa\nbbbb", "cc"]
    assert split("aaaa\nbbbb\ncc", limit=10) == ["aaaa\nbbbb", "cc"]
    assert split("aa\nbb\ncc", limit=5) == ["aa\nbb", "cc"]


def test_blank_lines_at_a_cut_are_dropped():
    assert split("aaaa\n\nbbbb", limit=5) == ["aaaa", "bbbb"]


def test_a_line_over_the_limit_is_hard_cut():
    assert split("ab\n" + "x" * 12 + "\ncd", limit=5) == ["ab", "xxxxx", "xxxxx", "xx\ncd"]


def test_a_hard_cut_never_splits_an_entity():
    chunks = split("abc&amp;def", limit=5)
    assert chunks == ["abc", "&amp;", "def"]
    assert "".join(chunks) == "abc&amp;def"


def test_every_chunk_fits_the_default_limit():
    text = "\n".join("linha " + "x" * 1000 for _ in range(20))
    chunks = split(text)
    assert all(len(c) <= 4096 for c in chunks)
    assert "\n".join(chunks) == text
