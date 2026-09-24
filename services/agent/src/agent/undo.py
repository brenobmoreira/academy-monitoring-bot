"""/desfazer: undo the latest sheet write (op write.undo), answered without the model.

The reply is built from what the sheet reports it undid. Kept self-contained so it can move into
the command registry (commands.py) as a plain `run`.
"""

from __future__ import annotations

from typing import Any, Protocol

from agent.summary import LABELS

NOTHING = "Nada para desfazer."
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


def undone_line(undone: dict[str, Any]) -> str:
    """E.g. "↩️ Desfeito: 24/09 · Diário (Peso kg, Sono h)" or "↩️ Desfeito: 24/09 · Upper (Supino)"."""
    if undone.get("op") == "diary.upsert":
        what, items = "Diário", [LABELS.get(f, f) for f in undone.get("fields") or []]
    else:
        what, items = str(undone.get("session") or "Treino"), list(undone.get("exercises") or [])
    detail = f" ({', '.join(items)})" if items else ""
    date = str(undone["date"])
    return f"↩️ Desfeito: {date[8:10]}/{date[5:7]} · {what}{detail}"
