/**
 * Persistence against an existing sheet: one row per day keyed by the date column.
 *
 * Upsert semantics: fields present in the entry overwrite their cell; every other cell in
 * the row (including formula columns) is left untouched. Column positions are resolved from
 * the header row at runtime via Schema.
 */
const SheetRepo = {
  sheet_() {
    const sheet = SpreadsheetApp.openById(Config.spreadsheetId()).getSheetByName(Config.sheetName());
    if (!sheet) throw new Error(`Sheet "${Config.sheetName()}" not found`);
    return sheet;
  },

  /** @returns {Object<string, number>} header text -> 1-based column index */
  columnIndex_(sheet) {
    const headerRow = Config.headerRow();
    const headers = sheet.getRange(headerRow, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
    const index = {};
    headers.forEach((h, i) => { if (h) index[h.trim()] = i + 1; });
    if (!index[Schema.DATE_HEADER]) {
      throw new Error(`Header "${Schema.DATE_HEADER}" not found on row ${headerRow}`);
    }
    return index;
  },

  /**
   * @param {{date: Date, [field: string]: any}} entry  keys other than `date` are Schema.FIELDS
   * @returns {{row: number, written: string[]}}
   */
  upsert(entry) {
    const sheet = SheetRepo.sheet_();
    const columns = SheetRepo.columnIndex_(sheet);
    const dateCol = columns[Schema.DATE_HEADER];

    let row = SheetRepo.findRowByDate_(sheet, dateCol, entry.date);
    if (!row) {
      row = SheetRepo.nextEmptyRow_(sheet, dateCol);
      sheet.getRange(row, dateCol).setValue(entry.date);
    }

    const written = [];
    Object.keys(Schema.FIELDS).forEach((field) => {
      if (entry[field] === undefined) return;
      const col = columns[Schema.FIELDS[field].header];
      if (!col) return; // column absent in this sheet: skip silently
      sheet.getRange(row, col).setValue(Schema.toCell(field, entry[field]));
      written.push(field);
    });
    return { row, written };
  },

  findRowByDate_(sheet, dateCol, date) {
    const first = Config.headerRow() + 1;
    const last = sheet.getLastRow();
    if (last < first) return null;
    const key = SheetRepo.dayKey_(date);
    const values = sheet.getRange(first, dateCol, last - first + 1, 1).getValues();
    for (let i = 0; i < values.length; i++) {
      const v = values[i][0];
      if (v instanceof Date && SheetRepo.dayKey_(v) === key) return first + i;
    }
    return null;
  },

  /** First row below the header whose date cell is empty (formula columns may extend further). */
  nextEmptyRow_(sheet, dateCol) {
    const first = Config.headerRow() + 1;
    const last = sheet.getLastRow();
    if (last < first) return first;
    const values = sheet.getRange(first, dateCol, last - first + 1, 1).getValues();
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] === '') return first + i;
    }
    return last + 1;
  },

  dayKey_(date) {
    return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  },
};
