'use strict';
/**
 * The staged migration (the dialog): tables, migration, then weeks / styles / dashboard / audit,
 * one Apps Script execution each. One operation for the Log (one undo reverts it all, also after
 * the clock moved), state kept in the document properties (a new execution, a reopened dialog or a
 * late answer resumes it without repeating anything), and a failing step stops the chain.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, freshExecution, plain } = require('./harness');
const { snapshot } = require('./fakes');

const NOW = '2026-09-29T15:00:00-03:00';
const clientText = (name) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'clients', `${name}.json`), 'utf8');
const boot = () => load({ fixture: 'zoio_3_0', now: NOW });

/** Values (formulas as text) of every tab but Log, and the named ranges. */
function comparable(ctx) {
  const snap = snapshot(ctx);
  const sheets = snap.sheets.filter((s) => s.name !== 'Log')
    .map((s) => ({ name: s.name, values: s.values.map((r) => r.map((v) => (v && v.$formula ? { $formula: v.$formula } : v))) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return JSON.stringify({ sheets, namedRanges: snap.namedRanges });
}

const confirm = (ctx) => plain(ctx.wizardConfirm({ json: clientText('zoio') }));
const step = (ctx, st) => plain(ctx.wizardStep(st.opId, st.next, st.cursor));

/** Runs steps until the operation leaves 'running' (or after `stopAfter` steps). */
function drive(ctx, st, { fresh = false, stopAfter = Infinity, between } = {}) {
  const results = [];
  let state = st;
  while (state.state === 'running' && results.length < stopAfter) {
    const r = step(ctx, state);
    results.push(r);
    state = r.state;
    if (between) between(ctx, r);
    if (fresh) freshExecution(ctx);
  }
  return { state, results };
}

test('staged migration and one undo: back to 3.0, no conflict, the Log keeps one operation', () => {
  const ctx = boot();
  const original = comparable(ctx);
  const out = confirm(ctx);
  assert.equal(out.state.state, 'running');
  assert.equal(out.state.next, 'weeks');
  const { state, results } = drive(ctx, out.state);
  assert.equal(state.state, 'done');
  assert.ok(results.every((r) => r.status === 'ok'));
  const labels = [...new Set(plain(ctx.ChangeLog.actions()).filter((a) => !a.undone).map((a) => a.label))];
  assert.deepEqual(labels, ['Migrar 3.0 → 4.0'], 'migration and steps are one action');
  const u = plain(ctx.Undo.last());
  assert.equal(u.action, 'Migrar 3.0 → 4.0');
  assert.equal(comparable(ctx), original);
  assert.equal(ctx.Migrate.isMigrated(), false);
  assert.equal(plain(ctx.wizardStatus()).state, 'none');
});

test('the same undo works after the clock moved (derived refreshes stay quiet during the undo)', () => {
  const ctx = boot();
  const original = comparable(ctx);
  const { state } = drive(ctx, confirm(ctx).state, { between: (c) => c.__clock.advance(60000) });
  assert.equal(state.state, 'done');
  ctx.__clock.advance(60000);
  freshExecution(ctx);
  ctx.Undo.last();
  assert.equal(comparable(ctx), original);
  assert.equal(ctx.Migrate.isMigrated(), false);
});

test('undo after an interruption between steps reverts what was done', () => {
  const ctx = boot();
  const original = comparable(ctx);
  const { state } = drive(ctx, confirm(ctx).state, { stopAfter: 1, fresh: true });
  assert.equal(state.next, 'styles');
  ctx.__clock.advance(60000);
  ctx.Undo.last();
  assert.equal(comparable(ctx), original);
  assert.equal(plain(ctx.wizardStatus()).state, 'none', 'the undone operation is no longer offered');
});

test('the layout spreads over executions (one tab each) from the saved cursor, then undoes', () => {
  const ctx = boot();
  const original = comparable(ctx);
  const tight = (c) => { c.Migrate.STEP_BUDGET_MS = -1; return c; };
  tight(ctx);
  let st = confirm(ctx).state;
  let styleCalls = 0;
  while (st.state === 'running') {
    if (st.next === 'styles') styleCalls += 1;
    st = step(ctx, st).state;
    tight(freshExecution(ctx));
  }
  assert.equal(st.state, 'done');
  assert.equal(styleCalls, ctx.Tabs.ids().length, 'one tab per execution');
  ctx.Undo.last();
  assert.equal(comparable(ctx), original);
});

test('a person editing a migrated cell blocks the undo with a conflict and nothing is overwritten', () => {
  const ctx = boot();
  drive(ctx, confirm(ctx).state);
  const config = ctx.SpreadsheetApp.getActive().getSheetByName(ctx.Tabs.get('config').name);
  const row = ctx.Tabs.read('config').find((r) => r.key === 'client.name')._row;
  const col = ctx.Tabs.layout('config').map.value;
  const cell = config.getRange(row, col);
  cell.setValue('Editado à mão');
  const before = comparable(ctx);
  assert.throws(() => ctx.Undo.last(), (err) => err.apiErrors[0].code === 'conflict');
  assert.equal(comparable(ctx), before);
  assert.equal(cell.getValue(), 'Editado à mão');
});

test('without the staged steps (Migrate.run) the migration still undoes in one go', () => {
  const ctx = boot();
  const original = comparable(ctx);
  ctx.Migrate.run(JSON.parse(clientText('zoio')));
  ctx.Undo.last();
  assert.equal(comparable(ctx), original);
});

test('after the operation, an ordinary save still refreshes Semanas and the Painel', () => {
  const ctx = boot();
  drive(ctx, confirm(ctx).state);
  freshExecution(ctx);
  const seen = [];
  const refresh = ctx.Weeks.refreshSafely_;
  ctx.Weeks.refreshSafely_ = () => { seen.push('weeks'); return refresh(); };
  const render = ctx.Dashboard.renderSafely_;
  ctx.Dashboard.renderSafely_ = () => { seen.push('painel'); return render(); };
  ctx.Core.withLock(() => ctx.ChangeLog.run('Salvar dia', () => ctx.Diary.save('2026-09-29', { weightKg: 80 })));
  assert.deepEqual(seen, ['weeks', 'painel']);
});

test('Core.mute: nested and throwing calls restore the previous state', () => {
  const ctx = boot();
  const calls = [];
  ctx.Core.on('t.a', () => calls.push('a'));
  ctx.Core.on('t.b', () => calls.push('b'));
  ctx.Core.mute(['t.a'], () => {
    assert.throws(() => ctx.Core.mute(['t.b'], () => { ctx.Core.emit('t.b'); throw new Error('x'); }), /x/);
    ctx.Core.emit('t.a');
    ctx.Core.emit('t.b');
  });
  ctx.Core.emit('t.a');
  assert.deepEqual(calls, ['b', 'a']);
  assert.deepEqual(plain(ctx.Core.muted_), {});
});

test('closing the dialog between any two steps: a new execution resumes from the saved state', () => {
  const ctx = boot();
  let st = confirm(ctx).state;
  freshExecution(ctx);
  const seen = [];
  while (st.state === 'running') {
    const reopened = plain(ctx.wizardStatus());
    assert.equal(reopened.next, st.next, 'the reopened dialog offers the same step');
    assert.equal(JSON.stringify(reopened.cursor), JSON.stringify(st.cursor));
    seen.push(st.next);
    st = step(ctx, reopened).state;
    freshExecution(ctx);
  }
  assert.deepEqual([...new Set(seen)], ['weeks', 'styles', 'dashboard', 'audit']);
  assert.equal(st.state, 'done');
  const again = confirm(ctx);
  assert.equal(again.alreadyMigrated, true);
  assert.equal(again.state.state, 'done');
});

test('a lost answer, a second window and a late request change nothing twice', () => {
  const ctx = boot();
  let st = confirm(ctx).state;
  const logRows = () => ctx.Tabs.read('log').length;
  // Lost answer of confirm: confirming again resumes, it does not migrate again.
  const rows = logRows();
  const again = confirm(ctx);
  assert.equal(again.resumed, true);
  assert.equal(logRows(), rows);
  // Weeks runs; its answer is lost; the same request comes again (retry or a second window).
  assert.equal(step(ctx, st).status, 'ok');
  freshExecution(ctx);
  const rows2 = logRows();
  const dup = step(ctx, st);
  assert.equal(dup.stale, true);
  assert.equal(logRows(), rows2, 'nothing written by the repeated request');
  st = dup.state;
  assert.equal(st.next, 'styles');
  // Run to the audit, lose its answer, ask again: no duplicated Auditoria rows.
  while (st.next !== 'audit') st = step(ctx, st).state;
  const auditRows = () => ctx.Tabs.read('audit').length;
  step(ctx, st);
  const n = auditRows();
  freshExecution(ctx);
  assert.equal(step(ctx, st).stale, true);
  assert.equal(auditRows(), n);
});

test('the final audit run twice (answer lost before the state was saved) does not repeat open findings', () => {
  const ctx = boot();
  assert.equal(drive(ctx, confirm(ctx).state).state.state, 'done');
  const n = ctx.Tabs.read('audit').length;
  ctx.Core.withLock(() => ctx.ChangeLog.run('Migrar 3.0 → 4.0', () => ctx.Migrate.finalAudit_()));
  assert.equal(ctx.Tabs.read('audit').length, n);
});

test('a step that writes and then fails is rolled back, stops the chain and can be retried', () => {
  const ctx = boot();
  let st = drive(ctx, confirm(ctx).state, { stopAfter: 2 }).state;
  assert.equal(st.next, 'dashboard');
  const painel = ctx.SpreadsheetApp.getActive().getSheetByName(ctx.Tabs.get('dashboard').name);
  const z1 = painel.getRange('Z1').getValue();
  const render = ctx.Dashboard.render;
  ctx.Dashboard.render = () => { ctx.Tabs.setCells('dashboard', { Z1: 'parcial' }); throw new Error('painel quebrado'); };
  const r = step(ctx, st);
  assert.equal(r.status, 'erro');
  assert.match(r.message, /painel quebrado/);
  assert.equal(r.state.state, 'failed');
  assert.equal(r.state.next, 'dashboard');
  assert.match(r.state.message, /falhou.*painel quebrado/);
  assert.equal(painel.getRange('Z1').getValue(), z1, 'the partial write was rolled back');
  assert.equal(plain(ctx.wizardStep(r.state.opId, 'audit', null)).stale, true, 'the next step cannot jump the failed one');
  ctx.Dashboard.render = render;
  freshExecution(ctx);
  st = plain(ctx.wizardStatus());
  assert.equal(st.state, 'failed');
  const retry = step(ctx, st);
  assert.equal(retry.status, 'ok');
  assert.equal(drive(ctx, retry.state).state.state, 'done');
});

test('open errors in the final audit are reported, not a plain success', () => {
  const ctx = boot();
  let st = drive(ctx, confirm(ctx).state, { stopAfter: 3 }).state;
  assert.equal(st.next, 'audit');
  ctx.Audit.findings = () => [{ severity: 'Erro', code: 'x', tab: 'Config', cell: 'C6', finding: 'problema de teste', action: '' }];
  st = step(ctx, st).state;
  assert.equal(st.state, 'done');
  assert.equal(st.auditOpen, 1);
  assert.match(st.message, /1 erro em aberto/);
  assert.doesNotMatch(st.message, /Pode fechar/);
});
