import pytest

from agent.config import ConfigError, Settings

pytestmark = pytest.mark.unit

BASE = {
    "TELEGRAM_BOT_TOKEN": "tok",
    "ALLOWED_CHAT_IDS": " 42, 7 ,",
    "SHEET_API_URL": "https://script.google.com/macros/s/x/exec",
    "SHEET_API_KEY": "k",
}


def test_reads_required_values_and_defaults():
    s = Settings.from_env(BASE)
    assert s.telegram_bot_token == "tok"
    assert s.allowed_chat_ids == frozenset({42, 7})
    assert s.sheet_api_url.endswith("/exec")
    assert s.telegram_webhook_secret is None
    assert s.gemini_model == "gemini-2.5-flash"
    assert s.timezone == "America/Sao_Paulo"


def test_optional_values_override_defaults():
    s = Settings.from_env({**BASE, "TELEGRAM_WEBHOOK_SECRET": "sec", "GEMINI_MODEL": "gemini-2.5-pro"})
    assert s.telegram_webhook_secret == "sec"
    assert s.gemini_model == "gemini-2.5-pro"


def test_lists_every_missing_variable_at_once():
    with pytest.raises(ConfigError) as err:
        Settings.from_env({"TELEGRAM_BOT_TOKEN": "tok"})
    assert "ALLOWED_CHAT_IDS" in str(err.value)
    assert "SHEET_API_URL" in str(err.value)
    assert "SHEET_API_KEY" in str(err.value)


def test_rejects_non_numeric_chat_ids():
    with pytest.raises(ConfigError, match="ALLOWED_CHAT_IDS"):
        Settings.from_env({**BASE, "ALLOWED_CHAT_IDS": "me"})
