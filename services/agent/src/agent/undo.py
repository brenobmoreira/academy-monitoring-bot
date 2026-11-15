"""Undo through the sheet (op write.undo), answered without the model: /desfazer undoes the
latest write, the ↩️ button under a confirmation undoes that message's writes.

Replies are built from what the sheet reports it undid.
"""

from __future__ import annotations

from typing import Any, NamedTuple, Protocol

from agent.sheet_client import WriteOutcome, write_outcome
from agent.summary import LABELS

NOTHING = "Nada para desfazer."
ALREADY = "Já estava desfeito."
GONE = "⚠ Não desfiz: a gravação saiu do registro de desfazer; corrija direto na planilha."
SHEET_DOWN = "⚠ A planilha não respondeu. Tente de novo em alguns minutos."
# The undo may have been applied (answer lost, or an error after the reverts began): no retry.
UNDO_UNCERTAIN = "⚠ Não sei se desfez; confira com /hoje."


class UndoApi(Protocol):
    async def undo(self, write_id: str | None = None) -> dict[str, Any]: ...


class UndoRun(NamedTuple):
    """The reply of an undo, whether the sheet was proven down (the only case worth another tap)
    and the write outcome of the run (None: nothing was attempted)."""

    text: str
    sheet_down: bool
    outcome: WriteOutcome | None


async def undo_last(sheet: UndoApi) -> tuple[str, WriteOutcome]:
    """Undoes the most recent write not yet undone, whoever made it (bot or sheet menu).
    Returns the reply and the outcome of the undo."""
    response = await sheet.undo()
    outcome = write_outcome(response)
    if outcome == "committed":
        return undone_line(response["result"]["undone"]), outcome
    if outcome == "uncertain":
        return UNDO_UNCERTAIN, outcome
    errors = response.get("errors") or []
    codes = {e.get("code") for e in errors}
    if "nothing_to_undo" in codes:
        return NOTHING, outcome
    if "unavailable" in codes:
        return SHEET_DOWN, outcome
    return "⚠ Não desfiz: " + "; ".join(str(e.get("message", "")) for e in errors), outcome


async def undo_run(sheet: UndoApi, write_ids: list[str]) -> UndoRun:
    """Undoes the given writes newest first (ids come oldest first, as the bot made them).

    The reply has one line per write (repeats merged). The run stops when the sheet is proven
    down (`sheet_down`: the caller keeps the button, so a later tap undoes the rest) and when an
    undo ends `uncertain` (no retry: it may have been applied; the person checks /hoje).
    The outcome is `uncertain` if that happened, else `committed` if anything was undone.
    """
    lines: list[str] = []
    undone = False
    for write_id in reversed(write_ids):
        response = await sheet.undo(write_id)
        outcome = write_outcome(response)
        if outcome == "committed":
            undone = True
            lines.append(undone_line(response["result"]["undone"]))
            continue
        if outcome == "uncertain":
            return UndoRun("\n".join([*dict.fromkeys(lines), UNDO_UNCERTAIN]), False, "uncertain")
        errors = response.get("errors") or []
        codes = {e.get("code") for e in errors}
        if "unavailable" in codes:
            text = "\n".join([*dict.fromkeys(lines), SHEET_DOWN])
            return UndoRun(text, True, "committed" if undone else "not_committed")
        if "already_undone" in codes:
            lines.append(ALREADY)
        elif "not_found" in codes:
            lines.append(GONE)
        else:
            lines.append("⚠ Não desfiz: " + "; ".join(str(e.get("message", "")) for e in errors))
    if not write_ids:
        return UndoRun(NOTHING, False, None)
    return UndoRun("\n".join(dict.fromkeys(lines)), False, "committed" if undone else "not_committed")


async def undo_writes(sheet: UndoApi, write_ids: list[str]) -> tuple[str, bool]:
    """`undo_run` as (reply, sheet was down), for the ↩️ button."""
    run = await undo_run(sheet, write_ids)
    return run.text, run.sheet_down


def undone_line(undone: dict[str, Any]) -> str:
    """E.g. "↩️ Desfeito: 24/09 · Diário (Peso kg, Sono h)", "↩️ Desfeito: 24/09 · Upper (Supino)",
    "↩️ Desfeito: 24/09 · Almoço (Arroz)"; an action made in the sheet (menu, Hoje) by its label."""
    op = undone.get("op")
    if op == "diary.upsert":
        what, items = "Diário", [LABELS.get(f, f) for f in undone.get("fields") or []]
    elif op == "measures.upsert":
        what, items = "Medidas", [LABELS.get(f, f) for f in undone.get("fields") or []]
    elif op == "workout.upsert":
        what, items = str(undone.get("session") or "Treino"), list(undone.get("exercises") or [])
    elif op == "food.add":
        what, items = str(undone.get("meal") or "Alimentação"), list(undone.get("items") or [])
    elif op == "food.copy":
        src = str(undone.get("from") or "")
        src_ddmm = f"{src[8:10]}/{src[5:7]}" if len(src) >= 10 else src
        what, items = f"Cópia ({undone.get('meal') or 'Todas'} de {src_ddmm})", []
    else:
        return f"↩️ Desfeito: {undone.get('action') or 'última alteração'}"
    detail = f" ({', '.join(items)})" if items else ""
    date = str(undone.get("date") or undone.get("to"))
    return f"↩️ Desfeito: {date[8:10]}/{date[5:7]} · {what}{detail}"
