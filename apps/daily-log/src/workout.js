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

  /**
   * Maps a typed name to the catalogue: exact normalized match, else a unique partial match.
   * @returns {{name: string, known: boolean}}
   */
  resolveExercise(typed) {
    const wanted = WorkoutPlan.normalize(typed);
    const entries = WorkoutPlan.catalogue().map((e) => ({ ...e, key: WorkoutPlan.normalize(e.name) }));
    const exact = entries.find((e) => e.key === wanted);
    if (exact) return { name: exact.name, known: true };
    const partial = entries.filter((e) => e.key.includes(wanted) || wanted.includes(e.key));
    if (partial.length === 1) return { name: partial[0].name, known: true };
    return { name: String(typed).trim(), known: false };
  },

  /** @returns {{setsAdaptation: number, setsRegular: number, repsMin: number, repsMax: number} | null} */
  prescription(session, exercise) {
    const rows = Sheets.readRows(WorkoutPlan.sheet_(Config.SHEETS.PLAN), Config.headerRow());
    const s = WorkoutPlan.normalize(session);
    const e = WorkoutPlan.normalize(exercise);
    const row = rows.find((r) => WorkoutPlan.normalize(r['Sessão']) === s && WorkoutPlan.normalize(r['Exercício proposto']) === e)
      || rows.find((r) => WorkoutPlan.normalize(r['Exercício proposto']) === e);
    if (!row) return null;
    return {
      setsAdaptation: Number(row['Séries adaptação']) || 0,
      setsRegular: Number(row['Séries após adaptação']) || 0,
      repsMin: Number(row['Reps mín.']) || 0,
      repsMax: Number(row['Reps máx.']) || 0,
    };
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
   * @param {Date} date
   * @param {{session: string, phase?: string, exercises: Array}} workout
   * @returns {{rows: number[], exercises: {name: string, known: boolean, setsDone: number, volume: number}[]}}
   */
  saveSession(date, workout) {
    if (!workout.session) throw new Error('workout.session is required');
    if (!workout.exercises || workout.exercises.length === 0) throw new Error('workout.exercises is empty');
    const sheet = WorkoutRepo.sheet_();
    const headerRow = Config.headerRow();
    const columns = Sheets.columnIndex(sheet, headerRow);
    const H = WorkoutRepo.HEADERS;
    if (!columns[H.date]) throw new Error(`Header "${H.date}" not found on row ${headerRow}`);

    const phase = workout.phase || WorkoutPlan.PHASE_REGULAR;
    const planVersion = WorkoutPlan.currentPlanVersion();
    const existing = Sheets.readRows(sheet, headerRow);
    const result = { rows: [], exercises: [] };

    workout.exercises.forEach((ex) => {
      const resolved = WorkoutPlan.resolveExercise(ex.name);
      const prescription = WorkoutPlan.prescription(workout.session, resolved.name);
      const sets = (ex.sets || []).slice(0, Schema.MAX_SETS);
      const setsDone = sets.filter((s) => Number(s.reps) > 0).length;
      const volume = sets.reduce((sum, s) => sum + (Number(s.kg) || 0) * (Number(s.reps) || 0), 0);

      const cells = {
        [H.date]: date,
        [H.session]: workout.session,
        [H.exercise]: resolved.name,
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
        [H.sessionId]: WorkoutRepo.sessionId(date, workout.session),
      };
      for (let n = 1; n <= Schema.MAX_SETS; n++) {
        const s = sets[n - 1];
        cells[WorkoutRepo.kgHeader(n)] = s ? Number(s.kg) || '' : '';
        cells[WorkoutRepo.repsHeader(n)] = s ? Number(s.reps) || '' : '';
      }

      const row = WorkoutRepo.findExisting_(existing, date, workout.session, resolved.name)
        || Sheets.nextEmptyRow(sheet, headerRow + 1, columns[H.date]);
      Object.keys(cells).forEach((header) => {
        if (columns[header]) sheet.getRange(row, columns[header]).setValue(cells[header]);
      });
      existing.push({ __row: row, [H.date]: date, [H.session]: workout.session, [H.exercise]: resolved.name });
      result.rows.push(row);
      result.exercises.push({ name: resolved.name, known: resolved.known, setsDone, volume, sets });
    });
    return result;
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
