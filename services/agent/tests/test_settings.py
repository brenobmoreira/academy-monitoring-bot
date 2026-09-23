import os

import pytest

from agent.settings import ConfigError, Settings

pytestmark = pytest.mark.unit

REQUIRED = {
    "TELEGRAM_BOT_TOKEN": "tok",
    "ALLOWED_CHAT_IDS": " 42, 7 ,",
    "SHEET_API_URL": "https://script.google.com/macros/s/x/exec",
    "SHEET_API_KEY": "k",
}
ALL_KEYS = [
    *REQUIRED,
    "TELEGRAM_WEBHOOK_SECRET",
    "GEMINI_MODEL",
    "MAX_LLM_CALLS",
    "TIMEZONE",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_API_KEY",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
]


@pytest.fixture
def env(monkeypatch, tmp_path):
    """Isolated environment: no real variables, no .env, a YAML file under the test's control."""
    for key in ALL_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.chdir(tmp_path)
    yaml_file = tmp_path / "settings.yaml"
    yaml_file.write_text("gemini_model: gemini-from-yaml\nmax_llm_calls: 5\n", encoding="utf-8")
    monkeypatch.setenv("SETTINGS_FILE", str(yaml_file))
    for key, value in REQUIRED.items():
        monkeypatch.setenv(key, value)
    return yaml_file


def test_yaml_fills_what_the_environment_does_not(env):
    s = Settings.load()
    assert s.gemini_model == "gemini-from-yaml"
    assert s.max_llm_calls == 5
    assert s.timezone == "America/Sao_Paulo"
    assert s.allowed_chat_ids == frozenset({42, 7})
    assert s.telegram_bot_token.get_secret_value() == "tok"
    assert s.telegram_webhook_secret is None


def test_environment_overrides_yaml(env, monkeypatch):
    monkeypatch.setenv("GEMINI_MODEL", "gemini-from-env")
    assert Settings.load().gemini_model == "gemini-from-env"


def test_dotenv_in_the_working_directory_is_read(env, monkeypatch, tmp_path):
    monkeypatch.delenv("SHEET_API_KEY")
    (tmp_path / ".env").write_text("SHEET_API_KEY=from-dotenv\n", encoding="utf-8")
    assert Settings.load().sheet_api_key.get_secret_value() == "from-dotenv"


def test_secrets_in_yaml_are_refused(env):
    env.write_text("gemini_model: x\ngoogle_api_key: leaked\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="google_api_key"):
        Settings.load()


def test_missing_required_values_are_listed_together(env, monkeypatch):
    monkeypatch.delenv("SHEET_API_URL")
    monkeypatch.delenv("SHEET_API_KEY")
    with pytest.raises(ConfigError) as err:
        Settings.load()
    assert "SHEET_API_URL" in str(err.value)
    assert "SHEET_API_KEY" in str(err.value)


def test_bad_values_are_rejected(env, monkeypatch):
    monkeypatch.setenv("ALLOWED_CHAT_IDS", "me")
    with pytest.raises(ConfigError, match="ALLOWED_CHAT_IDS"):
        Settings.load()


def test_a_missing_yaml_falls_back_to_defaults(env, monkeypatch, tmp_path):
    monkeypatch.setenv("SETTINGS_FILE", str(tmp_path / "absent.yaml"))
    assert Settings.load().gemini_model == "gemini-3.8-flash"


def test_model_env_is_exported_for_the_gemini_sdk(env, monkeypatch):
    monkeypatch.setenv("GOOGLE_API_KEY", "ai-studio-key")
    monkeypatch.delenv("GOOGLE_GENAI_USE_VERTEXAI", raising=False)
    Settings.load().apply_model_env()
    assert os.environ["GOOGLE_GENAI_USE_VERTEXAI"] == "FALSE"
    assert os.environ["GOOGLE_API_KEY"] == "ai-studio-key"
    assert os.environ["GOOGLE_CLOUD_LOCATION"] == "us-central1"
