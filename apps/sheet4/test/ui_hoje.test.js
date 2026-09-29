'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootDaily, cell, setCell, plain } = require('./daily_helpers');

const run = (ctx, fn) => ctx.ChangeLog.run('t', fn);

test('layout: the documented cell map, no cell used twice, texts for every label', () => {
  const ctx = bootDaily();
  const l = ctx.Hoje.layout();
  const sec = (id) => l.sections.find((s) => s.id === id);
  const cells = (id) => plain(sec(id).fields.map((f) => [f.key, f.cell]));
  assert.equal(ctx.Hoje.QUICK_CELL, 'B4');
  assert.deepEqual(cells('header'), [['quick', 'B4'], ['date', 'B5'], ['phase', 'B6'], ['dayState', 'B7']]);
  assert.deepEqual(cells('diary'), [
    ['weightKg', 'B10'], ['waistCm', 'B11'], ['sleepH', 'B12'], ['steps', 'B13'], ['cardioMin', 'B14'],
    ['activityMin', 'B15'], ['activity', 'B16'], ['hunger', 'B17'], ['fatigue', 'B18'], ['pain', 'B19'],
    ['foodLog', 'B20'], ['notes', 'B21'],
  ]);
  assert.deepEqual(cells('food'), [
    ['meal', 'B24'], ['food', 'B25'], ['qty', 'B26'], ['unit', 'B27'], ['measure', 'B28'], ['favorite', 'B29'],
    ['portions', 'B30'], ['copyFrom', 'B31'], ['copyMeal', 'B32'], ['noCalcText', 'B33'], ['note', 'B34'],
  ]);
  assert.deepEqual(cells('training'), [['session', 'B38'], ['phase', 'B39'], ['state', 'B40'], ['plan', 'B41']]);
  const t = sec('training').table;
  assert.deepEqual([t.headerRow, t.firstRow, t.rows], [43, 44, 12]);
  assert.deepEqual(plain(t.columns.map((c) => `${c.col} ${c.header}`)), [
    'A Exercício', 'B Aquec. kg', 'C Aquec. reps', 'D Feeder kg', 'E Feeder reps', 'F Work 1 kg', 'G Work 1 reps',
    'H RIR work 1', 'I Work 2 kg', 'J Work 2 reps', 'K RIR work 2', 'L Dor 0–10', 'M Observação',
  ]);
  const s = sec('status').table;
  assert.deepEqual(plain(s.indicators.map((i) => [i.key, i.row])), [['kcal', 60], ['protein', 61], ['carbs', 62], ['fat', 63], ['fiber', 64], ['steps', 65]]);
  assert.equal(cells('status')[0][1], 'B66');

  // no overlaps between fields, tables and texts
  const used = {};
  const mark = (a1, what) => { assert.ok(!used[a1], `${a1} used by ${used[a1]} and ${what}`); used[a1] = what; };
  l.sections.forEach((x) => {
    x.fields.forEach((f) => { mark(f.labelCell, `${f.key} label`); mark(f.cell, f.key); });
    if (x.titleCell) mark(x.titleCell, `${x.id} title`);
    Object.keys(x.hints || {}).forEach((a1) => mark(a1, 'hint'));
    if (x.table) {
      for (let r = x.table.headerRow; r < x.table.firstRow + x.table.rows; r++) x.table.columns.forEach((c) => mark(`${c.col}${r}`, `${x.id} table`));
    }
  });
  assert.ok(Object.keys(used).every((a1) => Number(a1.slice(1)) <= l.lastRow));
  // every input carries its validation description (dropdowns and ranges for Setup)
  const quick = sec('header').fields[0];
  assert.deepEqual(plain(quick.validation), { type: 'list', source: 'quickActions' });
  assert.deepEqual(plain(sec('diary').fields.find((f) => f.key === 'hunger').validation), { type: 'number', min: 1, max: 5, integer: true, allowInvalid: true });
  assert.deepEqual(plain(sec('diary').fields.find((f) => f.key === 'foodLog').validation), { type: 'list', values: ['Não informado', 'Parcial', 'Completo'] });
  // the bare tab carries the texts
  assert.equal(cell(ctx, 'A10'), 'Peso kg');
  assert.equal(cell(ctx, 'H43'), 'RIR work 1');
  assert.equal(cell(ctx, 'A58'), 'Meta × realizado do dia');
  assert.equal(cell(ctx, 'B4'), '—');
});

test('read: empty is null, comma decimals parse, "-" and "limpar" read as CLEAR only in the diary card', () => {
  const ctx = bootDaily();
  setCell(ctx, 'B5', '28/09/2026');
  setCell(ctx, 'B10', '67,4');
  setCell(ctx, 'B13', 0);
  setCell(ctx, 'B12', '-');
  setCell(ctx, 'B21', 'Limpar');
  setCell(ctx, 'B24', 'Almoço');
  setCell(ctx, 'B34', '-');
  const r = ctx.Hoje.read();
  assert.equal(ctx.Dates.key(r.date), '2026-09-28');
  assert.deepEqual([r.diary.weightKg, r.diary.steps, r.diary.sleepH, r.diary.notes, r.diary.hunger], [67.4, 0, ctx.Hoje.CLEAR, ctx.Hoje.CLEAR, null]);
  assert.deepEqual([r.food.meal, r.food.note, r.food.qty], ['Almoço', '-', null]);
  assert.deepEqual(plain(r.training.rows), []);
});

test('write/read the training table (Workout contract): rows from the top, rest emptied, 12 max', () => {
  const ctx = bootDaily();
  const rows = [
    { exercise: 'Supino inclinado', warmupKg: 20, warmupReps: 10, feederKg: 30, feederReps: 6, work1Kg: 40, work1Reps: 8, rir1: 1, work2Kg: 40, work2Reps: 7, rir2: 0, pain: 0, note: 'ok' },
    { exercise: 'Remada', work1Kg: 50, work1Reps: 10, rir1: 2 },
  ];
  ctx.Hoje.write('training', { session: 'Upper', phase: 'Regular', state: 'Parcial', plan: 'F002', rows });
  const t = ctx.Hoje.read().training;
  assert.deepEqual([t.session, t.phase, t.state, t.plan], ['Upper', 'Regular', 'Parcial', 'F002']);
  assert.deepEqual(plain(t.rows.map((r) => [r._index, r.exercise, r.work1Kg, r.rir1, r.work2Kg, r.rir2, r.pain])), [
    [0, 'Supino inclinado', 40, 1, 40, 0, 0],
    [1, 'Remada', 50, 2, null, null, null],
  ]);
  assert.equal(cell(ctx, 'F44'), 40);
  assert.equal(cell(ctx, 'H45'), 2);
  ctx.Hoje.write('training', [rows[1]]);
  assert.deepEqual(plain(ctx.Hoje.read().training.rows.map((r) => r.exercise)), ['Remada']);
  assert.equal(ctx.Hoje.read().training.session, 'Upper', 'an array replaces only the table');
  assert.throws(() => ctx.Hoje.write('training', new Array(13).fill({ exercise: 'x' })), /comporta 12 exercícios/);
  assert.throws(() => ctx.Hoje.write('training', [{ exercicio: 'x' }]), /Coluna desconhecida/);
  assert.throws(() => ctx.Hoje.write('food', { alimento: 'x' }), /Campo desconhecido em Hoje\/food: alimento/);
  ctx.Hoje.clear('training');
  const cleared = ctx.Hoje.read().training;
  assert.deepEqual([cleared.session, cleared.phase, cleared.state, cleared.rows.length], [null, null, 'Parcial', 0], 'script cells stay');
});

test('write/clear food card (Food contract)', () => {
  const ctx = bootDaily();
  ctx.Hoje.write('food', { meal: 'Jantar', food: 'Arroz', qty: 150, unit: 'g', measure: 'Pesada' });
  assert.deepEqual(plain(Object.entries(ctx.Hoje.read().food).filter(([, v]) => v !== null)),
    [['meal', 'Jantar'], ['food', 'Arroz'], ['qty', 150], ['unit', 'g'], ['measure', 'Pesada']]);
  ctx.Hoje.write('food', { qty: null });
  assert.equal(ctx.Hoje.read().food.qty, null);
  ctx.Hoje.clear('food');
  assert.ok(Object.values(ctx.Hoje.read().food).every((v) => v === null));
});

test('phase line resolves objective, goal and plan by date', () => {
  const ctx = bootDaily();
  assert.equal(ctx.Hoje.phaseLine('2026-09-29'), 'O001 Recomposição corporal · M001 · F002');
  assert.equal(ctx.Hoje.phaseLine('2026-09-20'), 'Sem objetivo · sem meta · F001');
  assert.equal(ctx.Hoje.phaseLine('2026-09-01'), 'Sem objetivo, meta ou ficha para esta data');
});

test('renderDayStatus: values written by the script, states of §4.5, meta by date', () => {
  const ctx = bootDaily({
    tabs: {
      diary: [
        { date: '2026-09-28', foodLog: 'Completo', kcal: 2350, protein: 150, carbs: 300, fat: 80, fiber: 20, steps: 8000, noCalcItems: 0 },
        { date: '2026-09-29', kcal: 900, protein: 60, steps: 0 },
      ],
    },
  });
  const s = ctx.Hoje.renderDayStatus('2026-09-28');
  assert.deepEqual(plain(s.rows.map((r) => [r.key, r.done, r.goal, r.comparison, r.status])), [
    ['kcal', 2350, 2400, '2350 / 2400 (−2%)', 'Dentro da meta'],
    ['protein', 150, 140, '150 / 140 (+7%) · faixa 135–145', 'Acima da meta'],
    ['carbs', 300, 313.8, '300 / 314 (−4%)', 'Dentro da meta'],
    ['fat', 80, 65, '80 / 65 (+23%)', 'Acima da meta'],
    ['fiber', 20, 30, '20 / 30 (−33%)', 'Abaixo da meta'],
    ['steps', 8000, 8000, '8000 / 8000 (0%)', 'Dentro da meta'],
  ]);
  assert.deepEqual([cell(ctx, 'B60'), cell(ctx, 'C60'), cell(ctx, 'E61'), cell(ctx, 'B7')], [2350, 2400, 'Acima da meta', 'Completo']);
  assert.equal(cell(ctx, 'B66'), 'Registro alimentar: Completo · meta M001');
  assert.equal(ctx.SpreadsheetApp.getActive().getSheetByName('Hoje').getRange('B60').getFormula(), '', 'values, not formulas');

  const p = ctx.Hoje.renderDayStatus('2026-09-29');
  assert.deepEqual(plain(p.rows.map((r) => [r.key, r.status])), [
    ['kcal', 'Parcial'], ['protein', 'Parcial'], ['carbs', 'Não informado'], ['fat', 'Não informado'], ['fiber', 'Não informado'], ['steps', 'Abaixo da meta'],
  ]);
  assert.equal(cell(ctx, 'D63'), '', 'unknown fat shows no comparison, never 0');
  assert.equal(cell(ctx, 'B63'), '');

  const n = ctx.Hoje.dayStatus('2026-09-27');
  assert.equal(n.state, 'Sem registro');
  assert.deepEqual(plain(n.rows.map((r) => r.status)), ['Sem registro', 'Sem registro', 'Sem registro', 'Sem registro', 'Sem registro', 'Não informado']);
  assert.equal(n.coverage, 'Registro alimentar: Não informado · sem meta vigente nesta data');
});

test('renderDayStatus: cálculo parcial and the goal of a later phase', () => {
  const ctx = bootDaily({
    tabs: { diary: [{ date: '2026-09-29', foodLog: 'Completo', kcal: 2600, protein: 150, noCalcItems: 2, estimatedItems: 1 }] },
  });
  ctx.Transition.newGoal({ date: '2026-09-29', goal: { kcal: 2600, protein: 150, fat: 70 }, reason: 'Ajuste' });
  const s = ctx.Hoje.dayStatus('2026-09-29');
  assert.equal(s.state, 'Completo — cálculo parcial');
  assert.deepEqual(plain(s.rows.slice(0, 2).map((r) => [r.goal, r.status])), [[2600, 'Completo — cálculo parcial'], [150, 'Completo — cálculo parcial']]);
  assert.equal(s.coverage, 'Registro alimentar: Completo · 2 itens sem cálculo · 1 item estimado · meta M002');
  assert.equal(ctx.Hoje.dayStatus('2026-09-28').rows[0].goal, 2400, 'the day before keeps M001');
});

test('screen writes are not part of the undoable action', () => {
  const ctx = bootDaily();
  run(ctx, () => ctx.Hoje.write('diary', { weightKg: 70 }));
  assert.equal(ctx.ChangeLog.actions().length, 0);
});
