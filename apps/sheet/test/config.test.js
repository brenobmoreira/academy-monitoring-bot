'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');

test('required properties throw when missing', () => {
  const ctx = load({ properties: {} });
  assert.throws(() => ctx.Config.telegramBotToken(), /Missing Script Property: TELEGRAM_BOT_TOKEN/);
});

test('defaults apply and allowed chat ids are split', () => {
  const ctx = load({ properties: { ALLOWED_CHAT_IDS: ' 1, 22 ,' } });
  assert.deepEqual(plain(ctx.Config.allowedChatIds()), ['1', '22']);
  assert.equal(ctx.Config.diarySheet(), 'Diário');
  assert.equal(ctx.Config.headerRow(), 5);
  assert.equal(ctx.Config.reminderHour(), 21);
});

test('llm config is null without base url and strips trailing slash', () => {
  assert.equal(load({ properties: {} }).Config.llm(), null);
  const ctx = load({ properties: { LLM_BASE_URL: 'https://x/v1/', LLM_API_KEY: 'k' } });
  assert.deepEqual(plain(ctx.Config.llm()), { baseUrl: 'https://x/v1', apiKey: 'k', model: 'gemini-2.5-flash' });
});
