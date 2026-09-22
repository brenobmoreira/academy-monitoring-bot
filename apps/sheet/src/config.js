/**
 * Central access to every configurable value.
 * All values come from Script Properties (Project Settings > Script Properties).
 * Nothing account-specific is hard-coded anywhere else in the project.
 */
const Config = {
  KEYS: {
    TELEGRAM_BOT_TOKEN: 'TELEGRAM_BOT_TOKEN',
    WEBHOOK_SECRET: 'WEBHOOK_SECRET',
    ALLOWED_CHAT_IDS: 'ALLOWED_CHAT_IDS', // comma-separated
    LLM_BASE_URL: 'LLM_BASE_URL',         // optional; OpenAI-compatible, e.g. Gemini's
    LLM_API_KEY: 'LLM_API_KEY',
    LLM_MODEL: 'LLM_MODEL',
    DIARY_SHEET: 'DIARY_SHEET',           // optional, default "Diário"
    HEADER_ROW: 'HEADER_ROW',             // optional, default 5
    REMINDER_HOUR: 'REMINDER_HOUR',       // optional, default 21
  },

  get_(key, fallback) {
    const value = PropertiesService.getScriptProperties().getProperty(key);
    if (value === null || value === '') {
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing Script Property: ${key}`);
    }
    return value;
  },

  telegramBotToken() { return this.get_(this.KEYS.TELEGRAM_BOT_TOKEN); },
  webhookSecret()    { return this.get_(this.KEYS.WEBHOOK_SECRET); },
  diarySheet()       { return this.get_(this.KEYS.DIARY_SHEET, 'Diário'); },
  headerRow()        { return Number(this.get_(this.KEYS.HEADER_ROW, '5')); },
  reminderHour()     { return Number(this.get_(this.KEYS.REMINDER_HOUR, '21')); },

  allowedChatIds() {
    return this.get_(this.KEYS.ALLOWED_CHAT_IDS)
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  },

  /** @returns {{baseUrl: string, apiKey: string, model: string} | null} null when no LLM is configured */
  llm() {
    const baseUrl = this.get_(this.KEYS.LLM_BASE_URL, '');
    if (!baseUrl) return null;
    return {
      baseUrl: baseUrl.replace(/\/+$/, ''),
      apiKey: this.get_(this.KEYS.LLM_API_KEY),
      model: this.get_(this.KEYS.LLM_MODEL, 'gemini-2.5-flash'),
    };
  },

  /** Tab names are fixed by the spreadsheet model; only the diary tab is overridable. */
  SHEETS: {
    WORKOUT: 'Registro de treino',
    PLAN: 'Ficha de treino',
    PLAN_HISTORY: 'Histórico de fichas',
    EXERCISES: 'Exercícios',
    PROGRESSION: 'Progressão',
    HOJE: 'Hoje',
  },
};
