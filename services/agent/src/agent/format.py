"""Telegram HTML: escaping of text we did not write, bold, and splitting into sendable chunks."""

from __future__ import annotations

import html
import re

LIMIT = 4096  # Telegram's limit for one message
_ENTITY = re.compile(r"&[#a-zA-Z0-9]*$")  # an entity cut before its ";"


def escape(text: object) -> str:
    """Anything that did not come from our own templates: model text, exercise names, notes."""
    return html.escape(str(text), quote=False)


def bold(html_text: str) -> str:
    """Wraps text that is already HTML (escape it first if it is not ours)."""
    return f"<b>{html_text}</b>"


def split(text: str, limit: int = LIMIT) -> list[str]:
    """Chunks of at most `limit` characters, cut on line boundaries.

    A single line longer than `limit` is hard-cut, but never inside an entity such as `&amp;`.
    Our templates open and close tags on the same short line, so cuts keep them balanced.
    Blank lines at a cut are dropped: a chunk never starts or ends with one.
    """
    chunks: list[str] = []
    current = ""
    for line in text.split("\n"):
        while len(line) > limit:
            if current:
                chunks.append(current.rstrip("\n"))
                current = ""
            cut = limit
            entity = _ENTITY.search(line[:cut])
            if entity and entity.start() > 0:
                cut = entity.start()
            chunks.append(line[:cut])
            line = line[cut:]
        candidate = f"{current}\n{line}" if current else line
        if len(candidate) <= limit:
            current = candidate
        else:
            chunks.append(current.rstrip("\n"))
            current = line
    current = current.rstrip("\n")
    if current or not chunks:
        chunks.append(current)
    return chunks
