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
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "TRANSCRIBE_MODEL",
    "TRANSCRIBE_API_KEY",
    "TRANSCRIBE_API_BASE",
    "TRANSCRIBE_FALLBACK_MODEL",
    "TRANSCRIBE_FALLBACK_API_KEY",
    "TRANSCRIBE_TIMEOUT_S",
    "TRANSCRIBE_RETRIES",
    "TRANSCRIBE_RETRY_WAIT_S",
    "TRANSCRIBE_DEADLINE_S",
    "VOICE_MAX_SECONDS",
    "VOICE_DAILY_TOKENS",
    "VOICE_GLOBAL_DAILY_TOKENS",
    "VOICE_MIN_BITRATE_BPS",
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
    # The transcription model (Gemini by default) needs a key the bot's own model may not provide.
    monkeypatch.setenv("TRANSCRIBE_API_KEY", "transcribe-key-1234")
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


def test_custom_env_file_via_argument_or_env_variable(env, monkeypatch, tmp_path):
    from agent.settings import parse_env_arg

    monkeypatch.delenv("SHEET_API_KEY")
    custom = tmp_path / ".env.luan"
    custom.write_text("SHEET_API_KEY=luan-secret-key\n", encoding="utf-8")
    assert Settings.load(custom).SHEET_API_KEY.get_secret_value() == "luan-secret-key"

    monkeypatch.setenv("ENV_FILE", str(custom))
    assert Settings.load().SHEET_API_KEY.get_secret_value() == "luan-secret-key"
    assert parse_env_arg(["--env", ".env.luan"]) == ".env.luan"
    assert parse_env_arg([]) is None


def test_miniapp_is_off_by_default(env):
    assert Settings.load().MINIAPP_URL == ""


@pytest.mark.parametrize(
    "url",
    ["https://luan.github.io/app/", "https://example.com", "https://a.b.c:8443/x?y=1", " https://ok.dev/ "],
)
def test_miniapp_url_accepts_https_addresses(env, monkeypatch, url):
    monkeypatch.setenv("MINIAPP_URL", url)
    assert Settings.load().MINIAPP_URL == url.strip()


@pytest.mark.parametrize(
    "url",
    [
        "http://example.com/",
        "https://",
        "https://?x",
        "https:///path",
        "https://exa mple.com/",
        "https://example.com/#v=1",
        "https://example.com/#",
        "https://user:pw@example.com/",
        "https://-bad-.com/",
        "https://example.com:notaport/",
        "ftp://example.com/",
        "example.com",
    ],
)
def test_miniapp_url_must_be_a_real_https_address(env, monkeypatch, url):
    monkeypatch.setenv("MINIAPP_URL", url)
    with pytest.raises(ConfigError, match="MINIAPP_URL"):
        Settings.load()


# --- transcription (voice spec §3.1) -----------------------------------------------------------


def test_transcription_defaults(env):
    s = Settings.load()
    assert s.TRANSCRIBE_MODEL == "gemini/gemini-3.8-flash"
    assert s.TRANSCRIBE_API_BASE is None
    assert s.TRANSCRIBE_FALLBACK_MODEL is None
    assert s.TRANSCRIBE_TIMEOUT_S == 15
    assert s.TRANSCRIBE_RETRIES == 1
    assert s.TRANSCRIBE_RETRY_WAIT_S == 1.0
    assert s.TRANSCRIBE_DEADLINE_S == 45
    assert s.VOICE_MAX_SECONDS == 90
    assert s.VOICE_DAILY_TOKENS == 120_000
    assert s.VOICE_GLOBAL_DAILY_TOKENS == 500_000
    assert s.VOICE_MIN_BITRATE_BPS == 6000


@pytest.mark.parametrize("model", ["anthropic/claude-sonnet-5", "openai/gpt-5.6", "gemini-3.8-flash", ""])
def test_the_transcription_model_must_be_gemini_or_vertex(env, monkeypatch, model):
    monkeypatch.setenv("TRANSCRIBE_MODEL", model)
    with pytest.raises(ConfigError, match="TRANSCRIBE_MODEL"):
        Settings.load()


def test_the_transcription_fallback_follows_the_same_provider_rule(env, monkeypatch):
    monkeypatch.setenv("TRANSCRIBE_FALLBACK_MODEL", "anthropic/claude-haiku-5-5")
    monkeypatch.setenv("TRANSCRIBE_FALLBACK_API_KEY", "fallback-key-12")
    with pytest.raises(ConfigError, match="TRANSCRIBE_FALLBACK_MODEL"):
        Settings.load()


def test_a_gemini_model_without_any_key_is_refused(env, monkeypatch):
    monkeypatch.delenv("TRANSCRIBE_API_KEY")
    with pytest.raises(ConfigError, match="TRANSCRIBE_API_KEY"):
        Settings.load()


def test_the_bot_key_is_reused_when_the_providers_match(env, monkeypatch):
    monkeypatch.delenv("TRANSCRIBE_API_KEY")
    env.write_text("LLM_MODEL: gemini/gemini-3.7-flash\n", encoding="utf-8")
    monkeypatch.setenv("LLM_API_KEY", "bot-gemini-key-12")
    assert Settings.load().transcribe_api_key() == "bot-gemini-key-12"


def test_the_bot_key_is_not_reused_for_another_provider(env, monkeypatch):
    monkeypatch.delenv("TRANSCRIBE_API_KEY")
    env.write_text("LLM_MODEL: anthropic/claude-sonnet-5\n", encoding="utf-8")
    monkeypatch.setenv("LLM_API_KEY", "bot-anthropic-key")
    with pytest.raises(ConfigError, match="TRANSCRIBE_API_KEY"):
        Settings.load()


def test_an_explicit_transcription_key_wins_over_the_bot_key(env, monkeypatch):
    env.write_text("LLM_MODEL: gemini/gemini-3.7-flash\n", encoding="utf-8")
    monkeypatch.setenv("LLM_API_KEY", "bot-gemini-key-12")
    assert Settings.load().transcribe_api_key() == "transcribe-key-1234"


def test_vertex_needs_no_key(env, monkeypatch):
    monkeypatch.delenv("TRANSCRIBE_API_KEY")
    monkeypatch.setenv("TRANSCRIBE_MODEL", "vertex_ai/gemini-3.8-flash")
    assert Settings.load().transcribe_api_key() is None


def test_without_media_the_transcription_key_is_not_required(env, monkeypatch):
    monkeypatch.delenv("TRANSCRIBE_API_KEY")
    monkeypatch.setenv("MEDIA_ENABLED", "false")
    assert Settings.load().transcribe_api_key() is None


def test_the_transcription_base_is_never_inherited_from_the_bot(env, monkeypatch):
    monkeypatch.setenv("LLM_API_BASE", "http://proxy:4000")
    s = Settings.load()
    assert s.LLM_API_BASE == "http://proxy:4000"
    assert s.TRANSCRIBE_API_BASE is None


def test_the_fallback_reuses_the_primary_key_for_the_same_provider(env, monkeypatch):
    monkeypatch.setenv("TRANSCRIBE_FALLBACK_MODEL", "gemini/gemini-3.7-flash")
    assert Settings.load().transcribe_fallback_api_key() == "transcribe-key-1234"


def test_a_fallback_of_another_provider_needs_its_own_key_for_transcription(env, monkeypatch):
    monkeypatch.setenv("TRANSCRIBE_FALLBACK_MODEL", "vertex_ai/gemini-3.8-flash")
    with pytest.raises(ConfigError, match="TRANSCRIBE_FALLBACK_API_KEY"):
        Settings.load()
    monkeypatch.setenv("TRANSCRIBE_FALLBACK_API_KEY", "fallback-key-12")
    assert Settings.load().transcribe_fallback_api_key() == "fallback-key-12"


def test_a_base_with_a_fallback_that_has_no_key_is_refused(env, monkeypatch):
    # Vertex on ADC both ways: no key anywhere, so the fallback would be handed the primary's base.
    monkeypatch.delenv("TRANSCRIBE_API_KEY")
    monkeypatch.setenv("TRANSCRIBE_MODEL", "vertex_ai/gemini-3.8-flash")
    monkeypatch.setenv("TRANSCRIBE_FALLBACK_MODEL", "vertex_ai/gemini-3.7-flash")
    monkeypatch.setenv("TRANSCRIBE_API_BASE", "https://proxy.example/v1")
    with pytest.raises(ConfigError, match="TRANSCRIBE_API_BASE"):
        Settings.load()
    monkeypatch.delenv("TRANSCRIBE_API_BASE")
    assert Settings.load().transcribe_fallback_api_key() is None


def test_a_base_with_a_fallback_that_has_a_key_is_fine(env, monkeypatch):
    monkeypatch.setenv("TRANSCRIBE_FALLBACK_MODEL", "gemini/gemini-3.7-flash")
    monkeypatch.setenv("TRANSCRIBE_API_BASE", "https://proxy.example/v1")
    assert Settings.load().TRANSCRIBE_API_BASE == "https://proxy.example/v1"


def test_the_attempt_timeout_cannot_pass_the_deadline(env, monkeypatch):
    monkeypatch.setenv("TRANSCRIBE_TIMEOUT_S", "30")
    monkeypatch.setenv("TRANSCRIBE_DEADLINE_S", "20")
    with pytest.raises(ConfigError, match="TRANSCRIBE_TIMEOUT_S"):
        Settings.load()
    monkeypatch.setenv("TRANSCRIBE_DEADLINE_S", "30")
    assert Settings.load().TRANSCRIBE_TIMEOUT_S == 30


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("TRANSCRIBE_RETRIES", "-1"),
        ("TRANSCRIBE_RETRIES", "6"),
        ("TRANSCRIBE_RETRY_WAIT_S", "-1"),
        ("TRANSCRIBE_DEADLINE_S", "0"),
        ("VOICE_MAX_SECONDS", "0"),
        ("VOICE_DAILY_TOKENS", "0"),
        ("VOICE_GLOBAL_DAILY_TOKENS", "0"),
        ("VOICE_MIN_BITRATE_BPS", "0"),
    ],
)
def test_transcription_numbers_are_bounded(env, monkeypatch, name, value):
    monkeypatch.setenv(name, value)
    with pytest.raises(ConfigError, match=name):
        Settings.load()


def test_the_transcription_keys_are_secrets(env, monkeypatch):
    from agent import logs

    for name in ("TRANSCRIBE_API_KEY", "TRANSCRIBE_FALLBACK_API_KEY"):
        env.write_text(f"{name}: leaked\n", encoding="utf-8")
        with pytest.raises(ConfigError, match=name):
            Settings.load()
    env.write_text("TRANSCRIBE_FALLBACK_MODEL: gemini/gemini-3.7-flash\n", encoding="utf-8")
    monkeypatch.setenv("TRANSCRIBE_FALLBACK_API_KEY", "fallback-sentinel-9")
    monkeypatch.setattr(logs, "_SECRETS", set())
    Settings.load()
    assert {"transcribe-key-1234", "fallback-sentinel-9"} <= logs._SECRETS


def test_a_short_or_blank_transcription_key_is_refused(env, monkeypatch):
    monkeypatch.setenv("TRANSCRIBE_API_KEY", "abc1234")
    with pytest.raises(ConfigError, match="TRANSCRIBE_API_KEY"):
        Settings.load()
    monkeypatch.setenv("TRANSCRIBE_API_KEY", "  ")
    with pytest.raises(ConfigError, match="TRANSCRIBE_API_KEY"):
        Settings.load()


@pytest.mark.parametrize("variable", ["GEMINI_API_KEY", "GOOGLE_API_KEY"])
def test_a_key_the_sdk_reads_from_the_environment_satisfies_a_gemini_model(env, monkeypatch, variable):
    monkeypatch.delenv("TRANSCRIBE_API_KEY")
    monkeypatch.setenv(variable, "sdk-env-key-1234")
    s = Settings.load()
    # Nothing is passed explicitly: LiteLLM finds the variable on its own.
    assert s.transcribe_api_key() is None


def test_a_blank_sdk_variable_does_not_count_as_a_key(env, monkeypatch):
    monkeypatch.delenv("TRANSCRIBE_API_KEY")
    monkeypatch.setenv("GEMINI_API_KEY", "  ")
    with pytest.raises(ConfigError, match="TRANSCRIBE_API_KEY"):
        Settings.load()
