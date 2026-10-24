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
