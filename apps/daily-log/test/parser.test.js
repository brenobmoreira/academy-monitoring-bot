'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');
const { sheets } = require('./fixtures');

const today = new Date('2026-09-21T00:00:00');
const llmProps = { LLM_BASE_URL: 'https://llm.example/v1', LLM_API_KEY: 'key' };
const ok = (obj) => ({ code: 200, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }] }) });

test('regex fallback extracts diary keywords in Portuguese', () => {
  const { Parser } = load({ sheets: sheets() });
  const e = Parser.parse('peso 82,4 sono 7h30 passos 8k cardio 20 muay sim dieta não cintura 91 fome 3 cansaço 2 obs: dor no ombro', { today });
  assert.equal(e.source, 'regex');
  assert.deepEqual(plain(e.diary), {
    weightKg: 82.4, sleepH: 7.5, steps: 8000, cardioMin: 20, muayThai: true, dietComplete: false,
    waistCm: 91, hunger: 3, fatigue: 2, notes: 'dor no ombro',
  });
  assert.equal(e.date.getTime(), today.getTime());
});

test('regex fallback returns no diary when nothing matches', () => {
  const { Parser } = load({ sheets: sheets() });
  const e = Parser.parse('bom dia', { today });
  assert.equal(e.diary, undefined);
  assert.equal(e.workout, undefined);
});

test('LLM path builds a prompt with today, sessions and catalogue, and maps the reply', () => {
  const reply = {
    date: '2026-09-20',
    diary: { weightKg: 82.4, sleepH: null, steps: null, cardioMin: null, muayThai: null, dietComplete: null, waistCm: null, hunger: null, fatigue: null, notes: null },
    workout: { session: 'Upper', exercises: [
      { name: 'Supino inclinado', sets: [{ kg: 60, reps: 8 }, { kg: 62, reps: 8 }], rir: 2, pain: null, note: null },
      { name: 'Puxada aberta', sets: [], rir: null, pain: null, note: null },
    ] },
  };
  const ctx = load({ sheets: sheets(), properties: llmProps, fetchResponses: [ok(reply)] });
  const e = ctx.Parser.parse('ontem pesei 82.4, upper: supino 60x8 62x8 rir 2', { today, phase: 'Adaptação' });
  assert.equal(e.source, 'llm');
  assert.equal(e.date.getTime(), new Date('2026-09-20T00:00:00').getTime());
  assert.deepEqual(plain(e.diary), { weightKg: 82.4 });
  assert.deepEqual(plain(e.workout), { session: 'Upper', phase: 'Adaptação', exercises: [
    { name: 'Supino inclinado', sets: [{ kg: 60, reps: 8 }, { kg: 62, reps: 8 }], rir: 2 },
  ] });
  const body = JSON.parse(ctx.__fetchCalls[0].options.payload);
  assert.match(body.messages[0].content, /Today is 2026-09-21/);
  assert.match(body.messages[0].content, /Known sessions: Upper, Lower/);
  assert.match(body.messages[0].content, /Supino inclinado \(Peito\)/);
});

test('LLM failure falls back to regex and carries a warning', () => {
  const ctx = load({ sheets: sheets(), properties: llmProps, fetchResponses: [{ code: 500, body: 'boom' }] });
  const e = ctx.Parser.parse('peso 82', { today });
  assert.equal(e.source, 'regex');
  assert.deepEqual(plain(e.diary), { weightKg: 82 });
  assert.match(e.warning, /LLM unavailable/);
});
