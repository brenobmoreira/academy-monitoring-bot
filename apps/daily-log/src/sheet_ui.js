/**
 * The "Hoje" screen: fixed cells the user fills by hand, read into an Entry by the sheet menu.
 * Cell addresses mirror the spreadsheet model; change here if the layout changes.
 */
const HojeScreen = {
  CELLS: {
    date: 'B5',
    diary: {
      weightKg: 'B7', sleepH: 'E7', steps: 'H7', cardioMin: 'K7',
      dietComplete: 'B9', muayThai: 'E9', waistCm: 'H9', hunger: 'K9',
      fatigue: 'B11', notes: 'E11',
    },
    session: 'B23',
    phase: 'E23',
  },

  sheet_() {
    return SpreadsheetApp.getActive().getSheetByName(Config.SHEETS.HOJE);
  },

  /** Phase selected on the Hoje screen, or undefined when the tab/cell is empty. */
  currentPhase() {
    const sheet = HojeScreen.sheet_();
    if (!sheet) return undefined;
    const v = sheet.getRange(HojeScreen.CELLS.phase).getValue();
    return v === '' || v === null ? undefined : String(v).trim();
  },
};
