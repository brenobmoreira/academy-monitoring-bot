'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

test('the API key is required', () => {
  const ctx = load({ properties: {} });
  assert.throws(() => ctx.Config.sheetApiKey(), /Missing Script Property: SHEET_API_KEY/);
  assert.equal(load({ properties: { SHEET_API_KEY: 'k' } }).Config.sheetApiKey(), 'k');
});

test('diary tab and header row have defaults', () => {
  const ctx = load({ properties: {} });
  assert.equal(ctx.Config.diarySheet(), 'Diário');
  assert.equal(ctx.Config.headerRow(), 5);
});
