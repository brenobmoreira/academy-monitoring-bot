'use strict';
/**
 * Last review of the staged migration (F1–F7): a recovery never deletes what it cannot prove is
 * the migration's (columns, tabs), a recovery killed midway is finished by the next one, writes
 * outside the Log (triggers, screen and menu actions) wait for an open operation, and an older
 * migration's "done" follows the Log after its steps are undone.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { load, freshExecution, parallelExecution, plain } = require('./harness');
const { snapshot } = require('./fakes');

const NOW = '2026-09-29T15:00:00-03:00';
const clientText = (name) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'clients', `${name}.json`), 'utf8');
const boot = (name = 'zoio') => load({ fixture: `${name}_3_0`, now: NOW });

function comparable(ctx) {
  const snap = snapshot(ctx);
  const sheets = snap.sheets.filter((s) => s.name !== 'Log')
    .map((s) => ({ name: s.name, values: s.values.map((r) => r.map((v) => (v && v.$formula ? { $formula: v.$formula } : v))) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return JSON.stringify({ sheets, namedRanges: snap.namedRanges });
}
const confirm = (ctx) => plain(ctx.wizardConfirm({ json: clientText('zoio') }));
const step = (ctx, st) => plain(ctx.wizardStep(st.opId, st.next, st.cursor));
function finish(ctx, st) {
  let s = st;
  while (s.state === 'running') s = step(ctx, s).state;
  return s;
}

/** Runs `call` in the VM until a hook installed by `hook` (VM-side code) loops; no finally runs. */
function kill(ctx, hook, call) {
  vm.runInContext(hook, ctx);
  assert.throws(() => vm.runInContext(call, ctx, { timeout: 2500 }), /timed out/);
  const finallyRan = ctx.ChangeLog.current_ === null && ctx.Core.lockDepth_ === 0;
  ctx.__releaseLocks();
  return finallyRan;
}

/** Kills the body right after its first column insertion (Semanas: after 33, count 12). */
function killAtFirstInsert(ctx) {
  ctx.__args = { json: clientText('zoio') };
  const ran = kill(ctx, `(function () {
    var o = Migrate.ensureColumns_;
    Migrate.ensureColumns_ = function (sheet, n) { var b = sheet.getMaxColumns(); var r = o.apply(this, arguments); if (sheet.getMaxColumns() > b) { for (;;) {} } return r; };
  })()`, 'wizardConfirm(__args)');
  assert.equal(ran, false, 'hard kill: no finally ran');
  freshExecution(ctx);
  const s = ctx.ChangeLog.entries().filter((e) => e.kind === 'structure' && e.after.op === 'insertColumns').pop().after;
  assert.deepEqual(plain(s), { op: 'insertColumns', sheet: 'Semanas', after: 33, count: 12 });
  return ctx.SpreadsheetApp.getActive().getSheetByName('Semanas');
}

/* F1: a recovery deletes no column (and no data) it cannot prove the migration's ------------- */

test('F1 exact case: a column inserted by hand after the kill (45 → 46) keeps "DADO HUMANO"; explicit conflict', () => {
  const ctx = boot();
  const semanas = killAtFirstInsert(ctx);
  assert.equal(semanas.getMaxColumns(), 45);
  semanas.insertColumnAfter(33);
  semanas.getRange('AH1').setValue('DADO HUMANO');
  assert.equal(semanas.getMaxColumns(), 46);
  const before = comparable(ctx);
  assert.throws(() => ctx.wizardStatus(), (err) => err.apiErrors[0].code === 'interrupted_conflict' && /colunas de "Semanas" mudaram/.test(err.message));
  assert.equal(semanas.getRange('AH1').getValue(), 'DADO HUMANO');
  assert.equal(semanas.getMaxColumns(), 46);
  assert.equal(comparable(ctx), before, 'nothing reverted (no hidden partial rollback)');
  assert.equal(plain(ctx.Migrate.op_()).phase, 'migrating', 'the recovery stays available');
});

[
  ['before the inserted columns', (s) => s.insertColumnAfter(10)],
  ['inside them', (s) => s.insertColumnAfter(40)],
  ['after them', (s) => s.insertColumnAfter(45)],
  ['one fewer (a column deleted)', (s) => s.deleteColumn(40)],
].forEach(([where, edit]) => {
  test(`F1: width changed by hand ${where}: conflict, nothing deleted`, () => {
    const ctx = boot();
    const semanas = killAtFirstInsert(ctx);
    edit(semanas);
    const width = semanas.getMaxColumns();
    const before = comparable(ctx);
    assert.throws(() => ctx.wizardStatus(), (err) => err.apiErrors[0].code === 'interrupted_conflict');
    assert.equal(semanas.getMaxColumns(), width);
    assert.equal(comparable(ctx), before);
  });
});

test('F1: expected width but content the migration did not write in those columns: conflict, kept', () => {
  const ctx = boot();
  const semanas = killAtFirstInsert(ctx);
  semanas.getRange('AL20').setValue('anotação');
  assert.throws(() => ctx.wizardStatus(), (err) => /Semanas!AL20 tem conteúdo que a migração não escreveu/.test(err.message));
  assert.equal(semanas.getRange('AL20').getValue(), 'anotação');
  assert.equal(semanas.getMaxColumns(), 45);
});

test('F1: without hand edits the same kill is recovered and the migration finishes and undoes', () => {
  const ctx = boot();
  const original = comparable(ctx);
  killAtFirstInsert(ctx);
  assert.equal(plain(ctx.wizardStatus()).state, 'tables');
  assert.equal(finish(ctx, confirm(ctx).state).state, 'done');
  ctx.Undo.last();
  assert.equal(comparable(ctx), original);
});

test('F1: a tab the migration created, with something typed in it after the kill, is not deleted', () => {
  const ctx = boot();
  ctx.__args = { json: clientText('zoio') };
  kill(ctx, `(function () {
    var o = Migrate.createTabs_;
    Migrate.createTabs_ = function () { var r = o.apply(this, arguments); for (;;) {} return r; };
  })()`, 'wizardConfirm(__args)');
  freshExecution(ctx);
  const created = ctx.ChangeLog.entries().filter((e) => e.kind === 'structure' && e.after.op === 'insertSheet').map((e) => e.after.name);
  assert.ok(created.length > 0);
  const tab = ctx.SpreadsheetApp.getActive().getSheetByName(created[0]);
  tab.getRange('B20').setValue('anotada à mão');
  assert.throws(() => ctx.wizardStatus(), (err) => new RegExp(`aba "${created[0]}", criada pela migração, tem conteúdo que ela não escreveu`).test(err.message));
  assert.ok(ctx.SpreadsheetApp.getActive().getSheetByName(created[0]));
  assert.equal(tab.getRange('B20').getValue(), 'anotada à mão');
});

test('F1: a renamed tab whose old name was taken by hand is not renamed over it', () => {
  const ctx = boot();
  ctx.__args = { json: clientText('zoio') };
  kill(ctx, `(function () {
    var o = Migrate.renameTabs_;
    Migrate.renameTabs_ = function () { var r = o.apply(this, arguments); for (;;) {} return r; };
  })()`, 'wizardConfirm(__args)');
  freshExecution(ctx);
  const renames = ctx.ChangeLog.entries().filter((e) => e.kind === 'structure' && e.after.op === 'renameSheet').map((e) => e.after);
  assert.ok(renames.length > 0);
  const ss = ctx.SpreadsheetApp.getActive();
  const theirs = ss.insertSheet(renames[0].from);
  theirs.getRange('A1').setValue('aba nova da pessoa');
  assert.throws(() => ctx.wizardStatus(), (err) => /não pode voltar a se chamar/.test(err.message));
  assert.ok(ss.getSheetByName(renames[0].to), 'the renamed tab is kept');
  assert.equal(theirs.getRange('A1').getValue(), 'aba nova da pessoa');
});

/* F2: a recovery killed midway is finished by the next one ----------------------------------- */

/** Kills the body just before its schema marker (many changes: renames, tabs, columns, cells). */
function killBody(ctx) {
  ctx.__args = { json: clientText('zoio') };
  kill(ctx, `(function () {
    var o = Migrate.clearLayoutFormulas_;
    Migrate.clearLayoutFormulas_ = function () { var r = o.apply(this, arguments); for (;;) {} return r; };
  })()`, 'wizardConfirm(__args)');
  freshExecution(ctx);
}

/** VM hook that loops on the n-th call of obj[fn] (obj: VM expression), after the call. */
const loopOn = (obj, fn, n) => `(function () {
  var t = ${obj}; var o = t.${fn}; var k = 0; globalThis.__restore = function () { t.${fn} = o; };
  t.${fn} = function () { var r = o.apply(this, arguments); k++; if (k === ${n}) { for (;;) {} } return r; };
})()`;
const sheetProto = 'Object.getPrototypeOf(SpreadsheetApp.getActive().getSheets()[0])';

[
  ['after the 1st cell was put back', () => loopOn('Undo', 'setCell_', 1)],
  ['halfway through the cells', () => loopOn('Undo', 'setCell_', 40)],
  ['after a column block was removed', () => loopOn(sheetProto, 'deleteColumns', 1)],
  ['after a created tab was removed', () => loopOn('Object.getPrototypeOf(SpreadsheetApp.getActive())', 'deleteSheet', 1)],
  ['after a tab got its 3.0 name back', () => loopOn(sheetProto, 'setName', 1)],
  ['after every revert, before the Log is marked', () => `(function () {
    var o = Tabs.update; globalThis.__restore = function () { Tabs.update = o; };
    Tabs.update = function (id) { if (id === 'log') { for (;;) {} } return o.apply(this, arguments); };
  })()`],
  ['after some Log rows were marked', () => `(function () {
    var o = Tabs.update; var k = 0; globalThis.__restore = function () { Tabs.update = o; };
    Tabs.update = function (id) { var r = o.apply(this, arguments); if (id === 'log' && ++k === 5) { for (;;) {} } return r; };
  })()`],
].forEach(([when, hook]) => {
  test(`F2: the recovery killed ${when}: the next execution finishes it, no conflict, undo back to 3.0`, () => {
    const ctx = boot();
    const original = comparable(ctx);
    killBody(ctx);
    const ran = kill(ctx, hook(), 'wizardStatus()');
    vm.runInContext('globalThis.__restore && globalThis.__restore()', ctx);
    assert.equal(ran, false, 'hard kill of the recovery itself');
    freshExecution(ctx);
    const st = plain(ctx.wizardStatus());
    assert.equal(st.state, 'tables', 'recovered');
    assert.equal(ctx.ChangeLog.entries().filter((e) => !e.undone).length, 0, 'every body row marked undone');
    assert.equal(comparable(ctx), original, 'back to the 3.0 file before the retry');
    assert.equal(finish(ctx, confirm(ctx).state).state, 'done');
    ctx.Undo.last();
    assert.equal(comparable(ctx), original);
  });
});

test('F2: a recovery killed twice in a row (cells, then structures) still converges', () => {
  const ctx = boot();
  const original = comparable(ctx);
  killBody(ctx);
  kill(ctx, loopOn('Undo', 'setCell_', 25), 'wizardStatus()');
  vm.runInContext('globalThis.__restore()', ctx);
  freshExecution(ctx);
  kill(ctx, loopOn(sheetProto, 'deleteColumns', 1), 'wizardStatus()');
  vm.runInContext('globalThis.__restore()', ctx);
  freshExecution(ctx);
  assert.equal(plain(ctx.wizardStatus()).state, 'tables');
  assert.equal(comparable(ctx), original);
});

test('F2: a cell written A → B → C, put back to A, recovery killed before the Log: no false conflict', () => {
  const ctx = boot();
  const painel = ctx.SpreadsheetApp.getActive().getSheetByName(ctx.Tabs.get('dashboard').name);
  painel.getRange('Z1').setValue('A');
  painel.getRange('Z2').setFormula('=1+1');
  const original = comparable(ctx);
  const id = ctx.ChangeLog.newId_();
  ctx.Migrate.saveOp_({ id: 'op1', phase: 'migrating', actionId: id, next: [], cursor: null, failed: null });
  ctx.__id = id;
  kill(ctx, '0', `ChangeLog.run('Migrar 3.0 → 4.0', function () {
    Tabs.setCells('dashboard', { Z1: 'B', Z2: new Date(2026, 8, 14) });
    Tabs.setCells('dashboard', { Z1: 'C', Z2: '=2+2' });
    for (;;) {}
  }, { id: __id })`);
  freshExecution(ctx);
  kill(ctx, `(function () {
    var o = Tabs.update; globalThis.__restore = function () { Tabs.update = o; };
    Tabs.update = function (id) { if (id === 'log') { for (;;) {} } return o.apply(this, arguments); };
  })()`, 'wizardStatus()');
  vm.runInContext('globalThis.__restore()', ctx);
  assert.equal(painel.getRange('Z1').getValue(), 'A', 'put back before the kill');
  freshExecution(ctx);
  assert.equal(plain(ctx.wizardStatus()).state, 'tables', 'recovered (the operation waits for its tables step)');
  assert.equal(painel.getRange('Z1').getValue(), 'A');
  assert.equal(painel.getRange('Z2').getFormula(), '=1+1');
  assert.equal(comparable(ctx), original);
});

test('F2: a person editing a cell during a half-done recovery is still a conflict, not overwritten', () => {
  const ctx = boot();
  killBody(ctx);
  kill(ctx, loopOn('Undo', 'setCell_', 5), 'wizardStatus()');
  vm.runInContext('globalThis.__restore()', ctx);
  freshExecution(ctx);
  // A cell the body wrote and the recovery has not put back yet.
  const body = ctx.ChangeLog.entries().filter((e) => !e.undone && e.kind === 'cells' && e.tab === 'Config');
  const a1 = Object.keys(body[body.length - 1].after)[0];
  const cell = ctx.SpreadsheetApp.getActive().getSheetByName('Config').getRange(a1);
  cell.setValue('digitado à mão');
  assert.throws(() => ctx.wizardStatus(), (err) => err.apiErrors[0].code === 'interrupted_conflict');
  assert.equal(cell.getValue(), 'digitado à mão');
});

/* F4: writes outside the Log wait for an open operation ---------------------------------------- */

test('F4 exact case: dailyRefresh during the steps is postponed, and the migration still undoes cleanly', () => {
  const ctx = boot();
  const original = comparable(ctx);
  step(ctx, confirm(ctx).state); // weeks
  ctx.__clock.advance(60000);
  freshExecution(ctx);
  const rows = ctx.ChangeLog.entries().length;
  const semanas = () => JSON.stringify(plain(ctx.SpreadsheetApp.getActive().getSheetByName('Semanas').getDataRange().getValues()));
  const before = semanas();
  const r = plain(ctx.dailyRefresh());
  assert.match(r.skipped, /migração 3\.0 → 4\.0 está em andamento/);
  assert.equal(ctx.ChangeLog.entries().length, rows);
  assert.equal(semanas(), before);
  ctx.Undo.last();
  assert.equal(comparable(ctx), original);
});

test('F4: menu and screen actions that write wait; undo and the migration dialog still run', () => {
  const ctx = boot();
  const st = confirm(ctx).state;
  const before = comparable(ctx);
  ['weeksRecompute', 'dashboardRefresh', 'setupApply', 'loadDay', 'clearScreen', 'weeksRefresh', 'audit'].forEach((id) => {
    const r = plain(ctx.Actions.run(id));
    assert.equal(r.ok, false, id);
    assert.match(r.error, /migração 3\.0 → 4\.0 está em andamento/, id);
  });
  assert.equal(comparable(ctx), before, 'nothing written');
  assert.equal(plain(ctx.Actions.run('migrate')).ok, true, 'the dialog opens');
  assert.equal(plain(ctx.Actions.run('setupWizard')).ok, true);
  // Measures typed during the migration are not stamped (no write outside the Log).
  const medidas = ctx.SpreadsheetApp.getActive().getSheetByName(ctx.Tabs.get('measures').name);
  const toasts = ctx.__toasts.length;
  ctx.onEditInstalled({ range: medidas.getRange(6, 2), value: 80 });
  assert.ok(ctx.__toasts.length > toasts, 'the person is told');
  // After the operation everything runs again, derived tabs included.
  finish(ctx, st);
  assert.equal(plain(ctx.Actions.run('weeksRecompute')).ok, true);
  assert.equal(plain(ctx.dailyRefresh()).skipped, undefined);
});

test('F4: undoLast stays available during the steps (it reverts the whole operation)', () => {
  const ctx = boot();
  const original = comparable(ctx);
  confirm(ctx);
  assert.equal(plain(ctx.Actions.run('undoLast')).ok, true);
  assert.equal(comparable(ctx), original);
  assert.equal(plain(ctx.wizardStatus()).state, 'none', 'no lock left behind');
});

/* F7: an older migration's "done" follows the Log after its steps are undone ------------------- */

function legacy(name, steps) {
  const ctx = boot(name);
  ctx.Migrate.run(JSON.parse(clientText(name)), { staged: true });
  ctx.Migrate.dropOp_();
  const fns = {
    'Recalcular semanas': () => ctx.Weeks.recomputeAll(),
    'Aplicar layout': () => ctx.Setup.apply({ dashboard: false }),
    'Atualizar painel': () => ctx.Dashboard.render(),
  };
  steps.forEach((s) => ctx.Core.mute(ctx.Migrate.DERIVED_EVENTS, () => ctx.Core.withLock(() => ctx.ChangeLog.run(`Migrar 3.0 → 4.0 — ${s}`, fns[s]))));
  freshExecution(ctx);
  return ctx;
}

['breno', 'zoio'].forEach((name) => {
  test(`F7 exact case (${name}): done after the real audit, then undoing the audit and the Painel brings the steps back`, () => {
    const ctx = legacy(name, ['Recalcular semanas', 'Aplicar layout', 'Atualizar painel']);
    let st = plain(ctx.wizardStatus());
    assert.equal(st.next, 'audit');
    st = step(ctx, st).state; // the real final audit
    assert.equal(st.state, 'done');
    freshExecution(ctx);
    ctx.Undo.last(); // the audit (its "concluída" row is its proof)
    freshExecution(ctx);
    st = plain(ctx.wizardStatus());
    assert.equal(st.state, 'running');
    assert.equal(st.next, 'audit');
    ctx.Undo.last(); // "Atualizar painel" of the older dialog
    freshExecution(ctx);
    st = plain(ctx.wizardStatus());
    assert.equal(st.state, 'running');
    assert.equal(st.next, 'styles', 'the layout is proven only by a later Painel');
    assert.ok(ctx.Migrate.op_(), 'the saved state was reconciled, not dropped');
    // Finishing again ends in done; confirming again changes nothing.
    assert.equal(finish(ctx, st).state, 'done');
    const again = plain(ctx.wizardConfirm({ json: clientText(name) }));
    assert.equal(again.alreadyMigrated, true);
  });
});

test('F7: an older migration with steps left does not block the bot', () => {
  const ctx = legacy('zoio', ['Recalcular semanas']);
  assert.equal(plain(ctx.wizardStatus()).state, 'running');
  const r = plain(ctx.SheetApi.run('diary.upsert', { date: '2026-09-29', fields: { weightKg: 80 } }, 'req-legacy-1'));
  assert.equal(r.ok, true);
});

test('F7: every finished step leaves its "concluída" proof in Auditoria, inside the operation', () => {
  const ctx = boot();
  assert.equal(finish(ctx, confirm(ctx).state).state, 'done');
  const proofs = ctx.Tabs.read('audit').filter((r) => r.code === 'step_done').map((r) => r.cell);
  assert.deepEqual(plain(proofs), ['weeks', 'styles', 'dashboard', 'audit']);
  ctx.Migrate.dropOp_();
  freshExecution(ctx);
  assert.equal(plain(ctx.wizardStatus()).state, 'done', 'read back from the proofs alone');
});

/* Final review P1 (a): a recovery whose Log was marked halfway still knows each cell's history -- */

const painelOf = (ctx) => ctx.SpreadsheetApp.getActive().getSheetByName(ctx.Tabs.get('dashboard').name);
const restore = (ctx) => vm.runInContext('globalThis.__restore && globalThis.__restore()', ctx);
const entriesOf = (ctx, actionId) => ctx.ChangeLog.entries().filter((e) => e.actionId === actionId);
/** Log, saved operation and sheets: what a rejected plan must leave exactly as it found it. */
const state = (ctx) => JSON.stringify([comparable(ctx), plain(ctx.ChangeLog.entries()), plain(ctx.Migrate.op_())]);

/** VM hook: loops before the (n+1)-th Log row is marked undone (after n marks). */
const killAfterMarks = (n) => `(function () {
  var o = Tabs.update; var k = 0; globalThis.__restore = function () { Tabs.update = o; };
  Tabs.update = function (id) { if (id === 'log' && k === ${n}) { for (;;) {} } var r = o.apply(this, arguments); if (id === 'log') k++; return r; };
})()`;
/** VM hook: loops right after Log row `row` is marked undone. */
const killAfterMarking = (row) => `(function () {
  var o = Tabs.update; globalThis.__restore = function () { Tabs.update = o; };
  Tabs.update = function (id, r) { var out = o.apply(this, arguments); if (id === 'log' && r === ${row}) { for (;;) {} } return out; };
})()`;
/** VM hook: loops after every Log row is marked, before the recovery reports it. */
const killAfterAllMarks = `(function () {
  var o = Migrate.log_; globalThis.__restore = function () { Migrate.log_ = o; };
  Migrate.log_ = function (text) { if (/interrompida desfeita/.test(String(text))) { for (;;) {} } return o.apply(this, arguments); };
})()`;

/** A body hard-killed after `writes` (VM source: an array of Painel cell maps), one action. */
function interruptedWrites(ctx, writes) {
  const id = ctx.ChangeLog.newId_();
  ctx.Migrate.saveOp_({ id: 'op1', phase: 'migrating', actionId: id, next: [], cursor: null, failed: null });
  ctx.__id = id;
  const ran = kill(ctx, '0', `ChangeLog.run('Migrar 3.0 → 4.0', function () {
    ${writes}.forEach(function (w) { Tabs.setCells('dashboard', w); });
    for (;;) {}
  }, { id: __id })`);
  assert.equal(ran, false, 'hard kill of the body');
  freshExecution(ctx);
  return id;
}

/** Kills the recovery (hard) with `hook`, then opens a new execution. */
function killRecovery(ctx, hook) {
  const ran = kill(ctx, hook, 'wizardStatus()');
  restore(ctx);
  assert.equal(ran, false, 'hard kill of the recovery');
  freshExecution(ctx);
}

/** The recovery converged: no false conflict, every row of the action marked, the 3.0 file. */
function assertRecovered(ctx, actionId, original) {
  assert.equal(plain(ctx.wizardStatus()).state, 'tables', 'recovered, no interrupted_conflict');
  assert.deepEqual(plain(entriesOf(ctx, actionId).filter((e) => !e.undone).map((e) => e.logRow)), [], 'every row of the action marked undone');
  assert.equal(comparable(ctx), original, 'back to the file before the body');
  // Asking again (new executions) changes nothing and finds nothing left.
  const rows = ctx.ChangeLog.entries().length;
  for (let i = 0; i < 2; i++) {
    freshExecution(ctx);
    assert.equal(plain(ctx.wizardStatus()).state, 'tables');
  }
  assert.equal(ctx.ChangeLog.entries().length, rows, 'no new Log rows');
  assert.equal(comparable(ctx), original);
}

test('P1a exact case: Painel!Z1 A → B → C by the real body, recovery killed after marking only A → B: A stays, no false conflict', () => {
  const ctx = boot();
  const A = 'Breno era cliente. Planilha 3.0 está pronta.';
  const B = 'Planilha 3.0 está pronta.';
  painelOf(ctx).getRange('Z1').setValue(A);
  const original = comparable(ctx);
  killBody(ctx); // the real body, hard-killed after clearLayoutFormulas_, before the schema marker
  const actionId = ctx.Migrate.op_().actionId;
  const painel = painelOf(ctx).getName();
  const z1 = entriesOf(ctx, actionId).filter((e) => e.kind === 'cells' && e.tab === painel && 'Z1' in e.after);
  assert.deepEqual(plain(z1.map((e) => [e.before.Z1, e.after.Z1])), [[A, B], [B, ctx.Migrate.STATUS_TEXT]], 'fixResidues_ then fixStaleTexts_');
  assert.equal(painelOf(ctx).getRange('Z1').getValue(), ctx.Migrate.STATUS_TEXT);
  killRecovery(ctx, killAfterMarking(z1[0].logRow));
  const marks = entriesOf(ctx, actionId).filter((e) => e.logRow === z1[0].logRow || e.logRow === z1[1].logRow).map((e) => !!e.undone);
  assert.deepEqual(plain(marks), [true, false], 'A → B marked, B → C still pending');
  assert.equal(painelOf(ctx).getRange('Z1').getValue(), A, 'the killed recovery had put A back');
  assertRecovered(ctx, actionId, original);
  assert.equal(painelOf(ctx).getRange('Z1').getValue(), A);
  // The retry is a new body (its own action); the old rows stay marked; one undo returns to 3.0.
  assert.equal(finish(ctx, confirm(ctx).state).state, 'done');
  const retry = ctx.ChangeLog.actions().filter((a) => a.label === 'Migrar 3.0 → 4.0' && !a.undone);
  assert.equal(retry.length, 1);
  assert.notEqual(retry[0].id, actionId);
  const again = entriesOf(ctx, retry[0].id).filter((e) => e.kind === 'cells' && e.tab === painel && 'Z1' in e.after);
  // The new body wrote its own chain from A; the later Painel step then renders the tab again.
  assert.deepEqual(plain(again.slice(0, 2).map((e) => [e.before.Z1, e.after.Z1])), [[A, B], [B, ctx.Migrate.STATUS_TEXT]], 'the new body wrote its own chain from A');
  assert.equal(entriesOf(ctx, actionId).every((e) => e.undone), true, 'the interrupted rows stay marked');
  assert.equal(painelOf(ctx).getRange('Z1').getValue(), again[again.length - 1].after.Z1);
  ctx.Undo.last();
  assert.equal(comparable(ctx), original);
});

test('P1a: a cycle A → B → A, recovery killed after the first mark: always A, never the intermediate B', () => {
  const ctx = boot();
  painelOf(ctx).getRange('Z1').setValue('A');
  painelOf(ctx).getRange('Z2').setValue('p');
  const original = comparable(ctx);
  const id = interruptedWrites(ctx, "[{ Z1: 'B', Z2: 'q' }, { Z1: 'A' }]");
  assert.equal(painelOf(ctx).getRange('Z1').getValue(), 'A');
  killRecovery(ctx, killAfterMarks(1));
  assert.equal(entriesOf(ctx, id).filter((e) => e.undone).length, 1);
  assertRecovered(ctx, id, original);
  assert.equal(painelOf(ctx).getRange('Z1').getValue(), 'A');
  assert.equal(painelOf(ctx).getRange('Z2').getValue(), 'p');
});

// Several cells, several writes each: Z1 A → B → C → B, Z2 formula → date → formula, Z3 x → y → x,
// Z4 empty → n → m.
const CHAINS = "[{ Z1: 'B', Z2: new Date(2026, 8, 14), Z3: 'y' }, { Z1: 'C', Z2: '=2+2', Z3: 'x', Z4: 'n' }, { Z1: 'B', Z4: 'm' }]";
function bootChains() {
  const ctx = boot();
  const p = painelOf(ctx);
  p.getRange('Z1').setValue('A');
  p.getRange('Z2').setFormula('=1+1');
  p.getRange('Z3').setValue('x');
  return ctx;
}
function assertChainsBack(ctx) {
  const p = painelOf(ctx);
  assert.deepEqual([p.getRange('Z1').getValue(), p.getRange('Z2').getFormula(), p.getRange('Z3').getValue(), p.getRange('Z4').getValue()], ['A', '=1+1', 'x', '']);
}

[
  ['after the 1st cell was put back', () => loopOn('Undo', 'setCell_', 1)],
  ['after the 2nd cell was put back', () => loopOn('Undo', 'setCell_', 2)],
  ['after every cell, before any mark', () => killAfterMarks(0)],
  ['after 1 mark', () => killAfterMarks(1)],
  ['after 2 marks', () => killAfterMarks(2)],
  ['after every mark', () => killAfterAllMarks],
].forEach(([when, hook]) => {
  test(`P1a: several cells and writes, recovery killed ${when}: converges to the originals`, () => {
    const ctx = bootChains();
    const original = comparable(ctx);
    const id = interruptedWrites(ctx, CHAINS);
    assert.ok(entriesOf(ctx, id).length >= 3, 'one Log row per write at least');
    killRecovery(ctx, hook());
    assertRecovered(ctx, id, original);
    assertChainsBack(ctx);
  });
});

test('P1a: the recovery killed twice after partial marks still converges', () => {
  const ctx = bootChains();
  const original = comparable(ctx);
  const id = interruptedWrites(ctx, CHAINS);
  killRecovery(ctx, killAfterMarks(1));
  killRecovery(ctx, killAfterMarks(1));
  assert.ok(entriesOf(ctx, id).filter((e) => e.undone).length >= 2);
  assertRecovered(ctx, id, original);
  assertChainsBack(ctx);
});

test('P1a: another action on the same cell does not leak into the target or the allowed values', () => {
  const setup = () => {
    const ctx = boot();
    painelOf(ctx).getRange('Z1').setValue('A0');
    ctx.ChangeLog.run('Outra ação', () => ctx.Tabs.setCells('dashboard', { Z1: 'A' }));
    const other = ctx.ChangeLog.actions().filter((a) => a.label === 'Outra ação')[0].id;
    const original = comparable(ctx);
    const id = interruptedWrites(ctx, "[{ Z1: 'B' }, { Z1: 'C' }]");
    killRecovery(ctx, killAfterMarks(1));
    return { ctx, other, original, id };
  };
  // Recovered to the value before the migration (A), not to the other action's before (A0).
  const r = setup();
  assertRecovered(r.ctx, r.id, r.original);
  assert.equal(painelOf(r.ctx).getRange('Z1').getValue(), 'A');
  assert.equal(entriesOf(r.ctx, r.other).every((e) => !e.undone), true, 'the other action is untouched');
  // A0 is not one of the migration's values: typed now, it is a conflict.
  const c = setup();
  painelOf(c.ctx).getRange('Z1').setValue('A0');
  const before = state(c.ctx);
  assert.throws(() => c.ctx.wizardStatus(), (err) => err.apiErrors[0].code === 'interrupted_conflict' && /Z1 mudou/.test(err.message));
  assert.equal(state(c.ctx), before, 'nothing written, no Log row marked, the operation as it was');
});

test('P1a: a value outside the action history, typed after a partial mark, blocks with nothing written', () => {
  const ctx = bootChains();
  const id = interruptedWrites(ctx, CHAINS);
  killRecovery(ctx, killAfterMarks(1));
  painelOf(ctx).getRange('Z1').setValue('digitado à mão');
  const before = state(ctx);
  for (let i = 0; i < 2; i++) {
    assert.throws(() => ctx.wizardStatus(), (err) => err.apiErrors[0].code === 'interrupted_conflict' && /Z1 mudou/.test(err.message));
    assert.equal(state(ctx), before, 'no cell, structure, Log mark or state changed by the rejected plan');
    freshExecution(ctx);
  }
  assert.equal(painelOf(ctx).getRange('Z1').getValue(), 'digitado à mão');
  assert.equal(plain(ctx.Migrate.op_()).phase, 'migrating');
  assert.ok(entriesOf(ctx, id).some((e) => !e.undone));
});

/* Final review P1 (b): the migration check of Actions.run is decided under the lock --------------- */

/**
 * Execution A runs action `id` with no migration open; when A asks for the script lock (before
 * holding it), execution B starts the migration through the dialog and lets the lock go. The
 * body of the action is wrapped by a pass-through counter (it still runs the real code).
 */
function raceAgainstMigration(id) {
  const a = boot();
  const original = comparable(a);
  const b = parallelExecution(a);
  const seen = {};
  const def = a.Actions.get(id);
  const body = def.run;
  seen.calls = 0;
  def.run = function () { seen.calls++; return body.apply(this, arguments); };
  const getScriptLock = a.LockService.getScriptLock;
  a.LockService.getScriptLock = function () {
    a.LockService.getScriptLock = getScriptLock; // only A's first request is intercepted
    const lock = getScriptLock.apply(this, arguments);
    const wait = lock.waitLock;
    lock.waitLock = function () {
      seen.opBeforeB = a.Migrate.op_();
      seen.heldBeforeB = lock.hasLock();
      seen.b = plain(b.wizardConfirm({ json: clientText('zoio') }));
      seen.afterB = state(a);
      return wait.apply(this, arguments);
    };
    return lock;
  };
  const out = plain(a.Actions.run(id));
  return { a, b, original, seen, out };
}

[
  ['weeksRecompute', false],
  ['dashboardRefresh', false],
  ['setupApply', false],
  ['audit', true],
].forEach(([id, logged]) => {
  test(`P1b: ${id} (${logged ? 'logged' : 'logged:false'}) waiting for the lock while another execution starts the migration is refused, nothing written`, () => {
    const r = raceAgainstMigration(id);
    assert.equal(r.a.Actions.get(id).logged, logged);
    assert.equal(r.seen.opBeforeB, null, 'A passed the early check with no migration');
    assert.equal(r.seen.heldBeforeB, false, 'B ran before A held the lock');
    assert.equal(r.seen.b.state.state, 'running');
    assert.equal(r.seen.b.state.next, 'weeks');
    assert.equal(r.out.ok, false, 'refused, not a success');
    assert.match(r.out.error, /A migração 3\.0 → 4\.0 está em andamento/);
    assert.equal(r.seen.calls, 0, 'the action body never ran');
    assert.equal(state(r.a), r.seen.afterB, 'sheets, Log and operation exactly as B left them');
    // B's operation goes on and one undo returns to the 3.0 file, with no conflict.
    assert.equal(finish(r.b, r.seen.b.state).state, 'done');
    assert.equal(plain(r.a.Actions.run(id)).ok, true, 'runs again once the operation is done');
    // Back to the migration as the latest action (the audit A just ran, when it wrote anything).
    while (r.a.Undo.pending()[0].label !== 'Migrar 3.0 → 4.0') r.a.Undo.last();
    r.b.Undo.last();
    assert.equal(comparable(r.a), r.original);
    assert.equal(r.a.ChangeLog.blockedReason(r.a.Actions.get(id).label), null, 'nothing blocks after the undo');
  });
});

test('P1b controls: with no migration the actions run; the dialog and undo run during the steps', () => {
  const a = boot();
  assert.equal(finish(a, confirm(a).state).state, 'done');
  ['weeksRecompute', 'dashboardRefresh', 'setupApply'].forEach((id) => {
    const r = plain(a.Actions.run(id));
    assert.equal(r.ok, true, id);
    assert.equal(typeof r.result.message, 'string', id);
  });
  const c = boot();
  const original = comparable(c);
  const st = confirm(c).state;
  const before = state(c);
  assert.equal(plain(c.Actions.run('migrate')).ok, true, 'the dialog opens (duringMigration)');
  assert.equal(state(c), before);
  assert.equal(plain(c.wizardStatus()).next, st.next, 'reading the state changes nothing');
  assert.equal(plain(c.Actions.run('undoLast')).ok, true, 'undo runs (duringMigration)');
  assert.equal(comparable(c), original);
});

/* Final review P1 (c): the Medidas stamps of onEditInstalled are decided under the lock ---------- */

/** Medidas row 6 dated today with a weight; `objective` also fills the header K5 and K6. */
function bootMedidas(objective) {
  const a = boot();
  const sheet = a.SpreadsheetApp.getActive().getSheetByName(a.Tabs.get('measures').name);
  sheet.getRange('A6').setValue(new Date('2026-09-29T12:00:00-03:00'));
  sheet.getRange('B6').setValue(90);
  if (objective) {
    sheet.getRange('K5').setValue('Objetivo');
    sheet.getRange('K6').setValue(objective);
  }
  a.Tabs.invalidate();
  return { a, sheet };
}

/** Counts Measures.stampRow calls of execution `ctx` (pass-through: the real stamp still runs). */
function countStamps(ctx) {
  const calls = [];
  const stamp = ctx.Measures.stampRow;
  ctx.Measures.stampRow = function (row) { calls.push(row); return stamp.apply(this, arguments); };
  return calls;
}

/**
 * Execution A receives the edit `range` of Medidas; when A asks for the script lock (before
 * holding it), `startB(seen)` runs in execution B. Returns what the test saw.
 */
function editRacingMigration(a, b, range, startB) {
  const seen = { stamps: countStamps(a), toasts: a.__toasts.length };
  const getScriptLock = a.LockService.getScriptLock;
  a.LockService.getScriptLock = function () {
    a.LockService.getScriptLock = getScriptLock; // only A's first request is intercepted
    const lock = getScriptLock.apply(this, arguments);
    const wait = lock.waitLock;
    lock.waitLock = function () {
      seen.opBeforeB = a.Migrate.op_();
      seen.heldBeforeB = lock.hasLock();
      startB(seen);
      seen.afterB = state(a);
      return wait.apply(this, arguments);
    };
    return lock;
  };
  assert.doesNotThrow(() => a.onEditInstalled({ range, value: range.getValue() }), 'no exception leaves the trigger');
  seen.toastsAfter = a.__toasts.length;
  return seen;
}

function assertEditBlocked(a, seen) {
  assert.equal(seen.opBeforeB, null, 'A passed the early check with no migration');
  assert.equal(seen.heldBeforeB, false, 'B ran before A held the lock');
  assert.deepEqual(plain(seen.stamps), [], 'no row of the batch was stamped');
  assert.equal(state(a), seen.afterB, 'sheets, Log and operation exactly as B left them');
  assert.equal(seen.toastsAfter - seen.toasts, 1, 'the person is told once');
  assert.match(JSON.stringify(plain(a.__toasts[a.__toasts.length - 1])), /migração 3\.0 → 4\.0 está em andamento/);
}

test('P1c R1: an existing Objetivo O099 survives an edit that waited for the lock while the migration started, the steps and the undo', () => {
  const { a, sheet } = bootMedidas('O099');
  const original = comparable(a);
  const b = parallelExecution(a);
  const seen = editRacingMigration(a, b, sheet.getRange('B6'), (s) => {
    s.b = plain(b.wizardConfirm({ json: clientText('zoio') })).state;
    s.k6AfterB = sheet.getRange('K6').getValue();
  });
  assert.equal(seen.b.state, 'running');
  assert.ok(seen.b.left > 0, 'steps left');
  assert.equal(seen.k6AfterB, 'O099', 'B kept the existing objective');
  assert.equal(sheet.getRange('K6').getValue(), 'O099', 'A did not overwrite the existing objective');
  assertEditBlocked(a, seen);
  assert.equal(finish(b, seen.b).state, 'done');
  assert.equal(sheet.getRange('K6').getValue(), 'O099', 'still O099 after the steps');
  b.Undo.last();
  assert.equal(sheet.getRange('K5').getValue(), 'Objetivo');
  assert.equal(sheet.getRange('K6').getValue(), 'O099', 'still O099 after the undo (not only a successful undo)');
  assert.equal(comparable(a), original);
});

test('P1c R2: stock headers, B hard-killed before stampIds_ while A waits: A writes nothing, the recovery leaves no orphan id', () => {
  const { a, sheet } = bootMedidas(null);
  const original = comparable(a);
  assert.deepEqual([sheet.getRange('K5').getValue(), sheet.getRange('K6').getValue()], ['', '']);
  const b = parallelExecution(a);
  const seen = editRacingMigration(a, b, sheet.getRange('B6'), (s) => {
    b.__args = { json: clientText('zoio') };
    s.finallyRan = kill(b, 'Migrate.stampIds_ = function () { for (;;) {} }', 'wizardConfirm(__args)');
    s.phase = plain(b.Migrate.op_()).phase;
    s.k5 = sheet.getRange('K5').getValue();
    s.k6 = sheet.getRange('K6').getValue();
  });
  assert.equal(seen.finallyRan, false, 'hard kill of B: no finally ran');
  assert.equal(seen.phase, 'migrating');
  assert.equal(seen.k5, 'Objetivo', 'the body had created the Objetivo column');
  assert.equal(seen.k6, '');
  assert.equal(sheet.getRange('K6').getValue(), '', 'A wrote no objective outside the Log');
  assertEditBlocked(a, seen);
  // B's next execution recovers the interrupted body to the original file, no orphan in K6.
  freshExecution(b);
  assert.equal(plain(b.wizardStatus()).state, 'tables');
  assert.deepEqual([sheet.getRange('K5').getValue(), sheet.getRange('K6').getValue()], ['', '']);
  assert.equal(comparable(a), original);
  freshExecution(b);
  assert.equal(plain(b.wizardStatus()).state, 'tables', 'stable');
  assert.equal(comparable(a), original);
  assert.equal(finish(b, confirm(b).state).state, 'done');
  b.Undo.last();
  assert.equal(comparable(a), original);
});

test('P1c: a paste across the header and several rows, racing the migration: no row stamped', () => {
  const { a, sheet } = bootMedidas('O099');
  sheet.getRange('A7').setValue(new Date('2026-09-28T12:00:00-03:00'));
  sheet.getRange('B7').setValue(91);
  const b = parallelExecution(a);
  const seen = editRacingMigration(a, b, sheet.getRange('B4:B7'), (s) => {
    s.b = plain(b.wizardConfirm({ json: clientText('zoio') })).state;
  });
  assertEditBlocked(a, seen);
});

test('P1c controls: open migration, normal stamps, eligible rows only, unrelated or missing events', () => {
  // A migration already open when the edit arrives: no stamp, one toast, no exception.
  const open = bootMedidas('O099');
  confirm(open.a);
  const stampsOpen = countStamps(open.a);
  const before = state(open.a);
  const toasts = open.a.__toasts.length;
  assert.doesNotThrow(() => open.a.onEditInstalled({ range: open.sheet.getRange('B6:B7'), value: 90 }));
  assert.deepEqual(plain(stampsOpen), []);
  assert.equal(state(open.a), before);
  assert.equal(open.a.__toasts.length - toasts, 1);
  // With no open operation the stamp works as before, on the eligible rows only.
  const { a, sheet } = bootMedidas(null);
  assert.equal(finish(a, confirm(a).state).state, 'done');
  sheet.getRange('A7').setValue(new Date('2026-09-28T12:00:00-03:00'));
  sheet.getRange('B7').setValue(91);
  const k = a.Tabs.layout('measures').map.objective;
  sheet.getRange(6, k).setValue('');
  sheet.getRange(7, k).setValue('');
  const stamps = countStamps(a);
  a.onEditInstalled({ range: sheet.getRange('B6'), value: 90 });
  assert.deepEqual(plain(stamps), [6], 'a single edit stamps its row');
  assert.equal(sheet.getRange(6, k).getValue(), 'O001');
  stamps.length = 0;
  const firstData = a.Tabs.get('measures').firstDataRow;
  a.onEditInstalled({ range: sheet.getRange('B3:B7'), value: 90 });
  const eligible = [];
  for (let r = Math.max(3, firstData); r <= 7; r++) eligible.push(r);
  assert.deepEqual(plain(stamps), eligible, 'header rows skipped, every data row of the paste processed');
  assert.equal(sheet.getRange(7, k).getValue(), 'O001');
  // Missing events and other tabs: nothing written, nothing thrown.
  stamps.length = 0;
  const quiet = state(a);
  assert.doesNotThrow(() => a.onEditInstalled(undefined));
  assert.doesNotThrow(() => a.onEditInstalled({}));
  const other = a.SpreadsheetApp.getActive().getSheetByName(a.Tabs.get('diary').name);
  assert.doesNotThrow(() => a.onEditInstalled({ range: other.getRange('B6'), value: 1 }));
  assert.deepEqual(plain(stamps), []);
  assert.equal(state(a), quiet);
});
