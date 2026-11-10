'use strict';
/**
 * Text that starts with an apostrophe through the public write paths. In Sheets a leading
 * apostrophe typed into a cell marks the rest as text and is not part of the value (Sheets API,
 * ExtendedValue.stringValue: "Leading single quotes are not included"), and Apps Script parses a
 * string given to setValue(s) as typed input. The fakes model that; whether setValue itself drops
 * the apostrophe is NOT confirmed on Google here (see docs/specs, "Validação controlada").
 * Numbers, dates and intended formulas must come back as they were.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');

const NOW = '2026-09-29T15:00:00-03:00';

test('the fake: a leading apostrophe is a text marker, two keep one, "=" is a formula', () => {
  const ctx = load({ sheets: [{ name: 'P', rows: [] }], now: NOW });
  const r = ctx.SpreadsheetApp.getActive().getSheetByName('P').getRange('A1');
  r.setValue("'abc");
  assert.equal(r.getValue(), 'abc');
  r.setValue("''abc");
  assert.equal(r.getValue(), "'abc");
  r.setValue("'=1+1");
  assert.deepEqual([r.getValue(), r.getFormula()], ['=1+1', '']);
  r.setValue('=1+1');
  assert.equal(r.getFormula(), '=1+1');
});

test('Hoje: a note that starts with an apostrophe reads back the same', () => {
  const ctx = load({ fixture: 'zoio_3_0', now: NOW });
  ctx.Migrate.run({});
  ctx.Hoje.ensure();
  ctx.Hoje.write('food', { note: "'observacao literal", qty: 150, food: 'Arroz' });
  const food = plain(ctx.Hoje.read().food);
  assert.equal(food.note, "'observacao literal");
  assert.equal(food.qty, 150, 'numbers untouched');
  assert.equal(food.food, 'Arroz');
});

test('Tabs and Style: data rows and layout grids keep a leading apostrophe; formulas stay formulas', () => {
  const ctx = load({ fixture: 'zoio_3_0', now: NOW });
  ctx.Migrate.run({});
  const row = ctx.ChangeLog.run('t', () => ctx.Tabs.append('audit', { severity: 'Info', code: 'x', tab: 'T', cell: "'Aba'!B5", finding: "'citação", action: '', state: 'Aberto' }));
  const saved = ctx.Tabs.read('audit').find((r) => r._row === row);
  assert.deepEqual([saved.cell, saved.finding], ["'Aba'!B5", "'citação"]);
  const sheet = ctx.SpreadsheetApp.getActive().getSheetByName(ctx.Tabs.get('dashboard').name);
  ctx.Style.write(sheet, 50, 20, [["'nome", '=1+2', 7, new Date('2026-09-14T00:00:00-03:00')]]);
  assert.equal(sheet.getRange(50, 20).getValue(), "'nome");
  assert.equal(sheet.getRange(50, 21).getFormula(), '=1+2');
  assert.equal(sheet.getRange(50, 22).getValue(), 7);
  assert.ok(sheet.getRange(50, 23).getValue() instanceof Date);
});

test('user text that starts with = + - @ stays literal through Tabs write and read', () => {
  const ctx = load({ fixture: 'zoio_3_0', now: NOW });
  ctx.Migrate.run({});
  const texts = ['=1+1', '+5kg', '-dor leve no ombro', '@fulano', "'aspas", 'Arroz e feijão'];
  texts.forEach((t, i) => {
    const row = ctx.ChangeLog.run('t', () => ctx.Tabs.append('audit', { severity: 'Info', code: `c${i}`, tab: 'T', cell: 'A1', finding: t, action: t, state: 'Aberto' }));
    const saved = ctx.Tabs.read('audit').find((r) => r._row === row);
    assert.deepEqual([saved.finding, saved.action], [t, t]);
    const sheet = ctx.SpreadsheetApp.getActive().getSheetByName(ctx.Tabs.get('audit').name);
    assert.equal(sheet.getRange(row, 1, 1, 12).getFormulas()[0].filter(Boolean).length, 0, `no formula for ${t}`);
    ctx.ChangeLog.run('u', () => ctx.Tabs.update('audit', row, { finding: `x${t}` }));
    ctx.ChangeLog.run('u', () => ctx.Tabs.update('audit', row, { finding: t }));
    assert.equal(ctx.Tabs.read('audit').find((r) => r._row === row).finding, t);
  });
});

test('undo puts back literal text that starts with = as text, never as a live formula', () => {
  const ctx = load({ fixture: 'zoio_3_0', now: NOW });
  ctx.Migrate.run({});
  const sheet = ctx.SpreadsheetApp.getActive().getSheetByName(ctx.Tabs.get('audit').name);
  const col = ctx.Tabs.headerMap('audit').finding;
  const row = ctx.ChangeLog.run('t', () => ctx.Tabs.append('audit', { severity: 'Info', code: 'f', tab: 'T', cell: 'A1', finding: '=1+1', action: '', state: 'Aberto' }));
  ctx.ChangeLog.run('u', () => ctx.Tabs.update('audit', row, { finding: 'normal' }));
  ctx.Undo.last();
  assert.deepEqual([sheet.getRange(row, col).getFormula(), sheet.getRange(row, col).getValue()], ['', '=1+1'], 'update undone');
  ctx.ChangeLog.run('r', () => ctx.Tabs.remove('audit', row));
  ctx.Undo.last();
  assert.deepEqual([sheet.getRange(row, col).getFormula(), sheet.getRange(row, col).getValue()], ['', '=1+1'], 'delete undone');
  const dash = ctx.SpreadsheetApp.getActive().getSheetByName(ctx.Tabs.get('dashboard').name);
  dash.getRange(50, 20).setValue("'=2+2");
  dash.getRange(50, 21).setFormula('=1+2');
  ctx.ChangeLog.run('s', () => ctx.Style.write(dash, 50, 20, [['x', 'y']]));
  ctx.Undo.last();
  assert.deepEqual([dash.getRange(50, 20).getFormula(), dash.getRange(50, 20).getValue()], ['', '=2+2'], 'layout text undone');
  assert.equal(dash.getRange(50, 21).getFormula(), '=1+2', 'layout formula undone');
});

test('undo refuses an old-format {$f} snapshot, which may have been literal text, and changes nothing', () => {
  const ctx = load({ fixture: 'zoio_3_0', now: NOW });
  ctx.Migrate.run({});
  const sheet = ctx.SpreadsheetApp.getActive().getSheetByName(ctx.Tabs.get('audit').name);
  const col = ctx.Tabs.headerMap('audit').finding;
  const row = ctx.ChangeLog.run('t', () => ctx.Tabs.append('audit', { severity: 'Info', code: 'f', tab: 'T', cell: 'A1', finding: '=1+1', action: '', state: 'Aberto' }));
  ctx.ChangeLog.run('u', () => ctx.Tabs.update('audit', row, { finding: 'normal' }));
  // Rewrite the update's Log row the way the previous format recorded it: {$f} without $v.
  const last = ctx.Tabs.read('log').filter((r) => !r.undone).pop();
  const before = JSON.parse(last.before);
  Object.keys(before).forEach((k) => { if (before[k] === '=1+1') before[k] = { $f: '=1+1' }; });
  assert.ok(JSON.stringify(before).includes('$f'), 'the legacy snapshot is in place');
  ctx.Tabs.update('log', last._row, { before: JSON.stringify(before) });
  assert.throws(() => ctx.Undo.last(), /antes da proteção contra fórmulas/);
  assert.deepEqual([sheet.getRange(row, col).getFormula(), sheet.getRange(row, col).getValue()], ['', 'normal'], 'nothing changed');
  // A formula recorded in the current format still round-trips as a formula.
  assert.deepEqual(plain(ctx.ChangeLog.decode(ctx.ChangeLog.encode({ a: ctx.Tabs.snapCell('=1+2', 3) }))), { a: { $f: '=1+2' } });
});

test('Hoje: notes starting with = or - read back as text', () => {
  const ctx = load({ fixture: 'zoio_3_0', now: NOW });
  ctx.Migrate.run({});
  ctx.Hoje.ensure();
  ctx.Hoje.write('food', { note: '=1+1', food: '-dor', qty: 150 });
  const food = plain(ctx.Hoje.read().food);
  assert.deepEqual([food.note, food.food, food.qty], ['=1+1', '-dor', 150]);
});

test('Tabs.text: only text starting with = + - @ or an apostrophe changes', () => {
  const ctx = load({ sheets: [{ name: 'P', rows: [] }], now: NOW });
  ['Arroz', '123', '1,5', '2026-10-20', '.5', '/x', 'a=b', '', 7, null, true].forEach((v) => assert.equal(ctx.Tabs.text(v), v));
  assert.deepEqual(['=1', '+1', '-1', '@a', "'a"].map(ctx.Tabs.text), ["'=1", "'+1", "'-1", "'@a", "''a"]);
});
