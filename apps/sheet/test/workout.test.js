'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');
const { sheets, WORKOUT_HEADERS } = require('./fixtures');

const col = (h) => WORKOUT_HEADERS.indexOf(h) + 1;
const day = (s) => new Date(`${s}T00:00:00`);

test('sessions and plan rows come from the plan tab', () => {
  const { WorkoutPlan } = load({ sheets: sheets() });
  assert.deepEqual(plain(WorkoutPlan.sessions()), ['Upper', 'Lower']);
  assert.equal(WorkoutPlan.planRows().length, 3);
});

test('prescription and prescribedSets follow the plan and phase', () => {
  const { WorkoutPlan } = load({ sheets: sheets() });
  const p = WorkoutPlan.prescription('Upper', 'Supino inclinado');
  assert.deepEqual(plain(p), { setsAdaptation: 2, setsRegular: 3, repsMin: 6, repsMax: 10 });
  assert.equal(WorkoutPlan.prescribedSets(p, 'Adaptação'), 2);
  assert.equal(WorkoutPlan.prescribedSets(p, 'Regular'), 3);
  assert.equal(WorkoutPlan.prescription('Upper', 'nope'), null);
  assert.equal(WorkoutPlan.currentPlanVersion(), 'F001');
});

test('saveSession appends one row per exercise with computed and prescribed columns', () => {
  const ctx = load({ sheets: sheets() });
  const r = ctx.WorkoutRepo.saveSession(day('2026-09-21'), {
    session: 'Upper', phase: 'Adaptação',
    exercises: [
      { name: 'Supino inclinado', sets: [{ kg: 60, reps: 8 }, { kg: 62, reps: 8 }, { kg: 60, reps: 7 }], rir: 2 },
      { name: 'Leg press', sets: [{ kg: 40, reps: 10 }], pain: 3, note: 'pegada supinada' },
    ],
  });
  assert.deepEqual(plain(r.rows), [6, 7]);
  assert.equal(r.sessionId, '2026-09-21/Upper');
  assert.deepEqual(plain(r.exercises[1]), { name: 'Leg press', row: 7, sets: [{ kg: 40, reps: 10 }], setsDone: 1, volume: 400, pain: 3, note: 'pegada supinada' });
  const sheet = ctx.__spreadsheet.getSheetByName('Registro de treino');
  const row6 = sheet.getRange(6, 1, 1, WORKOUT_HEADERS.length).getValues()[0];
  assert.equal(row6[col('Exercício') - 1], 'Supino inclinado');
  assert.equal(row6[col('kg série 1') - 1], 60);
  assert.equal(row6[col('Reps 3') - 1], 7);
  assert.equal(row6[col('kg série 4') - 1], '');
  assert.equal(row6[col('Séries feitas') - 1], 3);
  assert.equal(row6[col('Volume kg×reps') - 1], 60 * 8 + 62 * 8 + 60 * 7);
  assert.equal(row6[col('RIR final') - 1], 2);
  assert.equal(row6[col('Ficha') - 1], 'F001');
  assert.equal(row6[col('Séries prescritas') - 1], 2);
  assert.equal(row6[col('Reps mín') - 1], 6);
  assert.equal(row6[col('Reps máx') - 1], 10);
  assert.equal(row6[col('Fase') - 1], 'Adaptação');
  assert.equal(row6[col('ID sessão') - 1], '2026-09-21/Upper');
  const row7 = sheet.getRange(7, 1, 1, WORKOUT_HEADERS.length).getValues()[0];
  assert.equal(row7[col('Exercício') - 1], 'Leg press');
  assert.equal(row7[col('Séries prescritas') - 1], 2);
  assert.equal(row7[col('Dor 0–10') - 1], 3);
  assert.equal(row7[col('Técnica / adaptação') - 1], 'pegada supinada');
});

test('saveSession overwrites the same date+session+exercise instead of duplicating', () => {
  const ctx = load({ sheets: sheets() });
  const w = { session: 'Upper', exercises: [{ name: 'Supino inclinado', sets: [{ kg: 60, reps: 8 }] }] };
  ctx.WorkoutRepo.saveSession(day('2026-09-21'), w);
  w.exercises[0].sets = [{ kg: 60, reps: 8 }, { kg: 60, reps: 8 }];
  const r = ctx.WorkoutRepo.saveSession(day('2026-09-21'), w);
  assert.deepEqual(plain(r.rows), [6]);
  const sheet = ctx.__spreadsheet.getSheetByName('Registro de treino');
  assert.equal(sheet.getLastRow(), 6);
  assert.equal(sheet.getRange(6, col('Séries feitas')).getValue(), 2);
  assert.equal(sheet.getRange(6, col('Fase')).getValue(), 'Regular');
});

test('history returns one exercise newest first, capped by limit', () => {
  const ctx = load({ sheets: sheets() });
  ['2026-09-14', '2026-09-21', '2026-09-17'].forEach((d) => ctx.WorkoutRepo.saveSession(day(d), { session: 'Upper', exercises: [{ name: 'Supino inclinado', sets: [{ kg: 60, reps: 8 }] }] }));
  const rows = ctx.WorkoutRepo.history('Supino inclinado', 2);
  assert.deepEqual(rows.map((r) => r['Data'].getDate()), [21, 17]);
});
