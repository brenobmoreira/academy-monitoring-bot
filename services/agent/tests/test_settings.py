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
    "REMINDER_TOKEN",
    "LLM_MODEL",
    "LLM_API_KEY",
    "LLM_API_BASE",
    "MAX_LLM_CALLS",
    "TIMEZONE",
]


@pytest.fixture
def env(monkeypatch, tmp_path):
    """Isolated environment: no real variables, no .env, a YAML file under the test's control."""
    for key in ALL_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.chdir(tmp_path)
    yaml_file = tmp_path / "settings.yaml"
    yaml_file.write_text("LLM_MODEL: openai/from-yaml\nMAX_LLM_CALLS: 5\n", encoding="utf-8")
    monkeypatch.setenv("SETTINGS_FILE", str(yaml_file))
    for key, value in REQUIRED.items():
        monkeypatch.setenv(key, value)
    return yaml_file


def test_yaml_fills_what_the_environment_does_not(env):
    s = Settings.load()
    assert s.LLM_MODEL == "openai/from-yaml"
    assert s.MAX_LLM_CALLS == 5
    assert s.TIMEZONE == "America/Sao_Paulo"
    assert s.ALLOWED_CHAT_IDS == frozenset({42, 7})
    assert s.TELEGRAM_BOT_TOKEN.get_secret_value() == "tok"
    assert s.TELEGRAM_WEBHOOK_SECRET is None
    assert s.REMINDER_TOKEN is None


def test_environment_overrides_yaml(env, monkeypatch):
    monkeypatch.setenv("LLM_MODEL", "anthropic/from-env")
    assert Settings.load().LLM_MODEL == "anthropic/from-env"


def test_dotenv_in_the_working_directory_is_read(env, monkeypatch, tmp_path):
    monkeypatch.delenv("SHEET_API_KEY")
    (tmp_path / ".env").write_text("SHEET_API_KEY=from-dotenv\n", encoding="utf-8")
    assert Settings.load().SHEET_API_KEY.get_secret_value() == "from-dotenv"


def test_secrets_in_yaml_are_refused(env):
    env.write_text("LLM_MODEL: x\nLLM_API_KEY: leaked\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="LLM_API_KEY"):
        Settings.load()


def test_the_reminder_token_is_a_secret(env, monkeypatch):
    env.write_text("REMINDER_TOKEN: leaked\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="REMINDER_TOKEN"):
        Settings.load()
    env.write_text("LLM_MODEL: x\n", encoding="utf-8")
    monkeypatch.setenv("REMINDER_TOKEN", "from-env")
    token = Settings.load().REMINDER_TOKEN
    assert token is not None and token.get_secret_value() == "from-env"


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
    assert Settings.load().LLM_MODEL == "gemini/gemini-3.8-flash"
