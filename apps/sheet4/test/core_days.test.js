'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, plain } = require('./core_helpers');

const tabs = () => ({
  objectives: [
    { id: 'O001', name: 'Recomposição corporal', analysisType: 'recomposicao', start: '2026-09-28', end: '2026-10-04', status: 'Encerrado' },
    { id: 'O002', name: 'Ganho de massa controlado', analysisType: 'ganho_controlado', start: '2026-10-05', status: 'Planejado' },
  ],
  goals: [{ id: 'M001', objective: 'O001', start: '2026-09-28', status: 'Vigente', kcal: 2400, protein: 140, fat: 65, carbs: 313.75 }],
  plans: [{ id: 'F002', legacyStart: '2026-09-28', session: 'Upper', exercise: 'Supino', start: '2026-09-28', status: 'Vigente' }],
  diary: [],
});

test('patch creates the day row with the ids in force on that date, not today', () => {
  const ctx = boot({ tabs: tabs() });
  ctx.ChangeLog.run('t', () => {
    ctx.Days.patch('2026-10-06', { weightKg: 68 });
    ctx.Days.patch('2026-09-30', { weightKg: 67.2, steps: 0 });
  });
  const rows = plain(ctx.Tabs.read('diary').map((r) => [ctx.Dates.key(r.date), r.weightKg, r.steps, r.objective, r.goal, r.plan]));
  assert.deepEqual(rows, [
    ['2026-10-06', 68, null, 'O002', 'M001', 'F002'],
    ['2026-09-30', 67.2, 0, 'O001', 'M001', 'F002'],
  ]);
});

test('patch updates only the given keys; null clears to não informado; owned keys are refused', () => {
  const ctx = boot({ tabs: tabs() });
  ctx.ChangeLog.run('t', () => ctx.Days.patch('2026-09-30', { weightKg: 67.2, sleepH: 7 }));
  ctx.ChangeLog.run('t', () => ctx.Days.patch('2026-09-30', { sleepH: null, kcal: 2300 }));
  const r = ctx.Days.get('2026-09-30');
  assert.deepEqual([r.weightKg, r.sleepH, r.kcal], [67.2, null, 2300]);
  assert.throws(() => ctx.Days.patch('2026-09-30', { objective: 'O009' }), /controlados pelo sistema/);
});

test('restampAll fixes ids after history changes', () => {
  const ctx = boot({ tabs: Object.assign(tabs(), { diary: [{ date: '2026-10-06', weightKg: 68, objective: 'O001' }] }) });
  assert.equal(ctx.ChangeLog.run('t', () => ctx.Days.restampAll()), 1);
  assert.equal(ctx.Days.get('2026-10-06').objective, 'O002');
});
