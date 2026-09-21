'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');
const { sheets, DIARY_HEADERS, WORKOUT_HEADERS } = require('./fixtures');

const props = { TELEGRAM_BOT_TOKEN: 'tok', WEBHOOK_SECRET: 'sec', ALLOWED_CHAT_IDS: '42' };
const post = (ctx, text, { secret = 'sec', chatId = 42 } = {}) => ctx.doPost({
  parameter: { secret },
  postData: { contents: JSON.stringify({ message: { chat: { id: chatId }, text } }) },
});
const telegramCalls = (ctx) => ctx.__fetchCalls.filter((c) => c.url.includes('api.telegram.org'));
const sent = (ctx) => telegramCalls(ctx).map((c) => JSON.parse(c.options.payload));

test('rejects wrong secret and unknown chat without side effects', () => {
  const ctx = load({ sheets: sheets(), properties: props });
  post(ctx, 'peso 82', { secret: 'nope' });
  post(ctx, 'peso 82', { chatId: 7 });
  assert.equal(ctx.__fetchCalls.length, 0);
  assert.equal(ctx.__spreadsheet.getSheetByName('Diário').getLastRow(), 5);
});

test('ignores updates without text and always answers 200 ok', () => {
  const ctx = load({ sheets: sheets(), properties: props });
  const out = ctx.doPost({ parameter: { secret: 'sec' }, postData: { contents: JSON.stringify({ message: { chat: { id: 42 } } }) } });
  assert.equal(out.text, 'ok');
  assert.equal(ctx.__fetchCalls.length, 0);
});

test('writes the diary and echoes what was written', () => {
  const ctx = load({ sheets: sheets(), properties: props, now: '2026-09-21T15:00:00-03:00' });
  post(ctx, 'peso 82,4 sono 7h30 muay sim');
  const sheet = ctx.__spreadsheet.getSheetByName('Diário');
  assert.equal(sheet.getRange(6, DIARY_HEADERS.indexOf('Peso kg') + 1).getValue(), 82.4);
  assert.equal(sheet.getRange(6, DIARY_HEADERS.indexOf('Muay Thai') + 1).getValue(), 'Sim');
  const msg = sent(ctx)[0];
  assert.equal(msg.chat_id, '42');
  assert.equal(msg.text, '21/09 · Peso kg 82,4 · Sono h 7,5 · Muay Thai Sim');
});

test('replies "nada reconhecido" and writes nothing for unparseable text', () => {
  const ctx = load({ sheets: sheets(), properties: props, now: '2026-09-21T15:00:00-03:00' });
  post(ctx, 'oi');
  assert.equal(ctx.__spreadsheet.getSheetByName('Diário').getLastRow(), 5);
  assert.equal(sent(ctx)[0].text, '21/09: nada reconhecido');
});

test('with an LLM, writes diary and workout and confirms both, using the Hoje phase', () => {
  const reply = {
    date: null,
    diary: { weightKg: 82.4, sleepH: null, steps: null, cardioMin: null, muayThai: null, dietComplete: null, waistCm: null, hunger: null, fatigue: null, notes: null },
    workout: { session: 'Upper', exercises: [
      { name: 'supino inclinado', sets: [{ kg: 60, reps: 8 }, { kg: 62.5, reps: 8 }], rir: 2, pain: null, note: null },
      { name: 'remada curvada', sets: [{ kg: 40, reps: 10 }], rir: null, pain: 3, note: null },
    ] },
  };
  const llm = { code: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }) };
  const hoje = Array.from({ length: 23 }, () => []); hoje[22] = ['Sessão', 'Upper', '', 'Fase', 'Adaptação'];
  const ctx = load({
    sheets: sheets({ hoje }), now: '2026-09-21T15:00:00-03:00',
    properties: { ...props, LLM_BASE_URL: 'https://llm.example/v1', LLM_API_KEY: 'k' },
    fetchResponses: [llm],
  });
  post(ctx, 'pesei 82.4; upper: supino 60x8 62,5x8 rir 2, remada curvada 40x10 dor 3');
  const w = ctx.__spreadsheet.getSheetByName('Registro de treino');
  assert.equal(w.getLastRow(), 7);
  assert.equal(w.getRange(6, WORKOUT_HEADERS.indexOf('Fase') + 1).getValue(), 'Adaptação');
  assert.equal(w.getRange(6, WORKOUT_HEADERS.indexOf('Séries prescritas') + 1).getValue(), 2);
  assert.equal(sent(ctx)[0].text, [
    '21/09 · Peso kg 82,4',
    '21/09 · Upper (Adaptação):',
    '• Supino inclinado 60×8 62,5×8 (RIR 2)',
    '• remada curvada 40×10 (dor 3) ⚠ não está no cadastro',
  ].join('\n'));
});

test('repo errors are reported to the chat instead of swallowed', () => {
  const ctx = load({ sheets: [], properties: props, now: '2026-09-21T15:00:00-03:00' });
  post(ctx, 'peso 82');
  assert.match(sent(ctx)[0].text, /não gravei: Sheet "Diário" not found/);
});
