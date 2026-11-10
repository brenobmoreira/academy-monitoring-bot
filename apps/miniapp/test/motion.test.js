'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/motion.js');

test('outside a browser every motion is a harmless no-op', () => {
  assert.equal(M.enabled(), false);
  for (const k of ['viewIn', 'settle', 'stagger', 'enter', 'review', 'pop', 'roll', 'fill', 'shake', 'keep']) {
    assert.equal(M[k]({}, 1), undefined, k);
  }
  assert.equal(M.snapshot({}, null), null);
  assert.equal(M.leave({}, {}), null);
  assert.equal(M.handoff({}), null);
  // out() answers false so the caller hides the element itself, and never calls done
  assert.equal(M.out({}, () => assert.fail('done must not run')), false);
});

test('match: same blocks pair one to one; a changed label means it cannot tell', () => {
  assert.deepEqual(M.match(['head', 'ref', 'set|Série 1'], ['head', 'ref', 'set|Série 1']), [0, 1, 2]);
  assert.equal(M.match(['head', 'set|Série 1'], ['head', 'set|Série 2']), null);
});

test('match: new blocks are -1 and the rest keep their order', () => {
  // "+ Série 2" between the first set and the extras row
  assert.deepEqual(M.match(['head', 'set|Série 1', 'extras|'], ['head', 'set|Série 1', 'set|Série 2', 'extras|']), [0, 1, -1, 2]);
  // a collapsed card opening: everything but the head is new
  assert.deepEqual(M.match(['head'], ['head', 'ref', 'set|Série 1', 'extras|']), [0, -1, -1, -1]);
  // longer, but nothing recognisably new
  assert.equal(M.match(['a'], ['a', 'a']), null);
});

test('match: removed blocks drop out, also at the end (a card closing)', () => {
  assert.deepEqual(M.match(['head', 'ref', 'set|Série 1', 'extras|'], ['head']), [0]);
  assert.deepEqual(M.match(['head', 'set warm|Aquecimento', 'extras|'], ['head', 'extras|']), [0, 2]);
});

test('match ordered: the removed block was taken out, renumbered labels still pair in order', () => {
  // Série 1 of 3 removed: old [2, 3] become new [1, 2]
  assert.deepEqual(M.match(['head', 'set|Série 2', 'set|Série 3', 'extras|'], ['head', 'set|Série 1', 'set|Série 2', 'extras|'], true), [0, 1, 2, 3]);
});
