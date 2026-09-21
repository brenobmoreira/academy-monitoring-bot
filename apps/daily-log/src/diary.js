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
   * @param {Date} date
   * @param {Object} diary  normalized diary fields (see Schema.normalizeDiary)
   * @returns {{row: number, written: string[]}}
   */
  upsert(date, diary) {
    const sheet = DiaryRepo.sheet_();
    const columns = Sheets.columnIndex(sheet, Config.headerRow());
    const dateCol = columns[Schema.DATE_HEADER];
    if (!dateCol) throw new Error(`Header "${Schema.DATE_HEADER}" not found on row ${Config.headerRow()}`);

    let row = Sheets.findRowByDate(sheet, Config.headerRow() + 1, dateCol, date);
    if (!row) {
      row = Sheets.nextEmptyRow(sheet, Config.headerRow() + 1, dateCol);
      sheet.getRange(row, dateCol).setValue(date);
    }

    const written = [];
    Object.keys(Schema.DIARY_FIELDS).forEach((field) => {
      if (diary[field] === undefined) return;
      const col = columns[Schema.DIARY_FIELDS[field].header];
      if (!col) return; // column absent in this sheet: skip silently
      sheet.getRange(row, col).setValue(Schema.toCell(field, diary[field]));
      written.push(field);
    });
    return { row, written };
  },
};
