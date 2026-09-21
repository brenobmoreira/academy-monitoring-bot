'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');
const { sheets, DIARY_HEADERS } = require('./fixtures');

const col = (h) => DIARY_HEADERS.indexOf(h) + 1;
const day = (s) => new Date(`${s}T00:00:00`);

test('upsert creates the day row on the first empty date below the header', () => {
  const ctx = load({ sheets: sheets({ diaryRows: [[day('2026-09-20'), 82.1]] }) });
  const r = ctx.DiaryRepo.upsert(day('2026-09-21'), { weightKg: 82.4, muayThai: true });
  assert.equal(r.row, 7);
  assert.deepEqual(plain(r.written), ['weightKg', 'muayThai']);
  const sheet = ctx.__spreadsheet.getSheetByName('Diário');
  assert.equal(sheet.getRange(7, col('Peso kg')).getValue(), 82.4);
  assert.equal(sheet.getRange(7, col('Muay Thai')).getValue(), 'Sim');
});

test('upsert on an existing day overwrites given fields and preserves the rest', () => {
  const ctx = load({ sheets: sheets({ diaryRows: [[day('2026-09-21'), 82.1, 7, '', '', '', '', '', '', '', 'old note', 'v3']] }) });
  const r = ctx.DiaryRepo.upsert(day('2026-09-21'), { sleepH: 7.5 });
  assert.equal(r.row, 6);
  const sheet = ctx.__spreadsheet.getSheetByName('Diário');
  assert.equal(sheet.getRange(6, col('Peso kg')).getValue(), 82.1);
  assert.equal(sheet.getRange(6, col('Sono h')).getValue(), 7.5);
  assert.equal(sheet.getRange(6, col('Observações')).getValue(), 'old note');
  assert.equal(sheet.getRange(6, col('Meta versão')).getValue(), 'v3');
});

test('upsert skips fields whose column is absent and fills gaps left by formula columns', () => {
  const rows = [[day('2026-09-20'), 82], [], ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'formula']];
  const ctx = load({ sheets: sheets({ diaryRows: rows }) });
  const sheet = ctx.__spreadsheet.getSheetByName('Diário');
  sheet.setCell_(5, col('Cintura cm'), 'Renamed');
  const r = ctx.DiaryRepo.upsert(day('2026-09-21'), { waistCm: 90, steps: 8000 });
  assert.equal(r.row, 7);
  assert.deepEqual(plain(r.written), ['steps']);
});

test('upsert fails loudly when the diary tab or date header is missing', () => {
  assert.throws(() => load({ sheets: [] }).DiaryRepo.upsert(day('2026-09-21'), {}), /Sheet "Diário" not found/);
  const ctx = load({ sheets: sheets(), properties: { HEADER_ROW: '2' } });
  assert.throws(() => ctx.DiaryRepo.upsert(day('2026-09-21'), {}), /Header "Data" not found on row 2/);
});
