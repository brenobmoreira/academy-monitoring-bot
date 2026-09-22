/**
 * Central access to every configurable value.
 * All values come from Script Properties (Project Settings > Script Properties).
 * Nothing account-specific is hard-coded anywhere else in the project.
 */
const Config = {
  KEYS: {
    SHEET_API_KEY: 'SHEET_API_KEY', // shared secret the agent sends in every request body
    DIARY_SHEET: 'DIARY_SHEET',     // optional, default "Diário"
    HEADER_ROW: 'HEADER_ROW',       // optional, default 5
  },

  get_(key, fallback) {
    const value = PropertiesService.getScriptProperties().getProperty(key);
    if (value === null || value === '') {
      if (fallback !== undefined) return fallback;
      throw new Error(`Missing Script Property: ${key}`);
    }
    return value;
  },

  sheetApiKey() { return this.get_(this.KEYS.SHEET_API_KEY); },
  diarySheet()  { return this.get_(this.KEYS.DIARY_SHEET, 'Diário'); },
  headerRow()   { return Number(this.get_(this.KEYS.HEADER_ROW, '5')); },

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
