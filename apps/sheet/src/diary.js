/**
 * Diary persistence: one row per day in the diary tab, keyed by the date column.
 *
 * Upsert semantics: fields present in the entry overwrite their cell; every other cell in
 * the row (including formula columns) is left untouched. Column positions are resolved from
 * the header row at runtime via Schema.
 */
const DiaryRepo = {
  sheet_() {
    const name = Config.diarySheet();
    const sheet = SpreadsheetApp.getActive().getSheetByName(name);
    if (!sheet) throw new Error(`Sheet "${name}" not found`);
    return sheet;
  },

  /**
   * Every column is resolved before the first write, so a renamed header fails the whole call.
   * @param {Date} date
   * @param {Object} fields  validated diary fields (see Validator.diaryUpsert)
   * @param {UndoCapture_} [capture]  records the previous cell values (see UndoLog)
   * @returns {{row: number, written: string[]}}
   */
  upsert(date, fields, capture = UndoLog.capture()) {
    const sheet = DiaryRepo.sheet_();
    const headerRow = Config.headerRow();
    const columns = Sheets.columnIndex(sheet, headerRow);
    const dateCol = columns[Schema.DATE_HEADER];
    if (!dateCol) throw new Error(`Header "${Schema.DATE_HEADER}" not found on row ${headerRow}`);
    const written = Object.keys(Schema.DIARY_FIELDS).filter((field) => fields[field] !== undefined);
    const missing = written.map((f) => Schema.DIARY_FIELDS[f].header).filter((h) => !columns[h]);
    if (missing.length) throw new Error(`Header ${missing.map((h) => `"${h}"`).join(', ')} not found on row ${headerRow} of "${sheet.getName()}"`);

    let row = Sheets.findRowByDate(sheet, headerRow + 1, dateCol, date);
    if (!row) {
      row = Sheets.nextEmptyRow(sheet, headerRow + 1, dateCol);
      capture.newRow(sheet, row);
      capture.set(sheet, row, dateCol, date);
    }
    written.forEach((field) => {
      capture.set(sheet, row, columns[Schema.DIARY_FIELDS[field].header], Schema.toCell(field, fields[field]));
    });
    return { row, written };
  },

  /**
   * Days between from and to (yyyy-MM-dd, inclusive) that have a row, oldest first, as
   * {date, <field>: value}. Empty cells are left out, and so is a dated row with no field filled
   * in, so a pre-dated template row does not read as a logged day. With two rows for one date
   * the first wins, as in upsert.
   */
  range(from, to) {
    const sheet = DiaryRepo.sheet_();
    const rows = Sheets.readRows(sheet, Config.headerRow());
    const byDate = {};
    rows.forEach((r) => {
      const d = r[Schema.DATE_HEADER];
      if (!(d instanceof Date)) return;
      const key = Sheets.dayKey(d);
      if (key < from || key > to || byDate[key]) return;
      const day = {};
      Object.keys(Schema.DIARY_FIELDS).forEach((field) => {
        const value = Schema.fromCell(field, r[Schema.DIARY_FIELDS[field].header]);
        if (value !== undefined) day[field] = value;
      });
      if (Object.keys(day).length) byDate[key] = { date: key, ...day };
    });
    return Object.keys(byDate).sort().map((key) => byDate[key]);
  },

  /**
   * Diary fields of one day as API values (Sim/Não become booleans). Empty cells and columns
   * missing from the header row are omitted, so a day without a row reads as {}.
   * @param {Date} date
   * @returns {Object}
   */
  read(date) {
    const sheet = DiaryRepo.sheet_();
    const headerRow = Config.headerRow();
    const columns = Sheets.columnIndex(sheet, headerRow);
    const dateCol = columns[Schema.DATE_HEADER];
    if (!dateCol) throw new Error(`Header "${Schema.DATE_HEADER}" not found on row ${headerRow}`);
    const row = Sheets.findRowByDate(sheet, headerRow + 1, dateCol, date);
    if (!row) return {};
    const line = sheet.getRange(row, 1, 1, sheet.getLastColumn()).getValues()[0];
    const fields = {};
    Object.keys(Schema.DIARY_FIELDS).forEach((field) => {
      const col = columns[Schema.DIARY_FIELDS[field].header];
      const value = col ? Schema.fromCell(field, line[col - 1]) : undefined;
      if (value !== undefined) fields[field] = value;
    });
    return fields;
  },
};
