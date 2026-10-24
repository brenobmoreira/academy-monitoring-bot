'use strict';
/**
 * Validation rules read by the audit (Audit.brokenValidations_) and by undo (Undo.rejects_):
 * rules with the same help text can point at different ranges, and a date restored by undo is
 * accepted by a date range that holds it.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');

const NOW = '2026-09-29T15:00:00-03:00';
const boot = () => load({ sheets: [{ name: 'Página1', rows: [] }, { name: 'Listas', rows: [['a'], ['b'], ['c']] }], now: NOW });

/** A VALUE_IN_RANGE rule naming `ref` (a named range that may not exist), as the 3.0 exports hold. */
function rangeRule(ctx, ref, { help = 'Escolha da lista', allowInvalid = false } = {}) {
  const ss = ctx.SpreadsheetApp.getActive();
  const any = ctx.SpreadsheetApp.newDataValidation().requireValueInRange(ss.getSheetByName('Listas').getRange('A1:A3')).build();
  // Built like loadFixture builds a rule whose named range is given by name.
  return new any.constructor({ criteria: 'VALUE_IN_RANGE', values: [ref], allowInvalid, helpText: help });
}

function setRules(ctx, a1, rules) {
  const sheet = ctx.SpreadsheetApp.getActive().getSheetByName('Página1');
  rules.forEach((rule, i) => sheet.getRange(a1).offset(i, 0, 1, 1).setDataValidation(rule));
}

const reported = (ctx) => plain(ctx.Audit.brokenValidations_()).filter((b) => b.tab === 'Página1')
  .map((b) => `${b.ref}:${b.cells.map((c) => `${c.row},${c.col}`).join(' ')}`);

test('a valid rule followed by a broken one with the same help text: only the broken cells', () => {
  const ctx = boot();
  const ss = ctx.SpreadsheetApp.getActive();
  ss.setNamedRange('ListaOk', ss.getSheetByName('Listas').getRange('A1:A3'));
  setRules(ctx, 'B2', [rangeRule(ctx, 'ListaOk'), rangeRule(ctx, 'ListaOk'), rangeRule(ctx, 'Sumiu'), rangeRule(ctx, 'Sumiu')]);
  assert.deepEqual(reported(ctx), ['Sumiu:4,2 5,2']);
});

test('a broken rule followed by a valid one: the valid cells are not reported', () => {
  const ctx = boot();
  const ss = ctx.SpreadsheetApp.getActive();
  ss.setNamedRange('ListaOk', ss.getSheetByName('Listas').getRange('A1:A3'));
  setRules(ctx, 'B2', [rangeRule(ctx, 'Sumiu'), rangeRule(ctx, 'ListaOk'), rangeRule(ctx, 'ListaOk')]);
  assert.deepEqual(reported(ctx), ['Sumiu:2,2']);
});

test('two broken references with the same attributes are reported apart', () => {
  const ctx = boot();
  setRules(ctx, 'C1', [rangeRule(ctx, 'Antiga'), rangeRule(ctx, 'Antiga'), rangeRule(ctx, 'Outra')]);
  assert.deepEqual(reported(ctx), ['Antiga:1,3 2,3', 'Outra:3,3']);
});

test('a rule whose range is gone (getCriteriaValues throws) is reported as such', () => {
  const ctx = boot();
  const rule = rangeRule(ctx, 'X');
  rule.getCriteriaValues = () => { throw new Error('Intervalo não encontrado'); }; // as Apps Script does
  setRules(ctx, 'D1', [rule]);
  assert.deepEqual(reported(ctx), ['(intervalo inexistente):1,4']);
});

/* Exact audit through the Sheets API, against the cell-by-cell oracle ------------------------ */

/**
 * Sheets advanced service over the fake: spreadsheets.get with ranges ['Tab'!r1:r2] returns the
 * dataValidation of each cell as the API writes it (ONE_OF_RANGE, userEnteredValue "='Aba'!A1:A3"
 * for a range, "=Nome" for a named range). A rule whose range is gone is given as `gone`
 * (the API's text for it is not documented; '=#REF!' by default). `calls` counts requests.
 */
function validationsApi(ctx, { gone = '=#REF!', fail = null } = {}) {
  const ss = ctx.SpreadsheetApp.getActive();
  const api = {
    calls: 0,
    Spreadsheets: {
      get: (id, opts) => {
        api.calls += 1;
        if (fail) throw new Error(fail);
        const m = /^'((?:[^']|'')+)'!(\d+):(\d+)$/.exec(opts.ranges[0]);
        const sheet = ss.getSheetByName(m[1].replace(/''/g, "'"));
        const r1 = Number(m[2]);
        const r2 = Number(m[3]);
        const rules = sheet.getRange(r1, 1, r2 - r1 + 1, sheet.getMaxColumns()).getDataValidations();
        const rowData = rules.map((line) => ({
          values: line.map((rule) => {
            if (!rule || String(rule.getCriteriaType()) !== 'VALUE_IN_RANGE') return rule ? { dataValidation: { condition: { type: 'ONE_OF_LIST', values: [] } } } : {};
            let target;
            try { target = rule.getCriteriaValues()[0]; } catch (err) { target = null; }
            const text = target === null ? gone
              : typeof target === 'string' ? `=${target}`
                : `='${target.getSheet().getName()}'!${target.getA1Notation()}`;
            return { dataValidation: { condition: { type: 'ONE_OF_RANGE', values: [{ userEnteredValue: text }] }, strict: true } };
          }),
        }));
        return { sheets: [{ data: [{ startRow: r1 - 1, startColumn: 0, rowData }] }] };
      },
    },
  };
  ctx.Sheets = api;
  return api;
}

/** {tab!row,col: ref} of a scan, for exact comparison. */
const cellsOf = (groups) => {
  const out = {};
  groups.forEach((g) => g.cells.forEach((c) => { out[`${g.tab}!${c.row},${c.col}`] = g.ref; }));
  return out;
};
const scan = (ctx) => plain(ctx.Audit.validationScan_());

function withRefs(ctx) {
  const ss = ctx.SpreadsheetApp.getActive();
  ss.setNamedRange('ListaA', ss.getSheetByName('Listas').getRange('A1:A3'));
  ss.setNamedRange('ListaC', ss.getSheetByName('Listas').getRange('A1:A2'));
  return ss;
}
const goneRule = (ctx) => {
  const r = rangeRule(ctx, 'X');
  r.getCriteriaValues = () => { throw new Error('Intervalo não encontrado'); };
  return r;
};

[
  ['valid / broken / valid', (ctx) => [rangeRule(ctx, 'ListaA'), rangeRule(ctx, 'Sumiu'), rangeRule(ctx, 'ListaA')], { 'Página1!2,2': 'Sumiu' }],
  ['broken / valid / broken', (ctx) => [rangeRule(ctx, 'Sumiu'), rangeRule(ctx, 'ListaA'), rangeRule(ctx, 'Sumiu')], { 'Página1!1,2': 'Sumiu', 'Página1!3,2': 'Sumiu' }],
  ['broken A / broken B / broken A', (ctx) => [rangeRule(ctx, 'VelhaA'), rangeRule(ctx, 'VelhaB'), rangeRule(ctx, 'VelhaA')], { 'Página1!1,2': 'VelhaA', 'Página1!2,2': 'VelhaB', 'Página1!3,2': 'VelhaA' }],
  ['valid list A / broken / valid list C', (ctx) => [rangeRule(ctx, 'ListaA'), goneRule(ctx), rangeRule(ctx, 'ListaC')], { 'Página1!2,2': '(intervalo inexistente)' }],
].forEach(([name, rules, expected]) => {
  test(`exact audit, ${name} (same help text and allowInvalid): oracle and Sheets API agree`, () => {
    const ctx = boot();
    withRefs(ctx);
    setRules(ctx, 'B1', rules(ctx));
    const oracle = cellsOf(scan(ctx).broken);
    assert.deepEqual(oracle, expected, 'cell-by-cell oracle');
    validationsApi(ctx);
    const viaApi = scan(ctx);
    assert.deepEqual(cellsOf(viaApi.broken), expected, 'Sheets API');
    assert.deepEqual(viaApi.inconclusive, []);
  });
});

test('brokenValidations_ (used by the migration) is exact for the four patterns', () => {
  const patterns = [
    [(ctx) => [rangeRule(ctx, 'ListaA'), rangeRule(ctx, 'Sumiu'), rangeRule(ctx, 'ListaA')], { 'Página1!2,2': 'Sumiu' }],
    [(ctx) => [rangeRule(ctx, 'Sumiu'), rangeRule(ctx, 'ListaA'), rangeRule(ctx, 'Sumiu')], { 'Página1!1,2': 'Sumiu', 'Página1!3,2': 'Sumiu' }],
    [(ctx) => [rangeRule(ctx, 'VelhaA'), rangeRule(ctx, 'VelhaB'), rangeRule(ctx, 'VelhaA')], { 'Página1!1,2': 'VelhaA', 'Página1!2,2': 'VelhaB', 'Página1!3,2': 'VelhaA' }],
    [(ctx) => [rangeRule(ctx, 'ListaA'), goneRule(ctx), rangeRule(ctx, 'ListaC')], { 'Página1!2,2': '(intervalo inexistente)' }],
  ];
  patterns.forEach(([rules, expected], i) => {
    const ctx = boot();
    withRefs(ctx);
    setRules(ctx, 'B1', rules(ctx));
    assert.deepEqual(cellsOf(plain(ctx.Audit.brokenValidations_())), expected, `pattern ${i + 1}`);
  });
});

test('varied rule sequences over several columns and block edges: the API scan equals the oracle', () => {
  const ctx = boot();
  const ss = withRefs(ctx);
  const sheet = ss.getSheetByName('Página1');
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const kinds = [() => rangeRule(ctx, 'ListaA'), () => rangeRule(ctx, 'ListaC'), () => rangeRule(ctx, 'Sumiu'), () => rangeRule(ctx, 'Outra'), () => goneRule(ctx), () => null];
  for (let col = 1; col <= 6; col++) {
    for (let row = 1; row <= 60; row++) {
      const rule = kinds[rand(kinds.length)]();
      if (rule) sheet.getRange(row, col).setDataValidation(rule);
    }
  }
  const oracle = cellsOf(scan(ctx).broken);
  assert.ok(Object.keys(oracle).length > 50, 'a mix with many broken cells');
  ctx.Audit.VALIDATION_BLOCK_ROWS = 7; // blocks end inside runs of equal rules
  const api = validationsApi(ctx);
  const viaApi = scan(ctx);
  assert.deepEqual(cellsOf(viaApi.broken), oracle);
  const expectedCalls = ss.getSheets().reduce((n, s) => n + Math.ceil(s.getMaxRows() / 7), 0);
  assert.equal(api.calls, expectedCalls, 'one request per block of rows of each audited tab');
});

test('a rule the audit cannot classify is inconclusive, and the audit is not clean', () => {
  const ctx = boot();
  withRefs(ctx);
  setRules(ctx, 'B1', [goneRule(ctx)]);
  validationsApi(ctx, { gone: '=ALGO(ESTRANHO' });
  const s = scan(ctx);
  assert.deepEqual(s.broken, []);
  assert.deepEqual(cellsOf(s.inconclusive), { 'Página1!1,2': 'ALGO(ESTRANHO' });
  const findings = plain(ctx.Audit.findings({ otherNames: [] }));
  assert.ok(findings.some((f) => f.code === 'validation_inconclusive' && f.severity === 'Erro'));
});

test('validations that cannot be read are reported as unread, not as broken or clean', () => {
  const ctx = boot();
  withRefs(ctx);
  setRules(ctx, 'B1', [rangeRule(ctx, 'Sumiu')]);
  validationsApi(ctx, { fail: 'Service unavailable' });
  const s = scan(ctx);
  assert.deepEqual(s.broken, []);
  assert.ok(s.unread.some((u) => u.tab === 'Página1' && /Service unavailable/.test(u.message)));
  const findings = plain(ctx.Audit.findings({ otherNames: [] }));
  assert.ok(findings.some((f) => f.code === 'validation_unread' && f.severity === 'Erro'));
});

test('classifyRangeRef_: sheets, quoted sheets, named ranges, #REF! and the unknown', () => {
  const ctx = boot();
  const ss = withRefs(ctx);
  const named = (n) => !!ss.getRangeByName(n);
  const c = (t) => plain(ctx.Audit.classifyRangeRef_(ss, t, named));
  assert.equal(c('=Listas!A1:A3'), null);
  assert.equal(c("='Listas'!$A$1:$A"), null);
  assert.equal(c('=ListaA'), null);
  assert.equal(c('=A1:A9'), null);
  assert.deepEqual(c("='Aba que sumiu'!A1:A3"), { kind: 'broken', ref: "'Aba que sumiu'!A1:A3" });
  assert.deepEqual(c('=Sumiu'), { kind: 'broken', ref: 'Sumiu' });
  assert.deepEqual(c('=#REF!'), { kind: 'broken', ref: '(intervalo inexistente)' });
  assert.deepEqual(c('=FILTER(A:A, B:B)'), { kind: 'inconclusive', ref: 'FILTER(A:A, B:B)' });
  assert.deepEqual(c(null), { kind: 'inconclusive', ref: '(sem referência)' });
});

/* F5: short names are names, not A1 ------------------------------------------------------------ */

test('isA1_: cells, ranges, whole rows/columns and open ranges; nothing else', () => {
  const ctx = boot();
  ['A1', '$A$1', 'B5', 'AB12', 'A1:C9', '$A$1:$C$9', 'A:A', '$A:$C', '1:5', '$1:$5', 'A6:A', 'A:A6', 'XFD1048576'].forEach((t) => {
    assert.equal(ctx.Audit.isA1_(t), true, t);
  });
  ['TMP', 'Foo', 'A0', 'A$', 'A1:', ':A1', 'A', '1', 'ABCD1', 'A1:B2:C3', 'A-1', '$', ''].forEach((t) => {
    assert.equal(ctx.Audit.isA1_(t), false, t);
  });
});

test('=TMP and =Foo are looked up as names: missing → broken, existing → fine (the lookup happens)', () => {
  const ctx = boot();
  const ss = withRefs(ctx);
  let lookups = [];
  const original = ss.getRangeByName;
  ss.getRangeByName = function (n) { lookups.push(n); return original.call(this, n); };
  const named = (n) => !!ss.getRangeByName(n);
  const c = (t) => plain(ctx.Audit.classifyRangeRef_(ss, t, named));
  assert.deepEqual(c('=TMP'), { kind: 'broken', ref: 'TMP' });
  assert.deepEqual(c('=Foo'), { kind: 'broken', ref: 'Foo' });
  assert.deepEqual(c('=A0'), { kind: 'broken', ref: 'A0' }, 'A0 is not a cell');
  assert.deepEqual(plain(lookups), ['TMP', 'Foo', 'A0']);
  ss.setNamedRange('TMP', ss.getSheetByName('Listas').getRange('A1:A3'));
  ss.setNamedRange('Foo', ss.getSheetByName('Listas').getRange('A1:A2'));
  assert.equal(c('=TMP'), null);
  assert.equal(c('=Foo'), null);
  assert.deepEqual(c('=A$'), { kind: 'inconclusive', ref: 'A$' });
  assert.deepEqual(c('=A1:'), { kind: 'inconclusive', ref: 'A1:' });
  assert.deepEqual(c("='It''s'!A1"), { kind: 'broken', ref: "'It''s'!A1" });
  ss.insertSheet("It's");
  assert.equal(c("='It''s'!A1"), null, 'escaped quote in the sheet name');
  assert.equal(c("='It''s'!A6:A"), null);
  assert.deepEqual(c("='It''s'!TMP"), { kind: 'inconclusive', ref: "'It''s'!TMP" });
});

test('a short missing name as list source is reported through the Sheets API path and the scan', () => {
  const ctx = boot();
  withRefs(ctx);
  setRules(ctx, 'B1', [rangeRule(ctx, 'TMP'), rangeRule(ctx, 'ListaA')]);
  validationsApi(ctx);
  assert.deepEqual(cellsOf(scan(ctx).broken), { 'Página1!1,2': 'TMP' });
});

/* F6: names that exist on Object.prototype are looked up like any other ------------------------ */

['constructor', 'toString', '__proto__'].forEach((name) => {
  test(`=${name}: missing → broken, existing → fine, through the API and the cell-by-cell paths`, () => {
    const ctx = boot();
    const ss = withRefs(ctx);
    setRules(ctx, 'B1', [rangeRule(ctx, name), rangeRule(ctx, name)]);
    let lookups = 0;
    const original = ss.getRangeByName;
    ss.getRangeByName = function (n) { if (n === name) lookups += 1; return original.call(this, n); };
    const broken = { 'Página1!1,2': name, 'Página1!2,2': name };
    assert.deepEqual(cellsOf(scan(ctx).broken), broken, 'cell-by-cell');
    assert.equal(lookups, 1, 'looked up once, then cached');
    validationsApi(ctx);
    assert.deepEqual(cellsOf(scan(ctx).broken), broken, 'Sheets API');
    ss.setNamedRange(name, ss.getSheetByName('Listas').getRange('A1:A3'));
    ctx.Sheets = undefined;
    assert.deepEqual(scan(ctx).broken, [], 'existing name: fine (cell-by-cell)');
    validationsApi(ctx);
    assert.deepEqual(scan(ctx).broken, [], 'existing name: fine (API)');
  });
});

/* Undo.rejects_ ------------------------------------------------------------------------------- */

const D1 = new Date('2026-09-14T00:00:00-03:00');
const D2 = new Date('2026-09-21T00:00:00-03:00');

function rule(ctx, build) {
  return build(ctx.SpreadsheetApp.newDataValidation()).setAllowInvalid(false).build();
}

test('Undo.rejects_: the same date held by the range is accepted, another date is not', () => {
  const ctx = boot();
  const listas = ctx.SpreadsheetApp.getActive().getSheetByName('Listas');
  listas.getRange('B1:B2').setValues([[D1], [D2]]);
  const r = rule(ctx, (b) => b.requireValueInRange(listas.getRange('B1:B2')));
  assert.equal(ctx.Undo.rejects_(r, new Date(D1.getTime())), false);
  assert.equal(ctx.Undo.rejects_(r, new Date('2026-09-15T00:00:00-03:00')), true);
});

test('Undo.rejects_: lists with text, numbers, zero and false', () => {
  const ctx = boot();
  const r = rule(ctx, (b) => b.requireValueInList(['abc', '0', '2.5', 'FALSE']));
  assert.equal(ctx.Undo.rejects_(r, 'abc'), false);
  assert.equal(ctx.Undo.rejects_(r, 0), false);
  assert.equal(ctx.Undo.rejects_(r, 2.5), false);
  assert.equal(ctx.Undo.rejects_(r, false), false);
  assert.equal(ctx.Undo.rejects_(r, 'abd'), true);
  assert.equal(ctx.Undo.rejects_(r, true), true);
});

test('Undo.rejects_: permissive rules, empty values, missing ranges and other criteria never clear', () => {
  const ctx = boot();
  const listas = ctx.SpreadsheetApp.getActive().getSheetByName('Listas');
  const permissive = ctx.SpreadsheetApp.newDataValidation().requireValueInList(['a']).setAllowInvalid(true).build();
  assert.equal(ctx.Undo.rejects_(permissive, 'z'), false);
  assert.equal(ctx.Undo.rejects_(rule(ctx, (b) => b.requireValueInList(['a'])), ''), false);
  const gone = rule(ctx, (b) => b.requireValueInRange(listas.getRange('A1:A3')));
  gone.getCriteriaValues = () => { throw new Error('Intervalo não encontrado'); };
  assert.equal(ctx.Undo.rejects_(gone, 'z'), false);
  assert.equal(ctx.Undo.rejects_(rule(ctx, (b) => b.requireNumberBetween(1, 5)), 9), false);
});

test('undo restores a date into a cell whose date range validation holds it, keeping the rule', () => {
  const ctx = boot();
  const ss = ctx.SpreadsheetApp.getActive();
  const listas = ss.getSheetByName('Listas');
  listas.getRange('B1:B2').setValues([[D1], [D2]]);
  const sheet = ss.getSheetByName('Página1');
  const cell = sheet.getRange('G1');
  cell.setValue(D1);
  cell.setDataValidation(rule(ctx, (b) => b.requireValueInRange(listas.getRange('B1:B2'))));
  ctx.ChangeLog.run('Trocar data', () => {
    ctx.ChangeLog.track({ kind: 'cells', tab: 'Página1', row: null, before: { G1: D1 }, after: { G1: D2 } });
    cell.setValue(D2);
  });
  ctx.Undo.last();
  assert.equal(cell.getValue().getTime(), D1.getTime());
  assert.ok(cell.getDataValidation(), 'the validation is kept');
});
