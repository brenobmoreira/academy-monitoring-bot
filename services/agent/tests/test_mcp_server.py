import json

import httpx
import pytest
from mcp import Client

from agent.mcp_server import ConfigError, build_server, sheet_credentials
from agent.sheet_client import SheetClient

from .fakes import FakeSheet

pytestmark = pytest.mark.unit

REJECTED = {
    "ok": False,
    "errors": [
        {
            "path": "to",
            "code": "range_too_long",
            "message": "período maior que 92 dias",
            "suggestions": ["2026-04-01"],
        }
    ],
}


async def call(sheet, name, args=None):
    async with Client(build_server(sheet)) as client:
        return await client.call_tool(name, args or {})


async def test_lists_only_the_read_tools_annotated_read_only(sheet):
    async with Client(build_server(sheet)) as client:
        listed = (await client.list_tools()).tools
    assert [t.name for t in listed] == [
        "get_catalog",
        "get_phase",
        "get_week",
        "get_diary_history",
        "get_exercise_history",
        "get_workout_history",
    ]
    for tool in listed:
        assert tool.description
        assert tool.annotations is not None
        assert tool.annotations.read_only_hint is True


async def test_write_tools_do_not_exist(sheet):
    result = await call(sheet, "save_diary", {"date": "2026-09-21", "fields": {"weightKg": 82}})
    assert result.is_error is True
    assert sheet.calls == []


@pytest.mark.parametrize(
    ("tool", "args", "op", "api_args"),
    [
        ("get_catalog", {}, "catalog", {}),
        ("get_phase", {"date": "2026-09-21"}, "phase.get", {"date": "2026-09-21"}),
        ("get_week", {"date": "2026-09-21"}, "week.get", {"date": "2026-09-21"}),
        (
            "get_diary_history",
            {"date_from": "2026-09-01", "date_to": "2026-09-21"},
            "diary.range",
            {"from": "2026-09-01", "to": "2026-09-21"},
        ),
        (
            "get_exercise_history",
            {"name": "Supino reto", "limit": 5},
            "exercise.history",
            {"name": "Supino reto", "limit": 5},
        ),
        ("get_exercise_history", {"name": "Supino reto"}, "exercise.history", {"name": "Supino reto"}),
        (
            "get_workout_history",
            {"date_from": "2026-09-01", "date_to": "2026-09-21"},
            "workout.range",
            {"from": "2026-09-01", "to": "2026-09-21"},
        ),
    ],
)
async def test_each_tool_calls_its_op_and_returns_the_body_unchanged(tool, args, op, api_args):
    body = {"ok": True, "result": {"op": op, "rows": [{"date": "2026-09-21", "weightKg": 82.4}]}}
    sheet = FakeSheet(**{op.replace(".", "_"): [body]})
    result = await call(sheet, tool, args)
    assert sheet.calls == [(op, api_args)]
    assert result.is_error is False
    assert result.structured_content == body
    assert json.loads(result.content[0].text) == body


@pytest.mark.parametrize(
    ("tool", "args", "op"),
    [
        ("get_catalog", {}, "catalog"),
        ("get_phase", {"date": "2026-13-01"}, "phase.get"),
        ("get_week", {"date": "x"}, "week.get"),
        ("get_diary_history", {"date_from": "2026-01-01", "date_to": "2026-09-21"}, "diary.range"),
        ("get_exercise_history", {"name": "Inexistente"}, "exercise.history"),
        ("get_workout_history", {"date_from": "2026-01-01", "date_to": "2026-09-21"}, "workout.range"),
    ],
)
async def test_rejected_calls_reach_the_caller_as_is(tool, args, op):
    sheet = FakeSheet(**{op.replace(".", "_"): [REJECTED]})
    result = await call(sheet, tool, args)
    assert result.structured_content == REJECTED


async def test_sheet_outage_is_returned_in_the_same_shape():
    def handler(request):
        return httpx.Response(500)

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await call(SheetClient("https://script.google.com/macros/s/x/exec", "k", http), "get_catalog")
    body = result.structured_content
    assert body is not None
    assert body["ok"] is False
    assert body["errors"][0]["code"] == "unavailable"


async def test_key_goes_to_the_api_but_never_back_to_the_caller():
    secret = "chave-super-secreta"
    seen = {}

    def handler(request):
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "result": {"date": "2026-09-21"}})

    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    sheet = SheetClient("https://script.google.com/macros/s/x/exec", secret, http)
    result = await call(sheet, "get_phase", {"date": "2026-09-21"})
    assert seen["body"] == {"key": secret, "op": "phase.get", "args": {"date": "2026-09-21"}}
    assert secret not in result.model_dump_json()


def test_credentials_come_from_env_file(tmp_path):
    env_file = tmp_path / "sheet.env"
    env_file.write_text("SHEET_API_URL=https://example/exec\nSHEET_API_KEY=k1\nOTHER=x\n", encoding="utf-8")
    assert sheet_credentials({"ENV_FILE": str(env_file)}) == ("https://example/exec", "k1")


def test_environment_wins_over_env_file(tmp_path):
    env_file = tmp_path / "sheet.env"
    env_file.write_text("SHEET_API_URL=https://file/exec\nSHEET_API_KEY=from-file\n", encoding="utf-8")
    environ = {"ENV_FILE": str(env_file), "SHEET_API_KEY": "from-env"}
    assert sheet_credentials(environ) == ("https://file/exec", "from-env")


def test_missing_credentials_are_named_without_values(tmp_path):
    env_file = tmp_path / "sheet.env"
    env_file.write_text("SHEET_API_KEY=segredo\n", encoding="utf-8")
    with pytest.raises(ConfigError) as err:
        sheet_credentials({"ENV_FILE": str(env_file)})
    assert "SHEET_API_URL" in str(err.value)
    assert "segredo" not in str(err.value)


def test_missing_env_file_is_an_error(tmp_path):
    with pytest.raises(ConfigError, match="ENV_FILE"):
        sheet_credentials({"ENV_FILE": str(tmp_path / "nope.env")})
