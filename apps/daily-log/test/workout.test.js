'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');
const { sheets, WORKOUT_HEADERS } = require('./fixtures');

const col = (h) => WORKOUT_HEADERS.indexOf(h) + 1;
const day = (s) => new Date(`${s}T00:00:00`);

test('resolveExercise matches ignoring accents and case, and unique partials', () => {
  const { WorkoutPlan } = load({ sheets: sheets() });
  assert.deepEqual(plain(WorkoutPlan.resolveExercise('supino INCLINADO')), { name: 'Supino inclinado', known: true });
  assert.deepEqual(plain(WorkoutPlan.resolveExercise('puxada')), { name: 'Puxada aberta', known: true });
  assert.deepEqual(plain(WorkoutPlan.resolveExercise('remada curvada')), { name: 'remada curvada', known: false });
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
      { name: 'supino inclinado', sets: [{ kg: 60, reps: 8 }, { kg: 62, reps: 8 }, { kg: 60, reps: 7 }], rir: 2 },
      { name: 'remada curvada', sets: [{ kg: 40, reps: 10 }], pain: 3, note: 'pegada supinada' },
    ],
  });
  assert.deepEqual(plain(r.rows), [6, 7]);
  assert.equal(r.exercises[0].known, true);
  assert.equal(r.exercises[1].known, false);
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
  assert.equal(row7[col('Exercício') - 1], 'remada curvada');
  assert.equal(row7[col('Séries prescritas') - 1], '');
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

test('saveSession validates its input', () => {
  const { WorkoutRepo } = load({ sheets: sheets() });
  assert.throws(() => WorkoutRepo.saveSession(day('2026-09-21'), { exercises: [{ name: 'x' }] }), /session is required/);
  assert.throws(() => WorkoutRepo.saveSession(day('2026-09-21'), { session: 'Upper', exercises: [] }), /exercises is empty/);
});
