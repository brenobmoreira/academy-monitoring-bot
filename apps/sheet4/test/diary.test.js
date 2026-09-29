'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootDaily, dayRow, plain } = require('./daily_helpers');

const KEYS = ['weightKg', 'sleepH', 'steps', 'cardioMin', 'hunger', 'foodLog', 'notes', 'objective', 'goal', 'plan', 'dayState'];
const run = (ctx, fn) => ctx.ChangeLog.run('t', fn);
const newObjective = { name: 'Ganho de massa controlado', analysisType: 'ganho_controlado' };

test('save: absent keys are untouched, null clears, 0 stays zero, text numbers with comma parse', () => {
  const ctx = bootDaily();
  run(ctx, () => ctx.Diary.save('2026-09-29', { weightKg: '67,5', steps: 0, sleepH: 7, cardioMin: 0 }));
  assert.deepEqual(dayRow(ctx, '2026-09-29', KEYS), {
    weightKg: 67.5, sleepH: 7, steps: 0, cardioMin: 0, hunger: null, foodLog: null, notes: null,
    objective: 'O001', goal: 'M001', plan: 'F002', dayState: 'Sem registro',
  });
  const r = run(ctx, () => ctx.Diary.save('2026-09-29', { sleepH: null, hunger: 3, weightKg: 67.5 }));
  assert.deepEqual(plain(r.changed), ['sleepH', 'hunger'], 'unchanged weight is not rewritten');
  const row = dayRow(ctx, '2026-09-29', KEYS);
  assert.deepEqual([row.weightKg, row.sleepH, row.steps, row.hunger], [67.5, null, 0, 3]);
});

test('save refuses invalid values, future dates and system keys; nothing is written on error', () => {
  const ctx = bootDaily();
  assert.throws(() => run(ctx, () => ctx.Diary.save('2026-09-29', { hunger: 6 })), /Fome 1–5: 6 fora da faixa 1–5/);
  assert.throws(() => run(ctx, () => ctx.Diary.save('2026-09-29', { steps: 10.5 })), /Passos: use um número inteiro/);
  assert.throws(() => run(ctx, () => ctx.Diary.save('2026-09-29', { weightKg: 'abc' })), /Peso kg: valor inválido/);
  assert.throws(() => run(ctx, () => ctx.Diary.save('2026-09-29', { foodLog: 'Tudo' })), /Registro alimentar: use Não informado, Parcial, Completo/);
  assert.throws(() => run(ctx, () => ctx.Diary.save('2026-09-30', { weightKg: 67 })), /Data no futuro: 30\/09\/2026/);
  assert.throws(() => run(ctx, () => ctx.Diary.save('2026-09-29', { objective: 'O009' })), /Campo do dia desconhecido/);
  assert.equal(ctx.Days.get('2026-09-29'), null);
});

test('save with only clears does not create an empty day row', () => {
  const ctx = bootDaily();
  const r = run(ctx, () => ctx.Diary.save('2026-09-29', { weightKg: null }));
  assert.equal(r.row, null);
  assert.equal(ctx.Tabs.read('diary').length, 0);
});

test('dayState: Sem registro | Parcial | Completo | Completo — cálculo parcial', () => {
  const ctx = bootDaily({
    tabs: {
      diary: [
        { date: '2026-09-20', weightKg: 67 },
        { date: '2026-09-21', kcal: 1200 },
        { date: '2026-09-22', foodLog: 'Parcial' },
        { date: '2026-09-23', foodLog: 'Completo', kcal: 2350, noCalcItems: 0 },
        { date: '2026-09-24', foodLog: 'Completo', kcal: 2100, noCalcItems: 2 },
        { date: '2026-09-25', foodLog: 'Não informado', noCalcItems: 1 },
        { date: '2026-09-26', foodLog: 'Não informado' },
      ],
    },
  });
  const states = ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26']
    .map((d) => ctx.Diary.dayState(d));
  assert.deepEqual(plain(states), ['Sem registro', 'Sem registro', 'Parcial', 'Parcial', 'Completo', 'Completo — cálculo parcial', 'Parcial', 'Sem registro']);
  assert.equal(run(ctx, () => ctx.Diary.refreshAllStates()), 7, 'every existing row gets its stored state');
  assert.equal(run(ctx, () => ctx.Diary.refreshAllStates()), 0);
  assert.equal(ctx.Days.get('2026-09-24').dayState, 'Completo — cálculo parcial');
  assert.equal(ctx.Days.get('2026-09-20').dayState, 'Sem registro');
});

test('Food flow: totals patched then refreshState moves the day from Parcial to Completo', () => {
  const ctx = bootDaily();
  run(ctx, () => { ctx.Days.patch('2026-09-29', { kcal: 800, protein: 50 }); ctx.Diary.refreshState('2026-09-29'); });
  assert.equal(ctx.Days.get('2026-09-29').dayState, 'Parcial');
  run(ctx, () => ctx.Diary.save('2026-09-29', { foodLog: 'Completo' }));
  assert.equal(ctx.Days.get('2026-09-29').dayState, 'Completo');
});

test('transition.prepare fills Peso inicial (7-day average before the start) and Cintura inicial (latest waist)', () => {
  const ctx = bootDaily({
    tabs: {
      diary: [
        { date: '2026-09-21', weightKg: 60 },
        { date: '2026-09-22', weightKg: 67 },
        { date: '2026-09-25', weightKg: 67.4, waistCm: 81 },
        { date: '2026-09-28', weightKg: 67.8 },
        { date: '2026-09-29', weightKg: 70 },
      ],
      measures: [{ date: '2026-09-27', waistCm: 80 }, { date: '2026-09-29', hipCm: 95 }],
    },
  });
  ctx.Transition.apply({ date: '2026-09-29', objective: newObjective, reason: 'Nova fase' });
  const o = ctx.Objectives.get('O002').fields;
  assert.deepEqual([o.startWeightKg, o.startWaistCm], [67.4, 80]);
});

test('transition.prepare: fallback to the latest weigh-in; Diário waist wins on the same day; given values kept', () => {
  const ctx = bootDaily({
    tabs: {
      diary: [{ date: '2026-09-10', weightKg: 66.1, waistCm: 79 }],
      measures: [{ date: '2026-09-10', waistCm: 80 }],
    },
  });
  ctx.Transition.apply({ date: '2026-09-29', objective: newObjective, reason: 'x' });
  const o = ctx.Objectives.get('O002').fields;
  assert.deepEqual([o.startWeightKg, o.startWaistCm], [66.1, 79]);

  const ctx2 = bootDaily({ tabs: { diary: [{ date: '2026-09-28', weightKg: 66 }] } });
  ctx2.Transition.apply({ date: '2026-09-29', objective: Object.assign({ startWeightKg: 65, startWaistCm: 78 }, newObjective), reason: 'x' });
  const o2 = ctx2.Objectives.get('O002').fields;
  assert.deepEqual([o2.startWeightKg, o2.startWaistCm], [65, 78]);

  const ctx3 = bootDaily();
  ctx3.Transition.apply({ date: '2026-09-29', objective: newObjective, reason: 'x' });
  const o3 = ctx3.Objectives.get('O002').fields;
  assert.deepEqual([o3.startWeightKg, o3.startWaistCm], [null, null], 'no data: left empty, never guessed');
});

test('phase.changed re-stamps days on or after the change inside the transition action; undo restores', () => {
  const ctx = bootDaily();
  run(ctx, () => { ctx.Diary.save('2026-09-28', { weightKg: 67 }); });
  run(ctx, () => { ctx.Diary.save('2026-09-29', { weightKg: 67.2 }); });
  assert.equal(ctx.Days.get('2026-09-29').objective, 'O001');
  ctx.Transition.apply({ date: '2026-09-29', objective: newObjective, reason: 'x' });
  assert.deepEqual([ctx.Days.get('2026-09-28').objective, ctx.Days.get('2026-09-29').objective], ['O001', 'O002']);
  ctx.Undo.last();
  assert.equal(ctx.Days.get('2026-09-29').objective, 'O001');
  assert.equal(ctx.Objectives.list().length, 1);
});

test('baselineWeight rounds to 2 decimals and uses analysis.weightTrendDays', () => {
  const ctx = bootDaily({
    config: { 'analysis.weightTrendDays': 3 },
    tabs: { diary: [{ date: '2026-09-25', weightKg: 60 }, { date: '2026-09-26', weightKg: 67.1 }, { date: '2026-09-28', weightKg: 67.2 }] },
  });
  assert.equal(ctx.Diary.baselineWeight('2026-09-29'), 67.15);
});
