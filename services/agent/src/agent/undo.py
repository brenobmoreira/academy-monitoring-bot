"""Undo through the sheet (op write.undo), answered without the model: /desfazer undoes the
latest write, the ↩️ button under a confirmation undoes that message's writes.

Replies are built from what the sheet reports it undid.
"""

from __future__ import annotations

from typing import Any, Protocol

from agent.summary import LABELS

NOTHING = "Nada para desfazer."
ALREADY = "Já estava desfeito."
GONE = "⚠ Não desfiz: a gravação saiu do registro de desfazer; corrija direto na planilha."
SHEET_DOWN = "⚠ A planilha não respondeu. Tente de novo em alguns minutos."


class UndoApi(Protocol):
    async def undo(self, write_id: str | None = None) -> dict[str, Any]: ...


async def undo_last(sheet: UndoApi) -> str:
    """Undoes the most recent write not yet undone, whoever made it (bot or sheet menu)."""
    response = await sheet.undo()
    if response.get("ok"):
        return undone_line(response["result"]["undone"])
    errors = response.get("errors") or []
    codes = {e.get("code") for e in errors}
    if "nothing_to_undo" in codes:
        return NOTHING
    if codes & {"unavailable", "internal"}:
        return SHEET_DOWN
    return "⚠ Não desfiz: " + "; ".join(str(e.get("message", "")) for e in errors)


async def undo_writes(sheet: UndoApi, write_ids: list[str]) -> tuple[str, bool]:
    """Undoes the given writes newest first (ids come oldest first, as the bot made them).

    Returns the reply, one line per write (repeats merged), and whether the sheet was down: the
    run stops there and the caller keeps the button, so a later tap undoes the rest.
    """
    lines: list[str] = []
    for write_id in reversed(write_ids):
        response = await sheet.undo(write_id)
        if response.get("ok"):
            lines.append(undone_line(response["result"]["undone"]))
            continue
        errors = response.get("errors") or []
        codes = {e.get("code") for e in errors}
        if codes & {"unavailable", "internal"}:
            return "\n".join([*dict.fromkeys(lines), SHEET_DOWN]), True
        if "already_undone" in codes:
            lines.append(ALREADY)
        elif "not_found" in codes:
            lines.append(GONE)
        else:
            lines.append("⚠ Não desfiz: " + "; ".join(str(e.get("message", "")) for e in errors))
    return "\n".join(dict.fromkeys(lines)) or NOTHING, False


def undone_line(undone: dict[str, Any]) -> str:
    """E.g. "↩️ Desfeito: 24/09 · Diário (Peso kg, Sono h)" or "↩️ Desfeito: 24/09 · Upper (Supino)"."""
    if undone.get("op") == "diary.upsert":
        what, items = "Diário", [LABELS.get(f, f) for f in undone.get("fields") or []]
    else:
        what, items = str(undone.get("session") or "Treino"), list(undone.get("exercises") or [])
    detail = f" ({', '.join(items)})" if items else ""
    date = str(undone["date"])
    return f"↩️ Desfeito: {date[8:10]}/{date[5:7]} · {what}{detail}"
