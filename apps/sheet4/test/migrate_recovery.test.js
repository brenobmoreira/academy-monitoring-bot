'use strict';
/**
 * The staged migration against interruptions and concurrency: an execution killed midway (no
 * catch/finally runs, as at Apps Script's 6-minute limit), two windows confirming at once, other
 * writes while the steps are open, and spreadsheets migrated before the saved state existed.
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

/** Values and formulas of every tab but Log, tab names and named ranges. */
function comparable(ctx) {
  const snap = snapshot(ctx);
  const sheets = snap.sheets.filter((s) => s.name !== 'Log')
    .map((s) => ({ name: s.name, values: s.values.map((r) => r.map((v) => (v && v.$formula ? { $formula: v.$formula } : v))) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return JSON.stringify({ sheets, namedRanges: snap.namedRanges });
}

const confirm = (ctx, name = 'zoio') => plain(ctx.wizardConfirm({ json: clientText(name) }));
const step = (ctx, st) => plain(ctx.wizardStep(st.opId, st.next, st.cursor));
function finish(ctx, st) {
  let s = st;
  while (s.state === 'running') s = step(ctx, s).state;
  return s;
}
const pendingLabels = (ctx) => plain(ctx.Undo.pending()).map((a) => a.label);

/**
 * Kills the execution inside Migrate[fn] (after it ran, or before when `before`), the way Apps
 * Script stops a run: an endless loop ended by the VM timeout, so no catch or finally runs.
 * Then the platform frees the dead execution's locks.
 */
function killInside(ctx, fn, call, { before = false } = {}) {
  vm.runInContext(`(function () {
    var o = Migrate.${fn};
    Migrate.${fn} = function () { ${before ? 'for (;;) {}' : ''} var r = o.apply(this, arguments); for (;;) {} return r; };
  })()`, ctx);
  assert.throws(() => vm.runInContext(call, ctx, { timeout: 2500 }), /timed out/);
  const finallyRan = ctx.ChangeLog.current_ === null && ctx.Core.lockDepth_ === 0;
  ctx.__releaseLocks();
  return { finallyRan };
}

/* R2: killed inside the migration body ------------------------------------------------------- */

[
  ['steps_', true, 'before the first write (identity reserved)'],
  ['renameTabs_', false, 'after the first structural changes'],
  ['writeConfig_', false, 'after writeConfig_'],
  ['clearLayoutFormulas_', false, 'just before the schema marker'],
  ['startSteps_', true, 'after the schema marker, before the state is saved'],
].forEach(([fn, before, when]) => {
  test(`killed ${when}: a new execution recovers, the retry finishes and one undo restores 3.0`, () => {
    const ctx = boot();
    const original = comparable(ctx);
    ctx.__args = { json: clientText('zoio') };
    const kill = killInside(ctx, fn, 'wizardConfirm(__args)', { before });
    assert.equal(kill.finallyRan, false, 'no finally ran (hard kill)');
    freshExecution(ctx);
    const left = ctx.ChangeLog.entries().filter((r) => !r.undone).length;
    if (fn === 'steps_') {
      assert.equal(left, 0, 'killed before any write');
    } else {
      assert.ok(left > 0, `the kill left ${left} logged changes behind`);
      assert.notEqual(comparable(ctx), original, 'the spreadsheet is half migrated');
    }
    const st = plain(ctx.wizardStatus());
    assert.ok(['tables', 'running'].includes(st.state), `state after the kill: ${st.state}`);
    const out = confirm(ctx);
    const done = finish(ctx, out.state);
    assert.equal(done.state, 'done');
    assert.deepEqual(pendingLabels(ctx), ['Migrar 3.0 → 4.0'], 'one migration, no orphan action');
    ctx.Undo.last();
    assert.equal(comparable(ctx), original);
    assert.equal(ctx.Migrate.isMigrated(), false);
  });
});

test('killed midway, then someone edited a cell the body wrote: recovery stops, nothing reverted', () => {
  const ctx = boot();
  ctx.__args = { json: clientText('zoio') };
  killInside(ctx, 'writeConfig_', 'wizardConfirm(__args)');
  freshExecution(ctx);
  const config = ctx.SpreadsheetApp.getActive().getSheetByName('Config');
  const row = ctx.Tabs.read('config').find((r) => r.key === 'client.name')._row;
  const cell = config.getRange(row, ctx.Tabs.layout('config').map.value);
  cell.setValue('Editado à mão');
  const before = comparable(ctx);
  assert.throws(() => ctx.wizardStatus(), (err) => err.apiErrors[0].code === 'interrupted_conflict');
  assert.equal(comparable(ctx), before, 'nothing reverted');
  assert.equal(cell.getValue(), 'Editado à mão');
});

/* R3: two windows confirming at the same time ------------------------------------------------- */

test('two windows confirm at once: the second waits on the lock, then resumes the same operation', () => {
  const a = boot();
  const original = comparable(a);
  const b = parallelExecution(a);
  let seenByB = null;
  // B's confirmation arrives while A is inside its migration (A holds the script lock).
  const unwrap = a.Migrate.unwrapTables_;
  a.Migrate.unwrapTables_ = function () {
    try { b.wizardConfirm({ json: clientText('zoio') }); } catch (err) { seenByB = err.message; }
    return unwrap.apply(this, arguments);
  };
  const outA = confirm(a);
  assert.equal(outA.state.state, 'running');
  assert.match(seenByB, /Outra alteração está em andamento/);
  const outB = confirm(b);
  assert.equal(outB.resumed, true, 'B resumes A’s operation');
  assert.equal(outB.state.opId, outA.state.opId);
  assert.equal(finish(b, outB.state).state, 'done');
  assert.deepEqual(pendingLabels(a), ['Migrar 3.0 → 4.0'], 'one migration action');
  a.Undo.last();
  assert.equal(comparable(a), original);
});

test('a second confirmation that runs while the first one is between its checks does not migrate twice', () => {
  const a = boot();
  const original = comparable(a);
  const b = parallelExecution(a);
  // The earlier code read the state under one lock and migrated under another; B's whole
  // confirmation fits in between. Migrate.run logs "início" outside any lock (the earlier code
  // did it right after its state check): B runs there.
  const log = a.Migrate.log_;
  let ran = false;
  a.Migrate.log_ = function (what) {
    if (!ran && what === 'início') { ran = true; b.wizardConfirm({ json: clientText('zoio') }); }
    return log.apply(this, arguments);
  };
  const outA = confirm(a);
  assert.equal(outA.resumed, true, 'A finds B’s migration and resumes it');
  assert.equal(finish(a, outA.state).state, 'done');
  assert.deepEqual(pendingLabels(a), ['Migrar 3.0 → 4.0'], 'one migration action');
  a.Undo.last();
  assert.equal(comparable(a), original);
  assert.equal(a.Migrate.isMigrated(), false);
});

test('a step requested by two windows runs once; the late request changes nothing', () => {
  const a = boot();
  const st = confirm(a).state;
  const b = parallelExecution(a);
  const first = step(a, st);
  assert.equal(first.status, 'ok');
  const rows = a.Tabs.read('log').length;
  const late = step(b, st);
  assert.equal(late.stale, true);
  assert.equal(a.Tabs.read('log').length, rows);
});

/* R4: other writes while the steps are open ------------------------------------------------- */

test('while steps are left, other writes are refused with a recognizable error and nothing logged', () => {
  const ctx = boot();
  const st = confirm(ctx).state;
  const rows = ctx.Tabs.read('log').length;
  assert.throws(() => ctx.Core.withLock(() => ctx.ChangeLog.run('Salvar dia', () => ctx.Diary.save('2026-09-29', { weightKg: 80 }))),
    (err) => err.apiErrors[0].code === 'migration_in_progress');
  assert.throws(() => ctx.ChangeLog.record('Algo', [{ kind: 'cells', tab: 'Config', row: null, before: { A1: '' }, after: { A1: 'x' } }]),
    (err) => err.apiErrors[0].code === 'migration_in_progress');
  assert.equal(ctx.Tabs.read('log').length, rows);
  // Reads, status and resuming keep working.
  assert.equal(plain(ctx.wizardStatus()).state, 'running');
  assert.equal(finish(ctx, st).state, 'done');
});

test('a bot write refused during the migration is not taken for done: its retry writes afterwards', () => {
  const ctx = boot();
  const st = confirm(ctx).state;
  const req = () => plain(ctx.SheetApi.run('diary.upsert', { date: '2026-09-29', fields: { weightKg: 80 } }, 'req-mig-1'));
  const refused = req();
  assert.equal(refused.ok, false);
  assert.equal(refused.errors[0].code, 'migration_in_progress');
  finish(ctx, st);
  const later = req();
  assert.equal(later.ok, true);
  assert.ok(later.result.writeId, 'written now, not deduplicated');
  const day = ctx.Tabs.read('diary').find((r) => ctx.Dates.key(r.date) === '2026-09-29');
  assert.equal(day.weightKg, 80);
  // After the operation, ordinary actions are normal again and the undo order is LIFO.
  assert.notEqual(pendingLabels(ctx)[0], 'Migrar 3.0 → 4.0');
});

test('a step does not continue the migration action when another action sits after it in the Log', () => {
  const ctx = boot();
  const st = confirm(ctx).state;
  // Only possible from outside the guard (an older script version, a manual Log edit).
  ctx.ChangeLog.GUARDS.length = 0;
  ctx.Core.withLock(() => ctx.ChangeLog.run('Salvar dia', () => ctx.Diary.save('2026-09-29', { weightKg: 80 })));
  const r = step(ctx, st);
  assert.equal(r.status, 'erro');
  assert.match(r.message, /alterações no Log depois da migração/);
});

test('ChangeLog.run join and id: only the latest pending action, a new id only once', () => {
  const ctx = boot();
  const write = (v) => ctx.Tabs.setCells('dashboard', { Z1: v });
  ctx.Migrate.run(JSON.parse(clientText('zoio')));
  const migration = plain(ctx.Undo.pending())[0].id;
  ctx.ChangeLog.run('Outra', () => write('a'));
  assert.throws(() => ctx.ChangeLog.run('x', () => write('b'), { join: migration }), (err) => err.apiErrors[0].code === 'join_refused');
  assert.throws(() => ctx.ChangeLog.run('x', () => write('b'), { join: 'inexistente' }), (err) => err.apiErrors[0].code === 'join_refused');
  ctx.Undo.last();
  assert.throws(() => ctx.ChangeLog.run('x', () => write('b'), { id: migration }), (err) => err.apiErrors[0].code === 'id_in_use');
});

/* R8: spreadsheets migrated before the saved state existed ----------------------------------- */

/** Migration body only, then the old dialog's step actions given (no saved state). */
function legacy(name, steps) {
  const ctx = boot(name);
  ctx.Migrate.run(JSON.parse(clientText(name)), { staged: true });
  ctx.Migrate.dropOp_();
  const fns = {
    'Recalcular semanas': () => ctx.Weeks.recomputeAll(),
    'Aplicar layout': () => ctx.Setup.apply({ dashboard: false }),
    'Atualizar painel': () => ctx.Dashboard.render(),
    'Auditoria final': () => ctx.Migrate.finalAudit_(),
  };
  steps.forEach((s) => ctx.Core.mute(ctx.Migrate.DERIVED_EVENTS, () => ctx.Core.withLock(() => ctx.ChangeLog.run(`Migrar 3.0 → 4.0 — ${s}`, fns[s]))));
  freshExecution(ctx);
  return ctx;
}

['breno', 'zoio'].forEach((name) => {
  test(`${name}: an old migration is done only with evidence of every step, the audit included`, () => {
    const cases = [
      [[], 'running', 'weeks'],
      [['Recalcular semanas'], 'running', 'styles'],
      [['Recalcular semanas', 'Aplicar layout'], 'running', 'styles'],
      [['Recalcular semanas', 'Aplicar layout', 'Atualizar painel'], 'running', 'audit'],
    ];
    cases.forEach(([steps, state, next]) => {
      const st = plain(legacy(name, steps).wizardStatus());
      assert.equal(st.state, state, steps.join(' + ') || 'no steps');
      assert.equal(st.next, next, steps.join(' + ') || 'no steps');
    });
  });
});

test('an old migration with the Painel but no audit runs the audit; open errors are reported', () => {
  const ctx = legacy('zoio', ['Recalcular semanas', 'Aplicar layout', 'Atualizar painel']);
  let st = plain(ctx.wizardStatus());
  assert.equal(st.next, 'audit');
  ctx.Audit.findings = () => [{ severity: 'Erro', code: 'x', tab: 'Config', cell: 'C6', finding: 'problema de teste', action: '' }];
  st = step(ctx, st).state;
  assert.equal(st.state, 'done');
  assert.equal(st.auditOpen, 1);
  assert.doesNotMatch(st.message, /Pode fechar/);
});

test('old step actions that were undone do not count', () => {
  const ctx = legacy('zoio', ['Recalcular semanas', 'Aplicar layout', 'Atualizar painel']);
  ctx.Undo.last(); // undoes "Atualizar painel"
  ctx.Migrate.dropOp_();
  freshExecution(ctx);
  assert.equal(plain(ctx.wizardStatus()).next, 'styles');
});

test('a finished operation whose saved state was lost is read back from its own step rows', () => {
  const ctx = boot();
  assert.equal(finish(ctx, confirm(ctx).state).state, 'done');
  const audit = ctx.Tabs.read('audit').length;
  ctx.Migrate.dropOp_();
  freshExecution(ctx);
  let st = plain(ctx.wizardStatus());
  if (st.state === 'running') {
    // The final audit left no rows (nothing open): it runs again, without repeating findings.
    assert.equal(st.next, 'audit');
    st = finish(ctx, st);
  }
  assert.equal(st.state, 'done');
  assert.equal(ctx.Tabs.read('audit').length, audit);
});

test('on 4.0 without any migration in the Log: unverified, never done', () => {
  const ctx = boot();
  ctx.Migrate.run(JSON.parse(clientText('zoio')));
  // A Log that lost its rows (cleared by hand, or a spreadsheet set up long ago).
  const log = ctx.SpreadsheetApp.getActive().getSheetByName('Log');
  log.getRange(6, 1, log.getLastRow() - 5, log.getLastColumn()).clearContent();
  freshExecution(ctx);
  const st = plain(ctx.wizardStatus());
  assert.equal(st.state, 'unverified');
  assert.match(st.message, /não tem o registro da migração/);
  const again = confirm(ctx);
  assert.equal(again.alreadyMigrated, true);
  assert.equal(again.state.state, 'unverified');
});

test('a state saved by the previous dialog version is read again from the Log', () => {
  const ctx = legacy('zoio', ['Recalcular semanas', 'Aplicar layout', 'Atualizar painel']);
  // What the previous version saved for such a spreadsheet: derived from the Log, marked done.
  const old = { id: 'x', actionId: plain(ctx.Undo.pending()).find((a) => a.label === 'Migrar 3.0 → 4.0').id, next: [], cursor: null, failed: null, legacy: true, seq: 3 };
  ctx.PropertiesService.getDocumentProperties().setProperty('migration.op', JSON.stringify(old));
  assert.equal(plain(ctx.wizardStatus()).next, 'audit', 'not taken as done');
});
