/**
 * Workout module (spec §3.1 Fichas, §3.3 Registro de treino, §5.3 actions): exercise catalogue,
 * training sessions (rotation, load / resume / partial / complete) and plan drafting
 * (Ficha de treino → Salvar nova ficha). Progression lives in workout_progression.js.
 *
 * Rules carried over from 3.0 (Guia e fontes):
 * - load a session → register only what was done → save partial or complete;
 * - loading a date that has a saved session resumes it (the saved values come back);
 * - continuous rotation advances only when a session is concluded; weekly rotation restarts on
 *   Monday; the rotation itself is Config `routine.sessionRotation` (never code);
 * - only Work 1 + Work 2 count in volume and progression; warm-up and feeder are kept apart;
 * - previous loads are a reference (text/values beside the row), never pre-filled into work cells;
 * - RIR 0 is a valid record; empty is "não informado", never 0.
 *
 * Phase (Adaptação/Regular) of a session: Adaptação while the date is within the first
 * `routine.adaptationWeeks` weeks of the plan in force (counted from the plan's Início), Regular
 * after. The 3.0 plans only express adaptation as free text ("Primeiras 2 semanas…"), so the
 * duration is a Config value, 0 by default (always Regular). The phase picks the plan's
 * "Work sets adaptação/regular" and "RIR work adaptação/regular" columns.
 *
 * The Hoje training table is reached only through TrainingScreen (an adapter the Hoje module
 * provides), so this file never addresses Hoje cells.
 */

/* ---------------------------------------------------------------------------------------------
 * Exercises: the Exercícios catalogue (name, group, load convention) and name validation.
 * ------------------------------------------------------------------------------------------- */
const Exercises = {
  /** Lowercase, accent-free, single-spaced: the key used to match exercise and session names. */
  normalize(text) {
    return String(text === null || text === undefined ? '' : text)
      .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  },

  /** Catalogue entries in sheet order: [{name, group, loadConvention}] ([] when the tab is missing). */
  list() {
    if (!Tabs.findSheet('exercises')) return [];
    const seen = {};
    const out = [];
    Tabs.read('exercises').forEach((r) => {
      const name = r.name === null ? '' : String(r.name).trim();
      const key = Exercises.normalize(name);
      if (!key || seen[key]) return;
      seen[key] = true;
      out.push({
        name,
        group: r.group === null ? null : String(r.group).trim() || null,
        loadConvention: r.loadConvention === null ? null : String(r.loadConvention).trim() || null,
      });
    });
    return out;
  },

  /** Catalogue names, for the exercise validation list (3.0 named range ListaExercicios). */
  names() {
    return Exercises.list().map((e) => e.name);
  },

  /** Catalogue entry by name (accent/case-insensitive), or null. */
  find(name, list) {
    const key = Exercises.normalize(name);
    if (!key) return null;
    return (list || Exercises.list()).find((e) => Exercises.normalize(e.name) === key) || null;
  },

  /**
   * Names accepted on `date`: the catalogue plus the exercises of the plan in force (a plan row
   * that is missing from the catalogue is still a known exercise; the audit reports it).
   * @returns {{name, group, loadConvention, source: 'catalogue'|'plan'}[]}
   */
  known(date) {
    const out = Exercises.list().map((e) => Object.assign({ source: 'catalogue' }, e));
    const keys = {};
    out.forEach((e) => { keys[Exercises.normalize(e.name)] = true; });
    const plan = date ? Plans.on(date) : null;
    (plan ? plan.rows : []).forEach((r) => {
      const key = Exercises.normalize(r.exercise);
      if (!key || keys[key]) return;
      keys[key] = true;
      out.push({ name: String(r.exercise).trim(), group: r.group || null, loadConvention: null, source: 'plan' });
    });
    return out;
  },

  /**
   * The known entry for `name` (canonical spelling), or throws a Portuguese message with the
   * closest names.
   */
  resolve(name, date, known) {
    const list = known || Exercises.known(date);
    const hit = Exercises.find(name, list);
    if (hit) return hit;
    const sugg = Exercises.suggest(name, list.map((e) => e.name));
    throw new Error(`Exercício "${String(name).trim()}" não está no cadastro (Exercícios) nem na ficha vigente.${sugg.length ? ` Você quis dizer: ${sugg.join(', ')}?` : ' Cadastre-o em Exercícios.'}`);
  },

  /** Up to `max` names closest to `name` (edit distance on normalized text, or containment). */
  suggest(name, names, max) {
    const key = Exercises.normalize(name);
    if (!key) return [];
    const scored = names.map((n) => {
      const k = Exercises.normalize(n);
      let d = Exercises.distance_(key, k);
      if (k.indexOf(key) >= 0 || key.indexOf(k) >= 0) d = Math.min(d, Math.abs(k.length - key.length) / 4);
      return { n, d };
    }).filter((x) => x.d <= Math.max(3, Math.floor(key.length / 3)));
    scored.sort((a, b) => a.d - b.d || a.n.localeCompare(b.n));
    return scored.slice(0, max || 3).map((x) => x.n);
  },

  /** Levenshtein distance. */
  distance_(a, b) {
    const prev = [];
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      let diag = prev[0];
      prev[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = prev[j];
        prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
        diag = tmp;
      }
    }
    return prev[b.length];
  },

  /** Group of an exercise: catalogue first, then the given plan rows; null when unknown. */
  groupOf(name, planRows, list) {
    const hit = Exercises.find(name, list);
    if (hit && hit.group) return hit.group;
    const key = Exercises.normalize(name);
    const row = (planRows || []).find((r) => Exercises.normalize(r.exercise) === key && r.group);
    return row ? String(row.group).trim() : null;
  },
};

/* ---------------------------------------------------------------------------------------------
 * Workouts: the Registro de treino rows.
 * ------------------------------------------------------------------------------------------- */
const Workouts = {
  /** Input keys of a logged exercise (the Hoje training table columns). */
  INPUT_KEYS: ['warmupKg', 'warmupReps', 'feederKg', 'feederReps', 'work1Kg', 'work1Reps', 'rir1',
    'work2Kg', 'work2Reps', 'rir2', 'pain', 'note'],
  /** Work sets: the only sets that count in volume and progression. */
  WORK_SETS: [{ n: 1, kg: 'work1Kg', reps: 'work1Reps', rir: 'rir1' }, { n: 2, kg: 'work2Kg', reps: 'work2Reps', rir: 'rir2' }],

  /** Rows with a valid date, session and exercise, in sheet order ([] when the tab is missing). */
  rows() {
    if (!Tabs.findSheet('workouts')) return [];
    return Tabs.read('workouts').filter((r) => r.date && r.session !== null && r.exercise !== null
      && String(r.session).trim() && String(r.exercise).trim());
  },

  /** `yyyy-MM-dd/Sessão`. */
  sessionId(date, session) {
    return `${Dates.key(date)}/${String(session).trim()}`;
  },

  sameSession_(r, date, session) {
    return Dates.sameDay(r.date, date) && Exercises.normalize(r.session) === Exercises.normalize(session);
  },

  /** Rows of one session (date + session name). */
  ofSession(rows, date, session) {
    return rows.filter((r) => Workouts.sameSession_(r, date, session));
  },

  /**
   * Sessions of a day in sheet order: [{session, state, rows}] where state is Concluído when any
   * row of the session is concluded, else Parcial.
   */
  sessionsOn(rows, date) {
    const out = [];
    rows.filter((r) => Dates.sameDay(r.date, date)).forEach((r) => {
      const key = Exercises.normalize(r.session);
      let s = out.find((x) => Exercises.normalize(x.session) === key);
      if (!s) { s = { session: String(r.session).trim(), state: Sessions.STATE.PARTIAL, rows: [] }; out.push(s); }
      s.rows.push(r);
      if (r.sessionState === Sessions.STATE.DONE) s.state = Sessions.STATE.DONE;
    });
    return out;
  },

  /** Concluded sessions (date ≤ `to` when given), chronological: [{date, session, firstRow}]. */
  concluded(rows, to) {
    const out = [];
    const seen = {};
    rows.forEach((r) => {
      if (r.sessionState !== Sessions.STATE.DONE) return;
      if (to && Dates.compare(r.date, to) > 0) return;
      const id = `${Dates.key(r.date)}|${Exercises.normalize(r.session)}`;
      if (seen[id]) return;
      seen[id] = true;
      out.push({ date: r.date, session: String(r.session).trim(), firstRow: r._row });
    });
    return out.sort((a, b) => Dates.compare(a.date, b.date) || a.firstRow - b.firstRow);
  },
};

/* ---------------------------------------------------------------------------------------------
 * TrainingScreen: adapter to the Hoje training card (owned by ui_hoje.js).
 *
 *   read()  -> {date, session, phase, state, plan, rows: [{exercise, warmupKg, warmupReps,
 *              feederKg, feederReps, work1Kg, work1Reps, rir1, work2Kg, work2Reps, rir2, pain,
 *              note}]} (empty rows left out)
 *   write({date, session, state, plan, phase, header, rows: [same keys + group, prescription
 *          (text), reference (text of the previous work sets), referenceSets]})
 *   clear()
 *
 * The default implementation is HojeTrainingScreen (Hoje.read().training / Hoje.write('training')
 * / Hoje.clear('training')); tests plug another one with TrainingScreen.use(impl). Work cells are
 * filled only from what was saved for that date/session, never from the reference.
 * ------------------------------------------------------------------------------------------- */
const TrainingScreen = {
  MAX_ROWS: 12,
  ROW_KEYS: ['exercise'].concat(Workouts.INPUT_KEYS),
  impl_: null,

  /** Plugs the screen implementation ({read, write, clear}); null restores the Hoje one. */
  use(impl) {
    TrainingScreen.impl_ = impl;
  },

  target_() {
    if (TrainingScreen.impl_) return TrainingScreen.impl_;
    if (typeof Hoje !== 'undefined' && Hoje && typeof Hoje.read === 'function') return HojeTrainingScreen;
    throw new Error('A tela Hoje não está disponível. Rode Projeto → Sistema → Reaplicar layout.');
  },

  read() {
    return TrainingScreen.target_().read();
  },

  write(view) {
    return TrainingScreen.target_().write(view);
  },

  clear() {
    return TrainingScreen.target_().clear();
  },
};

/**
 * TrainingScreen on the Hoje tab. The prescription and the previous work sets have no column in
 * the Hoje table, so they go to the note of each row's Exercício cell (shown on hover / tap);
 * the work cells stay as saved (empty for an exercise not done yet).
 */
const HojeTrainingScreen = {
  read() {
    const t = Hoje.read().training || {};
    return {
      date: Hoje.date(), session: t.session || null, phase: t.phase || null, state: t.state || null, plan: t.plan || null,
      rows: (t.rows || []).map((r) => {
        const out = {};
        TrainingScreen.ROW_KEYS.forEach((k) => { out[k] = r[k] === undefined ? null : r[k]; });
        return out;
      }),
    };
  },

  write(view) {
    const rows = (view.rows || []).slice(0, TrainingScreen.MAX_ROWS);
    Hoje.write('training', {
      session: view.session || null, phase: view.phase || null, state: view.state || null, plan: view.plan || null,
      rows: rows.map((r) => {
        const out = {};
        TrainingScreen.ROW_KEYS.forEach((k) => { out[k] = r[k] === undefined ? null : r[k]; });
        return out;
      }),
    });
    HojeTrainingScreen.notes_(rows);
  },

  clear() {
    Hoje.clear('training');
    HojeTrainingScreen.notes_([]);
  },

  /** Prescription + reference as notes on the Exercício cells (the rest emptied). */
  notes_(rows) {
    const t = Hoje.section('training').table;
    const col = t.columns.find((c) => c.key === 'exercise').col;
    const range = Hoje.sheet_().getRange(`${col}${t.firstRow}:${col}${t.firstRow + t.rows - 1}`);
    const notes = [];
    for (let i = 0; i < t.rows; i++) {
      const r = rows[i];
      const lines = [];
      if (r && r.prescription) lines.push(`Ficha: ${r.prescription}`);
      if (r && r.reference) lines.push(`Última: ${r.reference}`);
      notes.push([lines.join('\n')]);
    }
    range.setNotes(notes);
  },
};

/* ---------------------------------------------------------------------------------------------
 * Sessions: rotation, load / resume, partial and complete.
 * ------------------------------------------------------------------------------------------- */
const Sessions = {
  STATE: { PARTIAL: 'Parcial', DONE: 'Concluído' },
  PHASE: { ADAPT: 'Adaptação', REGULAR: 'Regular' },
  MODES: { CONTINUOUS: 'continuous', WEEKLY: 'weekly' },

  /**
   * Session names in rotation order: Config `routine.sessionRotation`, or (when empty) the
   * sessions of the plan in force on `date` in plan order.
   */
  rotation(date) {
    const list = Config.getList('routine.sessionRotation');
    if (list.length) return list;
    return Sessions.planSessions(date);
  },

  /** Distinct session names of the plan in force on `date`, in plan order. */
  planSessions(date) {
    const out = [];
    Plans.exercisesOn(date || Dates.today()).forEach((r) => {
      const s = r.session === null ? '' : String(r.session).trim();
      if (s && !out.some((x) => Exercises.normalize(x) === Exercises.normalize(s))) out.push(s);
    });
    return out;
  },

  /** Session names valid on `date` (plan in force first, then rotation-only names): the list for validations. */
  names(date) {
    const out = Sessions.planSessions(date);
    Config.getList('routine.sessionRotation').forEach((s) => {
      if (!out.some((x) => Exercises.normalize(x) === Exercises.normalize(s))) out.push(s);
    });
    return out;
  },

  mode() {
    return Config.get('routine.rotationMode');
  },

  indexOf_(list, session) {
    const key = Exercises.normalize(session);
    for (let i = 0; i < list.length; i++) if (Exercises.normalize(list[i]) === key) return i;
    return -1;
  },

  /**
   * Next session to train on `date`.
   * continuous: the session after the last concluded one (on or before `date`), whatever the week;
   * weekly: the first of the rotation on Monday, then the one after the last concluded this week.
   * Partial sessions never advance the rotation. A concluded session that is not in the rotation
   * (e.g. an older plan's name) is skipped when looking back.
   * @returns {string|null} null when there is no rotation and no plan
   */
  nextSession(date, rows) {
    const d = Dates.require(date, 'Data do treino');
    const rotation = Sessions.rotation(d);
    if (!rotation.length) return null;
    let done = Workouts.concluded(rows || Workouts.rows(), d);
    if (Sessions.mode() === Sessions.MODES.WEEKLY) {
      const monday = Dates.weekStart(d);
      done = done.filter((s) => Dates.compare(s.date, monday) >= 0);
    }
    for (let i = done.length - 1; i >= 0; i--) {
      const idx = Sessions.indexOf_(rotation, done[i].session);
      if (idx >= 0) return rotation[(idx + 1) % rotation.length];
    }
    return rotation[0];
  },

  /** Adaptação or Regular on `date` for `plan` (see the file header). */
  phaseOn(date, plan) {
    const weeks = Config.get('routine.adaptationWeeks') || 0;
    if (!plan || !plan.start || weeks <= 0) return Sessions.PHASE.REGULAR;
    return Dates.diffDays(plan.start, date) < weeks * 7 ? Sessions.PHASE.ADAPT : Sessions.PHASE.REGULAR;
  },

  /** Prescription of a plan row for a phase: {sets, repsMin, repsMax, rirMax, restS, alternative, setModel}. */
  prescription(planRow, phase) {
    if (!planRow) return null;
    const adapt = phase === Sessions.PHASE.ADAPT;
    const pick = (a, r) => (adapt && planRow[a] !== null && planRow[a] !== undefined ? planRow[a] : planRow[r]);
    const val = (v) => (v === null || v === undefined || v === '' ? null : v);
    return {
      sets: val(pick('workSetsAdapt', 'workSetsRegular')),
      repsMin: val(planRow.repsMin),
      repsMax: val(planRow.repsMax),
      rirMax: val(pick('rirAdapt', 'rirRegular')),
      restS: val(planRow.restS),
      alternative: val(planRow.alternative),
      setModel: val(planRow.notes),
    };
  },

  /** "2×6–10 · RIR 0–1 · 150 s · alt.: X" */
  prescriptionText(p) {
    if (!p) return '';
    const parts = [];
    const reps = p.repsMin !== null && p.repsMax !== null && p.repsMin !== p.repsMax ? `${p.repsMin}–${p.repsMax}` : (p.repsMax !== null ? p.repsMax : p.repsMin);
    if (p.sets !== null || reps !== null) parts.push(`${p.sets !== null ? p.sets : '?'}×${reps !== null ? reps : '?'}`);
    if (p.rirMax !== null) parts.push(p.rirMax > 0 ? `RIR 0–${Fmt.num(p.rirMax)}` : 'RIR 0');
    if (p.restS !== null) parts.push(`${p.restS} s`);
    if (p.alternative) parts.push(`alt.: ${p.alternative}`);
    return parts.join(' · ');
  },

  /** Canonical session name for `date`, or throws with the valid names. */
  resolveSession(session, date) {
    const s = session === null || session === undefined ? '' : String(session).trim();
    const valid = Sessions.names(date);
    if (!s) throw new Error(`Informe a sessão do treino${valid.length ? ` (${valid.join(', ')})` : ''}.`);
    const idx = Sessions.indexOf_(valid, s);
    if (idx >= 0) return valid[idx];
    const sugg = Exercises.suggest(s, valid, 1);
    throw new Error(`Sessão "${s}" não existe na ficha vigente em ${Dates.format(date)} nem na rotação da Config.${sugg.length ? ` Você quis dizer: ${sugg[0]}?` : ''}${valid.length ? ` Sessões: ${valid.join(', ')}.` : ''}`);
  },

  /**
   * Everything needed to show a session on `date`:
   * the plan rows of the plan in force for the session, the values saved for that date/session
   * (resume), and each exercise's previous work sets as a reference (not as values).
   * Without `session`: the session saved as Parcial on that date (resume); on a past date with a
   * concluded session, that session (history); else nextSession(date) (today: a second session).
   * @returns {{date: Date, session, plan: ?string, objective: ?string, phase, state: ?string,
   *   resumed: boolean, rows: Object[]}} each row {exercise, group, loadConvention, inPlan,
   *   prescription, prescriptionText, reference: ?{date, session, sets}, referenceText,
   *   values: {warmupKg…note} (null when not saved), savedRow: ?number}
   */
  load(date, session) {
    const d = Dates.require(date, 'Data do treino');
    const all = Workouts.rows();
    let name = null;
    if (session !== null && session !== undefined && String(session).trim()) {
      const saved = Workouts.sessionsOn(all, d).find((s) => Exercises.normalize(s.session) === Exercises.normalize(session));
      name = saved ? saved.session : Sessions.resolveSession(session, d);
    } else {
      const onDay = Workouts.sessionsOn(all, d);
      const partial = onDay.filter((s) => s.state === Sessions.STATE.PARTIAL);
      if (partial.length) name = partial[partial.length - 1].session;
      else if (onDay.length && Dates.compare(d, Dates.today()) < 0) name = onDay[onDay.length - 1].session;
      else name = Sessions.nextSession(d, all);
    }
    if (!name) throw new Error('Configure a rotação de sessões (Config → Rotação de sessões) ou informe a sessão.');

    const plan = Plans.on(d);
    const saved = Workouts.ofSession(all, d, name);
    if (!plan && !saved.length) throw new Error(`Nenhuma ficha vigente em ${Dates.format(d)}. Salve uma ficha em Ficha de treino.`);
    const planRows = plan ? plan.rows.filter((r) => Exercises.normalize(r.session) === Exercises.normalize(name) && r.exercise !== null) : [];
    if (!planRows.length && !saved.length) {
      throw new Error(`A ficha ${plan.id} não tem a sessão "${name}". Sessões da ficha: ${Sessions.planSessions(d).join(', ') || '—'}.`);
    }
    const phase = Sessions.phaseOn(d, plan);
    const catalogue = Exercises.list();
    const history = Progression.index(all);
    const objective = Objectives.on(d);
    const used = {};

    const build = (exercise, planRow, savedRow) => {
      const key = Exercises.normalize(exercise);
      const entry = Exercises.find(exercise, catalogue);
      const p = Sessions.prescription(planRow, phase);
      const ref = Progression.previous(history[key] || [], d);
      const values = {};
      Workouts.INPUT_KEYS.forEach((k) => { values[k] = savedRow ? savedRow[k] : null; });
      return {
        exercise: entry ? entry.name : String(exercise).trim(),
        group: Exercises.groupOf(exercise, planRows, catalogue),
        loadConvention: entry ? entry.loadConvention : null,
        inPlan: !!planRow,
        prescription: p,
        prescriptionText: Sessions.prescriptionText(p),
        reference: ref ? { date: ref.date, session: ref.session, sets: ref.sets } : null,
        referenceText: ref ? Progression.referenceText(ref) : '',
        values,
        savedRow: savedRow ? savedRow._row : null,
      };
    };
    const rows = planRows.map((pr) => {
      const key = Exercises.normalize(pr.exercise);
      const s = saved.find((r) => Exercises.normalize(r.exercise) === key);
      if (s) used[s._row] = true;
      return build(pr.exercise, pr, s || null);
    });
    saved.forEach((s) => { if (!used[s._row]) rows.push(build(s.exercise, null, s)); });

    const state = saved.length ? (saved.some((r) => r.sessionState === Sessions.STATE.DONE) ? Sessions.STATE.DONE : Sessions.STATE.PARTIAL) : null;
    return {
      date: d, session: name, plan: plan ? plan.id : null, objective: objective ? objective.id : null,
      phase, state, resumed: saved.length > 0, rows,
    };
  },

  /** The view TrainingScreen.write receives for a loaded session. */
  screenView(view) {
    const header = [view.session, view.plan ? `ficha ${view.plan}` : null, view.phase, view.state].filter(Boolean).join(' · ');
    return {
      date: view.date, session: view.session, state: view.state, plan: view.plan, phase: view.phase, header,
      rows: view.rows.map((r) => Object.assign({
        exercise: r.exercise, group: r.group, prescription: r.prescriptionText, reference: r.referenceText,
        referenceSets: r.reference ? r.reference.sets : [],
      }, r.values)),
    };
  },

  /**
   * Saves what was done so far; the session stays Parcial (a concluded session stays concluded).
   * @param {{phase?: string}} opts phase declared on the screen (Adaptação/Regular) instead of
   *   the derived one
   */
  savePartial(date, session, rows, opts) {
    return Sessions.save_(date, session, rows, Sessions.STATE.PARTIAL, opts);
  },

  /** Saves and concludes the session: every row of that date/session becomes Concluído. */
  complete(date, session, rows, opts) {
    return Sessions.save_(date, session, rows, Sessions.STATE.DONE, opts);
  },

  /** Number, numeric text (comma decimal) or null; NaN when not a number. */
  num_(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    const s = String(v).trim().replace(/\s/g, '').replace(',', '.');
    if (s === '') return null;
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  },

  /**
   * Validates one screen row. Returns null for an empty row, or {exercise, values, errors}.
   * kg ≥ 0 (0 = body weight), reps integers ≥ 0, kg and reps go together, RIR 0–10 only with its
   * work set (0 valid), Dor integer 0–10.
   */
  cleanRow_(raw, index, date, known) {
    const label = `Linha ${index + 1}`;
    const errors = [];
    const values = {};
    const has = (v) => !(v === null || v === undefined || (typeof v === 'string' && v.trim() === ''));
    const any = Workouts.INPUT_KEYS.some((k) => has(raw[k]));
    if (!has(raw.exercise)) {
      if (any) errors.push(`${label}: informe o exercício.`);
      return errors.length ? { exercise: null, values, errors } : null;
    }
    if (!any) return null;
    let exercise = String(raw.exercise).trim();
    try { exercise = Exercises.resolve(exercise, date, known).name; } catch (err) { errors.push(`${label}: ${err.message}`); }
    const pairs = [
      { kg: 'warmupKg', reps: 'warmupReps', name: 'aquecimento' },
      { kg: 'feederKg', reps: 'feederReps', name: 'feeder' },
      { kg: 'work1Kg', reps: 'work1Reps', rir: 'rir1', name: 'work 1' },
      { kg: 'work2Kg', reps: 'work2Reps', rir: 'rir2', name: 'work 2' },
    ];
    pairs.forEach((p) => {
      const kg = Sessions.num_(raw[p.kg]);
      const reps = Sessions.num_(raw[p.reps]);
      if (Number.isNaN(kg) || (kg !== null && kg < 0)) errors.push(`${label} (${exercise}): kg de ${p.name} deve ser um número ≥ 0.`);
      if (Number.isNaN(reps) || (reps !== null && (reps < 0 || Math.round(reps) !== reps))) errors.push(`${label} (${exercise}): reps de ${p.name} devem ser um número inteiro.`);
      if ((kg === null) !== (reps === null) && !Number.isNaN(kg) && !Number.isNaN(reps)) {
        errors.push(`${label} (${exercise}): informe kg e reps de ${p.name} (0 kg = peso corporal).`);
      }
      values[p.kg] = Number.isNaN(kg) ? null : kg;
      values[p.reps] = Number.isNaN(reps) ? null : reps;
      if (p.rir) {
        const rir = Sessions.num_(raw[p.rir]);
        if (Number.isNaN(rir) || (rir !== null && (rir < 0 || rir > 10))) errors.push(`${label} (${exercise}): RIR de ${p.name} deve estar entre 0 e 10.`);
        else if (rir !== null && reps === null) errors.push(`${label} (${exercise}): RIR de ${p.name} sem a série.`);
        values[p.rir] = Number.isNaN(rir) ? null : rir;
      }
    });
    const pain = Sessions.num_(raw.pain);
    if (Number.isNaN(pain) || (pain !== null && (pain < 0 || pain > 10 || Math.round(pain) !== pain))) errors.push(`${label} (${exercise}): dor deve ser um inteiro de 0 a 10.`);
    values.pain = Number.isNaN(pain) ? null : pain;
    values.note = has(raw.note) ? String(raw.note).trim() : null;
    if (has(raw.equipment)) values.equipment = String(raw.equipment).trim();
    return { exercise, values, errors };
  },

  /** Work sets done (reps > 0) and their volume Σ kg×reps; volume null when no work set was done. */
  workTotals(values) {
    let done = 0;
    let volume = 0;
    Workouts.WORK_SETS.forEach((w) => {
      const reps = values[w.reps];
      const kg = values[w.kg];
      if (reps !== null && reps !== undefined && reps > 0 && kg !== null && kg !== undefined) {
        done += 1;
        volume += kg * reps;
      }
    });
    return { workSetsDone: done, workVolume: done ? Math.round(volume * 100) / 100 : null };
  },

  save_(date, session, rows, state, opts) {
    const label = state === Sessions.STATE.DONE ? 'Concluir treino' : 'Salvar parcial do treino';
    return Core.withLock(() => ChangeLog.run(label, () => {
      const d = Dates.require(date, 'Data do treino');
      if (Dates.compare(d, Dates.today()) > 0) throw new Error(`Não é possível registrar treino em data futura (${Dates.format(d)}).`);
      const all = Workouts.rows();
      const savedSession = session ? Workouts.sessionsOn(all, d).find((s) => Exercises.normalize(s.session) === Exercises.normalize(session)) : null;
      const name = savedSession ? savedSession.session : Sessions.resolveSession(session, d);
      const known = Exercises.known(d);
      const clean = [];
      const errors = [];
      (rows || []).forEach((raw, i) => {
        const c = Sessions.cleanRow_(raw || {}, i, d, known);
        if (!c) return;
        if (c.errors.length) errors.push(...c.errors);
        else clean.push(c);
      });
      const dup = {};
      clean.forEach((c) => {
        const k = Exercises.normalize(c.exercise);
        if (dup[k]) errors.push(`${c.exercise} aparece em mais de uma linha.`);
        dup[k] = true;
      });
      if (errors.length) {
        const err = new Error(errors.join(' '));
        err.apiErrors = errors.map((m) => ({ path: 'rows', code: 'invalid', message: m }));
        throw err;
      }
      const existing = Workouts.ofSession(all, d, name);
      if (!clean.length && !(state === Sessions.STATE.DONE && existing.length)) {
        throw new Error('Nada para salvar: registre ao menos um exercício feito.');
      }

      const plan = Plans.on(d);
      const planRows = plan ? plan.rows.filter((r) => Exercises.normalize(r.session) === Exercises.normalize(name)) : [];
      const objective = Objectives.on(d);
      const declared = opts && opts.phase ? String(opts.phase).trim() : '';
      const phases = [Sessions.PHASE.ADAPT, Sessions.PHASE.REGULAR];
      if (declared && phases.indexOf(declared) < 0) throw new Error(`Fase inválida: "${declared}". Use ${phases.join(' ou ')}.`);
      const phase = declared || Sessions.phaseOn(d, plan);
      const wasDone = existing.some((r) => r.sessionState === Sessions.STATE.DONE);
      const finalState = state === Sessions.STATE.DONE || wasDone ? Sessions.STATE.DONE : Sessions.STATE.PARTIAL;
      const sessionId = Workouts.sessionId(d, name);

      const written = [];
      const toAppend = [];
      const touched = {};
      let volume = 0;
      let workSets = 0;
      clean.forEach((c) => {
        const key = Exercises.normalize(c.exercise);
        const pr = planRows.find((r) => Exercises.normalize(r.exercise) === key) || null;
        const p = Sessions.prescription(pr, phase);
        const totals = Sessions.workTotals(c.values);
        const fields = Object.assign({}, c.values, totals, {
          date: d, session: name, exercise: c.exercise,
          plan: plan ? plan.id : null, objective: objective ? objective.id : null, phase,
          workSetsPrescribed: p ? p.sets : null, repsMin: p ? p.repsMin : null, repsMax: p ? p.repsMax : null,
          setModel: p ? p.setModel : null, sessionId, sessionState: finalState,
        });
        volume += totals.workVolume || 0;
        workSets += totals.workSetsDone;
        const hit = existing.find((r) => Exercises.normalize(r.exercise) === key);
        if (hit) {
          touched[hit._row] = true;
          Tabs.update('workouts', hit._row, fields);
          written.push(hit._row);
        } else {
          toAppend.push(fields);
        }
      });
      existing.forEach((r) => {
        if (touched[r._row]) return;
        if (r.sessionState !== finalState) Tabs.update('workouts', r._row, { sessionState: finalState });
        volume += r.workVolume || 0;
        workSets += r.workSetsDone || 0;
      });
      written.push(...Tabs.appendMany('workouts', toAppend));

      const concluded = Workouts.sessionsOn(Workouts.rows(), d).filter((s) => s.state === Sessions.STATE.DONE).length;
      const day = Days.get(d);
      if (concluded > 0 || (day && day.sessions !== null && day.sessions !== concluded)) Days.patch(d, { sessions: concluded });

      const next = finalState === Sessions.STATE.DONE ? Sessions.nextSession(d) : null;
      const kept = state === Sessions.STATE.PARTIAL && wasDone;
      const what = `${name} em ${Dates.format(d)}: ${clean.length} ${clean.length === 1 ? 'exercício' : 'exercícios'}, ${workSets} work sets, volume work ${Fmt.num(volume)} kg`;
      const message = finalState === Sessions.STATE.DONE
        ? `${kept ? 'Sessão já concluída; valores atualizados. ' : 'Treino concluído. '}${what}.${next ? ` Próxima sessão: ${next}.` : ''}`
        : `Treino salvo como parcial. ${what}. Carregar treino nesta data retoma a sessão.`;
      return {
        message, date: Dates.key(d), session: name, state: finalState, plan: plan ? plan.id : null,
        objective: objective ? objective.id : null, phase, rows: written, exercises: clean.length,
        workSets, workVolume: Math.round(volume * 100) / 100, sessionsConcluded: concluded, next,
      };
    }));
  },
};

/* ---------------------------------------------------------------------------------------------
 * PlanDraft: Ficha de treino shows the plan in force (or the planned next one) as an editable
 * draft; Salvar nova ficha archives the draft as the next version through Transition.newPlan.
 * The status shown in the title is derived from the Plans entity, never typed.
 * ------------------------------------------------------------------------------------------- */
const PlanDraft = {
  /** Cells on Ficha de treino: derived status in the title row, the save form on row 4. */
  CELLS: { title: 'A2', startLabel: 'A4', start: 'B4', reasonLabel: 'C4', reason: 'D4' },
  LABELS: { start: 'Início da nova ficha', reason: 'Motivo' },
  /** Fichas keys → draft keys (inverse of Plans.DRAFT_MAP). */
  toDraftKey_(k) {
    const inv = {};
    Object.keys(Plans.DRAFT_MAP).forEach((d) => { inv[Plans.DRAFT_MAP[d]] = d; });
    return inv[k] || k;
  },

  /** The version the draft shows: the planned next version when there is one, else the one in force. */
  shown(date) {
    const d = date ? Dates.require(date) : Dates.today();
    const latest = Plans.latest();
    if (latest && Dates.compare(latest.start, d) > 0) return latest;
    return Plans.on(d);
  },

  /** Title text derived from the entity: "Ficha vigente F002 · desde 28/09/2026 · …". */
  statusText(date) {
    const d = date ? Dates.require(date) : Dates.today();
    const cur = Plans.on(d);
    const latest = Plans.latest();
    const parts = [];
    if (cur) parts.push(`Ficha vigente ${cur.id} · ${cur.status || Plans.statusFor(cur.start, cur.end)} desde ${Dates.format(cur.start)}${cur.end ? ` até ${Dates.format(cur.end)}` : ''}`);
    else parts.push('Nenhuma ficha vigente');
    if (latest && Dates.compare(latest.start, d) > 0) parts.push(`próxima ${latest.id} a partir de ${Dates.format(latest.start)} (${latest.status || Plans.statusFor(latest.start, null)}) — em edição abaixo`);
    return parts.join(' · ');
  },

  /** Draft rows (planDraft keys) of a version. */
  draftOf(version) {
    const keys = Tabs.columns('planDraft').map((c) => c.key);
    return (version ? version.rows : []).map((r) => {
      const out = {};
      Object.keys(r).forEach((k) => {
        const dk = PlanDraft.toDraftKey_(k);
        if (keys.indexOf(dk) >= 0 && r[k] !== null && r[k] !== undefined) out[dk] = r[k];
      });
      return out;
    });
  },

  /**
   * Rewrites Ficha de treino with the version shown (discarding unsaved edits) and its derived
   * status. Tracked, so Desfazer restores the previous draft.
   */
  render(date) {
    const v = PlanDraft.shown(date);
    const rows = Tabs.read('planDraft');
    for (let i = rows.length - 1; i >= 0; i--) Tabs.remove('planDraft', rows[i]._row);
    Tabs.appendMany('planDraft', PlanDraft.draftOf(v));
    const cells = {};
    cells[PlanDraft.CELLS.title] = PlanDraft.statusText(date);
    cells[PlanDraft.CELLS.startLabel] = PlanDraft.LABELS.start;
    cells[PlanDraft.CELLS.reasonLabel] = PlanDraft.LABELS.reason;
    Tabs.setCells('planDraft', cells);
    return { plan: v ? v.id : null, rows: v ? v.rows.length : 0, status: cells[PlanDraft.CELLS.title] };
  },

  /** Comparable content of plan rows (Fichas keys), ignoring ids and dates. */
  signature_(rows) {
    const keys = ['session', 'exercise', 'group', 'workSetsAdapt', 'workSetsRegular', 'repsMin', 'repsMax', 'rirAdapt', 'rirRegular', 'restS', 'alternative', 'review', 'notes'];
    return JSON.stringify(rows.map((r) => keys.map((k) => (r[k] === null || r[k] === undefined || r[k] === '' ? null : (typeof r[k] === 'string' ? r[k].trim() : r[k])))));
  },

  /**
   * Checks draft rows (Fichas keys, as Plans.draftRows returns them) and canonicalizes exercise
   * names and empty groups from the catalogue (mutates `rows`).
   * @returns {{errors: string[], warnings: string[]}}
   */
  validate(rows, compareWith) {
    const errors = [];
    const warnings = [];
    if (!rows.length) errors.push('A Ficha de treino está vazia.');
    const catalogue = Exercises.list();
    if (!catalogue.length) warnings.push('O cadastro de Exercícios está vazio: nomes não conferidos.');
    const seen = {};
    const intOk = (v, min) => v === null || v === undefined || (typeof v === 'number' && Math.round(v) === v && v >= min);
    rows.forEach((r, i) => {
      const label = `Linha ${i + 1}`;
      if (!r.session || !String(r.session).trim()) errors.push(`${label}: informe a sessão.`);
      if (!r.exercise || !String(r.exercise).trim()) { errors.push(`${label}: informe o exercício.`); return; }
      if (catalogue.length) {
        const hit = Exercises.find(r.exercise, catalogue);
        if (!hit) {
          const sugg = Exercises.suggest(r.exercise, catalogue.map((e) => e.name));
          errors.push(`${label}: exercício "${r.exercise}" não está em Exercícios.${sugg.length ? ` Você quis dizer: ${sugg.join(', ')}?` : ' Cadastre-o antes.'}`);
        } else {
          r.exercise = hit.name;
          if ((r.group === null || r.group === undefined || r.group === '') && hit.group) r.group = hit.group;
        }
      }
      const key = `${Exercises.normalize(r.session)}|${Exercises.normalize(r.exercise)}`;
      if (seen[key]) errors.push(`${label}: ${r.exercise} repetido na sessão ${r.session}.`);
      seen[key] = true;
      if (r.workSetsRegular === null || r.workSetsRegular === undefined) errors.push(`${label} (${r.exercise}): informe as work sets regulares.`);
      ['workSetsAdapt', 'workSetsRegular', 'repsMin', 'repsMax'].forEach((k) => {
        if (!intOk(r[k], 1)) errors.push(`${label} (${r.exercise}): ${Tabs.column('planDraft', k).header} deve ser um inteiro ≥ 1.`);
      });
      if (typeof r.repsMin === 'number' && typeof r.repsMax === 'number' && r.repsMin > r.repsMax) errors.push(`${label} (${r.exercise}): reps mín. maior que reps máx.`);
      ['rirAdapt', 'rirRegular', 'restS'].forEach((k) => {
        if (r[k] !== null && r[k] !== undefined && !(typeof r[k] === 'number' && r[k] >= 0)) errors.push(`${label} (${r.exercise}): ${Tabs.column('planDraft', k).header} deve ser um número ≥ 0.`);
      });
      if (r.alternative && catalogue.length && !Exercises.find(r.alternative, catalogue)) {
        warnings.push(`${r.exercise}: alternativa "${r.alternative}" não está em Exercícios.`);
      }
    });
    const rotation = Config.getList('routine.sessionRotation');
    if (rotation.length && rows.length) {
      const sessions = [];
      rows.forEach((r) => { if (r.session && Sessions.indexOf_(sessions, r.session) < 0) sessions.push(String(r.session).trim()); });
      const extra = sessions.filter((s) => Sessions.indexOf_(rotation, s) < 0);
      const missing = rotation.filter((s) => Sessions.indexOf_(sessions, s) < 0);
      if (extra.length) warnings.push(`Sessões fora da rotação da Config: ${extra.join(', ')}.`);
      if (missing.length) warnings.push(`Sessões da rotação sem exercícios na ficha: ${missing.join(', ')}. Atualize Config → Rotação de sessões se a divisão mudou.`);
    }
    if (compareWith && !errors.length && PlanDraft.signature_(rows) === PlanDraft.signature_(compareWith.rows)) {
      errors.push(`A Ficha de treino é igual à ${compareWith.id}; nada a salvar.`);
    }
    return { errors, warnings };
  },

  /**
   * Salvar nova ficha: the draft becomes the next plan version from `date` (args.date, else the
   * form cell), closing the previous one; a Revisões row records it. Undoable as one action.
   * @param {{date?, reason?, reviewer?}} args
   */
  save(args) {
    const a = args || {};
    const sheet = Tabs.sheet('planDraft');
    const cell = (a1) => sheet.getRange(a1).getValue();
    const start = Dates.parse(a.date !== undefined ? a.date : cell(PlanDraft.CELLS.start));
    if (!start) throw new Error(`Informe o início da nova ficha (Ficha de treino!${PlanDraft.CELLS.start}).`);
    const reasonRaw = a.reason !== undefined ? a.reason : cell(PlanDraft.CELLS.reason);
    const reason = reasonRaw === null || reasonRaw === undefined ? '' : String(reasonRaw).trim();
    if (!reason) throw new Error(`Informe o motivo da nova ficha (Ficha de treino!${PlanDraft.CELLS.reason}).`);
    const rows = Plans.draftRows();
    const check = PlanDraft.validate(rows, Plans.latest());
    if (check.errors.length) {
      const err = new Error(check.errors.join(' '));
      err.apiErrors = check.errors.map((m) => ({ path: 'plan', code: 'invalid', message: m }));
      throw err;
    }
    return ChangeLog.run('Salvar nova ficha', () => {
      const res = Transition.newPlan({ date: start, plan: rows, reason, reviewer: a.reviewer });
      const clear = {};
      clear[PlanDraft.CELLS.start] = '';
      clear[PlanDraft.CELLS.reason] = '';
      Tabs.setCells('planDraft', clear);
      PlanDraft.render();
      const closed = res.closes.find((c) => c.entity === 'plan');
      const message = `Ficha ${res.after.plan} salva a partir de ${Dates.format(start)}${closed ? `; ${closed.id} vale até ${Dates.format(closed.end)}` : ''}.${check.warnings.length ? ` Avisos: ${check.warnings.join(' ')}` : ''}`;
      return Object.assign({ message, warnings: check.warnings }, res);
    });
  },
};

/* ---------------------------------------------------------------------------------------------
 * Formatting helpers (pt-BR numbers).
 * ------------------------------------------------------------------------------------------- */
const Fmt = {
  /** 42.5 → "42,5"; 40 → "40"; null → "". */
  num(n) {
    if (n === null || n === undefined || n === '') return '';
    const r = Math.round(Number(n) * 100) / 100;
    return String(r).replace('.', ',');
  },
};

/* ---------------------------------------------------------------------------------------------
 * Actions (menu Projeto and Ação rápida).
 * ------------------------------------------------------------------------------------------- */
const WorkoutActions = {
  /** Reads the screen unless the caller (bot/API) gave the values. */
  input_(args) {
    const a = args || {};
    if (a.rows) return { date: a.date, session: a.session, phase: a.phase, rows: a.rows };
    const s = TrainingScreen.read() || {};
    return { date: a.date || s.date, session: a.session || s.session, phase: a.phase || s.phase, state: s.state, rows: s.rows || [] };
  },

  load(args) {
    const a = args || {};
    let date = a.date;
    let session = a.session;
    if (!date || session === undefined) {
      const s = TrainingScreen.read() || {};
      date = date || s.date;
      // A session already concluded on the screen is not reloaded: the rotation picks the next one.
      if (session === undefined && s.session && s.state !== Sessions.STATE.DONE) session = s.session;
    }
    const view = Sessions.load(date || Dates.today(), session || null);
    TrainingScreen.write(Sessions.screenView(view));
    const extra = view.rows.length > TrainingScreen.MAX_ROWS ? ` Atenção: ${view.rows.length} exercícios; a tabela mostra ${TrainingScreen.MAX_ROWS}.` : '';
    const how = view.state === Sessions.STATE.DONE ? 'sessão concluída (corrija e use Concluir treino)'
      : view.resumed ? 'retomando o registro parcial' : 'cargas anteriores só como referência';
    return { message: `${view.session} carregado (${view.plan ? `ficha ${view.plan}, ` : ''}${view.phase}): ${how}.${extra}`, view };
  },

  save_(args, state) {
    const input = WorkoutActions.input_(args);
    const date = input.date || Dates.today();
    const opts = { phase: input.phase || null };
    const res = state === Sessions.STATE.DONE ? Sessions.complete(date, input.session, input.rows, opts) : Sessions.savePartial(date, input.session, input.rows, opts);
    if (!(args && args.rows)) TrainingScreen.write(Sessions.screenView(Sessions.load(date, res.session)));
    return res;
  },

  /**
   * 'hoje.loaded': when Hoje shows a date and its training table is empty, the session saved on
   * that date (the partial one first) is shown, so it can be resumed. Typed values are never
   * overwritten, and nothing happens on a date without a saved session.
   */
  onHojeLoaded(payload) {
    try {
      const d = Dates.parse(payload && payload.date);
      if (!d) return;
      const screen = TrainingScreen.read() || {};
      if ((screen.rows || []).length) return;
      const sessions = Workouts.sessionsOn(Workouts.rows(), d);
      if (!sessions.length) return;
      const partial = sessions.filter((x) => x.state === Sessions.STATE.PARTIAL);
      const pick = partial.length ? partial[partial.length - 1] : sessions[sessions.length - 1];
      TrainingScreen.write(Sessions.screenView(Sessions.load(d, pick.session)));
    } catch (err) {
      console.error(err);
    }
  },
};

Core.on('hoje.loaded', (payload) => WorkoutActions.onHojeLoaded(payload));

Actions.register({ id: 'saveWorkoutPartial', label: 'Salvar parcial do treino', group: 'today', order: 30, quick: true, run: (args) => WorkoutActions.save_(args, Sessions.STATE.PARTIAL) });
Actions.register({ id: 'completeWorkout', label: 'Concluir treino', group: 'today', order: 40, quick: true, run: (args) => WorkoutActions.save_(args, Sessions.STATE.DONE) });
Actions.register({ id: 'loadWorkout', label: 'Carregar treino', group: 'today', order: 50, quick: true, run: (args) => WorkoutActions.load(args) });
Actions.register({ id: 'savePlan', label: 'Salvar nova ficha', group: 'phase', order: 30, run: (args) => PlanDraft.save(args) });
Actions.register({
  id: 'showPlan', label: 'Mostrar ficha vigente', group: 'phase', order: 35,
  run: () => {
    const r = PlanDraft.render();
    return { message: `${r.status}. Rascunho refeito a partir de ${r.plan || '—'} (${r.rows} exercícios).`, result: r };
  },
});
Actions.register({
  id: 'progressionSuggestions', label: 'Sugestões de progressão', group: 'analysis', order: 40,
  run: (args) => Progression.runSuggestions((args && args.date) || Dates.today()),
});
