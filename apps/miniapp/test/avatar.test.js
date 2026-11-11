'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/avatar.js');

test('the public API keeps the old members and adds progress', () => {
  assert.deepEqual(A.MOODS.slice(0, 4), ['idle', 'focused', 'happy', 'alert']);
  assert.ok(A.MOODS.includes('thinking'));
  for (const k of ['mount', 'setMood', 'mood', 'say', 'create', 'setProgress', 'progress', 'intro']) {
    assert.equal(typeof A[k], 'function', k);
  }
  assert.equal(A.TICKS, 12);
});

test('clampProgress keeps 0..1 and reads junk as 0', () => {
  assert.equal(A.clampProgress(0.5), 0.5);
  assert.equal(A.clampProgress(0), 0);
  assert.equal(A.clampProgress(1), 1);
  assert.equal(A.clampProgress(-0.2), 0);
  assert.equal(A.clampProgress(7), 1);
  assert.equal(A.clampProgress('0.25'), 0.25);
  for (const junk of [NaN, Infinity, -Infinity, null, undefined, '', '  ', 'abc', true, {}, []]) {
    assert.equal(A.clampProgress(junk), 0, String(junk));
  }
});

test('litTicks: none at 0, one as soon as there is progress, all only at 1', () => {
  assert.equal(A.litTicks(0), 0);
  assert.equal(A.litTicks(0.001), 1);
  assert.equal(A.litTicks(0.5), 6);
  assert.equal(A.litTicks(1 / 3), 4);
  assert.equal(A.litTicks(0.999), 11);
  assert.equal(A.litTicks(1), 12);
  assert.equal(A.litTicks(3), 12);
  assert.equal(A.litTicks(0.5, 4), 2);
  assert.equal(A.litTicks('junk'), 0);
});

test('flip maps one rect onto another, centre to centre', () => {
  const big = { left: 139, top: 300, width: 112, height: 112 };
  const slot = { left: 16, top: 20, width: 40, height: 40 };
  const m = A.flip(big, slot);
  assert.equal(m.x, 36 - 195);
  assert.equal(m.y, 40 - 356);
  assert.equal(m.s, 40 / 112);
  assert.deepEqual(A.flip(slot, slot), { x: 0, y: 0, s: 1 });
  assert.equal(A.flip({ left: 0, top: 0, width: 0, height: 0 }, slot).s, 1);
});

test('intro does nothing before mount (and outside a browser)', () => {
  assert.equal(A.intro('x'), false);
});

test('pulse does nothing before mount and for unknown kinds', () => {
  assert.equal(typeof A.pulse, 'function');
  assert.equal(A.pulse('tick'), false);
  assert.equal(A.pulse('nope'), false);
});

test('setProgress without a mounted host still clamps and remembers the value', () => {
  assert.equal(A.setProgress(2), 1);
  assert.equal(A.progress(), 1);
  assert.equal(A.setProgress(-1), 0);
  assert.equal(A.progress(), 0);
});
