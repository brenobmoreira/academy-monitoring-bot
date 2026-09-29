/** Test helpers for the workout module: a client with a plan history, a catalogue and a fake Hoje screen. */
'use strict';
const { boot, plain } = require('./core_helpers');

/** Tuesday. F001 15/09–27/09 (closed), F002 from 28/09 (in force). */
const NOW = '2026-10-20T15:00:00-03:00';

const CATALOGUE = [
  { name: 'Supino inclinado', group: 'Peito', loadConvention: 'Carga total' },
  { name: 'Puxada aberta', group: 'Costas', loadConvention: 'kg da máquina' },
  { name: 'Leg press', group: 'Quadríceps', loadConvention: 'kg da máquina' },
  { name: 'Mesa flexora', group: 'Posteriores', loadConvention: 'kg da máquina' },
  { name: 'Elevação lateral', group: 'Ombros', loadConvention: 'kg por halter' },
  { name: 'Supino reto', group: 'Peito', loadConvention: 'Carga total' },
];

const SET_MODEL = '1 aquecimento + 1 feeder + 2 work sets de 6–10 reps, 0–1 RIR.';
const planRow = (id, start, end, status, session, exercise, group, extra) => Object.assign({
  id, legacyStart: start, start, end, status, session, exercise, group,
  workSetsAdapt: 1, workSetsRegular: 2, repsMin: 6, repsMax: 10, rirAdapt: 3, rirRegular: 1, restS: 150,
  review: 'Confirmado', notes: SET_MODEL,
}, extra || {});

function plans() {
  const f1 = (s, e, g) => planRow('F001', '2026-09-15', '2026-09-27', 'Encerrada', s, e, g, { repsMin: 8, repsMax: 12 });
  const f2 = (s, e, g, x) => planRow('F002', '2026-09-28', null, 'Vigente', s, e, g, x);
  return [
    f1('Upper', 'Supino reto', 'Peito'),
    f1('Lower', 'Leg press', 'Quadríceps'),
    f2('Upper', 'Supino inclinado', 'Peito', { alternative: 'Supino reto' }),
    f2('Upper', 'Puxada aberta', 'Costas'),
    f2('Lower', 'Leg press', 'Quadríceps'),
    f2('Lower', 'Mesa flexora', 'Posteriores'),
    f2('Full Body', 'Leg press', 'Quadríceps'),
    f2('Full Body', 'Elevação lateral', 'Ombros'),
  ];
}

const CONFIG = {
  'client.reviewer': 'Revisor X',
  'routine.sessionRotation': 'Upper, Lower, Full Body',
  'routine.rotationMode': 'continuous',
};

/** In-memory TrainingScreen implementation recording every write. */
function memoryScreen(initial) {
  const screen = {
    state: Object.assign({ date: null, session: null, state: null, rows: [] }, initial || {}),
    writes: [],
    clears: 0,
    read() { return JSON.parse(JSON.stringify(screen.state), (k, v) => (k === 'date' && v ? new Date(v) : v)); },
    write(view) {
      screen.writes.push(view);
      screen.state = { date: view.date, session: view.session, state: view.state, rows: view.rows.map((r) => Object.assign({}, r)) };
    },
    clear() { screen.clears += 1; screen.state = { date: null, session: null, state: null, rows: [] }; },
  };
  return screen;
}

/**
 * @param {{config?: Object, tabs?: Object, now?: string, screen?: Object}} opts
 * @returns ctx with ctx.screen (memory TrainingScreen, already plugged in)
 */
function setup(opts = {}) {
  const tabs = Object.assign({
    objectives: [{ id: 'O001', name: 'Recomposição corporal', analysisType: 'recomposicao', start: '2026-09-15', status: 'Vigente', goal: 'M001', plan: 'F002' }],
    goals: [{ id: 'M001', objective: 'O001', start: '2026-09-15', status: 'Vigente', kcal: 2400, protein: 140, fat: 65 }],
    plans: plans(),
    exercises: CATALOGUE,
    workouts: [],
    diary: [],
    reviews: [],
    progression: [],
    planDraft: [],
  }, opts.tabs || {});
  const ctx = boot({ tabs, config: Object.assign({}, CONFIG, opts.config || {}), now: opts.now || NOW });
  ctx.screen = memoryScreen(opts.screen);
  ctx.TrainingScreen.use(ctx.screen);
  return ctx;
}

/** A screen row: w1/w2 = [kg, reps, rir]; warm-up and feeder as [kg, reps]. */
function row(exercise, w1, w2, extra) {
  const r = { exercise };
  if (w1) { r.work1Kg = w1[0]; r.work1Reps = w1[1]; if (w1[2] !== undefined) r.rir1 = w1[2]; }
  if (w2) { r.work2Kg = w2[0]; r.work2Reps = w2[1]; if (w2[2] !== undefined) r.rir2 = w2[2]; }
  return Object.assign(r, extra || {});
}

/** Completes `session` on `date` with the given rows (defaults to one row per plan exercise). */
function done(ctx, date, session, rows) {
  return ctx.Sessions.complete(date, session, rows);
}

const snapshot = (ctx, names) => JSON.stringify(names.map((n) => {
  const s = ctx.__spreadsheet.getSheetByName(n);
  return s ? s.getDataRange().getValues() : null;
}));

module.exports = { setup, row, done, snapshot, plain, NOW, CATALOGUE, SET_MODEL, memoryScreen };
