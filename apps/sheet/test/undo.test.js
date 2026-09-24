'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');
const { sheets, DIARY_HEADERS, WORKOUT_HEADERS } = require('./fixtures');

const NOW = '2026-09-21T15:00:00-03:00';
const day = (s) => new Date(`${s}T00:00:00`);
const boot = (opts = {}) => load({ sheets: sheets(opts), properties: { SHEET_API_KEY: 'k' }, now: NOW });
const run = (ctx, op, args) => plain(ctx.SheetApi.run(op, args));
const codes = (res) => res.errors.map((e) => `${e.path}:${e.code}`);
const log = (ctx) => JSON.parse(ctx.__properties.UNDO_LOG || '[]');
const diary = (ctx) => ctx.__spreadsheet.getSheetByName('Diário');
const workout = (ctx) => ctx.__spreadsheet.getSheetByName('Registro de treino');
const dcol = (h) => DIARY_HEADERS.indexOf(h) + 1;
const wcol = (h) => WORKOUT_HEADERS.indexOf(h) + 1;
const supino = (kg) => ({ date: '2026-09-21', session: 'Upper', exercises: [{ name: 'Supino inclinado', sets: [{ kg, reps: 8 }], rir: 2 }] });

test('undo of an update restores the previous values and leaves the other cells alone', () => {
  const ctx = boot({ diaryRows: [[day('2026-09-21'), 82.1, 7, '', '', '', '', '', '', '', 'nota']] });
  const w = run(ctx, 'diary.upsert', { date: '2026-09-21', fields: { weightKg: 82.4, sleepH: 7.5, steps: 8000 } });
  diary(ctx).setCell_(6, dcol('Observações'), 'editada à mão');
  const res = run(ctx, 'write.undo', { writeId: w.result.writeId });
  assert.deepEqual(res, { ok: true, result: { writeId: w.result.writeId, undone: { op: 'diary.upsert', date: '2026-09-21', fields: ['weightKg', 'sleepH', 'steps'] } } });
  const row = diary(ctx).getRange(6, 1, 1, 11).getValues()[0];
  assert.equal(row[dcol('Peso kg') - 1], 82.1);
  assert.equal(row[dcol('Sono h') - 1], 7);
  assert.equal(row[dcol('Passos') - 1], '');
  assert.equal(row[dcol('Observações') - 1], 'editada à mão');
  assert.equal(ctx.Sheets.dayKey(row[0]), '2026-09-21');
});

test('undo of a created row clears its cells, keeps the row, and the next write reuses it', () => {
  const ctx = boot({ diaryRows: [[day('2026-09-20'), 82]] });
  const w = run(ctx, 'diary.upsert', { date: '2026-09-21', fields: { weightKg: 82.4, muayThai: true } });
  assert.equal(w.result.row, 7);
  assert.deepEqual(log(ctx)[0].rows, [{ r: 7, c: [dcol('Data'), dcol('Peso kg'), dcol('Muay Thai')], n: 1 }]);
  run(ctx, 'write.undo', {});
  assert.deepEqual(plain(diary(ctx).getRange(7, 1, 1, 7).getValues()[0]), ['', '', '', '', '', '', '']);
  assert.equal(diary(ctx).getRange(6, dcol('Peso kg')).getValue(), 82);
  assert.equal(run(ctx, 'diary.upsert', { date: '2026-09-19', fields: { sleepH: 7 } }).result.row, 7);
});

test('workout undo restores replaced sets and clears rows the write added', () => {
  const ctx = boot();
  run(ctx, 'workout.upsert', supino(60));
  const w = run(ctx, 'workout.upsert', { ...supino(62), exercises: [...supino(62).exercises, { name: 'Puxada aberta', sets: [{ kg: 50, reps: 10 }] }] });
  // Only cells whose value changed are captured: sets, volume, and every cell of the new row.
  const [updated, created] = log(ctx)[1].rows;
  assert.deepEqual(updated, { r: 6, c: [[wcol('Volume kg×reps'), 480], [wcol('kg série 1'), 60]] });
  assert.equal(created.r, 7);
  assert.equal(created.n, 1);
  const res = run(ctx, 'write.undo', { writeId: w.result.writeId });
  assert.deepEqual(res.result.undone, { op: 'workout.upsert', date: '2026-09-21', session: 'Upper', exercises: ['Supino inclinado', 'Puxada aberta'] });
  assert.equal(workout(ctx).getRange(6, wcol('kg série 1')).getValue(), 60);
  assert.equal(workout(ctx).getRange(6, wcol('Volume kg×reps')).getValue(), 480);
  assert.equal(workout(ctx).getLastRow(), 6);
});

test('a formula the write overwrote comes back as a formula', () => {
  const blankRow = Array(WORKOUT_HEADERS.length).fill('');
  blankRow[wcol('Volume kg×reps') - 1] = '=SUMPRODUCT(E6:L6)';
  const ctx = boot({ workoutRows: [blankRow] });
  run(ctx, 'workout.upsert', supino(60));
  assert.equal(workout(ctx).getRange(6, wcol('Volume kg×reps')).getValue(), 480);
  run(ctx, 'write.undo', {});
  assert.equal(workout(ctx).getRange(6, wcol('Volume kg×reps')).getValue(), '=SUMPRODUCT(E6:L6)');
  assert.equal(workout(ctx).getRange(6, wcol('Data')).getValue(), '');
});

test('without an id, undo walks back through the writes not yet undone', () => {
  const ctx = boot();
  const a = run(ctx, 'diary.upsert', { date: '2026-09-21', fields: { weightKg: 82 } }).result.writeId;
  const b = run(ctx, 'diary.upsert', { date: '2026-09-21', fields: { weightKg: 83 } }).result.writeId;
  assert.notEqual(a, b);
  assert.equal(run(ctx, 'write.undo', {}).result.writeId, b);
  assert.equal(diary(ctx).getRange(6, dcol('Peso kg')).getValue(), 82);
  assert.equal(run(ctx, 'write.undo', {}).result.writeId, a);
  assert.equal(diary(ctx).getRange(6, dcol('Data')).getValue(), '');
  const none = run(ctx, 'write.undo', {});
  assert.deepEqual(codes(none), ['args:nothing_to_undo']);
  assert.match(none.errors[0].message, /nada para desfazer/);
});

test('an entry is undone once; unknown ids and bad arguments are refused', () => {
  const ctx = boot();
  const id = run(ctx, 'diary.upsert', { date: '2026-09-21', fields: { sleepH: 7 } }).result.writeId;
  assert.equal(run(ctx, 'write.undo', { writeId: id }).ok, true);
  const again = run(ctx, 'write.undo', { writeId: id });
  assert.deepEqual(codes(again), ['args.writeId:already_undone']);
  assert.match(again.errors[0].message, /já foi desfeita/);
  assert.deepEqual(codes(run(ctx, 'write.undo', { writeId: 'nope' })), ['args.writeId:not_found']);
  assert.deepEqual(codes(run(ctx, 'write.undo', { writeId: 7, extra: 1 })), ['args.extra:unknown_field', 'args.writeId:wrong_type']);
  assert.deepEqual(codes(run(ctx, 'write.undo', { writeId: 'x'.repeat(21) })), ['args.writeId:too_long']);
  const undone = log(ctx)[0];
  assert.equal(undone.rows, undefined);
  assert.equal(undone.undone, new Date(NOW).toISOString());
});

test('undo refuses, writing nothing, when the row no longer holds the write\'s date', () => {
  const ctx = boot();
  const id = run(ctx, 'diary.upsert', { date: '2026-09-21', fields: { weightKg: 82 } }).result.writeId;
  diary(ctx).setCell_(6, dcol('Data'), day('2026-09-20'));
  const res = run(ctx, 'write.undo', { writeId: id });
  assert.deepEqual(codes(res), ['args.writeId:conflict']);
  assert.equal(diary(ctx).getRange(6, dcol('Peso kg')).getValue(), 82);
  assert.equal(log(ctx)[0].undone, undefined);
});

test('each entry keeps when, which op and what it wrote, for catalog.recent', () => {
  const ctx = boot();
  run(ctx, 'workout.upsert', supino(60));
  const [entry] = log(ctx);
  assert.equal(entry.at, new Date(NOW).toISOString());
  assert.equal(entry.op, 'workout.upsert');
  assert.equal(entry.sheet, 'Registro de treino');
  assert.equal(entry.date, '2026-09-21');
  assert.equal(entry.session, 'Upper');
  assert.deepEqual(entry.exercises, ['Supino inclinado']);
  assert.ok(entry.id.length <= 20);
});

test('the log keeps the last 30 entries and stays under the property size limit', () => {
  const ctx = boot();
  const ids = [];
  for (let i = 0; i < 35; i++) ids.push(run(ctx, 'diary.upsert', { date: '2026-09-21', fields: { steps: 1000 + i } }).result.writeId);
  assert.equal(log(ctx).length, 30);
  assert.equal(log(ctx)[0].id, ids[5]);
  assert.deepEqual(codes(run(ctx, 'write.undo', { writeId: ids[4] })), ['args.writeId:not_found']);

  for (let i = 0; i < 30; i++) run(ctx, 'diary.upsert', { date: '2026-09-21', fields: { notes: `${'ação '.repeat(99)}${i}` } });
  const text = ctx.__properties.UNDO_LOG;
  assert.ok(Buffer.byteLength(text, 'utf8') <= 9000, `${Buffer.byteLength(text, 'utf8')} bytes`);
  assert.ok(log(ctx).length < 30);
  assert.equal(run(ctx, 'write.undo', {}).ok, true);
});

test('an entry too large for the property keeps only its summary and cannot be undone', () => {
  const ctx = boot();
  const huge = { r: 6, c: [[11, 'x'.repeat(9000)]] };
  ctx.UndoLog.save_([{ id: 'big', at: 't', op: 'diary.upsert', sheet: 'Diário', date: '2026-09-21', fields: ['notes'], rows: [huge] }]);
  assert.equal(log(ctx)[0].rows, undefined);
  assert.deepEqual(codes(run(ctx, 'write.undo', {})), ['args.writeId:not_undoable']);
});

test('menu writes enter the log, so undo reaches them too', () => {
  const hoje = Array.from({ length: 40 }, () => []);
  hoje[4] = ['Data', day('2026-09-21')];
  hoje[6] = ['Peso kg', 82.4];
  const ctx = boot({ hoje });
  ctx.menuSaveDay();
  assert.equal(diary(ctx).getRange(6, dcol('Peso kg')).getValue(), 82.4);
  const res = run(ctx, 'write.undo', {});
  assert.deepEqual(res.result.undone, { op: 'diary.upsert', date: '2026-09-21', fields: ['weightKg'] });
  assert.equal(diary(ctx).getRange(6, dcol('Peso kg')).getValue(), '');
});

test('write.undo runs under the script lock', () => {
  const ctx = boot();
  run(ctx, 'diary.upsert', { date: '2026-09-21', fields: { sleepH: 7 } });
  ctx.__locks.length = 0;
  run(ctx, 'write.undo', {});
  assert.deepEqual(plain(ctx.__locks), ['wait', 'release']);
});

test('a log that cannot be saved costs the writeId, never the write', () => {
  const ctx = boot();
  const props = ctx.PropertiesService.getScriptProperties();
  ctx.PropertiesService.getScriptProperties = () => ({ ...props, setProperty: () => { throw new Error('quota'); } });
  const res = run(ctx, 'diary.upsert', { date: '2026-09-21', fields: { sleepH: 7 } });
  assert.equal(res.ok, true);
  assert.equal(res.result.writeId, undefined);
  assert.equal(diary(ctx).getRange(6, dcol('Sono h')).getValue(), 7);
});

test('catalog.recent lists the writes of the last 30 minutes, newest first, without undone ones', () => {
  const ctx = boot();
  const ago = (min) => new Date(new Date(NOW).getTime() - min * 60000).toISOString();
  assert.equal(ctx.UndoLog.RECENT_MINUTES, 30);
  ctx.UndoLog.save_([
    { id: 'old', at: ago(31), op: 'diary.upsert', sheet: 'Diário', date: '2026-09-21', fields: ['weightKg'], rows: [] },
    { id: 'edge', at: ago(30), op: 'diary.upsert', sheet: 'Diário', date: '2026-09-21', fields: ['sleepH'], rows: [] },
    { id: 'gone', at: ago(10), op: 'diary.upsert', sheet: 'Diário', date: '2026-09-21', fields: ['steps'], undone: ago(5) },
    { id: 'bad', at: 'not a time', op: 'diary.upsert', sheet: 'Diário', date: '2026-09-21', fields: ['notes'], rows: [] },
  ]);
  run(ctx, 'workout.upsert', supino(60));
  const recent = run(ctx, 'catalog', {}).result.recent;
  assert.equal(recent.length, 2);
  assert.deepEqual(recent[0], {
    writeId: log(ctx)[4].id, at: new Date(NOW).toISOString(), op: 'workout.upsert', date: '2026-09-21', session: 'Upper', exercises: ['Supino inclinado'],
  });
  assert.deepEqual(recent[1], { writeId: 'edge', at: ago(30), op: 'diary.upsert', date: '2026-09-21', fields: ['sleepH'] });
});

test('catalog.recent drops a write once it is undone and is empty without a log', () => {
  const ctx = boot();
  assert.deepEqual(run(ctx, 'catalog', {}).result.recent, []);
  run(ctx, 'diary.upsert', { date: '2026-09-21', fields: { weightKg: 82 } });
  assert.equal(run(ctx, 'catalog', {}).result.recent.length, 1);
  run(ctx, 'write.undo', {});
  assert.deepEqual(run(ctx, 'catalog', {}).result.recent, []);
});
