'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, day, plain } = require('./core_helpers');

const eq = (a, b, m) => assert.deepEqual(plain(a), b, m);
const TECH = new Date('1900-01-01T00:00:00');

/** Today is 2026-09-29 (Tuesday). History as the owner fixed it in spec §9. */
function history(overrides = {}) {
  return Object.assign({
    objectives: [{ id: 'O001', name: 'Recomposição corporal', analysisType: 'recomposicao', start: '2026-09-28', status: 'Vigente', goal: 'M001', plan: 'F002' }],
    goals: [{ id: 'M001', objective: 'O001', start: '2026-09-28', status: 'Vigente', kcal: 2400, protein: 140, proteinMin: 135, proteinMax: 145, fat: 65, carbs: 313.75, strengthPerWeek: 3 }],
    plans: [
      { id: 'F001', legacyStart: '2026-09-15', session: 'A', exercise: 'Supino', start: '2026-09-15', end: '2026-09-27', status: 'Encerrada' },
      { id: 'F001', legacyStart: '2026-09-15', session: 'B', exercise: 'Agachamento', start: '2026-09-15', end: '2026-09-27', status: 'Encerrada' },
      { id: 'F002', legacyStart: '2026-09-28', session: 'A', exercise: 'Supino inclinado', start: '2026-09-28', status: 'Vigente' },
      { id: 'F002', legacyStart: '2026-09-28', session: 'B', exercise: 'Leg press', start: '2026-09-28', status: 'Vigente' },
    ],
    reviews: [],
  }, overrides);
}

const config = { 'client.sex': 'M', 'client.age': 24, 'client.heightCm': 179, 'client.startWeightKg': 67, 'client.reviewer': 'Revisor X' };
const setup = (tabs, cfg) => boot({ tabs: history(tabs), config: cfg === undefined ? config : cfg });
const snapshot = (ctx) => JSON.stringify([...ctx.__spreadsheet.sheets.entries()].map(([n, s]) => [n, s.rows]));
const keyOf = (ctx, v) => ctx.Dates.key(v);

test('on(date) resolves by date at the boundaries; null before the first version', () => {
  const ctx = setup();
  const id = (v) => (v ? v.id : null);
  assert.equal(id(ctx.Plans.on('2026-09-14')), null);
  assert.equal(id(ctx.Plans.on('2026-09-15')), 'F001');
  assert.equal(id(ctx.Plans.on('2026-09-27')), 'F001');
  assert.equal(id(ctx.Plans.on('2026-09-28')), 'F002');
  assert.equal(id(ctx.Plans.on('2031-01-01')), 'F002');
  assert.equal(id(ctx.Plans.on(day('2026-09-27'))), 'F001');
  assert.equal(id(ctx.Plans.on(null)), null);
  assert.equal(id(ctx.Objectives.on('2026-09-27')), null);
  assert.equal(id(ctx.Objectives.current()), 'O001');
  assert.equal(id(ctx.Goals.current()), 'M001');
  assert.equal(ctx.Plans.on('2026-09-28').rows.length, 2);
  eq(ctx.Plans.exercisesOn('2026-09-20').map((r) => r.exercise), ['Supino', 'Agachamento']);
});

test('list, latest, get and nextId', () => {
  const ctx = setup();
  eq(ctx.Plans.list().map((v) => v.id), ['F001', 'F002']);
  assert.equal(ctx.Plans.latest().id, 'F002');
  assert.equal(ctx.Plans.get('F001').rows.length, 2);
  assert.equal(ctx.Plans.get('F009'), null);
  assert.equal(ctx.Plans.nextId(), 'F003');
  assert.equal(ctx.Objectives.nextId(), 'O002');
  assert.equal(boot({ tabs: { goals: [] } }).Goals.nextId(), 'M001');
  eq(ctx.Plans.validate(), []);
  eq(ctx.Objectives.validate(), []);
  eq(ctx.Goals.validate(), []);
});

test('technical start dates are ignored by on() and reported by validate(); open() refuses until fixed', () => {
  const ctx = setup({
    goals: [{ id: 'M001', start: '2026-09-28', status: 'Vigente', kcal: 2400, protein: 140, fat: 65 }],
  });
  // Tabs never writes a technical date, so put the 3.0 value in the cell directly.
  ctx.__spreadsheet.getSheetByName('Metas').setCell_(6, ctx.Tabs.headerMap('goals').start, TECH);
  assert.equal(ctx.Goals.on('2026-09-28'), null);
  assert.equal(ctx.Goals.current(), null);
  eq(ctx.Goals.validate().map((p) => p.code), ['missing_start']);
  assert.match(ctx.Goals.validate()[0].message, /antes de 2000/);
  assert.throws(() => ctx.Goals.open({ kcal: 2300, protein: 140, fat: 60 }, '2026-10-05'), /M001 não tem data de início válida/);
});

test('open() closes the version in force on start−1 and opens the next (Vigente today)', () => {
  const ctx = setup();
  const r = plain(ctx.Objectives.open({ name: 'Déficit', analysisType: 'deficit' }, '2026-09-29'));
  assert.equal(r.id, 'O002');
  assert.equal(r.status, 'Vigente');
  assert.equal(r.closed.id, 'O001');
  assert.equal(r.closed.status, 'Encerrado');
  const [o1, o2] = ctx.Objectives.list();
  assert.equal(keyOf(ctx, o1.end), '2026-09-28');
  assert.equal(o1.status, 'Encerrado');
  assert.equal(keyOf(ctx, o2.start), '2026-09-29');
  assert.equal(o2.end, null);
  assert.equal(ctx.Objectives.on('2026-09-28').id, 'O001');
  assert.equal(ctx.Objectives.on('2026-09-29').id, 'O002');
  eq(ctx.Objectives.validate(), []);
});

test('open() with a future start: new version Planejado, previous stays Vigente until start−1', () => {
  const ctx = setup();
  ctx.Objectives.open({ name: 'Mini-cut', analysisType: 'deficit' }, '2026-10-05');
  const [o1, o2] = ctx.Objectives.list();
  assert.equal(o1.status, 'Vigente');
  assert.equal(keyOf(ctx, o1.end), '2026-10-04');
  assert.equal(o2.status, 'Planejado');
  assert.equal(ctx.Objectives.current().id, 'O001');
  assert.equal(ctx.Objectives.on('2026-10-05').id, 'O002');
  eq(ctx.Objectives.validate(), []);
});

test('back-dated versions are rejected and nothing is written', () => {
  const ctx = setup();
  const before = snapshot(ctx);
  assert.throws(() => ctx.Objectives.open({ name: 'X', analysisType: 'deficit' }, '2026-09-28'), /não é posterior ao início de O001 \(28\/09\/2026\)/);
  assert.throws(() => ctx.Objectives.open({ name: 'X', analysisType: 'deficit' }, '2026-09-01'), /O histórico só cresce para frente/);
  assert.throws(() => ctx.Objectives.open({ name: 'X' }, 'ontem'), /Início \(Objetivo\) inválida/);
  assert.equal(snapshot(ctx), before);
});

test('open() refuses a start that would leave a gap after a closed version', () => {
  const ctx = setup({ objectives: [{ id: 'O001', name: 'A', analysisType: 'recomposicao', start: '2026-09-01', end: '2026-09-20', status: 'Encerrado' }] });
  assert.throws(() => ctx.Objectives.open({ name: 'B', analysisType: 'deficit' }, '2026-09-29'), /intervalo sem versão/);
  const ok = ctx.Objectives.open({ name: 'B', analysisType: 'deficit' }, '2026-09-21');
  assert.equal(ok.closed.id, 'O001');
});

test('Goals.open derives carbs, tolerances and energy (TMB ≠ gasto ≠ meta) at creation', () => {
  const ctx = setup();
  ctx.Goals.open({ kcal: 2650, protein: 170, fat: 70, carbs: 1 }, '2026-10-05', { weightKg: 67 });
  const m2 = ctx.Goals.get('M002').fields;
  assert.equal(m2.carbs, 335, 'computed, typed value ignored');
  assert.equal(m2.kcalTolerance, 0.05);
  assert.equal(m2.fatTolerance, 0.15);
  assert.equal(m2.bmr, 1673.75);
  assert.equal(m2.bmrMethod, 'Mifflin-St Jeor');
  assert.equal(m2.activityFactor, 1.55);
  assert.equal(m2.tdee, 2594.31);
  assert.equal(m2.kcal, 2650);
  assert.equal(m2.status, 'Planejada');
  assert.equal(ctx.Goals.get('M001').fields.status, 'Vigente');
  const noProfile = setup({}, {});
  noProfile.Goals.open({ kcal: 2400, protein: 140 }, '2026-10-05');
  const g = noProfile.Goals.get('M002').fields;
  assert.equal(g.carbs, null, 'no fat → no carbs');
  assert.equal(g.bmr, null, 'incomplete profile → no TMB');
});

test('Plans.open writes every exercise row with the same id, dates and status; closes all rows of the previous', () => {
  const ctx = setup();
  const r = ctx.Plans.open([{ session: 'A', exercise: 'Supino reto' }, { session: 'B', exercise: 'Terra' }, { session: 'C', exercise: 'Remada' }], '2026-10-01');
  eq(r.rows, [10, 11, 12]);
  const v = ctx.Plans.get('F003');
  assert.equal(v.rows.length, 3);
  assert.ok(v.rows.every((row) => row.status === 'Planejada' && keyOf(ctx, row.start) === '2026-10-01' && keyOf(ctx, row.legacyStart) === '2026-10-01'));
  const f2 = ctx.Plans.get('F002');
  assert.ok(f2.rows.every((row) => keyOf(ctx, row.end) === '2026-09-30' && row.status === 'Vigente'));
  eq(ctx.Plans.validate(), []);
});

test('Plans.draftRows reads Ficha de treino as Fichas rows', () => {
  const ctx = setup({ planDraft: [
    { session: 'Upper', exercise: 'Supino', group: 'Peito', workSetsRegular: 2, repsMin: 6, repsMax: 10, planStatus: 'Confirmado', setTypes: '1 aquec + 2 work' },
    { session: 'Upper' },
  ] });
  eq(ctx.Plans.draftRows(), [{ session: 'Upper', exercise: 'Supino', group: 'Peito', workSetsRegular: 2, repsMin: 6, repsMax: 10, review: 'Confirmado', notes: '1 aquec + 2 work' }]);
});

test('validate() reports overlap, gap, several Vigente, inverted dates, inconsistent rows and id order', () => {
  const ctx = setup({
    objectives: [
      { id: 'O001', name: 'a', analysisType: 'deficit', start: '2026-01-01', end: '2026-02-10', status: 'Encerrado' },
      { id: 'O002', name: 'b', analysisType: 'deficit', start: '2026-02-01', end: '2026-03-01', status: 'Vigente' },
      { id: 'O004', name: 'c', analysisType: 'deficit', start: '2026-04-01', end: '2026-03-15', status: 'Encerrado' },
      { id: 'O003', name: 'd', analysisType: 'deficit', start: '2026-05-01', status: 'Vigente' },
    ],
    plans: [
      { id: 'F001', session: 'A', exercise: 'x', start: '2026-09-15', status: 'Vigente' },
      { id: 'F001', session: 'B', exercise: 'y', start: '2026-09-16', status: 'Vigente' },
    ],
  });
  const codes = plain(ctx.Objectives.validate().map((p) => `${p.code}:${p.id}`)).sort();
  assert.deepEqual(codes, ['end_before_start:O004', 'gap:O003', 'gap:O004', 'id_order:O003', 'multiple_current:O003', 'overlap:O002', 'status_mismatch:O002'].sort());
  eq(ctx.Plans.validate().map((p) => p.code), ['inconsistent_rows']);
});

test('refreshStatuses() rewrites statuses that no longer match the dates', () => {
  const ctx = setup({
    objectives: [
      { id: 'O001', name: 'a', analysisType: 'deficit', start: '2026-09-01', end: '2026-09-20', status: 'Vigente' },
      { id: 'O002', name: 'b', analysisType: 'deficit', start: '2026-09-21', status: 'Planejado' },
    ],
  });
  assert.equal(ctx.Objectives.refreshStatuses(), 2);
  eq(ctx.Objectives.list().map((v) => v.status), ['Encerrado', 'Vigente']);
  assert.equal(ctx.Objectives.refreshStatuses(), 0);
});

/* Transition ----------------------------------------------------------------------------------- */

const newObjective = { name: 'Ganho controlado', analysisType: 'ganho_controlado', weightRateMinPct: 0.1, weightRateMaxPct: 0.25 };

test('Transition.apply with goal and plan: closes and opens all three, links ids, writes Revisões, one action', () => {
  const ctx = setup();
  const r = plain(ctx.Transition.apply({
    date: '2026-09-29', objective: newObjective, goal: { kcal: 2650, protein: 150, fat: 70 },
    plan: [{ session: 'A', exercise: 'Supino' }], reason: 'Fim da recomposição',
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.before, { objective: 'O001', goal: 'M001', plan: 'F002' });
  assert.deepEqual(r.after, { objective: 'O002', goal: 'M002', plan: 'F003' });
  assert.deepEqual(r.closes, [
    { entity: 'objective', id: 'O001', end: '2026-09-28', status: 'Encerrado' },
    { entity: 'goal', id: 'M001', end: '2026-09-28', status: 'Encerrada' },
    { entity: 'plan', id: 'F002', end: '2026-09-28', status: 'Encerrada' },
  ]);
  const o2 = ctx.Objectives.get('O002').fields;
  assert.equal(o2.goal, 'M002');
  assert.equal(o2.plan, 'F003');
  assert.equal(o2.kcal, 2650, 'initial targets copied from the new goal');
  assert.equal(o2.carbs, (2650 - 600 - 630) / 4);
  assert.equal(o2.reason, 'Fim da recomposição');
  assert.equal(o2.reviewer, 'Revisor X');
  assert.equal(ctx.Goals.get('M002').fields.objective, 'O002');
  const [rev] = ctx.Tabs.read('reviews');
  assert.equal(rev.area, 'Objetivo/fase');
  assert.equal(rev.status, 'Aplicado');
  assert.equal(rev.change, 'Objetivo O001 → O002 (Ganho controlado); Meta M001 → M002; Ficha F002 → F003; a partir de 29/09/2026.');
  assert.equal(keyOf(ctx, rev.nextReview), '2026-10-06');
  assert.deepEqual([rev.objective, rev.goal, rev.plan], ['O002', 'M002', 'F003']);
  const actions = ctx.ChangeLog.actions();
  assert.equal(actions.length, 1);
  assert.equal(actions[0].label, 'Mudar objetivo/fase');
  assert.equal(new Set(actions[0].changes.map((c) => c.tab)).size, 4);
  ['Objectives', 'Goals', 'Plans'].forEach((n) => eq(ctx[n].validate(), [], n));
});

test('Transition.apply without goal/plan: they continue and the objective links them', () => {
  const ctx = setup();
  const r = plain(ctx.Transition.apply({ date: '2026-10-05', objective: newObjective, reason: 'Nova fase' }));
  assert.deepEqual(r.after, { objective: 'O002', goal: 'M001', plan: 'F002' });
  assert.equal(r.closes.length, 1);
  const o2 = ctx.Objectives.get('O002').fields;
  assert.equal(o2.goal, 'M001');
  assert.equal(o2.plan, 'F002');
  assert.equal(o2.kcal, 2400, 'targets from the goal in force');
  assert.equal(o2.status, 'Planejado');
  assert.equal(ctx.Goals.get('M001').fields.end, null, 'goal untouched');
  const [rev] = ctx.Tabs.read('reviews');
  assert.equal(rev.status, 'Planejado');
  assert.equal(rev.change, 'Objetivo O001 → O002 (Ganho controlado); Meta M001 mantida; Ficha F002 mantida; a partir de 05/10/2026.');
  // History is resolved by date: before the transition the old objective still applies.
  assert.equal(ctx.Objectives.on('2026-10-04').id, 'O001');
  assert.equal(ctx.Objectives.on('2026-10-05').id, 'O002');
});

test('Transition.preview computes the same result with no side effects', () => {
  const ctx = setup();
  const before = snapshot(ctx);
  const args = { date: '2026-09-29', objective: newObjective, goal: { kcal: 2650, protein: 150, fat: 70 }, reason: 'Fase nova' };
  const p = plain(ctx.Transition.preview(args));
  assert.equal(snapshot(ctx), before, 'no sheet changed');
  assert.equal(ctx.__spreadsheet.getSheetByName('Log'), null, 'nothing logged');
  assert.equal(ctx.__locks.length, 0, 'no lock taken');
  assert.equal(p.ok, true);
  assert.deepEqual(p.opens.map((o) => `${o.entity}:${o.id}:${o.status}`), ['objective:O002:Vigente', 'goal:M002:Vigente']);
  assert.equal(p.review.change, 'Objetivo O001 → O002 (Ganho controlado); Meta M001 → M002; Ficha F002 mantida; a partir de 29/09/2026.');
  const applied = plain(ctx.Transition.apply(args));
  delete applied.reviewRow;
  assert.deepEqual(applied, p);
});

test('preview reports errors; apply with the same args throws and writes nothing', () => {
  const ctx = setup();
  const before = snapshot(ctx);
  const bad = { date: '2026-09-28', objective: { name: '', analysisType: 'cutting' }, goal: { kcal: 'x', protein: 150 } };
  const p = plain(ctx.Transition.preview(bad));
  assert.equal(p.ok, false);
  assert.deepEqual(p.errors, [
    'Informe o motivo da mudança.',
    'Objetivo: informe o nome.',
    'Objetivo: tipo de análise inválido (cutting). Use: adaptacao, recomposicao, manutencao, deficit, ganho_controlado, ganho_agressivo, manutencao_pos_cut, performance, personalizado.',
    'Meta: kcal deve ser um número positivo.',
  ]);
  assert.throws(() => ctx.Transition.apply(bad), (err) => err.apiErrors.length === 4);
  const backDated = { date: '2026-09-28', objective: newObjective, reason: 'x' };
  assert.match(ctx.Transition.preview(backDated).errors[0], /O histórico só cresce para frente/);
  assert.throws(() => ctx.Transition.apply(backDated), /não é posterior/);
  assert.throws(() => ctx.Transition.apply({ date: '2026-10-01', reason: 'x' }), /Informe o novo objetivo/);
  assert.equal(snapshot(ctx), before);
});

test('transition.prepare listeners fill baseline values; phase.changed runs inside the action', () => {
  const ctx = setup({ diary: [] });
  const seen = [];
  ctx.Core.on('transition.prepare', (t) => { if (t.objective) t.objective.startWeightKg = 68.2; });
  ctx.Core.on('phase.changed', (e) => {
    seen.push(plain(e.after));
    ctx.Tabs.append('diary', { date: '2026-09-29', notes: 'semana reanalisada' });
  });
  ctx.Transition.apply({ date: '2026-09-29', objective: newObjective, reason: 'x' });
  assert.equal(ctx.Objectives.get('O002').fields.startWeightKg, 68.2);
  assert.deepEqual(seen, [{ objective: 'O002', goal: 'M001', plan: 'F002' }]);
  assert.equal(ctx.ChangeLog.actions().length, 1, 'listener write joined the action');
  assert.equal(ctx.ChangeLog.actions()[0].changes.length, 4, 'close O001, append O002, review, diary');
});

test('newGoal and newPlan are the same operation limited to one entity', () => {
  const ctx = setup();
  const g = plain(ctx.Transition.newGoal({ date: '2026-10-01', goal: { kcal: 2300, protein: 145, fat: 60 }, reason: 'Ajuste de energia' }));
  assert.deepEqual(g.after, { objective: 'O001', goal: 'M002', plan: 'F002' });
  assert.equal(ctx.Goals.get('M002').fields.objective, 'O001');
  assert.equal(ctx.Objectives.list().length, 1);
  const p = plain(ctx.Transition.newPlan({ date: '2026-10-01', plan: [{ session: 'A', exercise: 'Remada' }], reason: 'Troca de exercício', reviewer: 'Outro' }));
  assert.deepEqual(p.after, { objective: 'O001', goal: 'M002', plan: 'F003' });
  const reviews = ctx.Tabs.read('reviews');
  eq(reviews.map((r) => r.area), ['Metas', 'Ficha']);
  assert.equal(reviews[1].reviewer, 'Outro');
  eq(ctx.ChangeLog.actions().map((a) => a.label), ['Nova meta', 'Salvar nova ficha']);
  assert.equal(ctx.Transition.preview({ date: '2026-10-02', plan: [{ session: 'A', exercise: 'x' }], reason: 'y' }).area, 'Ficha');
});
