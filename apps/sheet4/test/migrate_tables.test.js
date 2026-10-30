'use strict';
/**
 * Native tables turned into plain ranges (Migrate.unwrapTables_) without a window where data can
 * be lost: a verified copy is written before a table is removed, and a run stopped at any point
 * (simulated by an error plus a new execution: nothing in memory survives) is finished from it.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, freshExecution, plain } = require('./harness');

const NOW = '2026-09-29T15:00:00-03:00';

/**
 * Sheets advanced service over the fake: tables are sheet.tables_ ({name, range, id?});
 * deleteTable removes the table and, like "Excluir tabela", its contents and number formats.
 * hooks.afterDelete(table) runs right after a removal (to stop the run there).
 */
function sheetsApi(ctx, hooks = {}) {
  const ss = ctx.SpreadsheetApp.getActive();
  const grid = (s, a1) => {
    const r = s.getRange(a1);
    return { startRowIndex: r.getRow() - 1, endRowIndex: r.getLastRow(), startColumnIndex: r.getColumn() - 1, endColumnIndex: r.getLastColumn() };
  };
  const api = {
    deleted: [],
    hooks,
    Spreadsheets: {
      get: () => ({ sheets: ss.getSheets().map((s, i) => ({ properties: { sheetId: i, title: s.getName() }, tables: (s.tables_ || []).map((t) => ({ tableId: t.id || t.name, name: t.name, range: grid(s, t.range) })) })) }),
      batchUpdate: (body) => body.requests.forEach(({ deleteTable }) => ss.getSheets().forEach((s) => {
        const t = (s.tables_ || []).find((x) => (x.id || x.name) === deleteTable.tableId);
        if (!t) return;
        s.getRange(t.range).clearContent().setNumberFormat('General');
        s.tables_ = s.tables_.filter((x) => x !== t);
        api.deleted.push(t.name);
        if (api.hooks.afterDelete) api.hooks.afterDelete(t);
      })),
    },
  };
  ctx.Sheets = api;
  return api;
}

const DATE = new Date('2026-09-14T00:00:00-03:00');

/** A sheet "Dados" with table "Tabela1" on A1:E4 and a sheet "Resumo" whose formulas read it. */
function setup(ctx, { second = false } = {}) {
  const ss = ctx.SpreadsheetApp.getActive();
  const dados = ss.insertSheet('Dados');
  dados.getRange('A1:E4').setValues([
    ['Item', 'Valor', 'Data', 'Ok', 'Nota'],
    ["'=1+1", 0, DATE, false, 'ç/ã "aspas" , ; \\ \n linha'],
    ['0123', 2.5, '', true, "''apóstrofo"], // typed as text that starts with an apostrophe
    ['', -1, DATE, '', '29/09/2026'],
  ]);
  dados.getRange('B2').setFormula('=C2+1');
  dados.getRange('B2:B4').setNumberFormat('0.00');
  dados.getRange('C2:C4').setNumberFormat('dd/mm/yyyy');
  dados.tables_ = [{ name: 'Tabela1', range: 'A1:E4' }];
  const resumo = ss.insertSheet('Resumo');
  resumo.getRange('A1').setFormula("='Dados'!B3*2");
  if (second) {
    const outra = ss.insertSheet('Outra');
    outra.getRange('A1:B3').setValues([['Chave', 'Valor'], ['a', 1], ['b', 2]]);
    outra.tables_ = [{ name: 'Tabela2', range: 'A1:B3' }];
  }
  return { ss, dados, resumo };
}

/** Values, formulas and number formats of a range, comparable. */
function state(sheet, a1) {
  const r = sheet.getRange(a1);
  return JSON.stringify({ v: plain(r.getValues()), f: r.getFormulas(), n: r.getNumberFormats() });
}

const boot = () => load({ sheets: [{ name: 'Página1', rows: [] }], now: NOW });
const tablesLeft = (ss) => ss.getSheets().reduce((n, s) => n + (s.tables_ || []).length, 0);
/** The migration's copy sheet (its name carries the token), or null. */
const backupOf = (ctx) => ctx.SpreadsheetApp.getActive().getSheets().find((s) => s.getName().indexOf(`${ctx.Migrate.BACKUP_SHEET} `) === 0) || null;

test('a table becomes a plain range with values, formulas, literal "=" text, dates, 0, false, blanks and formats', () => {
  const ctx = boot();
  const { ss, dados, resumo } = setup(ctx);
  sheetsApi(ctx);
  const before = state(dados, 'A1:E4');
  assert.equal(dados.getRange('A2').getValue(), '=1+1');
  assert.equal(dados.getRange('A2').getFormula(), '', 'literal text, not a formula');
  const converted = plain(ctx.Migrate.unwrapTables_());
  assert.deepEqual(converted, ['Dados (Tabela1)']);
  assert.equal(state(dados, 'A1:E4'), before);
  assert.equal(dados.getRange('A2').getFormula(), '');
  assert.equal(dados.getRange('A3').getValue(), '0123', 'text that looks like a number stays text');
  assert.equal(dados.getRange('E3').getValue(), "'apóstrofo");
  assert.equal(resumo.getRange('A1').getFormula(), "='Dados'!B3*2", 'formulas outside the table are untouched');
  assert.equal(tablesLeft(ss), 0);
  assert.equal(backupOf(ctx), null, 'the copy is dropped once checked');
});

test('formulas that use a table by name are refused before anything is removed', () => {
  const ctx = boot();
  const { ss, dados, resumo } = setup(ctx);
  const api = sheetsApi(ctx);
  resumo.getRange('A2').setFormula('=SUM(Tabela1[Valor])');
  const before = state(dados, 'A1:E4');
  assert.throws(() => ctx.Migrate.unwrapTables_(), /pelo nome \(Resumo!A2\)/);
  assert.deepEqual(api.deleted, []);
  assert.equal(state(dados, 'A1:E4'), before);
  assert.equal(tablesLeft(ss), 1);
  assert.equal(backupOf(ctx), null);
});

test('an invalid configuration converts nothing (validated before the tables)', () => {
  const ctx = load({ fixture: 'breno_3_0', now: NOW });
  const api = sheetsApi(ctx);
  const ss = ctx.SpreadsheetApp.getActive();
  const n = tablesLeft(ss);
  assert.ok(n > 0);
  assert.throws(() => ctx.wizardUnwrapTables({ json: '{}' }), /Informe o sexo/);
  assert.deepEqual(api.deleted, []);
  assert.equal(tablesLeft(ss), n);
});

/** Stops the run right after the n-th removal (the error stands for Apps Script killing it). */
const stopAfterDelete = (api, n = 1) => {
  let count = 0;
  api.hooks.afterDelete = () => { count += 1; if (count === n) { api.hooks.afterDelete = null; throw new Error('execução interrompida'); } };
};

test('stopped right after the removal: the next execution restores the table from the copy', () => {
  const ctx = boot();
  const { ss, dados } = setup(ctx);
  const api = sheetsApi(ctx);
  const before = state(dados, 'A1:E4');
  stopAfterDelete(api);
  assert.throws(() => ctx.Migrate.unwrapTables_(), /interrompida/);
  assert.equal(dados.getRange('A1').getValue(), '', 'the data is gone from the sheet…');
  assert.ok(backupOf(ctx), '…but its copy is there');
  freshExecution(ctx);
  const r = plain(ctx.Migrate.unwrapTables_());
  assert.deepEqual(r, ['Dados (Tabela1)']);
  assert.equal(state(dados, 'A1:E4'), before);
  assert.equal(backupOf(ctx), null);
  assert.deepEqual(plain(ctx.Migrate.unwrapTables_()), [], 'nothing left to do');
});

test('stopped while writing back, or at the flush after it: the next execution finishes', () => {
  ['setValues', 'flush'].forEach((where) => {
    const ctx = boot();
    const { dados } = setup(ctx);
    const api = sheetsApi(ctx);
    const before = state(dados, 'A1:E4');
    const proto = Object.getPrototypeOf(dados.getRange('A1'));
    const originalSet = proto.setValues;
    const originalFlush = ctx.SpreadsheetApp.flush;
    api.hooks.afterDelete = () => {
      api.hooks.afterDelete = null;
      if (where === 'setValues') {
        proto.setValues = function (values) { proto.setValues = originalSet; originalSet.call(this, values.map((l, i) => (i === 0 ? l : l.map(() => '')))); throw new Error('falha ao gravar'); };
      } else {
        let calls = 0;
        ctx.SpreadsheetApp.flush = () => { calls += 1; if (calls === 1) { ctx.SpreadsheetApp.flush = originalFlush; throw new Error('falha no flush'); } };
      }
    };
    assert.throws(() => ctx.Migrate.unwrapTables_(), /falha/);
    proto.setValues = originalSet;
    freshExecution(ctx);
    assert.deepEqual(plain(ctx.Migrate.unwrapTables_()), ['Dados (Tabela1)'], where);
    assert.equal(state(dados, 'A1:E4'), before, where);
  });
});

test('two tables, the first converted and the second interrupted: only the second is recovered', () => {
  const ctx = boot();
  const { ss, dados } = setup(ctx, { second: true });
  const outra = ss.getSheetByName('Outra');
  const api = sheetsApi(ctx);
  const before = [state(dados, 'A1:E4'), state(outra, 'A1:B3')];
  stopAfterDelete(api, 2);
  assert.throws(() => ctx.Migrate.unwrapTables_(), /interrompida/);
  assert.equal(state(dados, 'A1:E4'), before[0], 'the first table was converted and checked');
  freshExecution(ctx);
  assert.deepEqual(plain(ctx.Migrate.unwrapTables_()), ['Outra (Tabela2)']);
  assert.deepEqual([state(dados, 'A1:E4'), state(outra, 'A1:B3')], before);
  assert.equal(tablesLeft(ss), 0);
});

test('a lost answer: converting again finds nothing and changes nothing', () => {
  const ctx = boot();
  const { ss, dados } = setup(ctx);
  sheetsApi(ctx);
  ctx.Migrate.unwrapTables_();
  const after = state(dados, 'A1:E4');
  freshExecution(ctx);
  assert.deepEqual(plain(ctx.Migrate.unwrapTables_()), []);
  assert.equal(state(dados, 'A1:E4'), after);
  assert.equal(backupOf(ctx), null);
});

test('someone typed in the emptied range after an interruption: nothing is overwritten', () => {
  const ctx = boot();
  const { dados } = setup(ctx);
  stopAfterDelete(sheetsApi(ctx));
  assert.throws(() => ctx.Migrate.unwrapTables_(), /interrompida/);
  dados.getRange('B4').setValue('novo');
  freshExecution(ctx);
  assert.throws(() => ctx.Migrate.unwrapTables_(), /B4 mudaram/);
  assert.equal(dados.getRange('B4').getValue(), 'novo');
  assert.equal(dados.getRange('A1').getValue(), '', 'nothing written over the person');
});

test('a damaged copy of a removed table stops with an explicit error', () => {
  const ctx = boot();
  const { ss } = setup(ctx);
  ctx.Migrate.BACKUP_CHUNK = 50; // the copy spans several cells
  stopAfterDelete(sheetsApi(ctx));
  assert.throws(() => ctx.Migrate.unwrapTables_(), /interrompida/);
  const backup = backupOf(ctx);
  assert.ok(backup.getLastRow() > 3);
  backup.deleteRow(3);
  freshExecution(ctx);
  assert.throws(() => ctx.Migrate.unwrapTables_(), /incompleta \(parte 2 de \d+ ausente\)/);
  assert.ok(backupOf(ctx), 'the copy is kept');
});

test('a copy whose table was never removed is replaced by a fresh one', () => {
  const ctx = boot();
  const { ss, dados } = setup(ctx);
  const api = sheetsApi(ctx);
  // Stopped after the copy was saved, before the removal.
  const remove = api.Spreadsheets.batchUpdate;
  api.Spreadsheets.batchUpdate = () => { api.Spreadsheets.batchUpdate = remove; throw new Error('execução interrompida'); };
  assert.throws(() => ctx.Migrate.unwrapTables_(), /interrompida/);
  dados.getRange('B4').setValue(99); // edited afterwards: the new copy must hold 99
  const before = state(dados, 'A1:E4');
  freshExecution(ctx);
  assert.deepEqual(plain(ctx.Migrate.unwrapTables_()), ['Dados (Tabela1)']);
  assert.equal(state(dados, 'A1:E4'), before);
  assert.equal(backupOf(ctx), null);
});

/* R1: a sheet with the copy's name that the migration did not create ------------------------- */

[false, true].forEach((hidden) => {
  test(`a ${hidden ? 'hidden' : 'visible'} sheet of the person with the copy's name is never touched`, () => {
    const ctx = boot();
    const ss = ctx.SpreadsheetApp.getActive();
    const theirs = ss.insertSheet(ctx.Migrate.BACKUP_SHEET);
    theirs.getRange('A1:C1').setValues([['Relatório particular', 'NÃO APAGAR', 123]]);
    if (hidden) theirs.hideSheet();
    const api = sheetsApi(ctx);
    const content = () => JSON.stringify(plain(theirs.getRange('A1:J5').getValues()));
    const before = content();
    assert.deepEqual(plain(ctx.Migrate.unwrapTables_()), [], 'no tables: nothing to do');
    assert.ok(ss.getSheetByName(ctx.Migrate.BACKUP_SHEET), 'their sheet is still there');
    assert.equal(content(), before);
    // With a table to convert, the migration's copy has a name of its own (with its token).
    const { dados } = setup(ctx);
    const table = state(dados, 'A1:E4');
    assert.deepEqual(plain(ctx.Migrate.unwrapTables_()), ['Dados (Tabela1)']);
    assert.deepEqual(api.deleted, ['Tabela1']);
    assert.equal(state(dados, 'A1:E4'), table);
    assert.equal(content(), before, 'their sheet untouched');
    assert.equal(theirs.isSheetHidden(), hidden);
    assert.equal(backupOf(ctx), null, 'the migration’s own copy is gone');
  });
});

test('a sheet with the copy headers but without the migration token is not the copy', () => {
  const ctx = boot();
  const ss = ctx.SpreadsheetApp.getActive();
  const look = ss.insertSheet(ctx.Migrate.BACKUP_SHEET);
  look.getRange(1, 1, 1, ctx.Migrate.BACKUP_HEADERS.length).setValues([plain(ctx.Migrate.BACKUP_HEADERS)]);
  look.getRange('A2:I2').setValues([['Tabela1', 'Dados (Tabela1)', 'Dados', 'A1:B2', 'restaurada', 1, 1, 2, '{}']]);
  sheetsApi(ctx);
  ctx.Migrate.unwrapTables_();
  assert.ok(ss.getSheetByName(ctx.Migrate.BACKUP_SHEET), 'kept: same headers prove nothing');
});

/* F3: a token saved before the copy sheet exists proves no sheet --------------------------- */

test('killed after the token was saved, before insertSheet: an empty sheet made by someone else is not adopted', () => {
  const ctx = boot();
  const ss = ctx.SpreadsheetApp.getActive();
  const { dados } = setup(ctx);
  sheetsApi(ctx);
  const before = state(dados, 'A1:E4');
  // The run dies right after saving the token (no sheet yet).
  const insert = ss.insertSheet;
  ss.insertSheet = function () { ss.insertSheet = insert; throw new Error('execução interrompida'); };
  assert.throws(() => ctx.Migrate.unwrapTables_(), /interrompida/);
  const rec = JSON.parse(ctx.PropertiesService.getDocumentProperties().getProperty(ctx.Migrate.BACKUP_KEY));
  assert.equal(rec.sheetId, null);
  // Another flow makes empty sheets with the bare name, visible and hidden, with a note.
  const other = ss.insertSheet(ctx.Migrate.BACKUP_SHEET);
  other.getRange('A1').setNote('nota de outra pessoa');
  other.hideSheet();
  freshExecution(ctx);
  assert.deepEqual(plain(ctx.Migrate.unwrapTables_()), ['Dados (Tabela1)']);
  assert.equal(state(dados, 'A1:E4'), before);
  assert.ok(ss.getSheetByName(ctx.Migrate.BACKUP_SHEET), 'the other sheet is still there');
  assert.equal(other.getRange('A1').getNote(), 'nota de outra pessoa');
  assert.equal(other.getLastRow(), 0, 'nothing written into it');
  assert.equal(backupOf(ctx), null);
});

test('killed after insertSheet, before the header: the empty sheet with the token name is completed', () => {
  const ctx = boot();
  const { dados } = setup(ctx);
  sheetsApi(ctx);
  const before = state(dados, 'A1:E4');
  const ss = ctx.SpreadsheetApp.getActive();
  const proto = Object.getPrototypeOf(dados.getRange('A1'));
  const setValues = proto.setValues;
  let armed = true;
  proto.setValues = function (values) {
    if (armed && this.getSheet().getName().indexOf(`${ctx.Migrate.BACKUP_SHEET} `) === 0) { armed = false; proto.setValues = setValues; throw new Error('execução interrompida'); }
    return setValues.call(this, values);
  };
  assert.throws(() => ctx.Migrate.unwrapTables_(), /interrompida/);
  proto.setValues = setValues;
  assert.ok(backupOf(ctx), 'an empty sheet with the token name was left');
  assert.equal(backupOf(ctx).getLastRow(), 0);
  freshExecution(ctx);
  assert.deepEqual(plain(ctx.Migrate.unwrapTables_()), ['Dados (Tabela1)']);
  assert.equal(state(dados, 'A1:E4'), before);
  assert.equal(backupOf(ctx), null);
  void ss;
});

test('a sheet with the token name that holds something else is refused, not overwritten', () => {
  const ctx = boot();
  setup(ctx);
  const api = sheetsApi(ctx);
  const ss = ctx.SpreadsheetApp.getActive();
  const insert = ss.insertSheet;
  ss.insertSheet = function () { ss.insertSheet = insert; throw new Error('execução interrompida'); };
  assert.throws(() => ctx.Migrate.unwrapTables_(), /interrompida/);
  const rec = JSON.parse(ctx.PropertiesService.getDocumentProperties().getProperty(ctx.Migrate.BACKUP_KEY));
  const odd = ss.insertSheet(rec.name);
  odd.getRange('A1').setValue('não é da migração');
  freshExecution(ctx);
  assert.throws(() => ctx.Migrate.unwrapTables_(), /conteúdo sem a marca da migração/);
  assert.deepEqual(api.deleted, []);
  assert.equal(odd.getRange('A1').getValue(), 'não é da migração');
});

test('the copy is the migration’s by token and id; a failed delete is repeated safely', () => {
  const ctx = boot();
  const ss = ctx.SpreadsheetApp.getActive();
  setup(ctx);
  const api = sheetsApi(ctx);
  stopAfterDelete(api);
  assert.throws(() => ctx.Migrate.unwrapTables_(), /interrompida/);
  const rec = JSON.parse(ctx.PropertiesService.getDocumentProperties().getProperty(ctx.Migrate.BACKUP_KEY));
  const copy = backupOf(ctx);
  assert.equal(rec.sheetId, copy.getSheetId());
  assert.equal(copy.getRange(1, ctx.Migrate.BACKUP_HEADERS.length + 1).getValue(), `migration-backup:${rec.token}`);
  // Deleting the restored copy fails once: the next run deletes it.
  freshExecution(ctx);
  const del = ss.deleteSheet;
  ss.deleteSheet = function () { ss.deleteSheet = del; throw new Error('falha ao apagar'); };
  assert.throws(() => ctx.Migrate.unwrapTables_(), /falha ao apagar/);
  assert.ok(backupOf(ctx));
  freshExecution(ctx);
  ctx.Migrate.unwrapTables_();
  assert.equal(backupOf(ctx), null);
  assert.equal(ctx.PropertiesService.getDocumentProperties().getProperty(ctx.Migrate.BACKUP_KEY), null);
});

test('an unreadable entry in the migration’s own copy keeps the copy', () => {
  const ctx = boot();
  const ss = ctx.SpreadsheetApp.getActive();
  setup(ctx);
  stopAfterDelete(sheetsApi(ctx));
  assert.throws(() => ctx.Migrate.unwrapTables_(), /interrompida/);
  const copy = backupOf(ctx);
  copy.getRange(2, 9).setValue('{quebrado');
  freshExecution(ctx);
  assert.throws(() => ctx.Migrate.unwrapTables_(), /incompleta/);
  assert.ok(backupOf(ctx));
});

/* R5: references to a table in the syntax Sheets accepts ------------------------------------- */

test('every way a formula can use a table is found before anything is removed', () => {
  const uses = [
    '=ARRAYFORMULA(Tabela1)',
    '=SUM(Tabela1)',
    '=SUM(tabela1[Valor])',
    '=SUM(Tabela_de_dados[Valor])',
    '=COUNT(Tabela_de_dados)',
  ];
  uses.forEach((f) => {
    const ctx = boot();
    const { ss, resumo } = setup(ctx);
    const outra = ss.insertSheet('Outra');
    outra.getRange('A1:B2').setValues([['Valor', 'x'], [1, 2]]);
    outra.tables_ = [{ name: 'Tabela de dados', range: 'A1:B2' }];
    const api = sheetsApi(ctx);
    resumo.getRange('B1').setFormula(f);
    assert.throws(() => ctx.Migrate.unwrapTables_(), /usam uma tabela pelo nome \(Resumo!B1\)/, f);
    assert.deepEqual(api.deleted, [], f);
  });
});

test('ordinary formulas, similar names, quoted text and sheet references are not table uses', () => {
  const fine = [
    '=SUM(A1:B2)',
    "='Dados'!B3*2",
    '=SUM(Tabela10)',
    '=SUM(MinhaTabela1)',
    '="Tabela1 total: "&A1',
    "='Tabela1'!A1",
    '=Tabela1!A1',
    '=INDIRECT("A1")',
  ];
  const ctx = boot();
  const { ss, resumo } = setup(ctx);
  ss.insertSheet('Tabela1');
  fine.forEach((f, i) => resumo.getRange(i + 2, 2).setFormula(f));
  sheetsApi(ctx);
  assert.deepEqual(plain(ctx.Migrate.unwrapTables_()), ['Dados (Tabela1)']);
});

test('INDIRECT with a table name in its text cannot be analysed: refused before anything is removed', () => {
  const ctx = boot();
  const { resumo } = setup(ctx);
  const api = sheetsApi(ctx);
  resumo.getRange('B1').setFormula('=SUM(INDIRECT("Tabela1[Valor]"))');
  assert.throws(() => ctx.Migrate.unwrapTables_(), /Não foi possível conferir se Resumo!B1 usa uma tabela/);
  assert.deepEqual(api.deleted, []);
});

/* R6: number formats are part of what is restored and checked -------------------------------- */

/** "Formatos" with percent, currency, decimal and date formats. */
function formatted(ctx) {
  const ss = ctx.SpreadsheetApp.getActive();
  const s = ss.insertSheet('Formatos');
  s.getRange('A1:D2').setValues([['Taxa', 'Preço', 'Peso', 'Data'], [0.125, 19.9, 70.25, DATE]]);
  s.getRange('A2').setNumberFormat('0.00%');
  s.getRange('B2').setNumberFormat('"R$" 0.00');
  s.getRange('C2').setNumberFormat('0.00');
  s.getRange('D2').setNumberFormat('dd/mm/yyyy');
  s.tables_ = [{ name: 'Fmt', range: 'A1:D2' }];
  return s;
}

[
  ['before the formats are written', 'setNumberFormats'],
  ['after the formats, before the copy is marked restored', 'markBackup_'],
].forEach(([when, where]) => {
  test(`stopped ${when}: the next run restores the formats and only then drops the copy`, () => {
    const ctx = boot();
    const s = formatted(ctx);
    const ss = ctx.SpreadsheetApp.getActive();
    const api = sheetsApi(ctx);
    const before = state(s, 'A1:D2');
    if (where === 'setNumberFormats') {
      const proto = Object.getPrototypeOf(s.getRange('A1'));
      const original = proto.setNumberFormats;
      api.hooks.afterDelete = () => {
        api.hooks.afterDelete = null;
        proto.setNumberFormats = function () { proto.setNumberFormats = original; throw new Error('execução interrompida'); };
      };
    } else {
      const mark = ctx.Migrate.markBackup_;
      ctx.Migrate.markBackup_ = function () { ctx.Migrate.markBackup_ = mark; throw new Error('execução interrompida'); };
    }
    assert.throws(() => ctx.Migrate.unwrapTables_(), /interrompida/);
    if (where === 'setNumberFormats') {
      assert.equal(s.getRange('A2').getNumberFormat(), 'General', 'values back, formats not yet');
      assert.equal(s.getRange('A2').getValue(), 0.125);
    }
    assert.ok(backupOf(ctx), 'the copy is kept');
    freshExecution(ctx);
    assert.deepEqual(plain(ctx.Migrate.unwrapTables_()), ['Formatos (Fmt)']);
    assert.equal(state(s, 'A1:D2'), before, 'values, formats (%, R$, decimals, date) as before');
    assert.equal(backupOf(ctx), null);
  });
});
