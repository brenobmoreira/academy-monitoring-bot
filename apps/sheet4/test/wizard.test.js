'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, plain } = require('./harness');

const NOW = '2026-09-29T15:00:00-03:00';
const clientText = (name) => fs.readFileSync(path.join(__dirname, '..', '..', '..', 'clients', `${name}.json`), 'utf8');
const field = (p, key) => p.fields.find((f) => f.key === key);

test('proposal without JSON shows the 3.0 profile values (height in cm) and asks for sex', () => {
  const ctx = load({ fixture: 'breno_3_0', now: NOW });
  const p = plain(ctx.Wizard.proposal());
  assert.deepEqual(p.errors, []);
  assert.equal(p.hasLegacyProfile, true);
  assert.equal(p.migrated, false);
  const h = field(p, 'client.heightCm');
  assert.deepEqual([h.value, h.source, h.legacy, h.unit], [179, '3.0', 179, 'cm']);
  assert.equal(field(p, 'client.startDate').value, '2026-09-21');
  assert.equal(field(p, 'client.sex').value, null);
  assert.equal(field(p, 'client.reviewer').value, 'Luan');
  assert.deepEqual([p.goal.kcal, p.goal.protein, p.goal.proteinMin, p.goal.proteinMax, p.goal.fat, p.goal.carbs], [2400, 140, 135, 145, 65, 313.75]);
  assert.equal(p.objective.name, 'Recomposição corporal');
  assert.equal(p.energy.bmr, null, 'no BMR without sex');
  assert.deepEqual(p.plans.map((x) => [x.id, x.start]), [['F001', null], ['F002', '2026-09-28']]);
});

test('proposal with the pasted client JSON shows its values and sources', () => {
  const ctx = load({ fixture: 'zoio_3_0', now: NOW });
  const p = plain(ctx.Wizard.proposal(clientText('zoio')));
  assert.deepEqual(p.errors, []);
  assert.equal(field(p, 'client.sex').value, 'M');
  assert.equal(field(p, 'client.sex').source, 'json');
  assert.equal(field(p, 'client.heightCm').legacy, 185);
  assert.deepEqual([p.goal.kcal, p.goal.protein, p.goal.proteinMin, p.goal.proteinMax, p.goal.fat, p.goal.carbs], [2650, 170, 160, 180, 70, 335]);
  assert.equal(p.goal.start, '2026-09-28');
  assert.equal(p.energy.bmr, 1886.25);
  assert.equal(p.energy.tdee, 2923.69);
  assert.deepEqual(p.plans.map((x) => [x.id, x.start, x.end]), [['F001', '2026-09-15', '2026-09-27'], ['F002', '2026-09-28', null]]);
  assert.deepEqual(p.otherClientNames, ['Breno']);
  assert.equal(p.review.length, 2);
  assert.match(ctx.Wizard.proposal('{bad').errors[0], /JSON inválido/);
});

test('confirm refuses to migrate without sex or with height in metres', () => {
  const ctx = load({ fixture: 'breno_3_0', now: NOW });
  assert.throws(() => ctx.Wizard.confirm({}), /sexo/);
  assert.throws(() => ctx.Wizard.confirm({ config: { 'client.sex': 'M', 'client.heightCm': '1,79' } }), /centímetros/);
  assert.equal(ctx.Migrate.isMigrated(), false, 'nothing written');
  assert.equal(ctx.__spreadsheet.getSheetByName('Log'), null);
});

test('confirm with the 3.0 profile plus the person edits migrates with those values', () => {
  const ctx = load({ fixture: 'breno_3_0', now: NOW });
  const r = ctx.Wizard.confirm({
    config: { 'client.sex': 'M', 'routine.sessionRotation': 'Upper, Lower, Full Body', 'energy.activityFactor': '1,5' },
    goal: { kcal: '2.450', start: '2026-09-28' },
    objective: { name: 'Recomposição corporal', analysisType: 'recomposicao' },
  });
  assert.equal(r.ok, true);
  assert.equal(ctx.Config.get('client.sex'), 'M');
  assert.equal(ctx.Config.get('energy.activityFactor'), 1.5);
  assert.equal(ctx.Config.get('client.heightCm'), 179);
  const m = ctx.Goals.current().fields;
  assert.deepEqual([m.kcal, m.protein, m.proteinMin, m.proteinMax, m.fat, m.carbs], [2450, 140, 135, 145, 65, 326.25]);
  assert.equal(ctx.Objectives.current().fields.name, 'Recomposição corporal');
  assert.equal(ctx.Dates.key(ctx.Objectives.current().start), '2026-09-28');
});

test('confirm with the pasted JSON and an edited protein target', () => {
  const ctx = load({ fixture: 'zoio_3_0', now: NOW });
  const r = ctx.Wizard.confirm({ json: clientText('zoio'), goal: { protein: '175' } });
  assert.equal(r.ok, true);
  assert.deepEqual(plain(r.findingsAfter), []);
  assert.equal(ctx.Goals.current().fields.protein, 175);
  assert.equal(ctx.Goals.current().fields.carbs, (2650 - 4 * 175 - 9 * 70) / 4);
  assert.equal(ctx.Wizard.confirm({ json: clientText('zoio') }).alreadyMigrated, true);
});

test('menu Sistema: the three actions; the dialog shows the proposal page', () => {
  const ctx = load({ fixture: 'zoio_3_0', now: NOW });
  const system = plain(ctx.Actions.menu()).find((g) => g.label === 'Sistema');
  assert.deepEqual(system.items.map((i) => i.label), ['Configuração inicial', 'Migrar 3.0 → 4.0', 'Auditoria', 'Reaplicar layout']);
  const r = ctx.Actions.run('migrate');
  assert.equal(r.ok, true);
  const d = ctx.__dialogs[0];
  assert.equal(d.title, 'Migrar 3.0 → 4.0');
  assert.match(d.html, /wizardProposal/);
  assert.match(d.html, /Nada é gravado antes de Confirmar|nada é gravado antes de Confirmar/);
  ctx.Actions.run('setupWizard');
  assert.equal(ctx.__dialogs[1].title, 'Configuração inicial');
  assert.equal(ctx.Migrate.isMigrated(), false);
  const out = plain(ctx.wizardConfirm({ json: clientText('zoio') }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.open, []);
});

test('the layout step resumes in new executions when its time budget runs out, until every tab is styled', () => {
  const ctx = load({ fixture: 'zoio_3_0', now: NOW });
  const out = plain(ctx.wizardConfirm({ json: clientText('zoio') }));
  plain(ctx.wizardPostStep('weeks'));
  ctx.Migrate.STEP_BUDGET_MS = -1; // every execution styles a single tab, then hands over the rest
  let r = plain(ctx.wizardPostStep('styles', null));
  let calls = 1;
  const seen = [];
  while (r.again) {
    assert.ok(seen.length === 0 || r.again.length < seen[seen.length - 1], 'progress on every call');
    seen.push(r.again.length);
    r = plain(ctx.wizardPostStep('styles', r.again));
    calls += 1;
  }
  assert.equal(r.status, 'ok');
  assert.ok(calls > 5, `resumed ${calls} times`);
  assert.equal(calls, ctx.Tabs.ids().length, 'one tab per execution');
  assert.equal(ctx.SpreadsheetApp.getActive().getActiveSheet().getName(), ctx.Tabs.get(ctx.Hoje.TAB).name, 'finished with Hoje');
  assert.ok(out.ok);
});

test('the dialog runs the post steps after the migration, one execution and one undoable action each', () => {
  const ctx = load({ fixture: 'zoio_3_0', now: NOW });
  const out = plain(ctx.wizardConfirm({ json: clientText('zoio') }));
  assert.equal(out.ok, true);
  assert.deepEqual(out.postSteps, [], 'nothing heavy inside the migration run');
  assert.deepEqual(out.next, ['weeks', 'styles', 'dashboard', 'audit']);
  const steps = out.next.map((id) => plain(ctx.wizardPostStep(id)));
  assert.deepEqual(steps.map((s) => [s.step, s.status]),
    [['Recalcular semanas', 'ok'], ['Aplicar layout', 'ok'], ['Atualizar painel', 'ok'], ['Auditoria final', 'ok']]);
  assert.match(steps[3].message, /erro|nenhum/);
  const labels = [...new Set(ctx.ChangeLog.actions().map((a) => a.label))];
  assert.ok(labels.some((l) => /Aplicar layout$/.test(l)), 'layout logged as its own action');
  assert.ok(ctx.Tabs.read('audit').some((r) => r.state === 'Aberto' || r.state === 'Corrigido'), 'audit rows written');
  assert.deepEqual(plain(ctx.wizardConfirm({ json: clientText('zoio') })).next, [], 'already migrated: nothing to chain');
});
