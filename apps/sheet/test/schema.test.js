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

test('fromCell reads cells back as API values and drops empty or unreadable yes/no cells', () => {
  const { Schema } = load();
  assert.equal(Schema.fromCell('muayThai', 'Sim'), true);
  assert.equal(Schema.fromCell('dietComplete', 'Não'), false);
  assert.equal(Schema.fromCell('dietComplete', true), true);
  assert.equal(Schema.fromCell('muayThai', 'talvez'), undefined);
  assert.equal(Schema.fromCell('weightKg', ''), undefined);
  assert.equal(Schema.fromCell('weightKg', 82.4), 82.4);
  assert.equal(Schema.fromCell('weightKg', '82,4 '), '82,4');
  assert.equal(Schema.fromCell('notes', '  ok '), 'ok');
  assert.equal(Schema.fromCell('notes', '   '), undefined);
});
