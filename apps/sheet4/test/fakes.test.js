'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { load, plain, fixture } = require('./harness');
const { createContext, loadFixture, snapshot, rectsFromCells, a1Of } = require('./fakes');

const TABS_3_0 = ['Hoje', 'Painel', 'Progressão', 'Macros e perfil', 'Ficha de treino', 'Registro de treino',
  'Dieta base', 'Equivalências', 'Alimentação', 'Diário', 'Semanas', 'Medidas e fotos', 'Revisões', 'Alimentos',
  'Guia e fontes', 'Histórico de metas', 'Exercícios', 'Histórico de fichas', 'Favoritas', 'Ingredientes'];

const HEADER_A5 = {
  Hoje: 'Data', Painel: 'Semana iniciada em', Progressão: 'Exercício', 'Macros e perfil': 'Parâmetro',
  'Ficha de treino': 'Sessão', 'Registro de treino': 'Data', 'Dieta base': 'Refeição', Equivalências: 'Base',
  Alimentação: 'Data', Diário: 'Data', Semanas: 'Início', 'Medidas e fotos': 'Data', Revisões: 'Data',
  Alimentos: 'Alimento único', 'Guia e fontes': 'Tema', 'Histórico de metas': 'Vigência', Exercícios: 'Exercício',
  'Histórico de fichas': 'Versão', Favoritas: 'Favorita', Ingredientes: 'Favorita',
};

const blankCtx = (extra = {}) => createContext({ sheets: [{ name: 'Aba', rows: [] }], ...extra });

// ------------------------------------------------------------------ fixtures

for (const name of ['breno_3_0', 'zoio_3_0']) {
  test(`${name}: loadFixture gives the 20 tabs in order with headers on row 5`, () => {
    const ctx = load({ fixture: name });
    const ss = ctx.SpreadsheetApp.getActive();
    assert.deepEqual(ss.getSheets().map((s) => s.getName()), TABS_3_0);
    for (const sheet of ss.getSheets()) {
      assert.equal(sheet.getRange(5, 1).getValue(), HEADER_A5[sheet.getName()], sheet.getName());
    }
    const diary = ss.getSheetByName('Diário');
    assert.deepEqual(diary.getRange('A5:F5').getValues()[0], ['Data', 'Peso kg', 'Sono h', 'Passos', 'Cardio min', 'Muay Thai']);
    assert.equal(diary.getFrozenRows(), 5);
    assert.equal(ss.getSheetByName('Progressão').getFrozenRows(), 9);
    assert.equal(diary.hasHiddenGridlines(), true);
    assert.equal(diary.getFilter().getRange().getA1Notation(), 'A5:AG1000');
    assert.equal(diary.getMaxColumns(), 33);
  });

  test(`${name}: snapshot(loadFixture(x)) === x`, () => {
    const json = fixture(name);
    const ctx = createContext();
    loadFixture(ctx, json);
    delete json.source;
    assert.deepEqual(plain(snapshot(ctx)), json);
  });
}

test('fixture details: formats, validations, notes, merges, charts, cached values', () => {
  const ctx = load({ fixture: 'breno_3_0' });
  const ss = ctx.SpreadsheetApp.getActive();
  const hoje = ss.getSheetByName('Hoje');
  assert.equal(hoje.getTabColor(), '#4c356b');
  assert.equal(hoje.getRange('A2').getFontWeight(), 'bold');
  assert.equal(hoje.getRange('A2').getFontSize(), 16);
  assert.equal(hoje.getRange('B5').getNumberFormat(), 'dd/mm/yyyy');
  assert.equal(hoje.isColumnHiddenByUser(14), true);
  assert.equal(hoje.isColumnHiddenByUser(13), false);
  assert.equal(hoje.getRange('B4').getNote().startsWith('Selecione uma ação'), true);
  assert.deepEqual(hoje.getRange('E5').getMergedRanges().map((r) => r.getA1Notation()), ['E5:L5']);
  const quick = hoje.getRange('B4').getDataValidation();
  assert.equal(quick.getCriteriaType(), 'VALUE_IN_LIST');
  assert.equal(quick.getCriteriaValues()[0][0], '—');
  assert.equal(quick.getAllowInvalid(), false);
  const fav = hoje.getRange('B14').getDataValidation();
  assert.equal(fav.getCriteriaType(), 'VALUE_IN_RANGE');
  assert.equal(fav.getCriteriaValues()[0].getSheet().getName(), 'Favoritas');
  assert.equal(fav.getCriteriaValues()[0].getA1Notation(), 'A6:A1000');
  // Formula: '' unless computed; the export's cached value is opt-in.
  assert.equal(hoje.getRange('B5').getFormula(), '=TODAY()');
  assert.equal(hoje.getRange('B5').getValue(), '');
  const cached = load({ fixture: 'breno_3_0', useCachedValues: true }).SpreadsheetApp.getActive().getSheetByName('Hoje');
  assert.equal(cached.getRange('B5').getDisplayValue(), '28/09/2026');
  const charts = ss.getSheetByName('Painel').getCharts();
  assert.equal(charts.length, 2);
  assert.equal(charts[0].modify().getChartType(), 'LINE');
  assert.equal(charts[0].getOptions().get('title'), 'Peso diário e média móvel de 7 dias');
  assert.equal(charts[1].getContainerInfo().getAnchorRow(), 25);
  const metas = ss.getSheetByName('Histórico de metas');
  const vig = metas.getRange('A6').getValue();
  assert.ok(vig instanceof Date);
  assert.equal(ctx.Utilities.formatDate(vig, 'America/Sao_Paulo', 'yyyy-MM-dd'), '1900-01-01');
  const cf = hoje.getConditionalFormatRules();
  assert.equal(cf.length, 3);
  assert.equal(cf[0].getBooleanCondition().getCriteriaType(), 'CUSTOM_FORMULA');
  assert.equal(cf[0].getBooleanCondition().getBackground(), '#dcfce7');
});

// ------------------------------------------------------------------ values and formulas

test('values, formulas, computed values, R1C1 and bounds', () => {
  const ctx = blankCtx();
  const sheet = ctx.SpreadsheetApp.getActive().getSheetByName('Aba');
  sheet.getRange('A1:B2').setValues([[1, 'x'], [new Date(2026, 8, 28), true]]);
  sheet.getRange('C1').setValue('=A1*2');
  assert.equal(sheet.getRange('C1').getFormula(), '=A1*2');
  assert.equal(sheet.getRange('C1').getValue(), '');
  sheet.getRange('C1').setComputedValue_(2);
  assert.equal(sheet.getRange('C1').getValue(), 2);
  sheet.getRange('D2').setFormulaR1C1('=R[-1]C[-3]+R1C1');
  assert.equal(sheet.getRange('D2').getFormula(), '=A1+$A$1');
  assert.equal(sheet.getRange('D2').getFormulaR1C1(), '=R[-1]C[-3]+R1C1');
  ctx.__formulaEvaluator = (f) => (f === '=A1+$A$1' ? 2 : '');
  assert.equal(sheet.getRange('D2').getValue(), 2);
  sheet.getRange('C1').setValue(5);
  assert.equal(sheet.getRange('C1').getFormula(), '');
  assert.equal(sheet.getLastRow(), 2);
  assert.equal(sheet.getLastColumn(), 4);
  assert.throws(() => sheet.getRange('A1:B2').setValues([[1]]), /1 rows x 1 columns/);
  assert.throws(() => sheet.getRange(1, 27), /outside the dimensions/);
  assert.throws(() => sheet.getRange(1001, 1), /outside the dimensions/);
  assert.equal(sheet.getRange('B:B').getNumRows(), 1000);
  assert.equal(sheet.getRange('A6:C').getA1Notation(), 'A6:C1000');
  sheet.getRange('A1:D2').clearContent();
  assert.equal(sheet.getLastRow(), 0);
});

test('display values follow number formats and the pt_BR locale', () => {
  const ctx = blankCtx();
  const sheet = ctx.SpreadsheetApp.getActive().getSheetByName('Aba');
  const r = sheet.getRange('A1:E1');
  r.setValues([[new Date(2026, 8, 28), 67.456, 0.123, 1234567.8, new Date(2026, 8, 28, 14, 5)]]);
  r.setNumberFormats([['dd/mm/yyyy', '0.0', '0%', '#,##0.00', 'dd/MM/yyyy HH:mm']]);
  assert.deepEqual(r.getDisplayValues()[0], ['28/09/2026', '67,5', '12%', '1.234.567,80', '28/09/2026 14:05']);
  sheet.getRange('A2').setValue(new Date(2026, 0, 2));
  assert.equal(sheet.getRange('A2').getDisplayValue(), '02/01/2026');
});

test('dates from the VM realm and the host realm are both instanceof Date', () => {
  const ctx = load({ now: '2026-09-29T15:00:00-03:00', sheets: [{ name: 'Aba', rows: [[new Date(2026, 8, 1)]] }] });
  const out = vm.runInContext(`(function () {
    const v = SpreadsheetApp.getActive().getSheetByName('Aba').getRange('A1').getValue();
    return [v instanceof Date, new Date() instanceof Date, new Date().toISOString(), Date.now()];
  })()`, ctx);
  assert.deepEqual(plain(out.slice(0, 3)), [true, true, '2026-09-29T18:00:00.000Z']);
  ctx.__clock.advance(60 * 1000);
  assert.equal(vm.runInContext('new Date().toISOString()', ctx), '2026-09-29T18:01:00.000Z');
});

// ------------------------------------------------------------------ formatting

test('formatting setters are recorded per cell and grouped in the snapshot', () => {
  const ctx = blankCtx();
  const sheet = ctx.SpreadsheetApp.getActive().getSheetByName('Aba');
  sheet.getRange('A1:C1').setBackground('#FFF4D1').setFontWeight('bold').setFontColor('white')
    .setFontSize(14).setFontFamily('Roboto').setHorizontalAlignment('center').setVerticalAlignment('middle');
  sheet.getRange('A2:B3').setWrap(true).setFontStyle('italic').setNumberFormat('0.0');
  sheet.getRange('C3').setNote('calculado');
  sheet.getRange('A5:B5').setBorder(true, true, true, true, null, null, '#cccccc', ctx.SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
  sheet.getRangeList(['E1', 'F2']).setBackground('#dcfce7');
  assert.deepEqual(sheet.getRange('A1:B1').getBackgrounds(), [['#fff4d1', '#fff4d1']]);
  assert.equal(sheet.getRange('D1').getBackground(), '#ffffff');
  assert.equal(sheet.getRange('D1').getFontWeight(), 'normal');
  assert.deepEqual(sheet.getRange('A5').getBorders_()[0][0], { top: { style: 'SOLID_MEDIUM', color: '#cccccc' }, bottom: { style: 'SOLID_MEDIUM', color: '#cccccc' }, left: { style: 'SOLID_MEDIUM', color: '#cccccc' } });
  sheet.getRange('B1').setFontWeight('normal');
  const snap = snapshot(ctx).sheets[0];
  assert.deepEqual(snap.formats.map((f) => [f.ranges, Object.keys(f.format).sort()]), [
    [['A1', 'C1'], ['background', 'fontColor', 'fontFamily', 'fontSize', 'fontWeight', 'horizontalAlignment', 'verticalAlignment']],
    [['B1'], ['background', 'fontColor', 'fontFamily', 'fontSize', 'horizontalAlignment', 'verticalAlignment']],
    [['E1', 'F2'], ['background']],
    [['A2:B3'], ['fontStyle', 'numberFormat', 'wrap']],
    [['A5'], ['borders']],
    [['B5'], ['borders']],
  ]);
  assert.deepEqual(snap.notes, { C3: 'calculado' });
  sheet.getRange('A1:C1').clearFormat();
  assert.equal(sheet.getRange('A1').getBackground(), '#ffffff');
});

test('sheet view: widths, heights, frozen rows, gridlines, tab colour, hidden, groups', () => {
  const ctx = blankCtx();
  const sheet = ctx.SpreadsheetApp.getActive().getSheetByName('Aba');
  sheet.setColumnWidth(1, 220).setColumnWidths(2, 3, 90).setRowHeight(1, 40).setRowHeights(2, 2, 28);
  sheet.setFrozenRows(5).setFrozenColumns(1).setHiddenGridlines(true).setTabColor('#4C356B');
  sheet.hideColumns(8, 2);
  sheet.getRange('J:K').shiftColumnGroupDepth(1);
  assert.equal(sheet.getColumnWidth(1), 220);
  assert.equal(sheet.getColumnWidth(10), 100);
  assert.equal(sheet.getRowHeight(3), 28);
  assert.equal(sheet.getColumnGroupDepth(11), 1);
  const snap = snapshot(ctx).sheets[0];
  assert.deepEqual(snap.columnWidths, { A: 220, B: 90, C: 90, D: 90 });
  assert.deepEqual(snap.rowHeights, [[1, 1, 40], [2, 3, 28]]);
  assert.deepEqual(snap.hiddenColumns, [[8, 9]]);
  assert.deepEqual(snap.columnGroups, [[10, 11, 1]]);
  assert.equal(snap.tabColor, '#4c356b');
  assert.equal(snap.frozenRows, 5);
});

test('merges keep the top-left value and follow row inserts', () => {
  const ctx = blankCtx();
  const sheet = ctx.SpreadsheetApp.getActive().getSheetByName('Aba');
  sheet.getRange('A1:C1').setValues([['a', 'b', 'c']]);
  sheet.getRange('A1:C1').merge();
  assert.deepEqual(sheet.getRange('A1:C1').getValues(), [['a', '', '']]);
  assert.equal(sheet.getRange('B1').isPartOfMerge(), true);
  sheet.insertRowsBefore(1, 2);
  assert.deepEqual(snapshot(ctx).sheets[0].merges, ['A3:C3']);
  sheet.getRange('A3:C3').breakApart();
  assert.deepEqual(snapshot(ctx).sheets[0].merges, []);
});

// ------------------------------------------------------------------ spreadsheet structure

test('sheets: insert at index, order, move, rename, hide, delete, ids', () => {
  const ctx = createContext({ sheets: [{ name: 'A', rows: [] }, { name: 'B', rows: [] }] });
  const ss = ctx.SpreadsheetApp.getActive();
  const c = ss.insertSheet('C', 1);
  assert.deepEqual(ss.getSheets().map((s) => s.getName()), ['A', 'C', 'B']);
  assert.equal(ss.getActiveSheet(), c);
  assert.equal(c.getIndex(), 2);
  ss.setActiveSheet(ss.getSheetByName('A'));
  ss.moveActiveSheet(3);
  assert.deepEqual(ss.getSheets().map((s) => s.getName()), ['C', 'B', 'A']);
  const id = c.getSheetId();
  c.setName('Config');
  assert.equal(ss.getSheetById(id).getName(), 'Config');
  assert.throws(() => c.setName('B'), /already exists/);
  assert.throws(() => ss.insertSheet('B'), /already exists/);
  c.hideSheet();
  assert.equal(c.isSheetHidden(), true);
  ss.getSheetByName('B').hideSheet();
  assert.throws(() => ss.getSheetByName('A').hideSheet(), /hide all the sheets/);
  c.showSheet();
  ss.deleteSheet(ss.getSheetByName('B'));
  assert.deepEqual(ss.getSheets().map((s) => s.getName()), ['Config', 'A']);
  assert.equal(ss.insertSheet().getName(), 'Sheet3');
});

test('renaming a sheet rewrites formulas and keeps range-based validations/named ranges', () => {
  const ctx = createContext({ sheets: [{ name: 'Painel', rows: [["='Histórico de metas'!A6", '=Metas!B2']] }, { name: 'Histórico de metas', rows: [] }] });
  const ss = ctx.SpreadsheetApp.getActive();
  const metas = ss.getSheetByName('Histórico de metas');
  ss.setNamedRange('MetasIds', metas.getRange('A6:A100'));
  const rule = ctx.SpreadsheetApp.newDataValidation().requireValueInRange(metas.getRange('A6:A100')).build();
  ss.getSheetByName('Painel').getRange('C1').setDataValidation(rule);
  metas.setName('Metas');
  assert.deepEqual(ss.getSheetByName('Painel').getRange('A1:B1').getFormulas(), [['=Metas!A6', '=Metas!B2']]);
  assert.equal(ss.getRangeByName('MetasIds').getSheet().getName(), 'Metas');
  const snap = snapshot(ctx);
  assert.deepEqual(snap.namedRanges, [{ name: 'MetasIds', sheet: 'Metas', range: 'A6:A100' }]);
  assert.deepEqual(snap.sheets[0].dataValidations[0].values, ['Metas!$A$6:$A$100']);
});

test('insertRows/deleteRows/insertColumns shift values, formats, named ranges and rules', () => {
  const ctx = createContext({ sheets: [{ name: 'Aba', rows: [['h1', 'h2'], ['a', 1], ['b', 2]] }] });
  const ss = ctx.SpreadsheetApp.getActive();
  const sheet = ss.getSheetByName('Aba');
  sheet.getRange('A2').setBackground('#eeeeee');
  ss.setNamedRange('Dados', sheet.getRange('A2:B3'));
  const cf = ctx.SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(1).setBackground('#fee2e2')
    .setRanges([sheet.getRange('B2:B3')]).build();
  sheet.setConditionalFormatRules([cf]);
  sheet.insertRowsAfter(1, 2);
  assert.equal(sheet.getMaxRows(), 1002);
  assert.deepEqual(sheet.getRange('A4:B5').getValues(), [['a', 1], ['b', 2]]);
  assert.equal(sheet.getRange('A4').getBackground(), '#eeeeee');
  assert.equal(ss.getRangeByName('Dados').getA1Notation(), 'A4:B5');
  assert.equal(sheet.getConditionalFormatRules()[0].getRanges()[0].getA1Notation(), 'B4:B5');
  sheet.deleteRows(2, 3);
  assert.deepEqual(sheet.getDataRange().getValues(), [['h1', 'h2'], ['b', 2]]);
  assert.equal(ss.getRangeByName('Dados').getA1Notation(), 'A2:B2');
  sheet.insertColumnsBefore(1, 1);
  assert.equal(sheet.getMaxColumns(), 27);
  assert.deepEqual(sheet.getRange('A1:C1').getValues(), [['', 'h1', 'h2']]);
  sheet.appendRow(['x', 'y']);
  assert.equal(sheet.getLastRow(), 3);
});

// ------------------------------------------------------------------ validations, rules, protections

test('data validation builder: list, number, checkbox, date, formula', () => {
  const ctx = blankCtx();
  const App = ctx.SpreadsheetApp;
  const sheet = App.getActive().getSheetByName('Aba');
  sheet.getRange('A6:A20').setDataValidation(App.newDataValidation().requireValueInList(['Sim', 'Não']).setAllowInvalid(false).setHelpText('Escolha').build());
  sheet.getRange('B6:B20').setDataValidation(App.newDataValidation().requireNumberBetween(0, 300).build());
  sheet.getRange('C6:C7').insertCheckboxes();
  sheet.getRange('D6').setDataValidation(App.newDataValidation().requireDate().build());
  sheet.getRange('E6').setDataValidation(App.newDataValidation().requireDateOnOrAfter(new Date(2000, 0, 1)).build());
  sheet.getRange('F6').setDataValidation(App.newDataValidation().requireFormulaSatisfied('=F6>0').build());
  const dv = sheet.getRange('A10').getDataValidation();
  assert.equal(dv.getCriteriaType(), App.DataValidationCriteria.VALUE_IN_LIST);
  assert.deepEqual(plain(dv.getCriteriaValues()), [['Sim', 'Não'], true]);
  assert.equal(dv.getAllowInvalid(), false);
  assert.equal(dv.getHelpText(), 'Escolha');
  assert.deepEqual(sheet.getRange('C6:C7').getValues(), [[false], [false]]);
  assert.equal(sheet.getRange('C6').isChecked(), false);
  assert.equal(sheet.getRange('A5').getDataValidation(), null);
  const snap = snapshot(ctx).sheets[0].dataValidations;
  assert.deepEqual(plain(snap), [
    { ranges: ['A6:A20'], criteria: 'VALUE_IN_LIST', values: ['Sim', 'Não'], allowInvalid: false, helpText: 'Escolha' },
    { ranges: ['B6:B20'], criteria: 'NUMBER_BETWEEN', values: [0, 300], allowInvalid: true },
    { ranges: ['C6:C7'], criteria: 'CHECKBOX', values: [], allowInvalid: true },
    { ranges: ['D6'], criteria: 'DATE_IS_VALID_DATE', values: [], allowInvalid: true },
    { ranges: ['E6'], criteria: 'DATE_ON_OR_AFTER', values: [{ $date: '2000-01-01' }], allowInvalid: true },
    { ranges: ['F6'], criteria: 'CUSTOM_FORMULA', values: ['=F6>0'], allowInvalid: true },
  ]);
  sheet.getRange('A6:A20').clearDataValidations();
  assert.equal(sheet.getRange('A6').getDataValidation(), null);
});

test('conditional format rules builder and get/set', () => {
  const ctx = blankCtx();
  const App = ctx.SpreadsheetApp;
  const sheet = App.getActive().getSheetByName('Aba');
  const rules = [
    App.newConditionalFormatRule().whenFormulaSatisfied('=$A6<DATE(2000,1,1)').setFontColor('#ffffff').setRanges([sheet.getRange('A6:A1000')]).build(),
    App.newConditionalFormatRule().whenTextEqualTo('No caminho').setBackground('#dcfce7').setBold(true).setRanges([sheet.getRange('C6:C1000'), sheet.getRange('B6:B1000')]).build(),
  ];
  sheet.setConditionalFormatRules(rules);
  const got = sheet.getConditionalFormatRules();
  assert.equal(got.length, 2);
  assert.equal(got[1].getBooleanCondition().getCriteriaType(), App.BooleanCriteria.TEXT_EQUAL_TO);
  assert.deepEqual(got[1].getBooleanCondition().getCriteriaValues(), ['No caminho']);
  assert.deepEqual(plain(snapshot(ctx).sheets[0].conditionalFormats[1]), {
    ranges: ['B6:B1000', 'C6:C1000'], condition: 'TEXT_EQUAL_TO', values: ['No caminho'], format: { background: '#dcfce7', bold: true },
  });
  const edited = got[0].copy().setBackground('#fee2e2').build();
  sheet.setConditionalFormatRules([edited]);
  assert.equal(sheet.getConditionalFormatRules()[0].getBooleanCondition().getBackground(), '#fee2e2');
  sheet.clearConditionalFormatRules();
  assert.equal(sheet.getConditionalFormatRules().length, 0);
});

test('protections: range and sheet, warning only, unprotected ranges, remove', () => {
  const ctx = blankCtx();
  const App = ctx.SpreadsheetApp;
  const ss = App.getActive();
  const sheet = ss.getSheetByName('Aba');
  sheet.getRange('Q6:Z1000').protect().setDescription('calculado').setWarningOnly(true);
  const sp = sheet.protect().setDescription('Painel').setWarningOnly(true);
  sp.setUnprotectedRanges([sheet.getRange('B4')]);
  assert.equal(sheet.protect(), sp);
  assert.equal(ss.getProtections(App.ProtectionType.RANGE).length, 1);
  assert.equal(sheet.getProtections(App.ProtectionType.SHEET)[0].isWarningOnly(), true);
  assert.deepEqual(plain(snapshot(ctx).sheets[0].protections), [
    { type: 'RANGE', range: 'Q6:Z1000', description: 'calculado', warningOnly: true, unprotectedRanges: [] },
    { type: 'SHEET', range: null, description: 'Painel', warningOnly: true, unprotectedRanges: ['B4'] },
  ]);
  sheet.getProtections(App.ProtectionType.RANGE)[0].remove();
  assert.equal(ss.getProtections(App.ProtectionType.RANGE).length, 0);
});

test('charts: builder, insert, modify/update, remove', () => {
  const ctx = createContext({ sheets: [{ name: 'Painel', rows: [] }, { name: 'Evolução', rows: [] }] });
  const ss = ctx.SpreadsheetApp.getActive();
  const painel = ss.getSheetByName('Painel');
  const evo = ss.getSheetByName('Evolução');
  const chart = painel.newChart().setChartType(ctx.Charts.ChartType.LINE)
    .addRange(evo.getRange('A5:A60')).addRange(evo.getRange('C5:E60'))
    .setPosition(20, 2, 0, 0).setOption('title', 'Peso (média 7d) por fase').setNumHeaders(1).build();
  painel.insertChart(chart);
  const [c] = painel.getCharts();
  assert.equal(typeof c.getChartId(), 'number');
  assert.deepEqual(c.getRanges().map((r) => r.getA1Notation()), ['A5:A60', 'C5:E60']);
  painel.updateChart(c.modify().asColumnChart().setOption('title', 'Cintura').build());
  assert.deepEqual(plain(snapshot(ctx).sheets[0].charts), [{
    type: 'COLUMN', position: { row: 20, column: 2, offsetX: 0, offsetY: 0 },
    ranges: ["'Evolução'!A5:A60", "'Evolução'!C5:E60"], options: { title: 'Cintura', numHeaders: 1 },
  }]);
  painel.removeChart(painel.getCharts()[0]);
  assert.equal(painel.getCharts().length, 0);
});

// ------------------------------------------------------------------ UI, HTML, triggers

test('menus, alerts, prompts, toasts and dialogs are recorded; answers are scripted', () => {
  const ctx = blankCtx({ uiResponses: ['NO', { button: 'OK', text: '2400' }] });
  const ui = ctx.SpreadsheetApp.getUi();
  ui.createMenu('Projeto')
    .addSubMenu(ui.createMenu('Hoje').addItem('Salvar dia', 'Actions.saveDay'))
    .addSeparator()
    .addItem('Desfazer última alteração', 'Actions.undo')
    .addToUi();
  assert.equal(ctx.__menus[0].name, 'Projeto');
  assert.deepEqual(plain(ctx.__menus[0].items.map((i) => i[0])), ['Hoje', '---', 'Desfazer última alteração']);
  assert.deepEqual(ctx.__menus[0].functions_(), ['Actions.saveDay', 'Actions.undo']);
  assert.equal(ui.alert('Migrar', 'Confirmar?', ui.ButtonSet.YES_NO), ui.Button.NO);
  const p = ui.prompt('Nova meta', 'kcal', ui.ButtonSet.OK_CANCEL);
  assert.equal(p.getSelectedButton(), ui.Button.OK);
  assert.equal(p.getResponseText(), '2400');
  assert.equal(ui.alert('Pronto'), ui.Button.OK);
  assert.deepEqual(ctx.__alerts.map((a) => [a.title, a.message, a.response]), [['Migrar', 'Confirmar?', 'NO'], ['', 'Pronto', 'OK']]);
  ctx.SpreadsheetApp.getActive().toast('Dia salvo', 'Projeto');
  assert.deepEqual(ctx.__toasts, [{ msg: 'Dia salvo', title: 'Projeto', seconds: 5 }]);
  const t = ctx.HtmlService.createTemplate('<h1><?= title ?></h1><? for (var i = 0; i < n; i++) { ?><p><?= i ?></p><? } ?><?!= raw ?>');
  t.title = 'A & B'; t.n = 2; t.raw = '<b>x</b>';
  ui.showModalDialog(t.evaluate().setWidth(400).setHeight(300), 'Mudar fase');
  assert.deepEqual(ctx.__dialogs, [{ kind: 'modal', title: 'Mudar fase', html: '<h1>A &#38; B</h1><p>0</p><p>1</p><b>x</b>', width: 400, height: 300 }]);
});

test('triggers: create, list, delete; simulated edits call installable handlers', () => {
  const ctx = load({ sheets: [{ name: 'Hoje', rows: [] }] });
  const edits = [];
  ctx.onEditInstalled = (e) => edits.push([e.range.getA1Notation(), e.value, e.oldValue]);
  const ss = ctx.SpreadsheetApp.getActive();
  ctx.ScriptApp.newTrigger('onEditInstalled').forSpreadsheet(ss).onEdit().create();
  ctx.ScriptApp.newTrigger('dailyUpdate').timeBased().everyDays(1).atHour(5).create();
  const triggers = ctx.ScriptApp.getProjectTriggers();
  assert.deepEqual(triggers.map((t) => [t.getHandlerFunction(), t.getEventType(), t.getTriggerSource()]),
    [['onEditInstalled', 'ON_EDIT', 'SPREADSHEETS'], ['dailyUpdate', 'CLOCK', 'CLOCK']]);
  assert.deepEqual(ctx.__triggers[1].schedule, { everyDays: 1, atHour: 5 });
  ctx.__simulateEdit('Hoje', 'B4', 'Salvar dia');
  assert.deepEqual(edits, [['B4', 'Salvar dia', '']]);
  ctx.ScriptApp.deleteTrigger(triggers[0]);
  assert.deepEqual(ctx.ScriptApp.getProjectTriggers().map((t) => t.getHandlerFunction()), ['dailyUpdate']);
});

test('properties, locks, cache, utilities, session and clock', () => {
  const ctx = blankCtx({ now: '2026-09-29T12:00:00Z', properties: { token: 'abc' } });
  const props = ctx.PropertiesService.getScriptProperties();
  props.setProperty('n', 3).setProperties({ a: 1 });
  assert.deepEqual(props.getProperties(), { token: 'abc', n: '3', a: '1' });
  props.deleteProperty('a');
  assert.deepEqual(props.getKeys(), ['token', 'n']);
  const lock = ctx.LockService.getScriptLock();
  lock.waitLock(30000);
  assert.equal(lock.hasLock(), true);
  lock.releaseLock();
  ctx.__lockBusy = true;
  assert.throws(() => ctx.LockService.getScriptLock().waitLock(10), /Lock timeout/);
  assert.equal(ctx.LockService.getScriptLock().tryLock(10), false);
  assert.deepEqual(ctx.__locks, ['wait', 'release', 'wait', 'try']);
  const cache = ctx.CacheService.getScriptCache();
  cache.put('k', 'v', 60);
  assert.equal(cache.get('k'), 'v');
  ctx.__clock.advance(61 * 1000);
  assert.equal(cache.get('k'), null);
  const d = new ctx.Date();
  assert.equal(ctx.Utilities.formatDate(d, 'America/Sao_Paulo', "yyyy-MM-dd'T'HH:mm EEE"), '2026-09-29T09:01 Tue');
  assert.equal(ctx.Utilities.parseDate('28/09/2026', 'America/Sao_Paulo', 'dd/MM/yyyy').toISOString(), '2026-09-28T03:00:00.000Z');
  assert.equal(ctx.Utilities.getUuid(), '00000000-0000-4000-8000-000000000001');
  assert.equal(ctx.Utilities.newBlob('olá', 'text/plain', 'a.txt').getDataAsString(), 'olá');
  assert.equal(ctx.Session.getScriptTimeZone(), 'America/Sao_Paulo');
  ctx.Utilities.sleep(1000);
  assert.equal(ctx.Date.now(), Date.parse('2026-09-29T12:01:02Z'));
});

test('rectsFromCells is the canonical cover shared with tools/sheetjson.py', () => {
  const cells = [[1, 1], [1, 2], [2, 1], [2, 2], [3, 1], [5, 1], [5, 3]];
  assert.deepEqual(rectsFromCells(cells).map((r) => a1Of(r)), ['A1:B2', 'A3', 'A5', 'C5']);
});

// ------------------------------------------------------------------ python round trip

const python = spawnSync('python3', ['-c', 'import openpyxl'], { encoding: 'utf8' });
test('a mutated snapshot survives fixture_to_xlsx -> xlsx_to_fixture', { skip: python.status !== 0 && 'python3 + openpyxl not available' }, () => {
  const ctx = load({ fixture: 'zoio_3_0' });
  const ss = ctx.SpreadsheetApp.getActive();
  const config = ss.getSheetByName('Macros e perfil');
  config.setName('Config');
  config.getRange('B10').setValue(new Date(2026, 8, 28));
  const obj = ss.insertSheet('Objetivos', 16);
  obj.getRange('A5:C5').setValues([['ID', 'Objetivo', 'Início']]).setFontWeight('bold').setBackground('#1e3a5f');
  obj.getRange('C6:C1000').setNumberFormat('dd/mm/yyyy');
  obj.getRange('A6:A1000').setDataValidation(ctx.SpreadsheetApp.newDataValidation().requireValueInRange(config.getRange('A6:A40')).build());
  obj.setTabColor('#999999').setFrozenRows(5);
  obj.hideSheet();
  const before = plain(snapshot(ctx));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet4-'));
  const jsonPath = path.join(dir, 'snap.json');
  const xlsxPath = path.join(dir, 'snap.xlsx');
  fs.writeFileSync(jsonPath, JSON.stringify(before));
  const tools = path.join(__dirname, '..', '..', '..', 'tools');
  let r = spawnSync('python3', [path.join(tools, 'fixture_to_xlsx.py'), jsonPath, xlsxPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync('python3', [path.join(tools, 'xlsx_to_fixture.py'), xlsxPath, jsonPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const after = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const strip = (s) => JSON.parse(JSON.stringify(s, (k, v) => (k === 'tables' || k === '$value' || k === 'source' || k === 'protections' ? undefined : v)));
  assert.deepEqual(strip(after), strip(before));
  fs.rmSync(dir, { recursive: true, force: true });
});
