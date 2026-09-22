'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

test('toCell renders booleans with the sheet vocabulary', () => {
  const { Schema } = load();
  assert.equal(Schema.toCell('muayThai', true), 'Sim');
  assert.equal(Schema.toCell('muayThai', false), 'Não');
  assert.equal(Schema.toCell('weightKg', 82.4), 82.4);
});
