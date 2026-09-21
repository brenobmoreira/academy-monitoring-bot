'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

test('setupTriggers replaces any existing reminder trigger with one at the configured hour', () => {
  const ctx = load({ properties: { REMINDER_HOUR: '20' } });
  ctx.setupTriggers();
  ctx.setupTriggers();
  assert.equal(ctx.__triggers.length, 1);
  assert.equal(ctx.__triggers[0].fn, 'sendDailyReminder');
  assert.equal(ctx.__triggers[0].atHour, 20);
  assert.equal(ctx.__triggers[0].everyDays, 1);
});

test('sendDailyReminder messages every allowed chat', () => {
  const ctx = load({ properties: { TELEGRAM_BOT_TOKEN: 't', ALLOWED_CHAT_IDS: '1,2' } });
  ctx.sendDailyReminder();
  const chats = ctx.__fetchCalls.map((c) => JSON.parse(c.options.payload).chat_id);
  assert.deepEqual([...chats], ['1', '2']);
});
