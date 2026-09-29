'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootDaily, setCell, plain } = require('./daily_helpers');

const run = (ctx, fn) => ctx.ChangeLog.run('t', fn);
const newObjective = { name: 'Ganho de massa controlado', analysisType: 'ganho_controlado' };
const ids = (ctx) => plain(ctx.Measures.list().map((r) => [ctx.Dates.key(r.date), r.objective]));

test('save upserts by date and stamps the objective in force on that date across a transition', () => {
  const ctx = bootDaily();
  run(ctx, () => ctx.Measures.save('2026-09-27', { waistCm: 81, notes: 'Antes do O001' }));
  run(ctx, () => ctx.Measures.save('2026-09-28', { waistCm: '80,5', photoFront: 'https://exemplo/f.jpg' }));
  run(ctx, () => ctx.Measures.save('2026-09-29', { waistCm: 80 }));
  assert.deepEqual(ids(ctx), [['2026-09-27', null], ['2026-09-28', 'O001'], ['2026-09-29', 'O001']]);

  ctx.Transition.apply({ date: '2026-09-29', objective: newObjective, reason: 'Nova fase' });
  assert.deepEqual(ids(ctx), [['2026-09-27', null], ['2026-09-28', 'O001'], ['2026-09-29', 'O002']], 'restamped from the change date on');

  run(ctx, () => ctx.Measures.save('2026-09-28', { hipCm: 95, photoFront: null }));
  const r = ctx.Measures.on('2026-09-28');
  assert.deepEqual([r.waistCm, r.hipCm, r.photoFront, r.objective], [80.5, 95, null, 'O001']);
  assert.equal(ctx.Measures.list().length, 3);
});

test('save refuses zero and out-of-range circumferences and future dates', () => {
  const ctx = bootDaily();
  assert.throws(() => run(ctx, () => ctx.Measures.save('2026-09-29', { waistCm: 0 })), /Cintura umbigo cm: 0 fora da faixa/);
  assert.throws(() => run(ctx, () => ctx.Measures.save('2026-10-01', { waistCm: 80 })), /Data no futuro/);
  assert.throws(() => run(ctx, () => ctx.Measures.save('2026-09-29', { weightKg: 80 })), /Campo de medidas desconhecido/);
  assert.equal(ctx.Measures.list().length, 0);
});

test('waist: Diário wins on the same day, Medidas counts when Diário has none', () => {
  const ctx = bootDaily({
    tabs: {
      diary: [{ date: '2026-09-20', waistCm: 82 }, { date: '2026-09-22', weightKg: 67 }, { date: '2026-09-27', waistCm: 80.5 }],
      measures: [{ date: '2026-09-20', waistCm: 83 }, { date: '2026-09-22', waistCm: 81.5 }, { date: '2026-09-25', hipCm: 95 }],
    },
  });
  assert.equal(ctx.Measures.waistOn('2026-09-20'), 82);
  assert.equal(ctx.Measures.waistOn('2026-09-22'), 81.5);
  assert.equal(ctx.Measures.waistOn('2026-09-25'), null, 'a Medidas row without waist is not a waist');
  assert.equal(ctx.Measures.waistOn('2026-09-26'), null);
  const latest = (d) => { const w = ctx.Measures.latestWaist(d); return w ? [ctx.Dates.key(w.date), w.waistCm, w.source] : null; };
  assert.deepEqual(plain(latest('2026-09-26')), ['2026-09-22', 81.5, 'Medidas']);
  assert.deepEqual(plain(latest('2026-09-29')), ['2026-09-27', 80.5, 'Diário']);
  assert.deepEqual(plain(latest(null)), ['2026-09-27', 80.5, 'Diário']);
  assert.equal(latest('2026-09-19'), null);
  assert.deepEqual(plain(ctx.Measures.waistSeries('2026-09-21', '2026-09-27').map((w) => [ctx.Dates.key(w.date), w.waistCm])),
    [['2026-09-22', 81.5], ['2026-09-27', 80.5]]);
});

test('a row typed directly on Medidas e fotos gets its Objetivo from the onEdit trigger', () => {
  const ctx = bootDaily();
  const sheet = ctx.SpreadsheetApp.getActive().getSheetByName('Medidas e fotos');
  setCell(ctx, 'B6', 79.5, 'Medidas e fotos');
  ctx.__simulateEdit('Medidas e fotos', 'A6', '28/09/2026');
  assert.equal(ctx.Measures.on('2026-09-28').objective, 'O001');
  ctx.__simulateEdit('Medidas e fotos', 'A6', '20/09/2026');
  assert.equal(ctx.Measures.on('2026-09-20').objective, null, 'no objective before O001');
  ctx.__simulateEdit('Medidas e fotos', 'A3', 'ajuda');
  assert.equal(sheet.getRange('A3').getValue(), 'ajuda', 'edits above the data are ignored');
  assert.equal(ctx.Measures.restampAll(), 0);
});
