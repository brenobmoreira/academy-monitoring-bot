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
  /** Exercise table: one row per exercise, columns A..L */
  TABLE: { firstRow: 27, rows: 12, firstCol: 1, cols: 12 },

  sheet_() {
    const sheet = SpreadsheetApp.getActive().getSheetByName(Config.SHEETS.HOJE);
    if (!sheet) throw new Error(`Sheet "${Config.SHEETS.HOJE}" not found`);
    return sheet;
  },

  /** Phase selected on the Hoje screen, or undefined when the tab/cell is empty. */
  currentPhase() {
    const sheet = SpreadsheetApp.getActive().getSheetByName(Config.SHEETS.HOJE);
    if (!sheet) return undefined;
    return HojeScreen.text_(sheet.getRange(HojeScreen.CELLS.phase).getValue());
  },

  date() {
    const v = HojeScreen.sheet_().getRange(HojeScreen.CELLS.date).getValue();
    return v instanceof Date ? Sheets.localDate(Sheets.dayKey(v)) : Sheets.today();
  },

  /** @returns {{date: Date, diary?: Object}} */
  readDiary() {
    const sheet = HojeScreen.sheet_();
    const raw = {};
    Object.keys(HojeScreen.CELLS.diary).forEach((field) => {
      raw[field] = sheet.getRange(HojeScreen.CELLS.diary[field]).getValue();
    });
    // yes/no cells default to "Não" on the screen; only an explicit "Sim" is a statement
    ['dietComplete', 'muayThai'].forEach((f) => { if (!Schema.toBoolean_(raw[f])) delete raw[f]; });
    const diary = Schema.normalizeDiary(raw);
    const entry = { date: HojeScreen.date() };
    if (Object.keys(diary).length) entry.diary = diary;
    return entry;
  },

  /** @returns {{date: Date, workout?: Object}} */
  readWorkout() {
    const sheet = HojeScreen.sheet_();
    const T = HojeScreen.TABLE;
    const session = HojeScreen.text_(sheet.getRange(HojeScreen.CELLS.session).getValue());
    const phase = HojeScreen.currentPhase();
    const table = sheet.getRange(T.firstRow, T.firstCol, T.rows, T.cols).getValues();
    const exercises = [];
    table.forEach((line) => {
      const name = HojeScreen.text_(line[0]);
      if (!name) return;
      const sets = [];
      for (let n = 0; n < Schema.MAX_SETS; n++) {
        const kg = line[1 + n * 2];
        const reps = line[2 + n * 2];
        if (Number(reps) > 0) sets.push({ kg: Number(kg) || 0, reps: Number(reps) });
      }
      if (!sets.length) return;
      const ex = { name, sets };
      if (line[9] !== '') ex.rir = Number(line[9]);
      if (line[10] !== '') ex.pain = Number(line[10]);
      if (HojeScreen.text_(line[11])) ex.note = HojeScreen.text_(line[11]);
      exercises.push(ex);
    });
    const entry = { date: HojeScreen.date() };
    if (exercises.length) {
      if (!session) throw new Error('Selecione a Sessão (B23) antes de salvar o treino');
      entry.workout = { session, phase, exercises };
    }
    return entry;
  },

  clearDiary() {
    const sheet = HojeScreen.sheet_();
    Object.keys(HojeScreen.CELLS.diary).forEach((field) => {
      const type = Schema.DIARY_FIELDS[field].type;
      const range = sheet.getRange(HojeScreen.CELLS.diary[field]);
      if (type === 'yesno') range.setValue(Schema.NO); else range.clearContent();
    });
  },

  /** Keeps exercise names (loaded from the plan); clears sets, RIR, pain and notes. */
  clearWorkout() {
    const T = HojeScreen.TABLE;
    HojeScreen.sheet_().getRange(T.firstRow, T.firstCol + 1, T.rows, T.cols - 1).clearContent();
  },

  text_(v) {
    return v === '' || v === null || v === undefined ? undefined : String(v).trim();
  },
};

// ---- Menu entry points (must be global functions) --------------------------------------

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Registro')
    .addItem('Salvar dia', 'menuSaveDay')
    .addItem('Salvar treino', 'menuSaveWorkout')
    .addItem('Atualizar progressão', 'menuRefreshProgression')
    .addToUi();
}

function menuSaveDay() {
  SheetMenu.run_(() => {
    const entry = HojeScreen.readDiary();
    if (EntryService.isEmpty(entry)) return 'Nada preenchido no bloco do dia.';
    const result = EntryService.apply(entry);
    HojeScreen.clearDiary();
    return Telegram.formatConfirmation(entry, result);
  });
}

function menuSaveWorkout() {
  SheetMenu.run_(() => {
    const entry = HojeScreen.readWorkout();
    if (EntryService.isEmpty(entry)) return 'Nenhuma série preenchida na tabela de treino.';
    const result = EntryService.apply(entry);
    HojeScreen.clearWorkout();
    return Telegram.formatConfirmation(entry, result);
  });
}

function menuRefreshProgression() {
  SheetMenu.run_(() => {
    const r = Progression.refresh();
    return `Progressão de ${r.exercise}: ${r.sessions} sessões.`;
  });
}

const SheetMenu = {
  run_(action) {
    let message;
    try {
      message = action();
    } catch (err) {
      console.error(err);
      message = `⚠ ${err.message}`;
    }
    SpreadsheetApp.getUi().alert(message);
  },
};
