/**
 * Shared helpers for header-addressed tabs. Every tab in the model has its header on one row
 * and data below; formula columns may extend further down than the last date, so "next empty"
 * is measured on the date column only.
 */
const Sheets = {
  /** @returns {Object<string, number>} header text -> 1-based column index */
  columnIndex(sheet, headerRow) {
    const lastCol = sheet.getLastColumn();
    if (lastCol === 0) return {};
    const headers = sheet.getRange(headerRow, 1, 1, lastCol).getDisplayValues()[0];
    const index = {};
    headers.forEach((h, i) => { if (h) index[String(h).trim()] = i + 1; });
    return index;
  },

  /** Rows as objects keyed by header text, in sheet order, with their 1-based row number. */
  readRows(sheet, headerRow) {
    const columns = Sheets.columnIndex(sheet, headerRow);
    const first = headerRow + 1;
    const last = sheet.getLastRow();
    if (last < first) return [];
    const lastCol = sheet.getLastColumn();
    const values = sheet.getRange(first, 1, last - first + 1, lastCol).getValues();
    return values.map((line, i) => {
      const row = { __row: first + i };
      Object.keys(columns).forEach((h) => { row[h] = line[columns[h] - 1]; });
      return row;
    });
  },

  findRowByDate(sheet, firstRow, dateCol, date) {
    const last = sheet.getLastRow();
    if (last < firstRow) return null;
    const key = Sheets.dayKey(date);
    const values = sheet.getRange(firstRow, dateCol, last - firstRow + 1, 1).getValues();
    for (let i = 0; i < values.length; i++) {
      const v = values[i][0];
      if (v instanceof Date && Sheets.dayKey(v) === key) return firstRow + i;
    }
    return null;
  },

  /** First row at/after firstRow whose cell in `col` is empty. */
  nextEmptyRow(sheet, firstRow, col) {
    const last = sheet.getLastRow();
    if (last < firstRow) return firstRow;
    const values = sheet.getRange(firstRow, col, last - firstRow + 1, 1).getValues();
    for (let i = 0; i < values.length; i++) {
      if (values[i][0] === '' || values[i][0] === null) return firstRow + i;
    }
    return last + 1;
  },

  dayKey(date) {
    return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  },

  /** Local midnight for a yyyy-MM-dd string, so cells hold pure dates like hand-typed rows. */
  localDate(ymd) {
    return new Date(`${ymd}T00:00:00`);
  },

  today() {
    return Sheets.localDate(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));
  },
};
