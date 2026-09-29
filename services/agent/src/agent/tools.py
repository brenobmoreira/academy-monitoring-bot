"""ADK function tools over the sheet API.

Tools return the API body unchanged, so on {"ok": false, "errors": [...]} the model reads each
error's path, message and suggestions and calls again with a fixed payload. Successful writes are
recorded in a Journal, from which the confirmation is built (see summary.py); the error codes of
every rejected call, reads included, are kept there too, so the bot can tell a sheet outage apart.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from types import FunctionType
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field


class SheetApi(Protocol):
    async def catalog(self) -> dict[str, Any]: ...
    async def upsert_diary(self, date: str, fields: dict[str, Any]) -> dict[str, Any]: ...
    async def upsert_workout(
        self,
        date: str,
        session: str,
        exercises: list[dict[str, Any]],
        complete: bool | None = None,
    ) -> dict[str, Any]: ...
    async def add_food(self, date: str, meal: str, items: list[dict[str, Any]]) -> dict[str, Any]: ...
    async def exercise_history(self, name: str, limit: int | None = None) -> dict[str, Any]: ...
    async def diary_range(self, date_from: str, date_to: str) -> dict[str, Any]: ...
    async def workout_range(self, date_from: str, date_to: str) -> dict[str, Any]: ...
    async def phase(self, date: str) -> dict[str, Any]: ...
    async def week(self, date: str) -> dict[str, Any]: ...


DiaryKey = Literal[
    "weightKg",
    "waistCm",
    "sleepH",
    "steps",
    "cardioMin",
    "activityMin",
    "activity",
    "hunger",
    "fatigue",
    "pain",
    "foodLog",
    "notes",
]


class DiaryFields(BaseModel):
    weightKg: float | None = Field(None, description="peso em kg, ex.: 82.4")
    waistCm: float | None = Field(None, description="cintura em cm")
    sleepH: float | None = Field(None, description="horas de sono em decimal: 7h30 = 7.5")
    steps: int | None = Field(None, description="passos no dia: 8k = 8000")
    cardioMin: float | None = Field(None, description="minutos de cardio")
    activityMin: float | None = Field(None, description="minutos de outra atividade (luta, corrida...)")
    activity: str | None = Field(None, description="nome da atividade, ex.: Muay Thai")
    hunger: int | None = Field(None, description="fome de 1 a 5")
    fatigue: int | None = Field(None, description="cansaço de 1 a 5")
    pain: int | None = Field(None, description="dor de 0 a 10")
    foodLog: Literal["Não informado", "Parcial", "Completo"] | None = Field(
        None, description="registro alimentar do dia, só quando a pessoa declarar"
    )
    notes: str | None = Field(None, description="observações livres, até 500 caracteres")


class LoadSet(BaseModel):
    kg: float = Field(description="carga em kg; 0 para peso corporal")
    reps: int = Field(description="repetições")


class WorkSet(BaseModel):
    kg: float = Field(description="carga em kg; 0 para peso corporal")
    reps: int = Field(description="repetições")
    rir: float | None = Field(
        None, description="repetições em reserva DESTA série, 0 a 10; omita se não foi dito"
    )


class Exercise(BaseModel):
    name: str = Field(description="nome exato do exercício no catálogo")
    work: list[WorkSet] = Field(description="1 ou 2 work sets (as séries válidas), na ordem feita")
    warmup: LoadSet | None = Field(None, description="série de aquecimento, se informada")
    feeder: LoadSet | None = Field(None, description="série feeder (aproximação), se informada")
    pain: int | None = Field(None, description="dor de 0 a 10")
    note: str | None = Field(None, description="nota de técnica, até 200 caracteres")
    equipment: str | None = Field(None, description="equipamento ou convenção de carga, até 100 caracteres")


class FoodItem(BaseModel):
    food: str | None = Field(None, description="nome exato de um alimento do catálogo (foods)")
    qty: float | None = Field(None, description="quantidade do alimento ou da descrição")
    unit: str | None = Field(None, description="g, ml, kg, l ou a medida caseira do alimento (un, fatia...)")
    favorite: str | None = Field(None, description="nome de uma refeição favorita (favorites)")
    portions: float | None = Field(None, description="porções da favorita; padrão 1")
    description: str | None = Field(
        None, description="o que foi comido quando não há alimento no catálogo (fica sem cálculo)"
    )
    measure: Literal["Pesada", "Rótulo", "Estimada"] | None = Field(
        None, description="como a quantidade foi obtida, se dito"
    )
    note: str | None = Field(None, description="observação, até 200 caracteres")


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

    @property
    def write_ids(self) -> list[str]:
        """The sheet's undo ids of these writes, in order (an older sheet deployment sends none)."""
        return [result["writeId"] for _, result in self.writes if result.get("writeId")]


def build_tools(sheet: SheetApi, journal: Journal) -> list[FunctionType]:
    async def get_catalog() -> dict[str, Any]:
        """Lê o catálogo da planilha: today; phase (objetivo, meta com alvos e ficha em vigor hoje,
        e a última recomendação); sessions, nextSession (próxima da rotação) e lastWorkout;
        exercises (nomes exatos com grupo); plan (ficha vigente com séries, reps e RIR
        prescritos); foods e favorites (nomes exatos); meals; recent: as gravações dos últimos
        30 minutos, a mais recente primeiro. Chame antes de save_workout, save_food ou
        get_exercise_history, e para continuar ou corrigir uma gravação recente."""
        return journal.check(await sheet.catalog())

    async def save_diary(
        date: str, fields: DiaryFields, clear: list[DiaryKey] | None = None
    ) -> dict[str, Any]:
        """Grava os dados do dia no Diário. Campo omitido não muda nada; campo vazio nunca apaga.

        Args:
            date: dia a que os dados se referem, yyyy-MM-dd.
            fields: só os campos que a mensagem informa.
            clear: campos que a pessoa pediu para apagar (ficam como não informado).
        """
        values = _plain(fields)
        for key in clear or []:
            values[key] = None
        response = await sheet.upsert_diary(date, values)
        return journal.record("diary.upsert", response)

    async def save_workout(
        date: str, session: str, exercises: list[Exercise], complete: bool = False
    ) -> dict[str, Any]:
        """Grava exercícios de musculação no Registro de treino, uma linha por exercício.
        Reenviar o mesmo exercício na mesma data e sessão substitui os work sets dele; aquecimento,
        feeder, dor e nota omitidos continuam como estavam.

        Args:
            date: dia do treino, yyyy-MM-dd.
            session: nome exato da sessão (ex.: Upper, Lower), conforme o catálogo.
            exercises: exercícios feitos: work sets (1 ou 2) separados de aquecimento e feeder.
            complete: true só quando a pessoa disser que terminou o treino (conclui a sessão);
                senão a sessão fica parcial.
        """
        response = await sheet.upsert_workout(date, session, _plain(exercises), True if complete else None)
        return journal.record("workout.upsert", response)

    async def save_food(date: str, meal: str, items: list[FoodItem]) -> dict[str, Any]:
        """Lança o que foi comido numa refeição na Alimentação. Cada item é um alimento do
        catálogo com quantidade (food + qty + unit), uma favorita (favorite + portions) ou, sem
        alimento no catálogo, uma descrição (description), que fica sem cálculo.

        Args:
            date: dia da refeição, yyyy-MM-dd.
            meal: refeição (ex.: Café da manhã, Almoço, Jantar), conforme meals do catálogo.
            items: itens da refeição.
        """
        response = await sheet.add_food(date, meal, _plain(items))
        return journal.record("food.add", response)

    async def get_exercise_history(name: str, limit: int | None = None) -> dict[str, Any]:
        """Sessões anteriores de um exercício (só work sets), da mais recente para a mais antiga.

        Args:
            name: nome exato do exercício no catálogo.
            limit: quantas sessões (1 a 50, padrão 10).
        """
        return journal.check(await sheet.exercise_history(name, limit))

    async def get_diary_history(date_from: str, date_to: str) -> dict[str, Any]:
        """Dados do Diário num período, do dia mais antigo ao mais recente. Só vêm os dias que
        têm registro, e em cada dia só os campos preenchidos: dia ou campo ausente não foi
        registrado. Cada dia traz ids: o objetivo, a meta e a ficha em vigor naquele dia.

        Args:
            date_from: primeiro dia, yyyy-MM-dd.
            date_to: último dia, yyyy-MM-dd; no máximo 92 dias depois de date_from.
        """
        return journal.check(await sheet.diary_range(date_from, date_to))

    async def get_phase(date: str) -> dict[str, Any]:
        """Objetivo, meta (alvos de kcal e macros) e ficha em vigor numa data, e a última
        recomendação da análise semanal até ela. Use para qualquer pergunta sobre o passado:
        o objetivo muda com o tempo.

        Args:
            date: dia, yyyy-MM-dd.
        """
        return journal.check(await sheet.phase(date))

    async def get_week(date: str) -> dict[str, Any]:
        """Análise da semana (segunda a domingo) que contém a data: peso, cintura, alimentação,
        treinos, recuperação, situação e recomendação, com o objetivo daquela semana.

        Args:
            date: qualquer dia da semana, yyyy-MM-dd.
        """
        return journal.check(await sheet.week(date))

    return [
        get_catalog,
        save_diary,
        save_workout,
        save_food,
        get_exercise_history,
        get_diary_history,
        get_phase,
        get_week,
    ]


def _plain(value: Any) -> Any:
    """Models or raw dicts (ADK passes dicts when it cannot build the model) to JSON without nulls."""
    if isinstance(value, BaseModel):
        value = value.model_dump()
    if isinstance(value, dict):
        return {k: _plain(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_plain(v) for v in value]
    return value
