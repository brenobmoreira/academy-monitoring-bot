'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');
const { sheets, DIARY_HEADERS, WORKOUT_HEADERS } = require('./fixtures');

const NOW = '2026-09-21T15:00:00-03:00';
const props = { SHEET_API_KEY: 'k' };
const boot = (opts = {}) => load({ sheets: sheets(opts), properties: props, now: NOW });
const call = (ctx, body) => {
  const out = ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
  assert.equal(out.mimeType, 'json');
  return JSON.parse(out.text);
};
const req = (op, args) => ({ key: 'k', op, args });
const codes = (res) => res.errors.map((e) => `${e.path}:${e.code}`);
const diaryCell = (ctx, row, h) => ctx.__spreadsheet.getSheetByName('Diário').getRange(row, DIARY_HEADERS.indexOf(h) + 1).getValue();
const workoutCell = (ctx, row, h) => ctx.__spreadsheet.getSheetByName('Registro de treino').getRange(row, WORKOUT_HEADERS.indexOf(h) + 1).getValue();

test('rejects a wrong or missing key before doing anything', () => {
  const ctx = boot();
  assert.deepEqual(codes(call(ctx, { key: 'x', op: 'catalog', args: {} })), ['key:unauthorized']);
  assert.deepEqual(codes(call(ctx, { op: 'catalog', args: {} })), ['key:unauthorized']);
});

test('reports malformed envelopes: bad JSON, unknown op, unknown field', () => {
  const ctx = boot();
  assert.deepEqual(codes(call(ctx, '{nope')), ['body:invalid_json']);
  assert.deepEqual(codes(call(ctx, req('diary.delete', {}))), ['op:unknown_op']);
  assert.deepEqual(codes(call(ctx, { ...req('catalog', {}), extra: 1 })), ['extra:unknown_field']);
  assert.match(call(ctx, req('nope', {})).errors[0].message, /catalog, diary\.upsert, workout\.upsert, write\.undo, exercise\.history, diary\.range, workout\.range/);
});

test('catalog lists today, sessions, exercises, plan and the current phase', () => {
  const hoje = Array.from({ length: 23 }, () => []); hoje[22] = ['Sessão', 'Upper', '', 'Fase', 'Adaptação'];
  const res = call(boot({ hoje }), req('catalog', {}));
  assert.equal(res.ok, true);
  assert.equal(res.result.today, '2026-09-21');
  assert.equal(res.result.timezone, 'America/Sao_Paulo');
  assert.equal(res.result.phase, 'Adaptação');
  assert.deepEqual(res.result.sessions, ['Upper', 'Lower']);
  assert.deepEqual(res.result.exercises[0], { name: 'Supino inclinado', group: 'Peito' });
  assert.deepEqual(res.result.plan[0], { session: 'Upper', exercise: 'Supino inclinado', setsAdaptation: 2, setsRegular: 3, repsMin: 6, repsMax: 10 });
});

test('diary.upsert writes and echoes exactly the stored fields', () => {
  const ctx = boot();
  const res = call(ctx, req('diary.upsert', { date: '2026-09-21', fields: { weightKg: 82.4, muayThai: true } }));
  const { writeId, ...result } = res.result;
  assert.deepEqual(result, { date: '2026-09-21', row: 6, fields: { weightKg: 82.4, muayThai: true } });
  assert.match(writeId, /^[0-9a-z]{1,20}$/);
  assert.equal(diaryCell(ctx, 6, 'Peso kg'), 82.4);
  assert.equal(diaryCell(ctx, 6, 'Muay Thai'), 'Sim');
});

test('diary.upsert writes nothing when any field is invalid', () => {
  const ctx = boot();
  const res = call(ctx, req('diary.upsert', { date: '2026-09-21', fields: { weightKg: 82.4, sleepH: '7h' } }));
  assert.equal(res.ok, false);
  assert.deepEqual(codes(res), ['args.fields.sleepH:wrong_type']);
  assert.equal(ctx.__spreadsheet.getSheetByName('Diário').getLastRow(), 5);
});

test('workout.upsert fills prescription columns and returns rows per exercise', () => {
  const hoje = Array.from({ length: 23 }, () => []); hoje[22] = ['Sessão', '', '', 'Fase', 'Adaptação'];
  const ctx = boot({ hoje });
  const res = call(ctx, req('workout.upsert', { date: '2026-09-21', session: 'Upper', exercises: [
    { name: 'Supino inclinado', sets: [{ kg: 60, reps: 8 }, { kg: 62.5, reps: 8 }], rir: 2 },
  ] }));
  const { writeId, ...result } = res.result;
  assert.match(writeId, /^[0-9a-z]{1,20}$/);
  assert.deepEqual(result, {
    date: '2026-09-21', session: 'Upper', phase: 'Adaptação', sessionId: '2026-09-21/Upper',
    exercises: [{ name: 'Supino inclinado', row: 6, sets: [{ kg: 60, reps: 8 }, { kg: 62.5, reps: 8 }], setsDone: 2, volume: 980, rir: 2, previous: null }],
  });
  assert.equal(workoutCell(ctx, 6, 'Séries prescritas'), 2);
  assert.equal(workoutCell(ctx, 6, 'Fase'), 'Adaptação');
});

test('workout.upsert rejects names outside the catalogue with suggestions and writes nothing', () => {
  const ctx = boot();
  const res = call(ctx, req('workout.upsert', { date: '2026-09-21', session: 'Upper', exercises: [
    { name: 'Supino inclinado', sets: [{ kg: 60, reps: 8 }] },
    { name: 'puxada', sets: [{ kg: 50, reps: 10 }] },
  ] }));
  assert.deepEqual(codes(res), ['args.exercises[1].name:not_in_catalog']);
  assert.deepEqual(res.errors[0].suggestions, ['Puxada aberta']);
  assert.equal(ctx.__spreadsheet.getSheetByName('Registro de treino').getLastRow(), 5);
});

test('exercise.history returns the latest sessions of one exercise, newest first', () => {
  const ctx = boot();
  const save = (date, kg) => call(ctx, req('workout.upsert', { date, session: 'Upper', exercises: [{ name: 'Supino inclinado', sets: [{ kg, reps: 8 }], rir: 2 }] }));
  save('2026-09-14', 58); save('2026-09-21', 60); save('2026-09-17', 59);
  call(ctx, req('workout.upsert', { date: '2026-09-18', session: 'Lower', exercises: [{ name: 'Leg press', sets: [{ kg: 100, reps: 10 }] }] }));
  const res = call(ctx, req('exercise.history', { name: 'Supino inclinado', limit: 2 }));
  assert.deepEqual(res.result, { name: 'Supino inclinado', sessions: [
    { date: '2026-09-21', session: 'Upper', sets: [{ kg: 60, reps: 8 }], setsDone: 1, volume: 480, rir: 2, pain: null },
    { date: '2026-09-17', session: 'Upper', sets: [{ kg: 59, reps: 8 }], setsDone: 1, volume: 472, rir: 2, pain: null },
  ] });
});

test('diary.range returns only the days with data, oldest first, with cells read back', () => {
  const ctx = boot();
  const diary = ctx.__spreadsheet.getSheetByName('Diário');
  call(ctx, req('diary.upsert', { date: '2026-09-21', fields: { weightKg: 82.4, muayThai: false, notes: 'ok' } }));
  call(ctx, req('diary.upsert', { date: '2026-09-10', fields: { weightKg: 83, sleepH: 7.5, dietComplete: true } }));
  call(ctx, req('diary.upsert', { date: '2026-09-01', fields: { steps: 8000 } }));
  diary.setCell_(9, 1, new ctx.Date('2026-09-15T00:00:00')); // dated row with nothing filled in
  ctx.__locks.length = 0;
  const res = call(ctx, req('diary.range', { from: '2026-09-05', to: '2026-09-27' }));
  assert.deepEqual(res, { ok: true, result: { from: '2026-09-05', to: '2026-09-27', days: [
    { date: '2026-09-10', weightKg: 83, sleepH: 7.5, dietComplete: true },
    { date: '2026-09-21', weightKg: 82.4, muayThai: false, notes: 'ok' },
  ] } });
  assert.deepEqual(call(ctx, req('diary.range', { from: '2026-08-01', to: '2026-08-31' })).result.days, []);
  assert.deepEqual(ctx.__locks, [], 'reads take no lock');
});

test('diary.range and workout.range reject bad periods before reading', () => {
  const ctx = boot();
  assert.deepEqual(codes(call(ctx, req('diary.range', { from: '2026-09-21', to: '2026-09-01' }))), ['args.to:invalid_range']);
  assert.deepEqual(codes(call(ctx, req('workout.range', { from: '2026-01-01', to: '2026-09-21' }))), ['args.to:out_of_range']);
});

test('workout.range returns log rows in the period with their muscle group', () => {
  const ctx = boot();
  call(ctx, req('workout.upsert', { date: '2026-09-18', session: 'Lower', exercises: [{ name: 'Leg press', sets: [{ kg: 100, reps: 10 }, { kg: 100, reps: 9 }], pain: 2 }] }));
  call(ctx, req('workout.upsert', { date: '2026-09-14', session: 'Upper', exercises: [
    { name: 'Supino inclinado', sets: [{ kg: 60, reps: 8 }], rir: 2 },
    { name: 'Puxada aberta', sets: [{ kg: 50, reps: 10 }] },
  ] }));
  call(ctx, req('workout.upsert', { date: '2026-09-07', session: 'Upper', exercises: [{ name: 'Supino inclinado', sets: [{ kg: 58, reps: 8 }] }] }));
  const log = ctx.__spreadsheet.getSheetByName('Registro de treino');
  log.setCell_(10, 1, new ctx.Date('2026-09-15T00:00:00')); // hand-typed row, name outside the catalogue
  log.setCell_(10, 2, 'Upper'); log.setCell_(10, 3, 'Rosca direta');
  const res = call(ctx, req('workout.range', { from: '2026-09-14', to: '2026-09-20' }));
  assert.deepEqual(res.result, { from: '2026-09-14', to: '2026-09-20', rows: [
    { date: '2026-09-14', session: 'Upper', exercise: 'Supino inclinado', group: 'Peito', setsDone: 1, volume: 480, prescribedSets: 3, rir: 2 },
    { date: '2026-09-14', session: 'Upper', exercise: 'Puxada aberta', group: 'Costas', setsDone: 1, volume: 500, prescribedSets: 3 },
    { date: '2026-09-15', session: 'Upper', exercise: 'Rosca direta', group: null, setsDone: null, volume: null, prescribedSets: null },
    { date: '2026-09-18', session: 'Lower', exercise: 'Leg press', group: 'Quadríceps', setsDone: 2, volume: 1900, prescribedSets: 3, pain: 2 },
  ] });
});

test('sheet problems come back as internal errors instead of throwing', () => {
  const ctx = load({ sheets: sheets().filter((s) => s.name !== 'Diário'), properties: props, now: NOW });
  const res = call(ctx, req('diary.upsert', { date: '2026-09-21', fields: { weightKg: 82 } }));
  assert.equal(res.ok, false);
  assert.equal(res.errors[0].code, 'internal');
  assert.match(res.errors[0].message, /Sheet "Diário" not found/);
});

test('a missing diary column fails the whole request before writing', () => {
  const ctx = boot();
  ctx.__spreadsheet.getSheetByName('Diário').setCell_(5, DIARY_HEADERS.indexOf('Cintura cm') + 1, 'Renamed');
  const res = call(ctx, req('diary.upsert', { date: '2026-09-21', fields: { weightKg: 82, waistCm: 90 } }));
  assert.equal(res.errors[0].code, 'internal');
  assert.match(res.errors[0].message, /Cintura cm/);
  assert.equal(ctx.__spreadsheet.getSheetByName('Diário').getLastRow(), 5);
});

test('SheetApi.run serves in-process callers without a key', () => {
  const ctx = boot();
  const res = ctx.SheetApi.run('diary.upsert', { date: '2026-09-21', fields: { sleepH: 7 } });
  assert.equal(plain(res).ok, true);
});
