/**
 * Rebuilds the "Progressão" tab for the exercise selected in its picker cell:
 * the last N sessions of that exercise from the workout log, newest first.
 */
const Progression = {
  PICKER_CELL: 'B5',
  HEADER_ROW: 9,
  MAX_SESSIONS: 20,

  refresh() {
    const sheet = SpreadsheetApp.getActive().getSheetByName(Config.SHEETS.PROGRESSION);
    if (!sheet) throw new Error(`Sheet "${Config.SHEETS.PROGRESSION}" not found`);
    const exercise = String(sheet.getRange(Progression.PICKER_CELL).getValue() || '').trim();
    if (!exercise) throw new Error(`Selecione o exercício em ${Config.SHEETS.PROGRESSION}!${Progression.PICKER_CELL}`);

    const columns = Sheets.columnIndex(sheet, Progression.HEADER_ROW);
    const width = Math.max(...Object.values(columns));
    const H = WorkoutRepo.HEADERS;
    const key = WorkoutPlan.normalize(exercise);
    const log = Sheets.readRows(WorkoutRepo.sheet_(), Config.headerRow())
      .filter((r) => r[H.date] instanceof Date && WorkoutPlan.normalize(r[H.exercise]) === key)
      .sort((a, b) => b[H.date] - a[H.date])
      .slice(0, Progression.MAX_SESSIONS);

    const firstRow = Progression.HEADER_ROW + 1;
    sheet.getRange(firstRow, 1, Progression.MAX_SESSIONS, width).clearContent();
    if (log.length) {
      const lines = log.map((r) => {
        const cells = {
          Data: r[H.date], Ficha: r[H.plan], 'Exercício': r[H.exercise],
          Volume: r[H.volume], 'Séries válidas': r[H.setsDone], 'RIR final': r[H.rir],
        };
        for (let n = 1; n <= Schema.MAX_SETS; n++) {
          cells[`kg ${n}`] = r[WorkoutRepo.kgHeader(n)];
          cells[`reps ${n}`] = r[WorkoutRepo.repsHeader(n)];
        }
        const line = new Array(width).fill('');
        Object.keys(cells).forEach((h) => { if (columns[h]) line[columns[h] - 1] = cells[h] === undefined ? '' : cells[h]; });
        return line;
      });
      sheet.getRange(firstRow, 1, lines.length, width).setValues(lines);
    }
    return { exercise, sessions: log.length };
  },
};
