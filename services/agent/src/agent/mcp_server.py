"""Read-only MCP server (stdio) over the sheet API, for agents outside the Telegram bot.

    ENV_FILE=C:/path/to/sheet.env uv run --directory services/agent agent-mcp

The Telegram bot stays the only writer: this server exposes only the read ops (catalog,
phase.get, week.get, diary.range, workout.range, exercise.history). Like the bot's tools
(tools.py), each tool returns the API body unchanged, so {"ok": false, "errors": [...]} reaches
the caller as-is, with each error's path, message and suggestions.

SHEET_API_URL and SHEET_API_KEY come from the process environment or from the .env file at
ENV_FILE (the environment wins). They are never taken as arguments, logged or returned.
stdout carries the protocol; logs go to stderr.
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from collections.abc import Awaitable, Mapping
from pathlib import Path
from typing import Any, Protocol

import httpx
from dotenv import dotenv_values
from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

from agent.sheet_client import SheetClient

log = logging.getLogger(__name__)

READ_ONLY = ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False)


class SheetReader(Protocol):
    async def catalog(self) -> dict[str, Any]: ...
    async def exercise_history(self, name: str, limit: int | None = None) -> dict[str, Any]: ...
    async def diary_range(self, date_from: str, date_to: str) -> dict[str, Any]: ...
    async def workout_range(self, date_from: str, date_to: str) -> dict[str, Any]: ...
    async def phase(self, date: str) -> dict[str, Any]: ...
    async def week(self, date: str) -> dict[str, Any]: ...


class ConfigError(RuntimeError):
    pass


async def _read(call: Awaitable[dict[str, Any]]) -> dict[str, Any]:
    """Awaits a sheet read, folding an unexpected exception into the API's outage shape.
    Only the exception type is kept, here and in the log: its text can echo the request, key
    included, and the SDK would log the whole exception to stderr. Cancellation still propagates."""
    try:
        return await call
    except Exception as err:
        name = type(err).__name__
        log.warning("leitura da planilha falhou (%s)", name)
        message = f"falha inesperada ao ler a planilha ({name})"
        return {"ok": False, "errors": [{"path": "", "code": "unavailable", "message": message}]}


def build_server(sheet: SheetReader) -> MCPServer:
    async def get_catalog() -> dict[str, Any]:
        """Lê o catálogo da planilha fitness: today; phase (objetivo, meta com alvos e ficha em
        vigor hoje, e a última recomendação); sessions, nextSession (próxima da rotação) e
        lastWorkout; exercises (nomes exatos com grupo); plan (ficha vigente com séries, reps e
        RIR prescritos); foods e favorites; meals; recent: as gravações dos últimos 30 minutos.
        Chame antes de get_exercise_history para ter o nome exato do exercício."""
        return await _read(sheet.catalog())

    async def get_phase(date: str) -> dict[str, Any]:
        """Objetivo, meta (alvos de kcal e macros) e ficha em vigor numa data, e a última
        recomendação da análise semanal até ela. O objetivo muda com o tempo: use para
        qualquer pergunta sobre o passado.

        Args:
            date: dia, yyyy-MM-dd.
        """
        return await _read(sheet.phase(date))

    async def get_week(date: str) -> dict[str, Any]:
        """Análise da semana (segunda a domingo) que contém a data: peso, cintura, alimentação,
        treinos, recuperação, situação e recomendação, com o objetivo daquela semana.

        Args:
            date: qualquer dia da semana, yyyy-MM-dd.
        """
        return await _read(sheet.week(date))

    async def get_diary_history(date_from: str, date_to: str) -> dict[str, Any]:
        """Dados do Diário (peso, cintura, sono, passos, cardio, fome, cansaço, dor, notas) num
        período, do dia mais antigo ao mais recente. Só vêm os dias que têm registro, e em cada
        dia só os campos preenchidos: dia ou campo ausente não foi registrado. Cada dia traz ids:
        o objetivo, a meta e a ficha em vigor naquele dia.

        Args:
            date_from: primeiro dia, yyyy-MM-dd.
            date_to: último dia, yyyy-MM-dd; período de no máximo 92 dias contando as duas datas.
        """
        return await _read(sheet.diary_range(date_from, date_to))

    async def get_exercise_history(name: str, limit: int | None = None) -> dict[str, Any]:
        """Sessões anteriores de um exercício (só work sets), da mais recente para a mais antiga.

        Args:
            name: nome exato do exercício no catálogo (get_catalog, exercises).
            limit: quantas sessões (1 a 50, padrão 10).
        """
        return await _read(sheet.exercise_history(name, limit))

    async def get_workout_history(date_from: str, date_to: str) -> dict[str, Any]:
        """Treinos registrados num período, do mais antigo ao mais recente: sessão, estado e
        exercícios com os work sets de cada dia de treino.

        Args:
            date_from: primeiro dia, yyyy-MM-dd.
            date_to: último dia, yyyy-MM-dd; período de no máximo 92 dias contando as duas datas.
        """
        return await _read(sheet.workout_range(date_from, date_to))

    server = MCPServer(
        name="academia-planilha",
        instructions=(
            "Leitura da planilha fitness (treino, dieta, diário e análise semanal). Somente "
            "leitura: gravações são feitas pelo bot do Telegram. Cada ferramenta devolve o corpo "
            'da API: {"ok": true, "result": ...} ou {"ok": false, "errors": [...]}; num erro, '
            "leia path, message e suggestions de cada item e corrija a chamada."
        ),
    )
    for fn in (
        get_catalog,
        get_phase,
        get_week,
        get_diary_history,
        get_exercise_history,
        get_workout_history,
    ):
        server.add_tool(fn, annotations=READ_ONLY)
    return server


def sheet_credentials(environ: Mapping[str, str]) -> tuple[str, str]:
    """(SHEET_API_URL, SHEET_API_KEY) from `environ`, falling back to the .env file at ENV_FILE."""
    values: dict[str, str | None] = {}
    env_file = environ.get("ENV_FILE")
    if env_file:
        path = Path(env_file)
        if not path.is_file():
            raise ConfigError(f"ENV_FILE não encontrado: {path}")
        values.update(dotenv_values(path, encoding="utf-8"))
    values.update({k: v for k, v in environ.items() if k in ("SHEET_API_URL", "SHEET_API_KEY")})
    url = (values.get("SHEET_API_URL") or "").strip()
    key = (values.get("SHEET_API_KEY") or "").strip()
    missing = [name for name, value in (("SHEET_API_URL", url), ("SHEET_API_KEY", key)) if not value]
    if missing:
        raise ConfigError(f"faltam {', '.join(missing)} no ambiente ou no arquivo ENV_FILE")
    return url, key


async def run(url: str, key: str) -> None:
    async with httpx.AsyncClient() as http:
        await build_server(SheetClient(url, key, http)).run_stdio_async()


def main() -> None:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr)
    # httpx logs every request URL at INFO; the deployment URL is not for the client's logs.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    try:
        url, key = sheet_credentials(os.environ)
    except ConfigError as err:
        log.error("%s", err)
        sys.exit(2)
    asyncio.run(run(url, key))
