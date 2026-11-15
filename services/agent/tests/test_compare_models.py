"""scripts/compare_models.py without a network: LiteLLM is a scripted fake, the key is a sentinel."""

from __future__ import annotations

import importlib.util
import json
import sys
from collections.abc import Awaitable, Callable
from datetime import date
from pathlib import Path
from typing import Any

import pytest
from google.adk.models.lite_llm import LiteLLMClient
from litellm import ModelResponse

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "compare_models.py"
spec = importlib.util.spec_from_file_location("compare_models", SCRIPT)
assert spec is not None and spec.loader is not None
cm = importlib.util.module_from_spec(spec)
sys.modules["compare_models"] = cm
spec.loader.exec_module(cm)

KEY = "sentinel-key-0123456789-not-a-real-key"
TRANSCRIPT = "FRASE-SENTINELA-DA-TRANSCRICAO supino oitenta por oito"
TODAY = date(2026, 11, 15)

Responder = Callable[[Any, list[dict[str, Any]], Any, dict[str, Any]], Awaitable[Any] | Any]


def response(
    content: str | None = "ok",
    *,
    tool: tuple[str, dict[str, Any]] | None = None,
    finish: str = "stop",
    usage: tuple[int, int, int | None, int | None] = (600, 40, 8, None),
) -> ModelResponse:
    """(prompt, completion, reasoning, audio) tokens, as LiteLLM reports them."""
    prompt, completion, reasoning, audio = usage
    message: dict[str, Any] = {"role": "assistant", "content": content}
    if tool is not None:
        message["tool_calls"] = [
            {
                "id": "c1",
                "type": "function",
                "function": {"name": tool[0], "arguments": json.dumps(tool[1])},
            }
        ]
    return ModelResponse(
        choices=[{"message": message, "finish_reason": finish}],
        usage={
            "prompt_tokens": prompt,
            "completion_tokens": completion,
            "total_tokens": prompt + completion,
            "completion_tokens_details": {"reasoning_tokens": reasoning},
            "prompt_tokens_details": {"audio_tokens": audio},
        },
    )


class FakeInner(LiteLLMClient):
    """Stands in for litellm.acompletion: `responder` answers each request, every request is kept."""

    def __init__(self, responder: Responder) -> None:
        self.responder = responder
        self.requests: list[dict[str, Any]] = []

    async def acompletion(self, model: Any, messages: Any, tools: Any, **kwargs: Any) -> Any:
        self.requests.append({"model": model, "messages": messages, "tools": tools, **kwargs})
        result = self.responder(model, messages, tools, kwargs)
        if hasattr(result, "__await__"):
            result = await result
        if isinstance(result, Exception):
            raise result
        return result


def is_transcription(messages: list[dict[str, Any]], tools: Any) -> bool:
    return tools is None and messages[0]["role"] == "system" and "transcreve" in str(messages[0]["content"])


def chat_script(
    case_steps: dict[str, list[tuple[str, dict[str, Any]]]],
) -> Callable[..., ModelResponse | Exception]:
    """Tool calls per case message, one per model turn, then "ok". The step is how many tool
    results the conversation already holds."""

    def respond(model: Any, messages: list[dict[str, Any]], tools: Any, kwargs: dict[str, Any]) -> Any:
        if is_transcription(messages, tools):
            return response(TRANSCRIPT, usage=(454 + 32 * 5, 60, 20, 32 * 5))
        text = json.dumps(messages, ensure_ascii=False)
        for message, steps in case_steps.items():
            if message in text:
                done = sum(1 for m in messages if m.get("role") == "tool")
                if done < len(steps):
                    return response(None, tool=steps[done], finish="tool_calls")
                return response("ok")
        return response("ok")

    return respond


FOOD_STEPS = [
    ("get_catalog", {}),
    (
        "save_food",
        {
            "date": "2026-11-17",
            "meal": "Jantar",
            "items": [
                {"food": "Frango grelhado", "qty": 200, "unit": "g"},
                {"food": "Arroz branco cozido", "qty": 150, "unit": "g"},
            ],
        },
    ),
]


@pytest.fixture
def audio_dir(tmp_path: Path) -> Path:
    folder = tmp_path / "audios"
    folder.mkdir()
    (folder / "meu-treino-privado.ogg").write_bytes(b"x" * 4000)
    (folder / "notes.txt").write_text("not audio")
    return folder


@pytest.fixture
def with_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", KEY)


def read_tree(folder: Path) -> str:
    return "\n".join(p.read_text(encoding="utf-8") for p in sorted(folder.rglob("*")) if p.is_file())


# --- the key ----------------------------------------------------------------------------------


def test_missing_key_exits_with_a_clear_message_and_calls_nothing(
    monkeypatch: pytest.MonkeyPatch, audio_dir: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    inner = FakeInner(lambda *a: AssertionError("must not be called"))

    code = cm.main([str(audio_dir), "--out", str(tmp_path / "out")], inner=inner, today=TODAY)

    captured = capsys.readouterr()
    assert code == 2
    assert "GEMINI_API_KEY" in captured.err
    assert inner.requests == []
    assert not (tmp_path / "out").exists()


def test_blank_key_counts_as_missing(
    monkeypatch: pytest.MonkeyPatch, audio_dir: Path, tmp_path: Path
) -> None:
    monkeypatch.setenv("GEMINI_API_KEY", "   ")
    assert cm.main([str(audio_dir), "--out", str(tmp_path / "out")], inner=FakeInner(lambda *a: None)) == 2


def test_the_key_never_appears_in_any_output(
    with_key: None,
    audio_dir: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    script = chat_script({"ontem no jantar": FOOD_STEPS})

    def responder(model: Any, messages: list[dict[str, Any]], tools: Any, kwargs: dict[str, Any]) -> Any:
        # A provider error that echoes the request, key included (they do).
        if "o que comi hoje" in json.dumps(messages, ensure_ascii=False):
            return RuntimeError(f"401 invalid key {KEY}")
        return script(model, messages, tools, kwargs)

    caplog.set_level(0)
    out = tmp_path / "out"
    code = cm.main([str(audio_dir), "--out", str(out)], inner=FakeInner(responder), today=TODAY)

    captured = capsys.readouterr()
    assert code == 0
    everything = captured.out + captured.err + caplog.text + read_tree(out)
    assert KEY not in everything
    assert "sentinel-key" not in everything
    # The failing case is reported by its class, not its message.
    assert "RuntimeError" in captured.out + read_tree(out) or "FALHOU" in captured.out
    assert (out / "results.md").is_file()


def test_the_key_is_not_passed_to_litellm_explicitly(with_key: None, audio_dir: Path, tmp_path: Path) -> None:
    inner = FakeInner(chat_script({}))
    cm.main(
        [str(audio_dir), "--out", str(tmp_path / "out"), "--levels", "low", "--runs", "1"],
        inner=inner,
        today=TODAY,
    )
    assert inner.requests
    assert all("api_key" not in r for r in inner.requests)


# --- content ----------------------------------------------------------------------------------


def test_transcript_content_never_reaches_stdout_or_results(
    with_key: None,
    audio_dir: Path,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(0)
    out = tmp_path / "out"
    code = cm.main(
        [str(audio_dir), "--out", str(out), "--skip-chat", "--runs", "2"],
        inner=FakeInner(chat_script({})),
        today=TODAY,
    )

    captured = capsys.readouterr()
    assert code == 0
    for visible in (
        captured.out,
        captured.err,
        caplog.text,
        (out / "results.md").read_text(encoding="utf-8"),
    ):
        assert "SENTINELA" not in visible
        assert "supino oitenta" not in visible
        assert "meu-treino-privado" not in visible  # audios are a01, a02...
    transcripts = (out / "transcripts.txt").read_text(encoding="utf-8")
    assert transcripts.count(TRANSCRIPT) == 4  # 1 audio x 2 levels x 2 runs
    assert "a01 = meu-treino-privado.ogg" in transcripts  # the key to the ids, local only


def test_default_levels_run_each_audio_twice_per_level(
    with_key: None, audio_dir: Path, tmp_path: Path
) -> None:
    inner = FakeInner(chat_script({}))
    cm.main([str(audio_dir), "--out", str(tmp_path / "out"), "--skip-chat"], inner=inner, today=TODAY)

    audio_calls = [r for r in inner.requests if r["tools"] is None and r["messages"][-1]["content"] != "."]
    assert len(audio_calls) == 4  # 1 audio x 2 levels (low, medium) x 2 runs
    assert [r["reasoning_effort"] for r in audio_calls] == ["low", "low", "medium", "medium"]
    assert {r["model"] for r in audio_calls} == {"gemini/gemini-3.8-flash"}
    # The real Transcriber's request: temperature 0 and max_tokens 600.
    assert all(r["temperature"] == 0 and r["max_tokens"] == 600 for r in audio_calls)
    # And one audio-free probe of the prompt size for the model.
    assert sum(r["messages"][-1]["content"] == "." for r in inner.requests) == 1


def test_results_md_has_metrics_and_the_three_checks(with_key: None, audio_dir: Path, tmp_path: Path) -> None:
    out = tmp_path / "out"
    cm.main([str(audio_dir), "--out", str(out), "--skip-chat"], inner=FakeInner(chat_script({})), today=TODAY)
    text = (out / "results.md").read_text(encoding="utf-8")
    assert "a01" in text
    assert "TRANSCRIBE_PROMPT_TOKENS = 454" in text
    assert "temperature=0" in text and "max_tokens = 600" in text
    assert "thinkingLevel" in text  # the config LiteLLM maps, offline
    # 454 text tokens in the fake usage: prompt 614, audio 160.
    assert "diferença +0" in text and "constante ok" in text
    assert "US$" in text and cm.PRICING_SOURCE in text


# --- cost ---------------------------------------------------------------------------------------


def test_cost_uses_prompt_and_completion_prices_per_million() -> None:
    price = cm.Price(date.min, 0.75, 3.75)
    assert cm.estimate_cost(1_000_000, 1_000_000, price) == pytest.approx(4.5)
    assert cm.estimate_cost(2_400, 500, price) == pytest.approx(0.003675)
    assert cm.estimate_cost(100, 100, None) is None
    assert cm.estimate_cost(None, 100, price) is None


def test_price_changes_on_the_dates_of_the_official_table() -> None:
    model = "gemini/gemini-3.8-flash"
    before, after = cm.price_in_effect(model, date(2026, 12, 31)), cm.price_in_effect(model, date(2027, 1, 1))
    assert (before.input_per_m, before.output_per_m) == (0.75, 3.75)
    assert (after.input_per_m, after.output_per_m) == (1.50, 7.50)
    assert cm.next_price(model, date(2026, 11, 15)).since == date(2027, 1, 1)
    assert cm.next_price(model, date(2027, 1, 1)) is None
    assert cm.price_in_effect("gemini/unknown-model", TODAY) is None


def test_cost_in_the_summary_follows_the_runs_tokens(with_key: None, audio_dir: Path, tmp_path: Path) -> None:
    out = tmp_path / "out"
    cm.main(
        [str(audio_dir), "--out", str(out), "--skip-chat", "--levels", "low", "--runs", "1"],
        inner=FakeInner(chat_script({})),
        today=TODAY,
    )
    # 614 prompt + 60 completion tokens at 0.75 / 3.75 per million.
    expected = (614 * 0.75 + 60 * 3.75) / 1_000_000
    assert f"US$ {expected:.4f}" in (out / "results.md").read_text(encoding="utf-8")


def test_a_model_without_a_price_reports_na_not_zero() -> None:
    run = cm.TranscribeRun("a01", "gemini/other", "low", 1, 1.0, metrics=cm.CallMetrics(1.0, 10, 5))
    report = cm.Report(["gemini/other"], ["low"], TODAY, transcribe=[run])
    _, rows = cm.transcribe_summary(report)
    assert rows[0][-2] == "n/d"


# --- truncation ---------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("finish", "cut"),
    [("length", True), ("LENGTH", True), ("MAX_TOKENS", True), ("stop", False), (None, False)],
)
def test_truncation_is_detected_from_finish_reason(finish: str | None, cut: bool) -> None:
    assert cm.is_truncated(finish) is cut


def test_metrics_read_usage_reasoning_audio_and_finish_reason() -> None:
    m = cm.metrics_from_response(response("x", finish="length", usage=(614, 600, 590, 160)), 1.5)
    assert (m.prompt_tokens, m.completion_tokens, m.reasoning_tokens, m.audio_tokens) == (614, 600, 590, 160)
    assert m.truncated and m.latency_s == 1.5


def test_metrics_read_tool_calls_with_their_arguments() -> None:
    m = cm.metrics_from_response(
        response(None, tool=("save_food", {"meal": "Jantar"}), finish="tool_calls"), 0.1
    )
    assert m.tool_calls == [("save_food", {"meal": "Jantar"})]


def test_a_cut_transcription_is_counted_and_max_tokens_is_not_enough(
    with_key: None, audio_dir: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    def responder(model: Any, messages: list[dict[str, Any]], tools: Any, kwargs: dict[str, Any]) -> Any:
        return response(TRANSCRIPT, finish="length", usage=(614, 600, 600, 160))

    out = tmp_path / "out"
    cm.main(
        [str(audio_dir), "--out", str(out), "--skip-chat", "--levels", "low", "--runs", "2"],
        inner=FakeInner(responder),
        today=TODAY,
    )
    text = (out / "results.md").read_text(encoding="utf-8")
    assert "não basta" in text
    assert "finish=length" in capsys.readouterr().out
    report_rows = [
        line for line in text.splitlines() if line.startswith("| gemini/gemini-3.8-flash | low | 2 |")
    ]
    assert report_rows and "| 2 |" in report_rows[0]


def test_stability_counts_identical_repeats_and_reports_the_lowest_similarity() -> None:
    def run(rep: int, text: str) -> Any:
        return cm.TranscribeRun("a01", "m", "low", rep, 1.0, text=text)

    same, pairs, lowest = cm.stability([run(1, "supino 80 por 8"), run(2, "supino 80 por 8")])
    assert (same, pairs, lowest) == (1, 1, 1.0)
    same, pairs, lowest = cm.stability([run(1, "supino 80 por 8"), run(2, "supino 80 por 9")])
    assert (same, pairs) == (0, 1) and lowest is not None and 0.9 < lowest < 1.0
    assert cm.stability([cm.TranscribeRun("a01", "m", "low", 1, 1.0)]) == (0, 0, None)


# --- chat ---------------------------------------------------------------------------------------


async def test_a_correct_agent_passes_a_meal_case_and_the_real_sheet_is_not_involved() -> None:
    inner = FakeInner(chat_script({"ontem no jantar": FOOD_STEPS}))
    run = await cm.run_chat_case(cm.CASES[0], "gemini/gemini-3.8-flash", "low", inner)

    assert run.passed, run.reason
    assert [t.split("(")[0] for t in run.tools] == ["get_catalog", "save_food"]
    assert len(run.calls) == 3 and run.total("prompt_tokens") == 1800
    assert all(r["reasoning_effort"] == "low" for r in inner.requests)  # the level reaches the agent's calls


async def test_an_agent_that_writes_nothing_fails_the_meal_case_with_a_reason() -> None:
    run = await cm.run_chat_case(cm.CASES[0], "gemini/gemini-3.8-flash", "low", FakeInner(chat_script({})))
    assert not run.passed
    assert run.reason


async def test_an_agent_that_writes_on_a_question_fails_it() -> None:
    steps = [("get_catalog", {}), ("save_diary", {"date": "2026-11-18", "fields": {"foodLog": "Completo"}})]
    run = await cm.run_chat_case(
        cm.CASES[3], "gemini/gemini-3.8-flash", "low", FakeInner(chat_script({"o que comi hoje": steps}))
    )
    assert not run.passed and "gravou" in (run.reason or "")


async def test_the_correction_case_sees_the_recent_write_in_the_catalog_and_accepts_82x8() -> None:
    steps = [
        ("get_catalog", {}),
        (
            "save_workout",
            {
                "date": "2026-11-18",
                "session": "Upper",
                "exercises": [{"name": "Supino reto", "work": [{"kg": 82, "reps": 8}]}],
            },
        ),
    ]
    run = await cm.run_chat_case(
        cm.CASES[2], "gemini/gemini-3.8-flash", "medium", FakeInner(chat_script({"na verdade foi 82": steps}))
    )
    assert run.passed, run.reason


async def test_a_truncated_chat_call_is_counted() -> None:
    def respond(model: Any, messages: Any, tools: Any, kwargs: Any) -> Any:
        return response("ok", finish="length")

    run = await cm.run_chat_case(cm.CASES[3], "gemini/gemini-3.8-flash", "low", FakeInner(respond))
    assert run.truncated


async def test_a_provider_error_is_reported_by_class_and_never_by_message() -> None:
    def respond(model: Any, messages: Any, tools: Any, kwargs: Any) -> Any:
        return RuntimeError(f"echo {KEY}")

    run = await cm.run_chat_case(cm.CASES[0], "gemini/gemini-3.8-flash", "low", FakeInner(respond))
    assert not run.passed
    assert KEY not in repr(run) and all(KEY not in repr(c) for c in run.calls)


async def test_memory_sheet_rejects_unknown_names_with_suggestions_like_the_real_api() -> None:
    sheet = cm.MemorySheet(date(2026, 11, 18))
    bad_food = await sheet.add_food("2026-11-18", "Almoço", [{"food": "Picanha", "qty": 100, "unit": "g"}])
    assert bad_food["ok"] is False and "Frango grelhado" in bad_food["errors"][0]["suggestions"]
    bad_day = await sheet.upsert_diary("ontem", {"steps": 9000})
    assert bad_day["errors"][0]["code"] == "invalid_date"
    assert sheet.writes == []


def test_the_chat_has_five_cases_with_unique_ids() -> None:
    assert [c.id for c in cm.CASES] == ["c1", "c2", "c3", "c4", "c5"]


# --- guards and plan ----------------------------------------------------------------------------


def test_an_output_folder_inside_a_git_repository_is_refused(
    with_key: None, audio_dir: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    repo = tmp_path / "repo"
    (repo / ".git").mkdir(parents=True)
    inner = FakeInner(lambda *a: AssertionError("must not be called"))

    code = cm.main([str(audio_dir), "--out", str(repo / "results")], inner=inner, today=TODAY)

    assert code == 2 and "repositório" in capsys.readouterr().err
    assert inner.requests == [] and not (repo / "results").exists()


def test_dry_run_needs_no_key_and_calls_nothing(
    monkeypatch: pytest.MonkeyPatch, audio_dir: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    inner = FakeInner(lambda *a: AssertionError("must not be called"))

    code = cm.main([str(audio_dir), "--dry-run"], inner=inner, today=TODAY)

    out = capsys.readouterr().out
    assert code == 0 and inner.requests == []
    assert "áudios: 1" in out and "nada foi chamado" in out


def test_a_non_gemini_model_is_refused_for_transcription(
    with_key: None, audio_dir: Path, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = cm.main(
        [str(audio_dir), "--out", str(tmp_path / "o"), "--models", "openai/gpt-5.6"],
        inner=FakeInner(chat_script({})),
    )
    assert code == 2 and "gemini/" in capsys.readouterr().err


def test_the_default_level_sends_no_reasoning_effort_like_the_bot_does_today(
    with_key: None, audio_dir: Path, tmp_path: Path
) -> None:
    inner = FakeInner(chat_script({}))
    out = tmp_path / "out"
    cm.main(
        [str(audio_dir), "--out", str(out), "--skip-chat", "--levels", "default", "--runs", "1"],
        inner=inner,
        today=TODAY,
    )
    measured = [r for r in inner.requests if r["messages"][-1]["content"] != "."]  # not the probe
    assert measured and all("reasoning_effort" not in r for r in measured)
    assert "thinkingConfig" not in cm.sent_config("gemini/gemini-3.8-flash", "default")
    assert (out / "results.md").is_file()
