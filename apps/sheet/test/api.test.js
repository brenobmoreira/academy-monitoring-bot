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
  assert.match(call(ctx, req('nope', {})).errors[0].message, /catalog, diary\.upsert, workout\.upsert, exercise\.history/);
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
  assert.deepEqual(res, { ok: true, result: { date: '2026-09-21', row: 6, fields: { weightKg: 82.4, muayThai: true } } });
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
  assert.deepEqual(res.result, {
    date: '2026-09-21', session: 'Upper', phase: 'Adaptação', sessionId: '2026-09-21/Upper',
    exercises: [{ name: 'Supino inclinado', row: 6, sets: [{ kg: 60, reps: 8 }, { kg: 62.5, reps: 8 }], setsDone: 2, volume: 980, rir: 2 }],
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

test('catalog reports the most recent logged session, or null before the first one', () => {
  const ctx = boot();
  assert.equal(call(ctx, req('catalog', {})).result.lastWorkout, null);
  const save = (date, session, name) => call(ctx, req('workout.upsert', { date, session, exercises: [{ name, sets: [{ kg: 50, reps: 10 }] }] }));
  save('2026-09-20', 'Lower', 'Leg press'); save('2026-09-18', 'Upper', 'Supino inclinado');
  assert.deepEqual(call(ctx, req('catalog', {})).result.lastWorkout, { date: '2026-09-20', session: 'Lower' });
  save('2026-09-20', 'Upper', 'Puxada aberta');
  assert.deepEqual(call(ctx, req('catalog', {})).result.lastWorkout, { date: '2026-09-20', session: 'Upper' });
});

test('day.get returns the diary row and the workout of one day as the API writes them', () => {
  const hoje = Array.from({ length: 23 }, () => []); hoje[22] = ['Sessão', '', '', 'Fase', 'Adaptação'];
  const ctx = boot({ hoje });
  call(ctx, req('diary.upsert', { date: '2026-09-21', fields: { weightKg: 82.4, sleepH: 7.5, muayThai: true, dietComplete: false, notes: 'ok' } }));
  call(ctx, req('workout.upsert', { date: '2026-09-21', session: 'Upper', exercises: [
    { name: 'Supino inclinado', sets: [{ kg: 60, reps: 8 }, { kg: 62.5, reps: 8 }], rir: 2 },
    { name: 'Puxada aberta', sets: [{ kg: 50, reps: 10 }], pain: 1 },
  ] }));
  call(ctx, req('workout.upsert', { date: '2026-09-20', session: 'Lower', exercises: [{ name: 'Leg press', sets: [{ kg: 100, reps: 10 }] }] }));
  assert.deepEqual(call(ctx, req('day.get', { date: '2026-09-21' })), { ok: true, result: {
    date: '2026-09-21',
    diary: { weightKg: 82.4, sleepH: 7.5, muayThai: true, dietComplete: false, notes: 'ok' },
    workout: [{ session: 'Upper', phase: 'Adaptação', exercises: [
      { name: 'Supino inclinado', sets: [{ kg: 60, reps: 8 }, { kg: 62.5, reps: 8 }], setsDone: 2, volume: 980, rir: 2 },
      { name: 'Puxada aberta', sets: [{ kg: 50, reps: 10 }], setsDone: 1, volume: 500, pain: 1 },
    ] }],
  } });
  assert.deepEqual(call(ctx, req('day.get', { date: '2026-09-20' })).result.diary, {});
  assert.deepEqual(call(ctx, req('day.get', { date: '2026-09-19' })).result, { date: '2026-09-19', diary: {}, workout: [] });
});

test('day.get maps hand-typed yes/no cells and skips values it cannot read back', () => {
  const ctx = boot({ diaryRows: [['', 83, '', '', '', 'Não', 'talvez']] });
  ctx.__spreadsheet.getSheetByName('Diário').setCell_(6, 1, ctx.Sheets.localDate('2026-09-21'));
  assert.deepEqual(call(ctx, req('day.get', { date: '2026-09-21' })).result.diary, { weightKg: 83, muayThai: false });
});

test('day.get validates the date like the writes do', () => {
  const ctx = boot();
  assert.deepEqual(codes(call(ctx, req('day.get', { date: '2026-09-22' }))), ['args.date:date_in_future']);
  assert.deepEqual(codes(call(ctx, req('day.get', { date: 'ontem' }))), ['args.date:invalid_date']);
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
