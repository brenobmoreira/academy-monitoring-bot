'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, plain } = require('./core_helpers');
const { FOODS } = require('./food_helpers');

/** Tuesday. O001/M001 from 15/09; F001 15/09–27/09, F002 from 28/09 (workout_helpers plans). */
const NOW = '2026-10-20T15:00:00-03:00';
const KEY = 'test-key';

const planRow = (id, start, end, status, session, exercise, group, extra) => Object.assign({
  id, legacyStart: start, start, end, status, session, exercise, group,
  workSetsAdapt: 1, workSetsRegular: 2, repsMin: 6, repsMax: 10, rirAdapt: 3, rirRegular: 1, restS: 150,
  notes: '1 aquecimento + 1 feeder + 2 work sets',
}, extra || {});

function tabs() {
  return {
    objectives: [{ id: 'O001', name: 'Recomposição corporal', analysisType: 'recomposicao', start: '2026-09-15', status: 'Vigente', goal: 'M001', plan: 'F002' }],
    goals: [{ id: 'M001', objective: 'O001', start: '2026-09-15', status: 'Vigente', kcal: 2400, protein: 140, proteinMin: 135, proteinMax: 145, fat: 65, carbs: 313.75 }],
    plans: [
      planRow('F001', '2026-09-15', '2026-09-27', 'Encerrada', 'Upper', 'Supino reto', 'Peito'),
      planRow('F002', '2026-09-28', null, 'Vigente', 'Upper', 'Supino inclinado', 'Peito'),
      planRow('F002', '2026-09-28', null, 'Vigente', 'Upper', 'Puxada aberta', 'Costas'),
      planRow('F002', '2026-09-28', null, 'Vigente', 'Lower', 'Leg press', 'Quadríceps'),
    ],
    exercises: [
      { name: 'Supino inclinado', group: 'Peito' }, { name: 'Puxada aberta', group: 'Costas' },
      { name: 'Leg press', group: 'Quadríceps' }, { name: 'Supino reto', group: 'Peito' },
    ],
    workouts: [], diary: [], reviews: [], measures: [], weeks: [], evolution: [],
    food: [], foods: FOODS.map((f) => ({ ...f })), favorites: [], ingredients: [],
  };
}

function setup(opts = {}) {
  const ctx = boot({
    tabs: Object.assign(tabs(), opts.tabs || {}),
    config: Object.assign({ 'client.name': 'Cliente Teste', 'routine.sessionRotation': 'Upper, Lower', 'routine.strengthPerWeek': 3 }, opts.config || {}),
    now: opts.now || NOW,
    properties: { SHEET_API_KEY: KEY },
  });
  ctx.api = (op, args) => plain(ctx.SheetApi.run(op, args));
  ctx.http = (body) => plain(JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).getContent()));
  return ctx;
}

const ok = (r) => { assert.equal(r.ok, true, JSON.stringify(r.errors)); return r.result; };
const codes = (r) => r.errors.map((e) => `${e.path}:${e.code}`);
const UPPER = [
  { name: 'Supino inclinado', warmup: { kg: 20, reps: 12 }, feeder: { kg: 40, reps: 5 }, work: [{ kg: 60, reps: 8, rir: 2 }, { kg: 62.5, reps: 8, rir: 1 }] },
  { name: 'Puxada aberta', work: [{ kg: 50, reps: 10 }, { kg: 50, reps: 9, rir: 0 }] },
];

/* Envelope and auth ------------------------------------------------------------------------------ */

test('doPost: key check, JSON errors, unknown envelope fields and ops', () => {
  const ctx = setup();
  assert.deepEqual(codes(ctx.http('not json')), ['body:invalid_json']);
  assert.deepEqual(codes(ctx.http([1])), ['body:wrong_type']);
  assert.deepEqual(codes(ctx.http({ key: 'nope', op: 'catalog' })), ['key:unauthorized']);
  assert.deepEqual(codes(ctx.http({ op: 'catalog' })), ['key:unauthorized']);
  assert.deepEqual(codes(ctx.http({ key: KEY, op: 'catalog', extra: 1 })), ['extra:unknown_field']);
  const bad = ctx.http({ key: KEY, op: 'drop.table' });
  assert.deepEqual(codes(bad), ['op:unknown_op']);
  assert.match(bad.errors[0].message, /aceitas: catalog, diary\.upsert/);
  assert.equal(ctx.http({ key: KEY, op: 'catalog' }).ok, true);
});

test('doPost without the Script Property answers internal, never an HTML page', () => {
  const ctx = setup();
  ctx.PropertiesService.getScriptProperties().deleteProperty('SHEET_API_KEY');
  const r = ctx.http({ key: '', op: 'catalog' });
  assert.deepEqual(codes(r), ['key:internal']);
});

/* catalog ---------------------------------------------------------------------------------------- */

test('catalog: today, client, phase in force with targets, rotation, next session, plan, foods', () => {
  const ctx = setup();
  const c = ok(ctx.api('catalog', {}));
  assert.equal(c.today, '2026-10-20');
  assert.equal(c.timezone, 'America/Sao_Paulo');
  assert.equal(c.client.name, 'Cliente Teste');
  assert.equal(c.phase.objective.id, 'O001');
  assert.equal(c.phase.objective.start, '2026-09-15');
  assert.equal(c.phase.goal.kcal, 2400);
  assert.equal(c.phase.goal.proteinMin, 135);
  assert.equal(c.phase.plan.id, 'F002');
  assert.deepEqual(c.sessions, ['Upper', 'Lower']);
  assert.equal(c.nextSession, 'Upper');
  assert.equal(c.trainingPhase, 'Regular');
  assert.deepEqual(c.exercises.slice(0, 2), [{ name: 'Supino inclinado', group: 'Peito' }, { name: 'Puxada aberta', group: 'Costas' }]);
  assert.deepEqual(c.plan.map((r) => [r.session, r.exercise, r.sets, r.repsMin, r.repsMax, r.rirMax]),
    [['Upper', 'Supino inclinado', 2, 6, 10, 1], ['Upper', 'Puxada aberta', 2, 6, 10, 1], ['Lower', 'Leg press', 2, 6, 10, 1]]);
  assert.equal(c.plan[0].prescription, '2×6–10 · RIR 0–1 · 150 s');
  assert.ok(c.foods.includes('Arroz branco cozido'));
  assert.deepEqual(c.foodLog, ['Não informado', 'Parcial', 'Completo']);
  assert.deepEqual(c.recent, []);
  assert.equal(c.lastWorkout, null);
  assert.deepEqual(codes(ctx.api('catalog', { x: 1 })), ['args.x:unknown_field']);
});

/* diary.upsert ----------------------------------------------------------------------------------- */

test('diary.upsert writes 4.0 fields through Diary.save, stamps ids, returns writeId; empty never erases, null clears', () => {
  const ctx = setup();
  const r = ok(ctx.api('diary.upsert', {
    date: '2026-10-19',
    fields: { weightKg: 82.4, waistCm: 84, sleepH: 7.5, steps: 8000, activityMin: 60, activity: 'Muay Thai', pain: 0, foodLog: 'Completo', hunger: 3 },
  }));
  assert.equal(r.date, '2026-10-19');
  assert.deepEqual(r.fields, { weightKg: 82.4, waistCm: 84, sleepH: 7.5, steps: 8000, activityMin: 60, activity: 'Muay Thai', pain: 0, foodLog: 'Completo', hunger: 3 });
  assert.deepEqual(r.ids, { objective: 'O001', goal: 'M001', plan: 'F002' });
  assert.equal(r.dayState, 'Completo');
  assert.ok(r.writeId);
  const day = ctx.Days.get('2026-10-19');
  assert.equal(day.pain, 0, 'zero is kept');
  // A second write with other fields keeps the first ones; null clears one.
  const r2 = ok(ctx.api('diary.upsert', { date: '2026-10-19', fields: { sleepH: 6, waistCm: null } }));
  assert.deepEqual(r2.fields, { sleepH: 6, waistCm: null });
  assert.deepEqual(plain(r2.changed).sort(), ['sleepH', 'waistCm']);
  const after = ctx.Days.get('2026-10-19');
  assert.equal(after.weightKg, 82.4);
  assert.equal(after.waistCm, null);
  // Same values again: nothing written, no writeId.
  const r3 = ok(ctx.api('diary.upsert', { date: '2026-10-19', fields: { sleepH: 6 } }));
  assert.equal(r3.writeId, undefined);
  // The running week was refreshed by the action commit.
  assert.equal(ctx.Tabs.read('weeks').length, 1);
});

test('diary.upsert validation: all errors at once, strict types, nothing written', () => {
  const ctx = setup();
  const r = ctx.api('diary.upsert', {
    date: '2026-10-21',
    fields: { weightKg: '82,4', sleepH: 30, steps: 10.5, foodLog: 'completo', muayThai: true, notes: ' ', activity: 5 },
    extra: 1,
  });
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r).sort(), [
    'args.date:date_in_future', 'args.extra:unknown_field', 'args.fields.activity:wrong_type', 'args.fields.foodLog:not_in_catalog',
    'args.fields.muayThai:unknown_field', 'args.fields.notes:empty', 'args.fields.sleepH:out_of_range',
    'args.fields.steps:wrong_type', 'args.fields.weightKg:wrong_type',
  ]);
  assert.equal(ctx.Tabs.read('diary').length, 0);
  assert.equal(ctx.Tabs.findSheet('log') ? ctx.Tabs.read('log').length : 0, 0);
  assert.deepEqual(codes(ctx.api('diary.upsert', { date: '2026-02-30', fields: {} })), ['args.date:invalid_date', 'args.fields:empty']);
  assert.deepEqual(codes(ctx.api('diary.upsert', { date: '1900-01-01', fields: { sleepH: 7 } })), ['args.date:invalid_date']);
});

/* workout.upsert --------------------------------------------------------------------------------- */

test('workout.upsert: warm-up/feeder apart, work sets with RIR, Parcial, then complete; previous and comparison', () => {
  const ctx = setup();
  ok(ctx.api('workout.upsert', {
    date: '2026-10-13', session: 'Upper', complete: true,
    exercises: [{ name: 'Supino inclinado', work: [{ kg: 60, reps: 8, rir: 2 }, { kg: 60, reps: 7, rir: 1 }] }],
  }));
  const r = ok(ctx.api('workout.upsert', { date: '2026-10-20', session: 'upper', exercises: UPPER }));
  assert.equal(r.session, 'Upper');
  assert.equal(r.state, 'Parcial');
  assert.equal(r.plan, 'F002');
  assert.equal(r.objective, 'O001');
  assert.ok(r.writeId);
  const supino = r.exercises[0];
  assert.deepEqual(supino.warmup, { kg: 20, reps: 12 });
  assert.deepEqual(supino.feeder, { kg: 40, reps: 5 });
  assert.deepEqual(supino.work, [{ kg: 60, reps: 8, rir: 2 }, { kg: 62.5, reps: 8, rir: 1 }]);
  assert.equal(supino.volume, 980, 'only work sets count');
  assert.equal(supino.group, 'Peito');
  assert.deepEqual(supino.previous.work, [{ kg: 60, reps: 8, rir: 2 }, { kg: 60, reps: 7, rir: 1 }]);
  assert.equal(supino.previous.date, '2026-10-13');
  assert.equal(supino.comparison, 'progressed');
  assert.deepEqual(r.exercises[1].work, [{ kg: 50, reps: 10, rir: null }, { kg: 50, reps: 9, rir: 0 }]);
  const row = ctx.Tabs.read('workouts').find((x) => x.exercise === 'Supino inclinado' && ctx.Dates.key(x.date) === '2026-10-20');
  assert.equal(row.sessionState, 'Parcial');
  assert.equal(row.warmupKg, 20);
  assert.equal(row.rir2, 1);
  // A correction resending only the work sets keeps warm-up and feeder; complete concludes the session.
  const c = ok(ctx.api('workout.upsert', { date: '2026-10-20', session: 'Upper', complete: true, exercises: [{ name: 'Supino inclinado', work: [{ kg: 62.5, reps: 8, rir: 1 }] }] }));
  assert.equal(c.state, 'Concluído');
  assert.equal(c.next, 'Lower');
  assert.deepEqual(c.exercises[0].warmup, { kg: 20, reps: 12 });
  assert.deepEqual(c.exercises[0].work, [{ kg: 62.5, reps: 8, rir: 1 }]);
  assert.ok(ctx.Tabs.read('workouts').filter((x) => ctx.Dates.key(x.date) === '2026-10-20').every((x) => x.sessionState === 'Concluído'));
  assert.equal(ctx.Days.get('2026-10-20').sessions, 1);
  // complete with no exercises concludes what was saved (no-op here) and still answers.
  assert.equal(ok(ctx.api('workout.upsert', { date: '2026-10-20', session: 'Upper', complete: true, exercises: [] })).state, 'Concluído');
});

test('workout.upsert validation: paths, suggestions, 1–2 work sets, nothing written', () => {
  const ctx = setup();
  const r = ctx.api('workout.upsert', {
    date: '2026-10-20', session: 'Uper', phase: 'Regular',
    exercises: [
      { name: 'puxada', work: [{ kg: 50, reps: 10 }] },
      { name: 'Supino inclinado', sets: [], work: [{ kg: 60, reps: 8 }, { kg: 60, reps: 8 }, { kg: 60, reps: 8 }] },
      { name: 'Leg press', warmup: { kg: 40 }, work: [{ kg: '100', reps: 0, rir: 11 }] },
      { name: 'Leg press', work: [] },
    ],
  });
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), [
    'args.phase:unknown_field', 'args.session:not_in_catalog', 'args.exercises[0].name:not_in_catalog',
    'args.exercises[1].sets:unknown_field', 'args.exercises[1].work:out_of_range',
    'args.exercises[2].warmup.reps:required', 'args.exercises[2].work[0].kg:wrong_type',
    'args.exercises[2].work[0].reps:out_of_range', 'args.exercises[2].work[0].rir:out_of_range',
    'args.exercises[3].name:duplicate', 'args.exercises[3].work:out_of_range',
  ]);
  const byPath = Object.fromEntries(r.errors.map((e) => [e.path, e]));
  assert.equal(byPath['args.session'].suggestions[0], 'Upper');
  assert.deepEqual(byPath['args.exercises[0].name'].suggestions, ['Puxada aberta']);
  assert.equal(ctx.Tabs.read('workouts').length, 0);
  assert.deepEqual(codes(ctx.api('workout.upsert', { date: '2026-10-20', session: 'Upper', exercises: [] })), ['args.exercises:out_of_range']);
});

/* food.add --------------------------------------------------------------------------------------- */

test('food.add: catalogue food, household unit (estimated), no-calc; macros, Cálculo/Fonte and day totals', () => {
  const ctx = setup();
  const r = ok(ctx.api('food.add', {
    date: '2026-10-20', meal: 'Almoço',
    items: [
      { food: 'arroz branco cozido', qty: 150, unit: 'g' },
      { food: 'Ovo inteiro cozido', qty: 2, unit: 'un' },
      { description: 'Pastel de feira' },
    ],
  }));
  assert.ok(r.writeId);
  assert.deepEqual(r.items.map((i) => [i.food, i.qty, i.unit, i.calc, i.source]), [
    ['Arroz branco cozido', 150, 'g', 'Calculado', 'TACO/fonte confiável'],
    ['Ovo inteiro cozido', 100, 'g', 'Estimado', 'TACO/fonte confiável'],
    ['Pastel de feira', null, null, 'Sem cálculo', 'Pendente'],
  ]);
  assert.equal(r.items[0].kcal, 192);
  assert.equal(r.items[2].kcal, null, 'sem cálculo is never 0');
  assert.deepEqual([r.totals.kcal, r.totals.noCalcItems, r.totals.estimatedItems], [338, 1, 1]);
  assert.equal(r.dayState, 'Parcial');
  assert.equal(ctx.Days.get('2026-10-20').kcal, 338);
  // One action: undo removes the three rows and the totals.
  ok(ctx.api('write.undo', { writeId: r.writeId }));
  assert.equal(ctx.Tabs.read('food').length, 0);
});

test('food.add validation: unknown food with suggestions, impossible unit, incomplete catalogue row, item forms', () => {
  const ctx = setup();
  const r = ctx.api('food.add', {
    date: '2026-10-20',
    items: [
      { food: 'Arroz branco', qty: 100 },
      { food: 'Leite desnatado', qty: 200, unit: 'g' },
      { food: 'Granola sem cadastro completo', qty: 40, unit: 'g' },
      { food: 'Aveia em flocos', favorite: 'X' },
      { favorite: 'Nada' },
      { food: 'Aveia em flocos', qty: '40' },
    ],
  });
  assert.deepEqual(codes(r), [
    'args.meal:required', 'args.items[0].food:not_in_catalog', 'args.items[1].unit:invalid_unit',
    'args.items[2].food:incomplete_food', 'args.items[3]:conflict', 'args.items[4].favorite:not_in_catalog',
    'args.items[5].qty:wrong_type',
  ]);
  assert.ok(r.errors[1].suggestions.includes('Arroz branco cozido'));
  assert.match(r.errors[2].message, /sem densidade/);
  assert.equal(ctx.Tabs.read('food').length, 0);
});

test('food.add with a favourite × portions expands one row per ingredient', () => {
  const ctx = setup({
    tabs: {
      favorites: [{ name: 'Café padrão', version: 'v1' }],
      ingredients: [
        { favorite: 'Café padrão', food: 'Pão integral', qty: 50, unit: 'g', version: 'v1', check: 'Calculado' },
        { favorite: 'Café padrão', food: 'Leite desnatado', qty: 200, unit: 'ml', version: 'v1', check: 'Calculado' },
      ],
    },
  });
  const r = ok(ctx.api('food.add', { date: '2026-10-20', meal: 'Café da manhã', items: [{ favorite: 'cafe padrao', portions: 2 }] }));
  assert.deepEqual(r.items.map((i) => [i.food, i.qty, i.favorite]), [['Pão integral', 100, 'Café padrão · v1'], ['Leite desnatado', 400, 'Café padrão · v1']]);
});

/* reads ----------------------------------------------------------------------------------------- */

test('day.get, diary.range, workout.range and exercise.history (work sets only)', () => {
  const ctx = setup();
  ok(ctx.api('diary.upsert', { date: '2026-10-19', fields: { weightKg: 82, sleepH: 7 } }));
  ok(ctx.api('diary.upsert', { date: '2026-10-20', fields: { weightKg: 81.8 } }));
  ok(ctx.api('workout.upsert', { date: '2026-10-20', session: 'Upper', exercises: UPPER }));
  ok(ctx.api('food.add', { date: '2026-10-20', meal: 'Almoço', items: [{ food: 'Arroz branco cozido', qty: 100 }] }));

  const d = ok(ctx.api('day.get', { date: '2026-10-20' }));
  assert.deepEqual(d.diary, { weightKg: 81.8 });
  assert.deepEqual(d.ids, { objective: 'O001', goal: 'M001', plan: 'F002' });
  assert.equal(d.totals.kcal, 128);
  assert.equal(d.food[0].food, 'Arroz branco cozido');
  assert.equal(d.workout[0].session, 'Upper');
  assert.equal(d.workout[0].state, 'Parcial');
  assert.deepEqual(d.workout[0].exercises[0].warmup, { kg: 20, reps: 12 });
  const empty = ok(ctx.api('day.get', { date: '2026-10-01' }));
  assert.deepEqual([empty.diary, empty.food, empty.workout, empty.dayState], [null, [], [], 'Sem registro']);
  assert.deepEqual(codes(ctx.api('day.get', { date: '2026-10-21' })), ['args.date:date_in_future']);

  const range = ok(ctx.api('diary.range', { from: '2026-10-19', to: '2026-10-25' }));
  assert.deepEqual(range.days.map((x) => [x.date, x.weightKg, x.sleepH]), [['2026-10-19', 82, 7], ['2026-10-20', 81.8, undefined]]);
  assert.deepEqual(codes(ctx.api('diary.range', { from: '2026-10-20', to: '2026-10-19' })), ['args.to:invalid_range']);
  assert.deepEqual(codes(ctx.api('diary.range', { from: '2026-01-01', to: '2026-10-19' })), ['args.to:out_of_range']);

  const w = ok(ctx.api('workout.range', { from: '2026-10-19', to: '2026-10-25' }));
  assert.deepEqual(w.rows.map((x) => [x.date, x.session, x.name, x.group, x.volume, x.state]), [
    ['2026-10-20', 'Upper', 'Supino inclinado', 'Peito', 980, 'Parcial'],
    ['2026-10-20', 'Upper', 'Puxada aberta', 'Costas', 950, 'Parcial'],
  ]);

  const h = ok(ctx.api('exercise.history', { name: 'supino inclinado' }));
  assert.equal(h.name, 'Supino inclinado');
  assert.deepEqual(h.sessions, [{ date: '2026-10-20', session: 'Upper', plan: 'F002', state: 'Parcial', equipment: null, work: [{ kg: 60, reps: 8, rir: 2 }, { kg: 62.5, reps: 8, rir: 1 }], volume: 980 }]);
  const bad = ctx.api('exercise.history', { name: 'Supino', limit: 0 });
  assert.deepEqual(codes(bad), ['args.name:not_in_catalog', 'args.limit:out_of_range']);
});

test('phase.get resolves ids and targets by date across a transition; week.get stored vs running', () => {
  const ctx = setup();
  ok(ctx.api('diary.upsert', { date: '2026-10-06', fields: { weightKg: 82 } }));
  ctx.Transition.apply({
    date: '2026-10-12', objective: { name: 'Ganho controlado', analysisType: 'ganho_controlado' },
    goal: { kcal: 2700, protein: 150, fat: 70 }, reason: 'Fim da recomposição',
  });
  ctx.Weeks.recomputeAll();
  const past = ok(ctx.api('phase.get', { date: '2026-10-05' }));
  assert.equal(past.objective.id, 'O001');
  assert.equal(past.objective.end, '2026-10-11');
  assert.equal(past.goal.id, 'M001');
  assert.equal(past.goal.kcal, 2400);
  assert.equal(past.plan.id, 'F002');
  assert.equal(past.recommendation.week, '2026-10-05');
  const now = ok(ctx.api('phase.get', { date: '2026-10-20' }));
  assert.deepEqual([now.objective.id, now.objective.name, now.objective.start, now.objective.analysisType], ['O002', 'Ganho controlado', '2026-10-12', 'ganho_controlado']);
  assert.equal(now.objective.days, 9);
  assert.deepEqual([now.goal.id, now.goal.kcal, now.goal.carbs], ['M002', 2700, 367.5]);
  const before = ok(ctx.api('phase.get', { date: '2026-09-01' }));
  assert.deepEqual([before.objective, before.goal, before.plan], [null, null, null]);
  const future = ok(ctx.api('phase.get', { date: '2026-12-01' }));
  assert.equal(future.objective.id, 'O002');

  const closed = ok(ctx.api('week.get', { date: '2026-10-08' }));
  assert.equal(closed.source, 'stored');
  assert.equal(closed.closed, true);
  assert.equal(closed.start, '2026-10-05');
  assert.equal(closed.objective, 'O001', 'a past week keeps the objective of its Sunday');
  assert.ok(closed.status);
  const running = ok(ctx.api('week.get', { date: '2026-10-20' }));
  assert.equal(running.source, 'computed');
  assert.equal(running.closed, false);
  assert.equal(running.objective, 'O002');
  assert.ok(running.recommendation);
});

/* write.undo and recent ------------------------------------------------------------------------ */

test('write.undo: last and by id, error codes mapped to args.writeId; catalog.recent lists the writes', () => {
  const ctx = setup();
  const a = ok(ctx.api('diary.upsert', { date: '2026-10-20', fields: { weightKg: 82 } }));
  const b = ok(ctx.api('workout.upsert', { date: '2026-10-20', session: 'Upper', exercises: UPPER }));
  const recent = ok(ctx.api('catalog', {})).recent;
  assert.deepEqual(recent.map((x) => [x.writeId, x.op, x.date]), [[b.writeId, 'workout.upsert', '2026-10-20'], [a.writeId, 'diary.upsert', '2026-10-20']]);
  assert.deepEqual(recent[0].exercises, ['Supino inclinado', 'Puxada aberta']);
  assert.equal(recent[0].session, 'Upper');
  assert.match(recent[0].action, /^Bot: treino Upper 20\/10\/2026$/);

  const notLatest = ctx.api('write.undo', { writeId: a.writeId });
  assert.deepEqual(codes(notLatest), ['args.writeId:not_latest']);
  const u = ok(ctx.api('write.undo', { writeId: b.writeId }));
  assert.deepEqual([u.writeId, u.undone.op, u.undone.session, u.undone.date], [b.writeId, 'workout.upsert', 'Upper', '2026-10-20']);
  assert.equal(ctx.Tabs.read('workouts').length, 0);
  assert.deepEqual(codes(ctx.api('write.undo', { writeId: b.writeId })), ['args.writeId:already_undone']);
  assert.deepEqual(codes(ctx.api('write.undo', { writeId: 'zzz' })), ['args.writeId:not_found']);
  const last = ok(ctx.api('write.undo', {}));
  assert.deepEqual(last.undone.fields, ['weightKg']);
  assert.equal(ctx.Days.get('2026-10-20'), null);
  assert.deepEqual(codes(ctx.api('write.undo', {})), ['args:nothing_to_undo']);
  // Writes older than 30 minutes leave recent.
  ok(ctx.api('diary.upsert', { date: '2026-10-20', fields: { sleepH: 7 } }));
  ctx.__clock.advance(31 * 60 * 1000);
  assert.deepEqual(ok(ctx.api('catalog', {})).recent, []);
});

test('a domain refusal rolls the whole action back and answers rejected', () => {
  const ctx = setup({
    tabs: {
      favorites: [{ name: 'Lanche', version: 'v1' }],
      ingredients: [{ favorite: 'Lanche', food: 'Alimento apagado do catálogo', qty: 50, unit: 'g', version: 'v1', check: 'Calculado' }],
    },
  });
  const r = ctx.api('food.add', { date: '2026-10-20', meal: 'Lanche', items: [{ food: 'Arroz branco cozido', qty: 100 }, { favorite: 'Lanche' }] });
  assert.equal(r.ok, false);
  assert.deepEqual(codes(r), ['args:rejected']);
  assert.match(r.errors[0].message, /Não foi possível lançar "Lanche · v1"/);
  assert.equal(ctx.Tabs.read('food').length, 0, 'the first item was rolled back too');
  assert.equal(ctx.Days.get('2026-10-20'), null);
});
