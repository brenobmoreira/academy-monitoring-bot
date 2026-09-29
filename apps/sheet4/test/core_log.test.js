'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, day, sheet, plain } = require('./core_helpers');

const eq = (a, b, m) => assert.deepEqual(plain(a), b, m);
const snapshot = (ctx, names) => JSON.stringify(names.map((n) => [n, sheet(ctx, n) ? sheet(ctx, n).rows.map((r) => {
  const out = r.map((v) => (v instanceof Date ? v.getTime() : v));
  while (out.length && (out[out.length - 1] === '' || out[out.length - 1] === undefined)) out.pop();
  return out;
}).filter((r, i, all) => i < all.length) : null]));
const trimRows = (ctx, name) => {
  const s = sheet(ctx, name);
  while (s.rows.length && s.rows[s.rows.length - 1].every((v) => v === '' || v === undefined || v === null)) s.rows.pop();
};

const diaryRows = () => [
  { date: '2026-09-26', weightKg: 67.4 },
  { date: '2026-09-27', weightKg: 67.1, notes: 'ok' },
  { date: '2026-09-28', weightKg: 66.9 },
];

test('writes outside an action are not logged', () => {
  const ctx = boot({ tabs: { diary: diaryRows() } });
  ctx.Tabs.update('diary', 6, { weightKg: 60 });
  assert.equal(sheet(ctx, 'Log'), null);
  assert.equal(ctx.ChangeLog.active(), null);
});

test('an action logs update, append and delete with before/after, one Log row per row', () => {
  const ctx = boot({ tabs: { diary: diaryRows() } });
  ctx.ChangeLog.run('Salvar dia', () => {
    assert.equal(ctx.ChangeLog.active().label, 'Salvar dia');
    ctx.Tabs.update('diary', 6, { weightKg: 67.5, sleepH: 7 });
    ctx.Tabs.append('diary', { date: '2026-09-29', weightKg: 66.7 });
    ctx.Tabs.remove('diary', 7);
  });
  const entries = ctx.ChangeLog.entries();
  assert.equal(entries.length, 3);
  assert.equal(new Set(entries.map((e) => e.actionId)).size, 1);
  eq(entries.map((e) => [e.kind, e.tab, e.row, e.action]), [
    ['update', 'Diário', 6, 'Salvar dia'], ['append', 'Diário', 9, 'Salvar dia'], ['delete', 'Diário', 7, 'Salvar dia'],
  ]);
  eq(entries[0].before, { 'Peso kg': 67.4, 'Sono h': '' });
  eq(entries[0].after, { 'Peso kg': 67.5, 'Sono h': 7 });
  assert.equal(entries[1].before, null);
  assert.equal(entries[1].after['Data'].getTime(), day('2026-09-29').getTime());
  assert.equal(entries[2].after, null);
  eq(entries[2].before['Observações'], 'ok');
  const raw = ctx.Tabs.read('log')[1];
  assert.match(raw.after, /"Data":\{"\$d":"2026-09-29T03:00:00.000Z"\}/);
  assert.equal(raw.kind, 'Inclusão');
});

test('undo of a multi-tab action (phase transition) restores every tab exactly', () => {
  const ctx = boot({
    tabs: {
      objectives: [{ id: 'O001', name: 'Recomposição', analysisType: 'recomposicao', start: '2026-09-28', status: 'Vigente' }],
      goals: [{ id: 'M001', start: '2026-09-28', status: 'Vigente', kcal: 2400, protein: 140, fat: 65 }],
      plans: [{ id: 'F001', session: 'A', exercise: 'x', start: '2026-09-28', status: 'Vigente' }],
      reviews: [{ date: '2026-09-15', area: 'Ficha', reason: 'inicial' }],
    },
  });
  const tabs = ['Objetivos', 'Metas', 'Fichas', 'Revisões'];
  const before = snapshot(ctx, tabs);
  ctx.Transition.apply({
    date: '2026-09-29', objective: { name: 'Déficit', analysisType: 'deficit' }, goal: { kcal: 2100, protein: 150, fat: 55 },
    plan: [{ session: 'A', exercise: 'y' }, { session: 'B', exercise: 'z' }], reason: 'Mini-cut',
  });
  assert.notEqual(snapshot(ctx, tabs), before);
  const r = plain(ctx.Undo.last());
  assert.equal(r.action, 'Mudar objetivo/fase');
  assert.equal(r.changes, 8, '3 closes + 4 appended rows (2 plan rows) + review');
  tabs.forEach((t) => trimRows(ctx, t));
  assert.equal(snapshot(ctx, tabs), before);
  assert.equal(ctx.Objectives.current().id, 'O001');
  assert.equal(ctx.Objectives.current().end, null);
  assert.ok(ctx.ChangeLog.entries().every((e) => e.undone instanceof Date));
  assert.throws(() => ctx.Undo.last(), /Nada para desfazer/);
});

test('undo restores a deleted row in place, drops appended rows and brings back formulas and dates', () => {
  const ctx = boot({ tabs: { diary: diaryRows() } });
  const s = sheet(ctx, 'Diário');
  const kcal = ctx.Tabs.headerMap('diary').kcal;
  s.setCell_(8, kcal, '=1+2');
  const before = snapshot(ctx, ['Diário']);
  ctx.ChangeLog.run('Várias', () => {
    ctx.Tabs.update('diary', 8, { kcal: 2000, date: '2026-09-30' });
    ctx.Tabs.remove('diary', 6);
    ctx.Tabs.append('diary', { date: '2026-10-01' });
  });
  assert.equal(ctx.Tabs.read('diary').length, 3);
  ctx.Undo.last();
  trimRows(ctx, 'Diário');
  assert.equal(snapshot(ctx, ['Diário']), before);
  assert.equal(s.cell_(8, kcal), '=1+2');
});

test('undo goes back one action at a time (LIFO)', () => {
  const ctx = boot({ tabs: { diary: diaryRows() } });
  const before = snapshot(ctx, ['Diário']);
  ctx.ChangeLog.run('A', () => ctx.Tabs.append('diary', { date: '2026-09-29', weightKg: 1 }));
  const mid = snapshot(ctx, ['Diário']);
  ctx.ChangeLog.run('B', () => { ctx.Tabs.append('diary', { date: '2026-09-30', weightKg: 2 }); ctx.Tabs.update('diary', 9, { weightKg: 3 }); });
  eq(ctx.Undo.pending().map((a) => a.label), ['B', 'A']);
  assert.equal(ctx.Undo.last().action, 'B');
  trimRows(ctx, 'Diário');
  assert.equal(snapshot(ctx, ['Diário']), mid);
  assert.equal(ctx.Undo.last().action, 'A');
  trimRows(ctx, 'Diário');
  assert.equal(snapshot(ctx, ['Diário']), before);
});

test('undo refuses when a touched cell changed since, and changes nothing', () => {
  const ctx = boot({ tabs: { diary: diaryRows(), goals: [] } });
  ctx.ChangeLog.run('Duas abas', () => {
    ctx.Tabs.append('goals', { id: 'M001', start: '2026-09-28', kcal: 2400 });
    ctx.Tabs.update('diary', 7, { weightKg: 70 });
  });
  sheet(ctx, 'Diário').setCell_(7, ctx.Tabs.headerMap('diary').weightKg, 71);
  const before = snapshot(ctx, ['Diário', 'Metas']);
  assert.throws(() => ctx.Undo.last(), (err) => err.apiErrors[0].code === 'conflict' && /linha 7 de "Diário" mudou \(Peso kg\)/.test(err.message));
  assert.equal(snapshot(ctx, ['Diário', 'Metas']), before);
  assert.equal(ctx.Undo.pending().length, 1);
});

test('Undo.action(id) only undoes the latest pending action', () => {
  const ctx = boot({ tabs: { diary: diaryRows() } });
  ctx.ChangeLog.run('A', () => ctx.Tabs.update('diary', 6, { weightKg: 1 }));
  ctx.ChangeLog.run('B', () => ctx.Tabs.update('diary', 6, { weightKg: 2 }));
  const [b, a] = ctx.Undo.pending();
  assert.throws(() => ctx.Undo.action(a.id), (e) => e.apiErrors[0].code === 'not_latest');
  assert.throws(() => ctx.Undo.action('zzz'), (e) => e.apiErrors[0].code === 'not_found');
  assert.equal(ctx.Undo.action(b.id).action, 'B');
  assert.throws(() => ctx.Undo.action(b.id), (e) => e.apiErrors[0].code === 'already_undone');
  assert.equal(ctx.Tabs.readRow('diary', 6).weightKg, 1);
});

test('an action that throws is rolled back and its Log rows marked undone', () => {
  const ctx = boot({ tabs: { diary: diaryRows(), goals: [] } });
  const before = snapshot(ctx, ['Diário', 'Metas']);
  assert.throws(() => ctx.ChangeLog.run('Falha', () => {
    ctx.Tabs.append('goals', { id: 'M001', kcal: 1 });
    ctx.Tabs.update('diary', 6, { weightKg: 99 });
    throw new Error('boom');
  }), /boom/);
  trimRows(ctx, 'Metas');
  assert.equal(snapshot(ctx, ['Diário', 'Metas']), before);
  assert.equal(ctx.ChangeLog.entries().length, 2);
  assert.ok(ctx.ChangeLog.entries().every((e) => e.undone));
  assert.throws(() => ctx.Undo.last(), /Nada para desfazer/);
});

test('the Log row is written before the data: a failing write leaves a logged, rolled-back change', () => {
  const ctx = boot({ tabs: { diary: diaryRows() } });
  const s = sheet(ctx, 'Diário');
  const original = s.getRange.bind(s);
  s.getRange = (...a) => { const r = original(...a); r.setValues = () => { throw new Error('quota'); }; return r; };
  assert.throws(() => ctx.ChangeLog.run('Falha de escrita', () => ctx.Tabs.append('diary', { date: '2026-09-29' })), /quota/);
  const [e] = ctx.ChangeLog.entries();
  assert.equal(e.kind, 'append');
  assert.ok(e.undone);
  s.getRange = original;
  assert.equal(ctx.Tabs.read('diary').length, 3, 'rollback did not delete an unwritten row');
});

test('layout cells (Hoje) are logged and undone by A1 address', () => {
  const ctx = boot();
  ctx.__spreadsheet.insertSheet('Hoje');
  const s = sheet(ctx, 'Hoje');
  s.setCell_(5, 2, day('2026-09-28'));
  s.setCell_(9, 1, '=B5+1');
  ctx.ChangeLog.run('Carregar dia', () => ctx.Tabs.setCells('today', { B5: day('2026-09-29'), B7: 67, A9: 'x' }));
  assert.equal(ctx.ChangeLog.entries()[0].kind, 'cells');
  ctx.Undo.last();
  assert.equal(s.cell_(5, 2).getTime(), day('2026-09-28').getTime());
  assert.equal(s.cell_(7, 2), '');
  assert.equal(s.cell_(9, 1), '=B5+1');
});

test('ChangeLog.record logs changes described by the caller as one action', () => {
  const ctx = boot({ tabs: { diary: diaryRows() } });
  const id = ctx.ChangeLog.record('Externa', [{ kind: 'update', tab: 'Diário', row: 6, before: { 'Peso kg': 67.4 }, after: { 'Peso kg': 80 } }]);
  sheet(ctx, 'Diário').setCell_(6, 2, 80);
  assert.equal(ctx.Undo.pending()[0].id, id);
  ctx.Undo.last();
  assert.equal(ctx.Tabs.readRow('diary', 6).weightKg, 67.4);
  assert.throws(() => ctx.ChangeLog.record('x', [{ kind: 'move', tab: 'Diário' }]), /Unknown change kind/);
});

test('Core.withLock takes and releases the script lock, is re-entrant, and reports contention in Portuguese', () => {
  const ctx = boot();
  const r = ctx.Core.withLock(() => ctx.Core.withLock(() => 42));
  assert.equal(r, 42);
  eq(ctx.__locks, ['wait', 'release']);
  assert.throws(() => ctx.Core.withLock(() => { throw new Error('x'); }), /x/);
  assert.equal(ctx.__locks.at(-1), 'release');
  ctx.LockService.getScriptLock = () => ({ waitLock: () => { throw new Error('timeout'); }, releaseLock: () => {} });
  assert.throws(() => ctx.Core.withLock(() => 1), /Outra alteração está em andamento/);
});

test('Core.on/emit call listeners in order with the payload', () => {
  const ctx = boot();
  const calls = [];
  ctx.Core.on('e', (p) => calls.push(['a', p.n]));
  ctx.Core.on('e', (p) => calls.push(['b', p.n]));
  assert.equal(ctx.Core.emit('e', { n: 1 }).n, 1);
  ctx.Core.emit('other', {});
  assert.deepEqual(calls, [['a', 1], ['b', 1]]);
});
