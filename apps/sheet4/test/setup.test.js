'use strict';
/**
 * Setup.apply (spec §5.1, §11): an empty spreadsheet becomes the product (tabs by layer, styles,
 * validations, protections, triggers), a second run changes nothing, 3.0 data cells survive, and
 * inside the migration one undo still returns the 3.0 values. No client names in the code.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, plain } = require('./harness');
const { snapshot } = require('./fakes');

const NOW = '2026-09-29T15:00:00-03:00';
const empty = () => load({ sheets: [{ name: 'Sheet1', rows: [] }], now: NOW });
const sheet = (ctx, name) => ctx.__spreadsheet.getSheetByName(name);

/** JSON with sorted keys (format objects are compared by content, not key order). */
function canon(v) {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

const LAYER_ORDER = ['Hoje', 'Painel', 'Progressão', 'Dieta base', 'Ficha de treino', 'Medidas e fotos',
  'Semanas', 'Evolução', 'Alimentação', 'Registro de treino', 'Diário', 'Revisões', 'Objetivos', 'Metas', 'Fichas',
  'Config', 'Alimentos', 'Favoritas', 'Ingredientes', 'Equivalências', 'Exercícios', 'Guia', 'Auditoria', 'Log'];

test('empty spreadsheet: every tab in layer order, colours, hidden Log, default sheet removed', () => {
  const ctx = empty();
  const r = plain(ctx.Setup.apply());
  assert.deepEqual(ctx.__spreadsheet.getSheets().map((s) => s.getName()), LAYER_ORDER);
  assert.deepEqual(r.removed, ['Sheet1']);
  assert.equal(r.created.length, LAYER_ORDER.length);
  assert.deepEqual(r.warnings, []);
  const hidden = ctx.__spreadsheet.getSheets().filter((s) => s.isSheetHidden()).map((s) => s.getName());
  assert.deepEqual(hidden, ['Log']);
  ctx.Tabs.ids().forEach((id) => {
    const spec = ctx.Tabs.get(id);
    const s = sheet(ctx, spec.name);
    assert.equal(s.getTabColor(), ctx.Style.LAYER[spec.layer].tab, spec.name);
    assert.equal(s.hasHiddenGridlines(), spec.layer === 1, `${spec.name} gridlines`);
    if (spec.kind === 'table') {
      assert.equal(s.getFrozenRows(), 5, `${spec.name} frozen header`);
      assert.equal(s.getRange('A2').getValue(), id === 'planDraft' ? ctx.PlanDraft.statusText() : spec.title);
      assert.equal(s.getRange('A5').getFontWeight(), 'bold');
      assert.equal(s.getRange('A5').getBackground(), ctx.Style.LAYER[spec.layer].headerBg);
    }
  });
  assert.equal(ctx.__spreadsheet.getActiveSheet().getName(), 'Hoje');
});

test('empty spreadsheet: formats, input vs calculated fills, validations and warning-only protections', () => {
  const ctx = empty();
  ctx.Setup.apply();
  const diary = sheet(ctx, 'Diário');
  const col = (id, key) => ctx.Tabs.headerMap(id)[key];
  const at = (s, id, key, row) => s.getRange(row || 6, col(id, key));
  assert.equal(at(diary, 'diary', 'date').getNumberFormat(), 'dd/mm/yyyy');
  assert.equal(at(diary, 'diary', 'weightKg', 500).getNumberFormat(), '0.0');
  assert.equal(at(diary, 'diary', 'kcal').getBackground(), ctx.Style.C.calc);
  assert.equal(at(diary, 'diary', 'kcal').getFontColor(), ctx.Style.C.calcText);
  // Layer 1: inputs painted as inputs.
  const measures = sheet(ctx, 'Medidas e fotos');
  assert.equal(at(measures, 'measures', 'waistCm').getBackground(), ctx.Style.C.input);
  // Enum validation from Tabs.SPEC.
  const dv = at(diary, 'diary', 'foodLog', 900).getDataValidation();
  assert.equal(dv.getCriteriaType(), 'VALUE_IN_LIST');
  assert.deepEqual(plain(dv.getCriteriaValues()[0]), ['Não informado', 'Parcial', 'Completo']);
  assert.equal(dv.getAllowInvalid(), false);
  // Number ranges from Diary.FIELDS.
  assert.deepEqual(plain(at(diary, 'diary', 'weightKg').getDataValidation().getCriteriaValues()), [20, 400]);
  // Exercise lists read the catalogue (live range) and the named range exists.
  const ex = at(sheet(ctx, 'Registro de treino'), 'workouts', 'exercise').getDataValidation();
  assert.equal(ex.getCriteriaType(), 'VALUE_IN_RANGE');
  assert.equal(ex.getCriteriaValues()[0].getSheet().getName(), 'Exercícios');
  const named = ctx.__spreadsheet.getRangeByName('ListaExercicios');
  assert.equal(named.getSheet().getName(), 'Exercícios');
  assert.equal(named.getA1Notation(), 'A6:A1000');
  // Protections: header row + calculated runs, warning only.
  const prot = diary.getProtections('RANGE').map((p) => ({ a1: p.getRange().getA1Notation(), warn: p.isWarningOnly(), d: p.getDescription() }));
  assert.ok(prot.every((p) => p.warn && p.d.startsWith('[Setup] ')));
  assert.ok(prot.some((p) => p.a1 === 'A5:Y5'), 'header');
  assert.ok(prot.some((p) => p.a1 === 'N6:Y1000' && /kcal/.test(p.d)), JSON.stringify(prot));
  // Conditional formats: technical dates hidden, statuses coloured.
  const cf = sheet(ctx, 'Semanas').getConditionalFormatRules().map((r) => r.getBooleanCondition());
  assert.ok(cf.some((c) => c.getCriteriaType() === 'CUSTOM_FORMULA' && /DATE\(2000,1,1\)/.test(c.getCriteriaValues()[0])));
  assert.ok(cf.some((c) => c.getCriteriaType() === 'TEXT_EQUAL_TO' && c.getCriteriaValues()[0] === 'Fora do esperado' && c.getBackground() === ctx.Style.STATUS.off.bg));
  // Config: every key, sections styled, enum keys validated.
  const keys = ctx.Tabs.read('config').filter((x) => x.key).map((x) => x.key);
  assert.deepEqual(plain(keys.slice().sort()), plain(ctx.Config.keys().slice().sort()));
  const sexRow = ctx.Tabs.read('config').find((x) => x.key === 'client.sex')._row;
  assert.deepEqual(plain(sheet(ctx, 'Config').getRange(sexRow, 3).getDataValidation().getCriteriaValues()[0]), ['M', 'F']);
  // Guia: generic topics.
  assert.ok(ctx.Tabs.read('guide').some((g) => g.topic === 'Rotação' && /Rotação não definida/.test(g.guidance)));
});

test('Hoje is drawn from Hoje.layout(): validations, inputs, calculated cells, chips, navigation', () => {
  const ctx = empty();
  ctx.Setup.apply();
  const hoje = sheet(ctx, 'Hoje');
  const layout = ctx.Hoje.layout();
  const expected = [];
  layout.sections.forEach((s) => {
    // A list read from Config is left out while Config has no value (no rotation yet: B38).
    s.fields.forEach((f) => { if (f.input && f.validation && !/^config:/.test(f.validation.source || '')) expected.push([f.cell, f.validation]); });
    if (s.table) s.table.columns.forEach((c) => { if (c.validation) expected.push([`${c.col}${s.table.firstRow}`, c.validation]); });
  });
  assert.ok(expected.length > 20);
  expected.forEach(([a1, v]) => {
    const dv = hoje.getRange(a1).getDataValidation();
    assert.ok(dv, `validation on ${a1}`);
    const type = dv.getCriteriaType();
    if (v.type === 'number') assert.match(type, /^NUMBER_/, a1);
    if (v.type === 'date') assert.equal(type, 'DATE_IS_VALID_DATE', a1);
    if (v.type === 'list' && v.values) assert.deepEqual(plain(dv.getCriteriaValues()[0]), plain(v.values), a1);
    if (v.type === 'list' && v.source && v.source.startsWith('tab:')) assert.equal(type, 'VALUE_IN_RANGE', a1);
  });
  assert.equal(hoje.getRange('B38').getDataValidation(), null, 'no sessions yet');
  assert.deepEqual(plain(hoje.getRange(ctx.Hoje.QUICK_CELL).getDataValidation().getCriteriaValues()[0]), plain(ctx.Actions.quickList()));
  assert.equal(hoje.getRange('B4').getValue(), '—');
  assert.equal(hoje.getRange('B10').getBackground(), ctx.Style.C.input);
  assert.equal(hoje.getRange('B6').getBackground(), ctx.Style.C.calc);
  assert.equal(hoje.getRange('B5').getNumberFormat(), 'dd/mm/yyyy');
  assert.equal(hoje.getFrozenRows(), 5);
  assert.equal(hoje.getRange('A1').getFormula(), `=HYPERLINK("#gid=${sheet(ctx, 'Painel').getSheetId()}","Painel")`);
  assert.equal(hoje.getRange('E1').getFormula(), `=HYPERLINK("#gid=${sheet(ctx, 'Medidas e fotos').getSheetId()}","Medidas e fotos")`);
  const chips = hoje.getConditionalFormatRules().map((r) => r.getRanges()[0].getA1Notation());
  assert.ok(chips.includes('B7') && chips.includes('E60:E65') && chips.includes('B40'));
  const calc = hoje.getProtections('RANGE').filter((p) => /Calculado/.test(p.getDescription())).map((p) => p.getRange().getA1Notation());
  assert.ok(calc.includes('B6') && calc.includes('B7') && calc.includes('B60:E65'));
  // Typed input values survive a second Setup.
  hoje.getRange('B10').setValue(70.5);
  ctx.Setup.apply();
  assert.equal(hoje.getRange('B10').getValue(), 70.5);
});

test('idempotent: a second run changes nothing; triggers are never duplicated', () => {
  const ctx = empty();
  ctx.Setup.apply();
  const once = canon(snapshot(ctx));
  const triggers = ctx.__triggers.map((t) => `${t.handler}/${t.eventType}`);
  assert.deepEqual(triggers.sort(), ['dailyRefresh/CLOCK', 'onEditInstalled/ON_EDIT']);
  const r = plain(ctx.Setup.apply());
  assert.equal(canon(snapshot(ctx)), once);
  assert.deepEqual(r.triggers, { created: [], removed: 0 });
  // A duplicate installed by hand is removed.
  ctx.ScriptApp.newTrigger('onEditInstalled').forSpreadsheet(ctx.__spreadsheet).onEdit().create();
  assert.deepEqual(plain(ctx.Setup.ensureTriggers()), { created: [], removed: 1 });
  assert.equal(ctx.__triggers.length, 2);
});

test('3.0 fixture after renaming the legacy tabs: every data cell is kept', () => {
  const ctx = load({ fixture: 'breno_3_0', now: NOW });
  const ss = ctx.__spreadsheet;
  // Minimal migration: 3.0 names → 4.0 names (the Migration module does much more).
  ctx.Tabs.ids().forEach((id) => {
    const spec = ctx.Tabs.get(id);
    (spec.legacyNames || []).forEach((old) => { const s = ss.getSheetByName(old); if (s && !ss.getSheetByName(spec.name)) s.setName(spec.name); });
  });
  const tables = ctx.Tabs.ids().filter((id) => ctx.Tabs.get(id).kind === 'table').map((id) => ctx.Tabs.get(id).name);
  const before = {};
  snapshot(ctx).sheets.filter((s) => tables.includes(s.name)).forEach((s) => { before[s.name] = s.values; });
  ctx.Setup.apply();
  const after = {};
  snapshot(ctx).sheets.forEach((s) => { after[s.name] = s.values; });
  let cells = 0;
  // Guia holds product texts that Setup rewrites (generic topics); every other tab is data.
  Object.keys(before).filter((name) => name !== 'Guia').forEach((name) => {
    before[name].forEach((row, i) => {
      if (i < 4) return; // title/help rows are layout
      row.forEach((v, j) => {
        if (v === null) return;
        cells++;
        assert.deepEqual((after[name][i] || [])[j], v, `${name}!${i + 1}:${j + 1}`);
      });
    });
  });
  assert.ok(cells > 1000, `${cells} cells checked`);
  // The 3.0 Hoje (a screen) was replaced by the 4.0 layout.
  assert.equal(ss.getSheetByName('Hoje').getRange('A9').getValue(), 'Medidas do dia');
});

test('inside the migration: layout applied, audit clean, one undo returns the 3.0 values', () => {
  const ctx = load({ fixture: 'breno_3_0', now: NOW });
  const values = () => {
    const snap = snapshot(ctx);
    return JSON.stringify(snap.sheets.filter((s) => s.name !== 'Log').map((s) => [s.name, s.values.map((r) => r.map((v) => (v && v.$formula ? v.$formula : v)))])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1)));
  };
  const original = values();
  const client = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'clients', 'breno.json'), 'utf8'));
  const r = plain(ctx.Migrate.run(client));
  assert.equal(r.postSteps.find((s) => s.step === 'Aplicar layout').status, 'ok');
  assert.deepEqual(r.findingsAfter, []);
  const painel = ctx.__spreadsheet.getSheetByName('Painel');
  assert.match(painel.getRange('A5').getValue(), /^OBJETIVO ATUAL — O001/);
  assert.equal(ctx.__spreadsheet.getSheetByName('Hoje').getRange('A9').getValue(), 'Medidas do dia');
  assert.equal(ctx.__spreadsheet.getSheetByName('Diário').getRange('A5').getBackground(), ctx.Style.LAYER[2].headerBg);
  assert.deepEqual(plain(ctx.ChangeLog.actions().filter((a) => !a.undone).map((a) => a.label)), ['Migrar 3.0 → 4.0']);
  ctx.Undo.last();
  assert.equal(values(), original);
});

test('no client names in the code', () => {
  const src = path.join(__dirname, '..', 'src');
  const hits = [];
  fs.readdirSync(src).forEach((f) => {
    fs.readFileSync(path.join(src, f), 'utf8').split('\n').forEach((line, i) => {
      if (/Breno|Zoio|Luan|Upper|Push/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  });
  assert.deepEqual(hits, []);
});
