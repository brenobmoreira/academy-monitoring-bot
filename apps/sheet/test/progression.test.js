'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');
const { sheets, PROGRESSION_HEADERS } = require('./fixtures');

const day = (s) => new Date(`${s}T00:00:00`);
const col = (h) => PROGRESSION_HEADERS.indexOf(h) + 1;

test('refresh lists the selected exercise newest first with sets, volume and RIR', () => {
  const ctx = load({ sheets: sheets() });
  const w = { session: 'Upper', exercises: [{ name: 'Supino inclinado', sets: [{ kg: 60, reps: 8 }], rir: 3 }] };
  ctx.WorkoutRepo.saveSession(day('2026-09-14'), w);
  ctx.WorkoutRepo.saveSession(day('2026-09-21'), { session: 'Upper', exercises: [{ name: 'Supino inclinado', sets: [{ kg: 62, reps: 8 }, { kg: 62, reps: 7 }], rir: 2 }] });
  ctx.WorkoutRepo.saveSession(day('2026-09-18'), { session: 'Lower', exercises: [{ name: 'Leg press', sets: [{ kg: 100, reps: 10 }] }] });
  const r = ctx.Progression.refresh();
  assert.deepEqual({ ...r }, { exercise: 'Supino inclinado', sessions: 2 });
  const p = ctx.__spreadsheet.getSheetByName('Progressão');
  assert.equal(p.getRange(10, col('Data')).getValue().getTime(), day('2026-09-21').getTime());
  assert.equal(p.getRange(10, col('kg 2')).getValue(), 62);
  assert.equal(p.getRange(10, col('Volume')).getValue(), 62 * 15);
  assert.equal(p.getRange(10, col('Séries válidas')).getValue(), 2);
  assert.equal(p.getRange(10, col('RIR final')).getValue(), 2);
  assert.equal(p.getRange(10, col('Ficha')).getValue(), 'F001');
  assert.equal(p.getRange(11, col('Data')).getValue().getTime(), day('2026-09-14').getTime());
  assert.equal(p.getRange(12, col('Data')).getValue(), '');
});

test('refresh clears stale rows and needs a picked exercise', () => {
  const ctx = load({ sheets: sheets() });
  const p = ctx.__spreadsheet.getSheetByName('Progressão');
  p.getRange(15, 1).setValue('stale');
  ctx.Progression.refresh();
  assert.equal(p.getRange(15, 1).getValue(), '');
  p.getRange('B5').setValue('');
  assert.throws(() => ctx.Progression.refresh(), /Selecione o exercício/);
});
