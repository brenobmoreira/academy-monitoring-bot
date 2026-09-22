/**
 * The "Hoje" screen: fixed cells the user fills by hand, read into the same arguments the API
 * accepts, so the menu and the agent share one validator and one write path.
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

  /** yyyy-MM-dd of the screen's date cell, today when it is empty. */
  date() {
    const v = HojeScreen.sheet_().getRange(HojeScreen.CELLS.date).getValue();
    return v instanceof Date ? Sheets.dayKey(v) : Sheets.todayKey();
  },

  /**
   * Cell values go through as the sheet holds them; a number typed as text reaches the validator
   * as text and is reported, never guessed. Yes/no cells default to "Não", so only "Sim" counts.
   * @returns {{date: string, fields: Object}} arguments for diary.upsert
   */
  readDiaryArgs() {
    const sheet = HojeScreen.sheet_();
    const fields = {};
    Object.keys(HojeScreen.CELLS.diary).forEach((field) => {
      const v = sheet.getRange(HojeScreen.CELLS.diary[field]).getValue();
      const type = Schema.DIARY_FIELDS[field].type;
      if (type === 'boolean') { if (v === Schema.YES) fields[field] = true; return; }
      if (v === '' || v === null) return;
      fields[field] = type === 'text' ? String(v) : v;
    });
    return { date: HojeScreen.date(), fields };
  },

  /** @returns {{date: string, session?: string, phase?: string, exercises: Object[]}} arguments for workout.upsert */
  readWorkoutArgs() {
    const sheet = HojeScreen.sheet_();
    const T = HojeScreen.TABLE;
    const table = sheet.getRange(T.firstRow, T.firstCol, T.rows, T.cols).getValues();
    const exercises = [];
    table.forEach((line) => {
      const name = HojeScreen.text_(line[0]);
      if (!name) return;
      const sets = [];
      for (let n = 0; n < Schema.MAX_SETS; n++) {
        const kg = line[1 + n * 2];
        const reps = line[2 + n * 2];
        if (reps !== '') sets.push({ kg: kg === '' ? 0 : kg, reps });
      }
      if (!sets.length) return;
      const ex = { name, sets };
      if (line[9] !== '') ex.rir = line[9];
      if (line[10] !== '') ex.pain = line[10];
      if (HojeScreen.text_(line[11])) ex.note = HojeScreen.text_(line[11]);
      exercises.push(ex);
    });
    const args = { date: HojeScreen.date(), exercises };
    const session = HojeScreen.text_(sheet.getRange(HojeScreen.CELLS.session).getValue());
    const phase = HojeScreen.currentPhase();
    if (session) args.session = session;
    if (phase) args.phase = phase;
    return args;
  },

  clearDiary() {
    const sheet = HojeScreen.sheet_();
    Object.keys(HojeScreen.CELLS.diary).forEach((field) => {
      const range = sheet.getRange(HojeScreen.CELLS.diary[field]);
      if (Schema.DIARY_FIELDS[field].type === 'boolean') range.setValue(Schema.NO); else range.clearContent();
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
    const args = HojeScreen.readDiaryArgs();
    if (!Object.keys(args.fields).length) return 'Nada preenchido no bloco do dia.';
    const res = SheetApi.run('diary.upsert', args);
    if (!res.ok) return SheetMenu.errors_(res.errors);
    HojeScreen.clearDiary();
    return SheetMenu.diarySummary(res.result);
  });
}

function menuSaveWorkout() {
  SheetMenu.run_(() => {
    const args = HojeScreen.readWorkoutArgs();
    if (!args.exercises.length) return 'Nenhuma série preenchida na tabela de treino.';
    const res = SheetApi.run('workout.upsert', args);
    if (!res.ok) return SheetMenu.errors_(res.errors);
    HojeScreen.clearWorkout();
    return SheetMenu.workoutSummary(res.result);
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

  errors_(errors) {
    return ['Não gravei:'].concat(errors.map((e) => `• ${e.path.replace(/^args\./, '')}: ${e.message}`)).join('\n');
  },

  /** "21/09 · Peso kg 82,4 · Muay Thai Sim" from a diary.upsert result */
  diarySummary(result) {
    const parts = Object.keys(result.fields).map((field) => {
      const header = Schema.DIARY_FIELDS[field].header.replace(/ \d–\d$/, '');
      return `${header} ${SheetMenu.cell_(Schema.toCell(field, result.fields[field]))}`;
    });
    return `${SheetMenu.day_(result.date)} · ${parts.join(' · ')}`;
  },

  /** "21/09 · Upper (Adaptação):" then "• Supino inclinado 60×8 62,5×8 (RIR 2)" per exercise */
  workoutSummary(result) {
    const lines = [`${SheetMenu.day_(result.date)} · ${result.session} (${result.phase}):`];
    result.exercises.forEach((ex) => {
      const sets = ex.sets.map((s) => `${SheetMenu.cell_(s.kg)}×${s.reps}`).join(' ');
      const extras = [];
      if (ex.rir !== undefined) extras.push(`RIR ${ex.rir}`);
      if (ex.pain !== undefined) extras.push(`dor ${ex.pain}`);
      lines.push(`• ${ex.name} ${sets}${extras.length ? ` (${extras.join(', ')})` : ''}`);
    });
    return lines.join('\n');
  },

  day_(ymd) {
    return `${ymd.slice(8, 10)}/${ymd.slice(5, 7)}`;
  },

  cell_(v) {
    return typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  },
};
