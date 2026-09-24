/**
 * Workout log: one row per exercise per session in "Registro de treino".
 * Prescription columns come from "Ficha de treino"; canonical exercise names from "Exercícios".
 */
const WorkoutPlan = {
  PHASE_ADAPTATION: 'Adaptação',
  PHASE_REGULAR: 'Regular',

  sheet_(name) {
    const sheet = SpreadsheetApp.getActive().getSheetByName(name);
    if (!sheet) throw new Error(`Sheet "${name}" not found`);
    return sheet;
  },

  /** lowercase, accent-free, single-spaced */
  normalize(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  },

  /** @returns {{name: string, group: string}[]} */
  catalogue() {
    return Sheets.readRows(WorkoutPlan.sheet_(Config.SHEETS.EXERCISES), Config.headerRow())
      .filter((r) => r['Exercício'])
      .map((r) => ({ name: String(r['Exercício']).trim(), group: String(r['Grupo'] || '').trim() }));
  },

  /** Session names in plan order ("Ficha de treino"), or the sheet defaults when it is empty. */
  sessions() {
    const seen = [];
    WorkoutPlan.planRows().forEach((r) => { if (!seen.includes(r.session)) seen.push(r.session); });
    return seen.length ? seen : Schema.DEFAULT_SESSIONS.slice();
  },

  /** @returns {{session, exercise, setsAdaptation, setsRegular, repsMin, repsMax}[]} */
  planRows() {
    return Sheets.readRows(WorkoutPlan.sheet_(Config.SHEETS.PLAN), Config.headerRow())
      .filter((r) => String(r['Sessão'] || '').trim() && String(r['Exercício proposto'] || '').trim())
      .map((r) => ({
        session: String(r['Sessão']).trim(),
        exercise: String(r['Exercício proposto']).trim(),
        setsAdaptation: Number(r['Séries adaptação']) || 0,
        setsRegular: Number(r['Séries após adaptação']) || 0,
        repsMin: Number(r['Reps mín.']) || 0,
        repsMax: Number(r['Reps máx.']) || 0,
      }));
  },

  /** @returns {{setsAdaptation: number, setsRegular: number, repsMin: number, repsMax: number} | null} */
  prescription(session, exercise) {
    const rows = WorkoutPlan.planRows();
    const s = WorkoutPlan.normalize(session);
    const e = WorkoutPlan.normalize(exercise);
    const row = rows.find((r) => WorkoutPlan.normalize(r.session) === s && WorkoutPlan.normalize(r.exercise) === e)
      || rows.find((r) => WorkoutPlan.normalize(r.exercise) === e);
    if (!row) return null;
    const { setsAdaptation, setsRegular, repsMin, repsMax } = row;
    return { setsAdaptation, setsRegular, repsMin, repsMax };
  },

  prescribedSets(prescription, phase) {
    if (!prescription) return '';
    const adaptation = WorkoutPlan.normalize(phase) === WorkoutPlan.normalize(WorkoutPlan.PHASE_ADAPTATION);
    return adaptation ? prescription.setsAdaptation : prescription.setsRegular;
  },

  /** Latest version code in "Histórico de fichas" (lexicographic max, e.g. F003), or ''. */
  currentPlanVersion() {
    const sheet = SpreadsheetApp.getActive().getSheetByName(Config.SHEETS.PLAN_HISTORY);
    if (!sheet) return '';
    const versions = Sheets.readRows(sheet, Config.headerRow()).map((r) => String(r['Versão'] || '')).filter(Boolean);
    return versions.sort().pop() || '';
  },
};

const WorkoutRepo = {
  HEADERS: {
    date: 'Data', session: 'Sessão', exercise: 'Exercício', equipment: 'Equipamento / carga',
    setsDone: 'Séries feitas', volume: 'Volume kg×reps', rir: 'RIR final', pain: 'Dor 0–10',
    note: 'Técnica / adaptação', plan: 'Ficha', prescribedSets: 'Séries prescritas',
    repsMin: 'Reps mín', repsMax: 'Reps máx', phase: 'Fase', sessionId: 'ID sessão',
  },
  kgHeader: (n) => `kg série ${n}`,
  repsHeader: (n) => `Reps ${n}`,

  sheet_() {
    const sheet = SpreadsheetApp.getActive().getSheetByName(Config.SHEETS.WORKOUT);
    if (!sheet) throw new Error(`Sheet "${Config.SHEETS.WORKOUT}" not found`);
    return sheet;
  },

  sessionId(date, session) {
    return `${Sheets.dayKey(date)}/${String(session).trim()}`;
  },

  /**
   * Names are expected to be exact catalogue names (see Validator.workoutUpsert). Each saved
   * exercise carries `previous`, its latest session before `date` (see previousSessions_).
   * @param {Date} date
   * @param {{session: string, phase?: string, exercises: Array}} workout
   * @param {UndoCapture_} [capture]  records the previous cell values (see UndoLog)
   * @returns {{phase: string, sessionId: string, rows: number[], exercises: Object[]}}
   */
  saveSession(date, workout, capture = UndoLog.capture()) {
    const sheet = WorkoutRepo.sheet_();
    const headerRow = Config.headerRow();
    const columns = Sheets.columnIndex(sheet, headerRow);
    const H = WorkoutRepo.HEADERS;
    if (!columns[H.date]) throw new Error(`Header "${H.date}" not found on row ${headerRow}`);

    const phase = workout.phase || WorkoutPlan.PHASE_REGULAR;
    const planVersion = WorkoutPlan.currentPlanVersion();
    const existing = Sheets.readRows(sheet, headerRow);
    const sessionId = WorkoutRepo.sessionId(date, workout.session);
    const previous = WorkoutRepo.previousSessions_(existing, date);
    const result = { phase, sessionId, rows: [], exercises: [] };

    workout.exercises.forEach((ex) => {
      const prescription = WorkoutPlan.prescription(workout.session, ex.name);
      const sets = (ex.sets || []).slice(0, Schema.MAX_SETS);
      const setsDone = sets.filter((s) => Number(s.reps) > 0).length;
      const volume = sets.reduce((sum, s) => sum + (Number(s.kg) || 0) * (Number(s.reps) || 0), 0);

      const cells = {
        [H.date]: date,
        [H.session]: workout.session,
        [H.exercise]: ex.name,
        [H.equipment]: ex.equipment || '',
        [H.setsDone]: setsDone,
        [H.volume]: volume,
        [H.rir]: ex.rir === undefined ? '' : ex.rir,
        [H.pain]: ex.pain === undefined ? '' : ex.pain,
        [H.note]: ex.note || '',
        [H.plan]: planVersion,
        [H.prescribedSets]: WorkoutPlan.prescribedSets(prescription, phase),
        [H.repsMin]: prescription ? prescription.repsMin : '',
        [H.repsMax]: prescription ? prescription.repsMax : '',
        [H.phase]: phase,
        [H.sessionId]: sessionId,
      };
      for (let n = 1; n <= Schema.MAX_SETS; n++) {
        const s = sets[n - 1];
        cells[WorkoutRepo.kgHeader(n)] = s ? Number(s.kg) || '' : '';
        cells[WorkoutRepo.repsHeader(n)] = s ? Number(s.reps) || '' : '';
      }

      let row = WorkoutRepo.findExisting_(existing, date, workout.session, ex.name);
      if (!row) {
        row = Sheets.nextEmptyRow(sheet, headerRow + 1, columns[H.date]);
        capture.newRow(sheet, row);
      }
      Object.keys(cells).forEach((header) => {
        if (columns[header]) capture.set(sheet, row, columns[header], cells[header]);
      });
      existing.push({ __row: row, [H.date]: date, [H.session]: workout.session, [H.exercise]: ex.name });
      result.rows.push(row);
      const saved = { name: ex.name, row, sets: sets.map((set) => ({ kg: set.kg, reps: set.reps })), setsDone, volume };
      ['rir', 'pain', 'note', 'equipment'].forEach((k) => { if (ex[k] !== undefined) saved[k] = ex[k]; });
      saved.previous = previous[WorkoutPlan.normalize(ex.name)] || null;
      result.exercises.push(saved);
    });
    return result;
  },

  /** Log rows (keyed by header) of one exercise, newest date first. */
  history(exercise, limit) {
    const H = WorkoutRepo.HEADERS;
    const key = WorkoutPlan.normalize(exercise);
    return Sheets.readRows(WorkoutRepo.sheet_(), Config.headerRow())
      .filter((r) => r[H.date] instanceof Date && WorkoutPlan.normalize(r[H.exercise]) === key)
      .sort((a, b) => b[H.date] - a[H.date])
      .slice(0, limit);
  },

  /** Sets logged in a log row (reps filled), in set order; a blank load is bodyweight (kg 0). */
  loggedSets(row) {
    const sets = [];
    for (let n = 1; n <= Schema.MAX_SETS; n++) {
      const reps = row[WorkoutRepo.repsHeader(n)];
      if (reps !== '' && reps !== undefined) sets.push({ kg: Number(row[WorkoutRepo.kgHeader(n)]) || 0, reps: Number(reps) });
    }
    return sets;
  },

  /**
   * Latest session of every exercise strictly before `date`, from log rows read before the write,
   * so a same-date rewrite never compares with itself. On a day logged twice (two sessions)
   * the later row wins.
   * @returns {Object<string, {date: string, sets: Object[], volume: ?number, setsDone: ?number}>} by normalized name
   */
  previousSessions_(rows, date) {
    const H = WorkoutRepo.HEADERS;
    const key = Sheets.dayKey(date);
    const cell = (v) => (v === '' || v === undefined ? null : v);
    const latest = {};
    rows.forEach((r) => {
      if (!(r[H.date] instanceof Date)) return;
      const day = Sheets.dayKey(r[H.date]);
      const name = WorkoutPlan.normalize(r[H.exercise]);
      if (day >= key || (latest[name] && latest[name].date > day)) return;
      latest[name] = { date: day, sets: WorkoutRepo.loggedSets(r), volume: cell(r[H.volume]), setsDone: cell(r[H.setsDone]) };
    });
    return latest;
  },

  /**
   * Log rows dated from..to (yyyy-MM-dd, inclusive), oldest first and in sheet order within a
   * day. group comes from "Exercícios" (null when the name is not there); rir and pain are left
   * out when empty; setsDone, volume and prescribedSets are null when empty.
   */
  range(from, to) {
    const H = WorkoutRepo.HEADERS;
    const groups = new Map(WorkoutPlan.catalogue().map((e) => [WorkoutPlan.normalize(e.name), e.group || null]));
    const cell = (v) => (v === '' || v === undefined || v === null ? null : v);
    return Sheets.readRows(WorkoutRepo.sheet_(), Config.headerRow())
      .filter((r) => r[H.date] instanceof Date && String(r[H.exercise] || '').trim())
      .map((r) => ({ r, date: Sheets.dayKey(r[H.date]) }))
      .filter(({ date }) => date >= from && date <= to)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.r.__row - b.r.__row))
      .map(({ r, date }) => {
        const exercise = String(r[H.exercise]).trim();
        const row = {
          date, session: String(r[H.session] || '').trim(), exercise,
          group: groups.get(WorkoutPlan.normalize(exercise)) || null,
          setsDone: cell(r[H.setsDone]), volume: cell(r[H.volume]), prescribedSets: cell(r[H.prescribedSets]),
        };
        if (cell(r[H.rir]) !== null) row.rir = r[H.rir];
        if (cell(r[H.pain]) !== null) row.pain = r[H.pain];
        return row;
      });
  },

  findExisting_(rows, date, session, exercise) {
    const H = WorkoutRepo.HEADERS;
    const key = Sheets.dayKey(date);
    const hit = rows.find((r) => r[H.date] instanceof Date && Sheets.dayKey(r[H.date]) === key
      && WorkoutPlan.normalize(r[H.session]) === WorkoutPlan.normalize(session)
      && WorkoutPlan.normalize(r[H.exercise]) === WorkoutPlan.normalize(exercise));
    return hit ? hit.__row : null;
  },
};
