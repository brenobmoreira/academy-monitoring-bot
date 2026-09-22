'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');

test('normalizeDiary coerces numbers with comma and yes/no words', () => {
  const { Schema } = load();
  const out = Schema.normalizeDiary({ weightKg: '82,4', sleepH: 7.5, muayThai: 'sim', dietComplete: false, notes: 'ok', unknown: 1 });
  assert.deepEqual(plain(out), { weightKg: 82.4, sleepH: 7.5, muayThai: true, dietComplete: false, notes: 'ok' });
});

test('normalizeDiary rejects scale values out of 1-5 and non-numbers', () => {
  const { Schema } = load();
  assert.throws(() => Schema.normalizeDiary({ hunger: 6 }), /hunger: must be 1-5/);
  assert.throws(() => Schema.normalizeDiary({ steps: 'many' }), /steps: not a number/);
});

test('toCell renders booleans with the sheet vocabulary', () => {
  const { Schema } = load();
  assert.equal(Schema.toCell('muayThai', true), 'Sim');
  assert.equal(Schema.toCell('muayThai', false), 'Não');
  assert.equal(Schema.toCell('weightKg', 82.4), 82.4);
});
