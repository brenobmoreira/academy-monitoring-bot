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
    SPREADSHEET_ID: 'SPREADSHEET_ID',
    SHEET_NAME: 'SHEET_NAME',             // optional, default "Diário"
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
  spreadsheetId()    { return this.get_(this.KEYS.SPREADSHEET_ID); },
  sheetName()        { return this.get_(this.KEYS.SHEET_NAME, 'Diário'); },
  headerRow()        { return Number(this.get_(this.KEYS.HEADER_ROW, '5')); },
  reminderHour()     { return Number(this.get_(this.KEYS.REMINDER_HOUR, '21')); },

  allowedChatIds() {
    return this.get_(this.KEYS.ALLOWED_CHAT_IDS)
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  },
};
