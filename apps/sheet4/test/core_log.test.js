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

test('a cells change bigger than one Log cell is logged in parts that each fit and keep every cell', () => {
  const ctx = boot({ tabs: { diary: diaryRows() } });
  const before = {};
  const after = {};
  for (let i = 1; i <= 2000; i++) { before[`K${i}`] = 'antes '.repeat(6); after[`K${i}`] = 'depois '.repeat(6); }
  ctx.ChangeLog.run('Grande', () => ctx.ChangeLog.track({ kind: 'cells', tab: 'Diário', row: null, before, after }));
  const rows = ctx.Tabs.read('log').filter((r) => r.action === 'Grande');
  assert.ok(rows.length > 1, `split into ${rows.length} rows`);
  rows.forEach((r) => assert.ok(String(r.before).length <= 50000 && String(r.after).length <= 50000));
  const keys = new Set();
  rows.forEach((r) => Object.keys(ctx.ChangeLog.decode(r.after)).forEach((k) => keys.add(k)));
  assert.equal(keys.size, 2000);
  assert.equal(new Set(rows.map((r) => r.actionId)).size, 1, 'one action');
});

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

test('Core.withLock takes and releases the script lock, flushes before release, is re-entrant, and reports contention in Portuguese', () => {
  const ctx = boot();
  const order = [];
  const origLock = ctx.LockService.getScriptLock;
  ctx.LockService.getScriptLock = () => {
    const l = origLock();
    return {
      waitLock: (ms) => { order.push('wait'); return l.waitLock(ms); },
      releaseLock: () => { order.push('release'); return l.releaseLock(); },
      hasLock: () => l.hasLock(),
    };
  };
  const origFlush = ctx.SpreadsheetApp.flush;
  ctx.SpreadsheetApp.flush = () => { order.push('flush'); return origFlush(); };
  const r = ctx.Core.withLock(() => ctx.Core.withLock(() => { order.push('fn'); return 42; }));
  assert.equal(r, 42);
  eq(ctx.__locks, ['wait', 'release']);
  eq(order, ['wait', 'fn', 'flush', 'release']);

  order.length = 0;
  assert.throws(() => ctx.Core.withLock(() => { order.push('throw'); throw new Error('x'); }), /x/);
  assert.equal(ctx.__locks.at(-1), 'release');
  eq(order, ['wait', 'throw', 'flush', 'release']);

  ctx.SpreadsheetApp.flush = origFlush;
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

test('action.committed fires once after the outermost action and after an undo, with the tabs written', () => {
  const ctx = boot({ tabs: { diary: diaryRows() } });
  const events = [];
  ctx.Core.on('action.committed', (e) => events.push(plain(e)));
  ctx.ChangeLog.run('fora', () => {
    ctx.ChangeLog.run('dentro', () => ctx.Tabs.update('diary', 6, { weightKg: 60 }));
    assert.equal(events.length, 0, 'nested runs do not commit');
  });
  assert.throws(() => ctx.ChangeLog.run('falha', () => { ctx.Tabs.update('diary', 7, { weightKg: 1 }); throw new Error('x'); }));
  ctx.ChangeLog.run('nada', () => null);
  ctx.Undo.last();
  eq(events, [
    { label: 'fora', tabs: ['Diário'] },
    { label: 'fora', tabs: ['Diário'], undo: true },
  ]);
});

test('structural changes (rename, new tab, columns, named range) are logged and undone in reverse', () => {
  const ctx = boot({ tabs: { exercises: [{ name: 'A' }] } });
  const ss = ctx.__spreadsheet;
  ss.getSheetByName('Exercícios').setName('Cadastro');
  const cols = ss.getSheetByName('Cadastro').getMaxColumns();
  ctx.ChangeLog.run('Estrutura', () => {
    ctx.ChangeLog.structure('Exercícios', { op: 'renameSheet', from: 'Cadastro', to: 'Exercícios' });
    ss.getSheetByName('Cadastro').setName('Exercícios');
    ctx.ChangeLog.structure('Nova', { op: 'insertSheet', name: 'Nova' });
    ss.insertSheet('Nova');
    ctx.ChangeLog.structure('Exercícios', { op: 'insertColumns', sheet: 'Exercícios', after: cols, count: 2 });
    ss.getSheetByName('Exercícios').insertColumnsAfter(cols, 2);
    ctx.ChangeLog.structure('Exercícios', { op: 'namedRange', name: 'Lista' });
    ss.setNamedRange('Lista', ss.getSheetByName('Exercícios').getRange('A6:A10'));
  });
  assert.equal(ctx.ChangeLog.entries()[0].kind, 'structure');
  assert.equal(ctx.Tabs.read('log')[0].kind, 'Estrutura');
  ctx.Undo.last();
  assert.ok(ss.getSheetByName('Cadastro'));
  assert.equal(ss.getSheetByName('Exercícios'), null);
  assert.equal(ss.getSheetByName('Nova'), null);
  assert.equal(ss.getSheetByName('Cadastro').getMaxColumns(), cols);
  assert.equal(ss.getRangeByName('Lista'), null);
});

test('undo refuses a structural change whose result is gone', () => {
  const ctx = boot({ tabs: { exercises: [{ name: 'A' }] } });
  const ss = ctx.__spreadsheet;
  ctx.ChangeLog.run('Nova aba', () => {
    ctx.ChangeLog.structure('Nova', { op: 'insertSheet', name: 'Nova' });
    ss.insertSheet('Nova');
  });
  ss.getSheetByName('Nova').setName('Renomeada');
  assert.throws(() => ctx.Undo.last(), /aba "Nova" não existe mais/);
});

test('layout cells changed since the action block the undo', () => {
  const ctx = boot({ tabs: { exercises: [] } });
  ctx.Tabs.ensure('today');
  ctx.ChangeLog.run('Hoje', () => ctx.Tabs.setCells('today', { B7: 70 }));
  ctx.__spreadsheet.getSheetByName('Hoje').getRange('B7').setValue(71);
  assert.throws(() => ctx.Undo.last(), /células B7 de "Hoje" mudaram/);
});

test('undo of an action that wrote the same cells twice checks only the latest write, and counts changes', () => {
  const ctx = boot({ tabs: { diary: diaryRows() } });
  const before = snapshot(ctx, ['Diário']);
  let counted = null;
  ctx.ChangeLog.run('Lançar dois alimentos', () => {
    ctx.Tabs.append('diary', { date: '2026-09-29', kcal: 100 });
    ctx.Tabs.update('diary', 9, { kcal: 250 });
    ctx.Tabs.update('diary', 6, { weightKg: 67.5 });
    ctx.Tabs.update('diary', 6, { weightKg: 67.6 });
    counted = ctx.ChangeLog.changeCount();
  });
  assert.equal(counted, 4);
  assert.equal(ctx.ChangeLog.changeCount(), 0, 'no action running');
  ctx.Undo.last();
  trimRows(ctx, 'Diário');
  assert.equal(snapshot(ctx, ['Diário']), before);
});

test('action.committed listener errors are isolated in ChangeLog.run and Undo.apply_, preserving existing warnings', () => {
  const ctx = boot({ tabs: { diary: diaryRows() } });
  const errs = [];
  const origErr = ctx.console.error;
  ctx.console.error = (...a) => { errs.push(a); origErr(...a); };
  ctx.Core.on('action.committed', () => {
    throw new Error('derived refresh exploded');
  });

  const res1 = ctx.ChangeLog.run('Com aviso prévio', () => {
    ctx.Tabs.update('diary', 6, { weightKg: 68.2 });
    return { saved: true, warnings: ['existing_warning'] };
  });
  assert.equal(ctx.Tabs.readRow('diary', 6).weightKg, 68.2);
  eq(res1, { saved: true, warnings: ['existing_warning', 'derived_refresh_failed'] });
  assert.equal(errs.length, 1);

  const undone = ctx.Undo.last();
  assert.equal(ctx.Tabs.readRow('diary', 6).weightKg, 67.4);
  eq(undone.warnings, ['derived_refresh_failed']);
  assert.equal(errs.length, 2);
});

test('partial update, restored: rollback restores written cells when a later setValue throws, and proves restoration by re-read', () => {
  const ctx = boot({ tabs: { diary: diaryRows() } });
  const s = sheet(ctx, 'Diário');
  const beforeSnap = snapshot(ctx, ['Diário']);
  const origGetRange = s.getRange.bind(s);
  const sleepCol = ctx.Tabs.headerMap('diary').sleepH;
  const weightCol = ctx.Tabs.headerMap('diary').weightKg;
  let sleepWrites = 0;
  let weightWrites = 0;
  let observedApplied = null;
  const origRestore = ctx.Undo.restore_.bind(ctx.Undo);
  ctx.Undo.restore_ = (c) => {
    observedApplied = ctx.Undo.applied_(c);
    return origRestore(c);
  };
  s.getRange = (r, c, ...rest) => {
    const rng = origGetRange(r, c, ...rest);
    if (rest.length === 0 && r === 6 && c === weightCol) {
      const realSet = rng.setValue.bind(rng);
      rng.setValue = (v) => { weightWrites++; return realSet(v); };
    }
    if (rest.length === 0 && r === 6 && c === sleepCol) {
      const realSet = rng.setValue.bind(rng);
      rng.setValue = (v) => {
        sleepWrites++;
        if (sleepWrites === 1) throw new Error('second cell failed');
        return realSet(v);
      };
    }
    return rng;
  };

  assert.throws(
    () => ctx.ChangeLog.run('Update parcial', () => ctx.Tabs.update('diary', 6, { weightKg: 70.1, sleepH: 8 })),
    /second cell failed/,
  );
  assert.equal(observedApplied, false, 'applied_ was false on the half-written row');
  assert.equal(weightWrites, 2, 'first cell written then restored');
  assert.equal(sleepWrites, 1, 'unwritten second cell already matched before and needed no restore write');
  assert.equal(ctx.ChangeLog.lastRunState_, 'rolled_back');
  assert.equal(snapshot(ctx, ['Diário']), beforeSnap);
  assert.ok(ctx.ChangeLog.entries().every((e) => e.undone instanceof Date));
});

test('proven rollback covers update, append, delete and cells when an action throws midway', () => {
  const ctx = boot({ tabs: { diary: diaryRows() } });
  ctx.Tabs.ensure('today');
  const todaySheet = sheet(ctx, 'Hoje');
  todaySheet.getRange('B5').setValue('antes');
  todaySheet.getRange('B6').setFormula('=1+1');
  const beforeSnap = snapshot(ctx, ['Diário', 'Hoje']);

  // Partial setCells on Hoje (second cell throws) after append + delete + update on Diário
  const origTodayRange = todaySheet.getRange.bind(todaySheet);
  let b6Calls = 0;
  todaySheet.getRange = (a, ...rest) => {
    const rng = origTodayRange(a, ...rest);
    if (a === 'B6') {
      const realSet = rng.setValue.bind(rng);
      rng.setValue = (v) => {
        b6Calls++;
        if (b6Calls === 1) throw new Error('layout cell failed');
        return realSet(v);
      };
    }
    return rng;
  };

  assert.throws(() => ctx.ChangeLog.run('Tudo junto', () => {
    ctx.Tabs.update('diary', 6, { weightKg: 68 });
    ctx.Tabs.remove('diary', 7);
    ctx.Tabs.append('diary', { date: '2026-09-29', weightKg: 66.5 });
    ctx.Tabs.setCells('today', { B5: 'depois', B6: 'texto' });
  }), /layout cell failed/);

  todaySheet.getRange = origTodayRange;
  trimRows(ctx, 'Diário');
  assert.equal(snapshot(ctx, ['Diário', 'Hoje']), beforeSnap);
  assert.equal(ctx.ChangeLog.lastRunState_, 'rolled_back');
});

test('partial update, not proven: restore throw, re-read throw, or re-read mismatch throws rollback_failed after trying earlier changes', () => {
  const sleepColOf = (ctx) => ctx.Tabs.headerMap('diary').sleepH;
  const weightColOf = (ctx) => ctx.Tabs.headerMap('diary').weightKg;

  // Case 1: restoring write throws, and an earlier change in the same action is still reverted first
  {
    const ctx = boot({ tabs: { diary: diaryRows(), goals: [] } });
    const s = sheet(ctx, 'Diário');
    const origGetRange = s.getRange.bind(s);
    const weightCol = weightColOf(ctx);
    const sleepCol = sleepColOf(ctx);
    let weightCalls = 0;
    s.getRange = (r, c, ...rest) => {
      const rng = origGetRange(r, c, ...rest);
      if (rest.length === 0 && r === 6 && c === weightCol) {
        const realSet = rng.setValue.bind(rng);
        rng.setValue = (v) => {
          weightCalls++;
          if (weightCalls === 2) throw new Error('restore write failed');
          return realSet(v);
        };
      }
      if (rest.length === 0 && r === 6 && c === sleepCol) {
        rng.setValue = () => { throw new Error('second cell failed'); };
      }
      return rng;
    };
    assert.throws(() => ctx.ChangeLog.run('Falha na restauração', () => {
      ctx.Tabs.append('goals', { id: 'M001', kcal: 2200 });
      ctx.Tabs.update('diary', 6, { weightKg: 70, sleepH: 8 });
    }), (err) => err.code === 'rollback_failed' && err.writeState === 'unknown');
    assert.equal(ctx.ChangeLog.lastRunState_, 'rollback_failed');
    assert.equal(ctx.Tabs.read('goals').length, 0, 'earlier change on Goals was still reverted after Diário failed');
  }

  // Case 2: restoring write succeeds, but re-read throws
  {
    const ctx = boot({ tabs: { diary: diaryRows() } });
    const s = sheet(ctx, 'Diário');
    const origGetRange = s.getRange.bind(s);
    const weightCol = weightColOf(ctx);
    const sleepCol = sleepColOf(ctx);
    let calls = 0;
    let restoredWriteDone = false;
    s.getRange = (r, c, ...rest) => {
      const rng = origGetRange(r, c, ...rest);
      if (rest.length === 0 && r === 6 && c === weightCol) {
        const realSet = rng.setValue.bind(rng);
        rng.setValue = (v) => {
          calls++;
          const out = realSet(v);
          if (calls === 2) restoredWriteDone = true;
          return out;
        };
        const realGet = rng.getValue.bind(rng);
        rng.getValue = () => {
          if (restoredWriteDone) throw new Error('re-read failed');
          return realGet();
        };
      }
      if (rest.length === 0 && r === 6 && c === sleepCol) {
        rng.setValue = () => { throw new Error('second cell failed'); };
      }
      return rng;
    };
    assert.throws(
      () => ctx.ChangeLog.run('Falha na releitura', () => ctx.Tabs.update('diary', 6, { weightKg: 70, sleepH: 8 })),
      (err) => err.code === 'rollback_failed' && err.writeState === 'unknown',
    );
    assert.equal(ctx.ChangeLog.lastRunState_, 'rollback_failed');
  }

  // Case 3: restoring setValue silently drops the write (no exception), caught only by Undo.restored_ re-read
  {
    const ctx = boot({ tabs: { diary: diaryRows() } });
    const s = sheet(ctx, 'Diário');
    const origGetRange = s.getRange.bind(s);
    const weightCol = weightColOf(ctx);
    const sleepCol = sleepColOf(ctx);
    let weightCalls = 0;
    s.getRange = (r, c, ...rest) => {
      const rng = origGetRange(r, c, ...rest);
      if (rest.length === 0 && r === 6 && c === weightCol) {
        const realSet = rng.setValue.bind(rng);
        rng.setValue = (v) => {
          weightCalls++;
          if (weightCalls === 2) return rng; // silent no-op during restore
          return realSet(v);
        };
      }
      if (rest.length === 0 && r === 6 && c === sleepCol) {
        rng.setValue = () => { throw new Error('second cell failed'); };
      }
      return rng;
    };
    assert.throws(
      () => ctx.ChangeLog.run('Releitura divergente', () => ctx.Tabs.update('diary', 6, { weightKg: 70, sleepH: 8 })),
      (err) => err.code === 'rollback_failed' && err.writeState === 'unknown',
    );
    assert.equal(ctx.ChangeLog.lastRunState_, 'rollback_failed');
  }
});

test('skipped or unverifiable change (legacy formula or unknown change kind) throws rollback_failed', () => {
  // 1. A partial change with a legacy formula in `before` (which old applied_ returned false for and skipped)
  const ctx = boot({ tabs: { diary: diaryRows() } });
  const legacyBefore = ctx.Tabs.snapCell('=60+7.4', '=60+7.4');
  legacyBefore.legacy = true;
  const weightCol = ctx.Tabs.headerMap('diary').weightKg;
  assert.throws(() => ctx.ChangeLog.run('Legado', () => {
    ctx.ChangeLog.pending_.push({
      change: { kind: 'update', tab: 'Diário', row: 6, before: { 'Peso kg': legacyBefore, 'Sono h': '' }, after: { 'Peso kg': 70, 'Sono h': 8 } },
      logRow: 6,
    });
    sheet(ctx, 'Diário').setCell_(6, weightCol, 70);
    assert.equal(ctx.Undo.applied_(ctx.ChangeLog.pending_[0].change), false);
    throw new Error('abort');
  }), (err) => err.code === 'rollback_failed' && err.writeState === 'unknown');

  // 2. Unknown change kind without a restored_ check is never proven
  const ctx2 = boot({ tabs: { diary: diaryRows() } });
  assert.equal(ctx2.Undo.restored_({ kind: 'move', tab: 'Diário', row: 6, before: {}, after: {} }), false);
  assert.throws(() => ctx2.ChangeLog.run('Desconhecido', () => {
    ctx2.ChangeLog.pending_.push({ change: { kind: 'move', tab: 'Diário', row: 6, before: {}, after: {} }, logRow: 6 });
    throw new Error('abort');
  }), (err) => err.code === 'rollback_failed' && err.writeState === 'unknown');
});

test('failed revert in Undo throws rollback_failed both on exception and on silent mismatch', () => {
  // 1. Exception inside Undo.revert_
  {
    const ctx = boot({ tabs: { diary: diaryRows() } });
    ctx.ChangeLog.run('Salvar', () => ctx.Tabs.update('diary', 6, { weightKg: 68.5 }));
    const s = sheet(ctx, 'Diário');
    const origGetRange = s.getRange.bind(s);
    const weightCol = ctx.Tabs.headerMap('diary').weightKg;
    s.getRange = (r, c, ...rest) => {
      const rng = origGetRange(r, c, ...rest);
      if (rest.length === 0 && r === 6 && c === weightCol) {
        rng.setValue = () => { throw new Error('sheet locked'); };
      }
      return rng;
    };
    assert.throws(() => ctx.Undo.last(), (err) => err.code === 'rollback_failed' && err.writeState === 'unknown');
  }

  // 2. Silent no-op setValue inside Undo.revert_ caught by Undo.restored_
  {
    const ctx = boot({ tabs: { diary: diaryRows() } });
    ctx.ChangeLog.run('Salvar', () => ctx.Tabs.update('diary', 6, { weightKg: 68.5 }));
    const s = sheet(ctx, 'Diário');
    const origGetRange = s.getRange.bind(s);
    const weightCol = ctx.Tabs.headerMap('diary').weightKg;
    s.getRange = (r, c, ...rest) => {
      const rng = origGetRange(r, c, ...rest);
      if (rest.length === 0 && r === 6 && c === weightCol) {
        rng.setValue = () => rng;
      }
      return rng;
    };
    assert.throws(() => ctx.Undo.last(), (err) => err.code === 'rollback_failed' && err.writeState === 'unknown');
  }
});
