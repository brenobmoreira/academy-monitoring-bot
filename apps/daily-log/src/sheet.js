/**
 * Persistence. One sheet, one row per day, keyed by `date`.
 * Writes are upserts: fields present in the entry overwrite, absent ones are preserved.
 */
const SheetRepo = {
  COLUMNS: ['date', 'weight_kg', 'sleep_h', 'load', 'trained', 'raw', 'updated_at'],

  sheet_() {
    const ss = SpreadsheetApp.openById(Config.spreadsheetId());
    const name = Config.sheetName();
    let sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
      sheet.appendRow(SheetRepo.COLUMNS);
      sheet.setFrozenRows(1);
    }
    return sheet;
  },

  /** @param {{date: string, raw: string, weightKg?: number, sleepH?: number, load?: number, trained?: boolean}} entry */
  upsert(entry) {
    const sheet = SheetRepo.sheet_();
    const rowIndex = SheetRepo.findRowByDate_(sheet, entry.date);
    const current = rowIndex ? SheetRepo.readRow_(sheet, rowIndex) : {};

    const merged = {
      date: entry.date,
      weight_kg: entry.weightKg !== undefined ? entry.weightKg : current.weight_kg,
      sleep_h: entry.sleepH !== undefined ? entry.sleepH : current.sleep_h,
      load: entry.load !== undefined ? entry.load : current.load,
      trained: entry.trained !== undefined ? entry.trained : current.trained,
      raw: entry.raw,
      updated_at: new Date(),
    };
    const values = SheetRepo.COLUMNS.map((c) => (merged[c] === undefined ? '' : merged[c]));

    if (rowIndex) {
      sheet.getRange(rowIndex, 1, 1, values.length).setValues([values]);
    } else {
      sheet.appendRow(values);
    }
    return merged;
  },

  findRowByDate_(sheet, date) {
    const last = sheet.getLastRow();
    if (last < 2) return null;
    const dates = sheet.getRange(2, 1, last - 1, 1).getDisplayValues();
    for (let i = 0; i < dates.length; i++) {
      if (dates[i][0] === date) return i + 2;
    }
    return null;
  },

  readRow_(sheet, rowIndex) {
    const values = sheet.getRange(rowIndex, 1, 1, SheetRepo.COLUMNS.length).getValues()[0];
    const row = {};
    SheetRepo.COLUMNS.forEach((c, i) => { row[c] = values[i] === '' ? undefined : values[i]; });
    return row;
  },
};
