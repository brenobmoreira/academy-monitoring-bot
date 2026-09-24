'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');

const ctx = { today: '2026-09-21', sessions: ['Upper', 'Lower'], exercises: ['Supino inclinado', 'Supino reto', 'Puxada aberta', 'Leg press'] };
const codes = (r) => plain(r.errors).map((e) => `${e.path}:${e.code}`);

test('diary: valid args pass through unchanged', () => {
  const { Validator } = load();
  const r = Validator.diaryUpsert({ date: '2026-09-21', fields: { weightKg: 82.4, sleepH: 7.5, steps: 8000, muayThai: true, hunger: 3, notes: 'ok' } }, ctx);
  assert.deepEqual(plain(r.errors), []);
  assert.deepEqual(plain(r.value), { date: '2026-09-21', fields: { weightKg: 82.4, sleepH: 7.5, steps: 8000, muayThai: true, hunger: 3, notes: 'ok' } });
});

test('diary: never coerces and reports every error in one pass', () => {
  const { Validator } = load();
  const r = Validator.diaryUpsert({ date: '21/09/2026', fields: { weightKg: '82,4', muayThai: 'sim', hunger: 6, steps: 80.5, mood: 'bom' }, extra: 1 }, ctx);
  assert.equal(r.value, null);
  assert.deepEqual(codes(r).sort(), [
    'args.date:invalid_date',
    'args.extra:unknown_field',
    'args.fields.hunger:out_of_range',
    'args.fields.mood:unknown_field',
    'args.fields.muayThai:wrong_type',
    'args.fields.steps:wrong_type',
    'args.fields.weightKg:wrong_type',
  ]);
});

test('diary: date must exist on the calendar and not be in the future', () => {
  const { Validator } = load();
  assert.deepEqual(codes(Validator.diaryUpsert({ date: '2026-02-30', fields: { sleepH: 7 } }, ctx)), ['args.date:invalid_date']);
  assert.deepEqual(codes(Validator.diaryUpsert({ date: '2026-09-22', fields: { sleepH: 7 } }, ctx)), ['args.date:date_in_future']);
});

test('diary: fields are required, non-empty, and notes have a length limit', () => {
  const { Validator } = load();
  assert.deepEqual(codes(Validator.diaryUpsert({ date: '2026-09-21' }, ctx)), ['args.fields:required']);
  assert.deepEqual(codes(Validator.diaryUpsert({ date: '2026-09-21', fields: {} }, ctx)), ['args.fields:empty']);
  assert.deepEqual(codes(Validator.diaryUpsert({ date: '2026-09-21', fields: { notes: 'x'.repeat(501) } }, ctx)), ['args.fields.notes:too_long']);
  assert.deepEqual(codes(Validator.diaryUpsert({ date: '2026-09-21', fields: { weightKg: null } }, ctx)), ['args.fields.weightKg:wrong_type']);
  assert.deepEqual(codes(Validator.diaryUpsert('x', ctx)), ['args:wrong_type']);
});

test('workout: valid args pass, phase is optional', () => {
  const { Validator } = load();
  const args = { date: '2026-09-21', session: 'Upper', exercises: [
    { name: 'Supino inclinado', sets: [{ kg: 60, reps: 8 }, { kg: 62.5, reps: 8 }], rir: 2 },
    { name: 'Puxada aberta', sets: [{ kg: 0, reps: 12 }], pain: 3, note: 'pegada neutra', equipment: 'polia' },
  ] };
  const r = Validator.workoutUpsert(args, ctx);
  assert.deepEqual(plain(r.errors), []);
  assert.deepEqual(plain(r.value), args);
});

test('workout: session and exercise names must match the catalogue exactly, with suggestions', () => {
  const { Validator } = load();
  const r = Validator.workoutUpsert({ date: '2026-09-21', session: 'upper', phase: 'adaptação', exercises: [
    { name: 'supino', sets: [{ kg: 60, reps: 8 }] },
  ] }, ctx);
  assert.deepEqual(codes(r), ['args.session:not_in_catalog', 'args.phase:not_in_catalog', 'args.exercises[0].name:not_in_catalog']);
  const [session, , exercise] = plain(r.errors);
  assert.deepEqual(session.suggestions, ['Upper']);
  assert.deepEqual(exercise.suggestions, ['Supino inclinado', 'Supino reto']);
});

test('workout: sets, reps, rir, pain and duplicates are checked per exercise', () => {
  const { Validator } = load();
  const r = Validator.workoutUpsert({ date: '2026-09-21', session: 'Lower', exercises: [
    { name: 'Leg press', sets: [{ kg: 100, reps: 0 }, { kg: -1, reps: 8.5 }, { kg: 1, reps: 1, rpe: 8 }, { kg: 1, reps: 1 }, { kg: 1, reps: 1 }], rir: 11 },
    { name: 'Leg press', sets: [], pain: '2' },
  ] }, ctx);
  assert.deepEqual(codes(r), [
    'args.exercises[0].sets:out_of_range',
    'args.exercises[0].sets[0].reps:out_of_range',
    'args.exercises[0].sets[1].kg:out_of_range',
    'args.exercises[0].sets[1].reps:wrong_type',
    'args.exercises[0].sets[2].rpe:unknown_field',
    'args.exercises[0].rir:out_of_range',
    'args.exercises[1].name:duplicate',
    'args.exercises[1].sets:out_of_range',
    'args.exercises[1].pain:wrong_type',
  ]);
});

test('workout: exercises list is required and bounded', () => {
  const { Validator } = load();
  assert.deepEqual(codes(Validator.workoutUpsert({ date: '2026-09-21', session: 'Upper' }, ctx)), ['args.exercises:required']);
  assert.deepEqual(codes(Validator.workoutUpsert({ date: '2026-09-21', session: 'Upper', exercises: [] }, ctx)), ['args.exercises:out_of_range']);
});

test('history: exact name, optional limit 1-50 defaulting to 10', () => {
  const { Validator } = load();
  assert.deepEqual(plain(Validator.exerciseHistory({ name: 'Leg press' }, ctx).value), { name: 'Leg press', limit: 10 });
  assert.deepEqual(codes(Validator.exerciseHistory({ name: 'leg', limit: 51 }, ctx)), ['args.name:not_in_catalog', 'args.limit:out_of_range']);
});

test('day: a strict date not after today, nothing else', () => {
  const { Validator } = load();
  assert.deepEqual(plain(Validator.dayGet({ date: '2026-09-21' }, ctx)), { value: { date: '2026-09-21' }, errors: [] });
  assert.deepEqual(codes(Validator.dayGet({ date: '2026-09-22', extra: 1 }, ctx)), ['args.extra:unknown_field', 'args.date:date_in_future']);
  assert.deepEqual(codes(Validator.dayGet({ date: '21/09' }, ctx)), ['args.date:invalid_date']);
  assert.deepEqual(codes(Validator.dayGet({}, ctx)), ['args.date:required']);
});

test('every error carries a Portuguese message for the model', () => {
  const { Validator } = load();
  const r = Validator.diaryUpsert({ date: '2026-09-21', fields: { hunger: 9 } }, ctx);
  assert.match(r.errors[0].message, /entre 1 e 5/);
});
