'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');
const { boot, NOW } = require('./core_helpers');

const ALL = { goals: [], plans: [], objectives: [] };

test('reports formula errors, broken references and fixed ranges only in data tabs', () => {
  const ctx = boot({ tabs: Object.assign({ diary: [{ date: '2026-09-28', weightKg: 70 }] }, ALL) });
  const diary = ctx.__spreadsheet.getSheetByName('Diário');
  diary.getRange('Q6').setFormula("=SUMIFS('Alimentação'!$F$6:$F1000,'Alimentação'!$A$6:$A1000,A6)");
  diary.getRange('R6').setFormula('=#REF!+1');
  diary.getRange('S6').setValue('#DIV/0!');
  const f = plain(ctx.Audit.findings());
  const by = (code) => f.filter((x) => x.code === code);
  assert.equal(by('fixed_range').length, 1);
  assert.equal(by('fixed_range')[0].cell, 'Q6');
  assert.deepEqual(by('formula_error').map((x) => x.cell).sort(), ['R6', 'S6']);
});

test('names of other clients are found as whole words, accents and case ignored', () => {
  const ctx = boot({ tabs: Object.assign({ guide: [{ topic: 'A', guidance: 'Rotina do JOÃO: treino A. Outra frase.' }, { topic: 'B', guidance: 'Joãozinho não conta.' }] }, ALL) });
  const f = plain(ctx.Audit.findings({ otherNames: ['Joao'] })).filter((x) => x.code === 'cross_client');
  assert.equal(f.length, 1);
  assert.equal(f[0].cell, 'B6');
  assert.equal(ctx.Audit.withoutNames('Rotina do JOÃO: treino A. Outra frase.', ['joão']), 'Outra frase.');
});

test('the Config row listing the other names and the client own name are not residues', () => {
  const ctx = boot({ config: { 'client.name': 'Ana', 'system.otherClientNames': 'Bia, Ana' }, tabs: Object.assign({ guide: [{ topic: 'x', guidance: 'Ana treina; Bia não.' }] }, ALL) });
  const f = plain(ctx.Audit.findings()).filter((x) => x.code === 'cross_client');
  assert.deepEqual(f.map((x) => [x.tab, x.cell]), [['Guia', 'B6']]);
});

test('empty required Config values and a missing schema version are reported', () => {
  const ctx = boot({ config: { 'client.name': 'Ana', 'energy.activityFactor': 'abc' }, tabs: ALL });
  const f = plain(ctx.Audit.findings());
  const missing = f.filter((x) => x.code === 'config_missing').map((x) => x.cell);
  ['client.sex', 'client.heightCm', 'client.startDate', 'client.age'].forEach((k) => assert.ok(missing.includes(k), k));
  assert.ok(f.some((x) => x.code === 'config_invalid' && x.cell === 'energy.activityFactor'));
  assert.ok(f.some((x) => x.code === 'schema_version'));
});

test('version problems of the three entities are reported', () => {
  const ctx = boot({
    tabs: {
      objectives: [{ id: 'O001', name: 'x', analysisType: 'recomposicao', start: '2026-09-28', status: 'Vigente' }],
      goals: [{ id: 'M001', start: '2026-09-01', status: 'Vigente' }, { id: 'M002', start: '2026-09-28', status: 'Vigente' }],
      plans: [],
    },
  });
  const f = plain(ctx.Audit.findings());
  assert.ok(f.some((x) => x.code === 'version_overlap' && x.tab === 'Metas'));
  assert.ok(f.some((x) => x.code === 'version_multiple_current'));
  assert.ok(f.some((x) => x.code === 'version_none_current' && x.tab === 'Fichas'));
  assert.ok(!f.some((x) => x.tab === 'Objetivos' && x.code.startsWith('version_')));
});

test('a typed plan status contradicting Fichas is an error; time values are not technical dates', () => {
  const ctx = boot({ tabs: { plans: [{ id: 'F002', session: 'A', exercise: 'x', start: '2026-09-28', status: 'Vigente' }], goals: [], objectives: [] } });
  const s = ctx.__spreadsheet.insertSheet('Notas');
  s.getRange('A1').setValue('Status da ficha');
  s.getRange('B1').setValue('F001 — vigente');
  s.getRange('A2').setValue('Status da ficha');
  s.getRange('B2').setValue('F002 vigente');
  s.getRange('C3').setValue(new Date(1899, 11, 30, 8, 30));
  s.getRange('C4').setValue(new Date(1900, 0, 1));
  const f = plain(ctx.Audit.findings());
  const status = f.filter((x) => x.code === 'stale_plan_status');
  assert.deepEqual(status.map((x) => [x.cell, x.severity]), [['B1', 'Erro']]);
  assert.deepEqual(f.filter((x) => x.code === 'technical_date').map((x) => x.cell), ['C4']);
});

test('Audit.run writes the findings to Auditoria as one undoable action and changes nothing else', () => {
  const ctx = load({ fixture: 'zoio_3_0', now: NOW });
  const r = ctx.Actions.run('audit');
  assert.equal(r.ok, true);
  const rows = ctx.Tabs.read('audit');
  assert.equal(rows.length, r.result.findings);
  assert.ok(rows.every((x) => x.state === 'Aberto' && x.at instanceof Date));
  assert.ok(rows.some((x) => x.code === 'technical_date' && /01\/01\/1900/.test(x.before)));
  ctx.Undo.last();
  assert.equal(ctx.__spreadsheet.getSheetByName('Auditoria'), null, 'the tab created by the audit is removed by undo');
});
