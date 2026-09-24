"""ADK function tools over the sheet API.

Tools return the API body unchanged, so on {"ok": false, "errors": [...]} the model reads each
error's path, message and suggestions and calls again with a fixed payload. Successful writes are
recorded in a Journal, from which the confirmation is built (see summary.py); the error codes of
every rejected call, reads included, are kept there too, so the bot can tell a sheet outage apart.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from types import FunctionType
from typing import Any, Protocol

from pydantic import BaseModel, Field


class SheetApi(Protocol):
    async def catalog(self) -> dict[str, Any]: ...
    async def upsert_diary(self, date: str, fields: dict[str, Any]) -> dict[str, Any]: ...
    async def upsert_workout(
        self, date: str, session: str, exercises: list[dict[str, Any]], phase: str | None = None
    ) -> dict[str, Any]: ...
    async def exercise_history(self, name: str, limit: int | None = None) -> dict[str, Any]: ...


class DiaryFields(BaseModel):
    weightKg: float | None = Field(None, description="peso em kg, ex.: 82.4")
    sleepH: float | None = Field(None, description="horas de sono em decimal: 7h30 = 7.5")
    steps: int | None = Field(None, description="passos no dia: 8k = 8000")
    cardioMin: float | None = Field(None, description="minutos de cardio")
    muayThai: bool | None = Field(None, description="treinou Muay Thai hoje")
    dietComplete: bool | None = Field(None, description="cumpriu a dieta completa")
    waistCm: float | None = Field(None, description="cintura em cm")
    hunger: int | None = Field(None, description="fome de 1 a 5")
    fatigue: int | None = Field(None, description="cansaço de 1 a 5")
    notes: str | None = Field(None, description="observações livres, até 500 caracteres")


class WorkSet(BaseModel):
    kg: float = Field(description="carga em kg; 0 para peso corporal")
    reps: int = Field(description="repetições")


class Exercise(BaseModel):
    name: str = Field(description="nome exato do exercício no catálogo")
    sets: list[WorkSet] = Field(description="de 1 a 4 séries, na ordem feita")
    rir: int | None = Field(None, description="repetições em reserva na última série, 0 a 10")
    pain: int | None = Field(None, description="dor de 0 a 10")
    note: str | None = Field(None, description="nota de técnica, até 200 caracteres")
    equipment: str | None = Field(None, description="equipamento ou regulagem, até 200 caracteres")


# Codes the sheet client (network, HTTP, bad body) and the API (uncaught exception) use when the
# sheet itself failed, as opposed to rejecting the payload.
OUTAGE_CODES = frozenset({"unavailable", "internal"})


@dataclass
class Journal:
    """Successful writes of one message, in order: (op, result), and the error codes of every
    rejected call."""

    writes: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    error_codes: list[str] = field(default_factory=list)

    def record(self, op: str, response: dict[str, Any]) -> dict[str, Any]:
        """For writes: journals the result on success, the error codes otherwise."""
        if response.get("ok"):
            self.writes.append((op, response["result"]))
        return self.check(response)

    def check(self, response: dict[str, Any]) -> dict[str, Any]:
        """For any call: keeps the error codes of a rejected response."""
        if not response.get("ok"):
            errors = response.get("errors")
            for error in errors if isinstance(errors, list) else []:
                self.error_codes.append(str(error.get("code", "")) if isinstance(error, dict) else "")
        return response

    @property
    def sheet_failed(self) -> bool:
        return not OUTAGE_CODES.isdisjoint(self.error_codes)


def build_tools(sheet: SheetApi, journal: Journal) -> list[FunctionType]:
    async def get_catalog() -> dict[str, Any]:
        """Lê o catálogo da planilha: data de hoje, sessões, nomes exatos de exercícios com grupo
        muscular, a ficha (séries e repetições por sessão) e a fase atual. Chame antes de
        save_workout ou get_exercise_history."""
        return journal.check(await sheet.catalog())

    async def save_diary(date: str, fields: DiaryFields) -> dict[str, Any]:
        """Grava os dados do dia no Diário (atualiza a linha da data, sem apagar o resto).

        Args:
            date: dia a que os dados se referem, yyyy-MM-dd.
            fields: só os campos que a mensagem informa.
        """
        response = await sheet.upsert_diary(date, _plain(fields))
        return journal.record("diary.upsert", response)

    async def save_workout(
        date: str, session: str, exercises: list[Exercise], phase: str | None = None
    ) -> dict[str, Any]:
        """Grava exercícios de musculação no Registro de treino, uma linha por exercício.
        Reenviar o mesmo exercício na mesma data e sessão substitui a linha anterior.

        Args:
            date: dia do treino, yyyy-MM-dd.
            session: nome exato da sessão (ex.: Upper, Lower), conforme o catálogo.
            exercises: exercícios feitos, cada um com suas séries.
            phase: omita; a planilha usa a fase atual.
        """
        response = await sheet.upsert_workout(date, session, _plain(exercises), phase)
        return journal.record("workout.upsert", response)

    async def get_exercise_history(name: str, limit: int | None = None) -> dict[str, Any]:
        """Sessões anteriores de um exercício, da mais recente para a mais antiga.

        Args:
            name: nome exato do exercício no catálogo.
            limit: quantas sessões (1 a 50, padrão 10).
        """
        return journal.check(await sheet.exercise_history(name, limit))

    return [get_catalog, save_diary, save_workout, get_exercise_history]


def _plain(value: Any) -> Any:
    """Models or raw dicts (ADK passes dicts when it cannot build the model) to JSON without nulls."""
    if isinstance(value, BaseModel):
        value = value.model_dump()
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value
