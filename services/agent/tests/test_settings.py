import pytest

from agent.settings import ConfigError, Settings

pytestmark = pytest.mark.unit

REQUIRED = {
    "TELEGRAM_BOT_TOKEN": "tok-12345678",
    "ALLOWED_CHAT_IDS": " 42, 7 ,",
    "SHEET_API_URL": "https://script.google.com/macros/s/x/exec",
    "SHEET_API_KEY": "sheet-key-1234",
}
ALL_KEYS = [
    *REQUIRED,
    "TELEGRAM_WEBHOOK_SECRET",
    "REMINDER_TOKEN",
    "LLM_MODEL",
    "LLM_API_KEY",
    "LLM_API_BASE",
    "LLM_FALLBACK_MODEL",
    "LLM_FALLBACK_API_KEY",
    "MAX_LLM_CALLS",
    "TIMEZONE",
    "MEDIA_ENABLED",
    "MEDIA_MAX_BYTES",
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
    assert s.TELEGRAM_BOT_TOKEN.get_secret_value() == "tok-12345678"
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


def test_the_fallback_key_is_a_secret(env, monkeypatch):
    env.write_text("LLM_FALLBACK_API_KEY: leaked\n", encoding="utf-8")
    with pytest.raises(ConfigError, match="LLM_FALLBACK_API_KEY"):
        Settings.load()
    env.write_text("LLM_FALLBACK_MODEL: anthropic/claude-haiku-5-5\n", encoding="utf-8")
    monkeypatch.setenv("LLM_FALLBACK_API_KEY", "from-env")
    key = Settings.load().LLM_FALLBACK_API_KEY
    assert key is not None and key.get_secret_value() == "from-env"


def test_a_fallback_of_another_provider_needs_its_own_key(env, monkeypatch):
    env.write_text(
        "LLM_MODEL: gemini/gemini-3.8-flash\nLLM_FALLBACK_MODEL: anthropic/claude-haiku-5-5\n",
        encoding="utf-8",
    )
    with pytest.raises(ConfigError, match="LLM_FALLBACK_API_KEY"):
        Settings.load()
    monkeypatch.setenv("LLM_FALLBACK_API_KEY", "fallback-key-12")
    assert Settings.load().LLM_FALLBACK_MODEL == "anthropic/claude-haiku-5-5"


def test_a_secret_shorter_than_eight_characters_is_refused(env, monkeypatch):
    monkeypatch.setenv("SHEET_API_KEY", "abc1234")
    with pytest.raises(ConfigError, match="SHEET_API_KEY"):
        Settings.load()


def test_an_empty_fallback_key_counts_as_missing(env, monkeypatch):
    env.write_text(
        "LLM_MODEL: gemini/gemini-3.8-flash\nLLM_FALLBACK_MODEL: anthropic/claude-haiku-5-5\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("LLM_FALLBACK_API_KEY", "  ")
    with pytest.raises(ConfigError, match="LLM_FALLBACK_API_KEY"):
        Settings.load()


def test_provider_keys_read_by_the_sdks_are_masked_too(env, monkeypatch):
    from agent import logs

    monkeypatch.setattr(logs, "_SECRETS", set())
    monkeypatch.setenv("GEMINI_API_KEY", "gemini-native-sentinel")
    Settings.load()
    assert "gemini-native-sentinel" in logs._SECRETS


def test_a_fallback_of_the_same_provider_reuses_the_main_key(env):
    env.write_text(
        "LLM_MODEL: gemini/gemini-3.8-flash\nLLM_FALLBACK_MODEL: gemini/gemini-3.7-flash\n", encoding="utf-8"
    )
    assert Settings.load().LLM_FALLBACK_API_KEY is None


def test_settings_register_their_secrets_for_log_redaction(env, monkeypatch):
    from agent import logs

    monkeypatch.setattr(logs, "_SECRETS", set())
    monkeypatch.setenv("LLM_API_KEY", "llm-sentinel-123")
    Settings.load()
    assert {"tok-12345678", "sheet-key-1234", "llm-sentinel-123"} <= logs._SECRETS


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


def test_media_is_on_by_default_up_to_5_mb(env):
    s = Settings.load()
    assert s.MEDIA_ENABLED is True
    assert s.MEDIA_MAX_BYTES == 5_000_000


def test_media_settings_come_from_the_environment(env, monkeypatch):
    monkeypatch.setenv("MEDIA_ENABLED", "false")
    monkeypatch.setenv("MEDIA_MAX_BYTES", "1000")
    s = Settings.load()
    assert (s.MEDIA_ENABLED, s.MEDIA_MAX_BYTES) == (False, 1000)


def test_media_max_bytes_stays_within_the_bot_api_limit(env, monkeypatch):
    monkeypatch.setenv("MEDIA_MAX_BYTES", "30000000")
    with pytest.raises(ConfigError, match="MEDIA_MAX_BYTES"):
        Settings.load()
