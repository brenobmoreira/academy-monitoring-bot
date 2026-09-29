'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');
const { day, NOW } = require('./core_helpers');

const ctx = load({ now: NOW });
const D = ctx.Dates;

test('key/fromKey round-trip local midnight', () => {
  const d = D.fromKey('2026-09-28');
  assert.equal(d.getHours(), 0);
  assert.equal(D.key(d), '2026-09-28');
  assert.equal(D.key(new Date('2026-09-28T23:30:00')), '2026-09-28');
});

test('parse accepts Date, yyyy-MM-dd and dd/mm/yyyy text; rejects garbage and impossible dates', () => {
  assert.equal(D.key(D.parse('28/09/2026')), '2026-09-28');
  assert.equal(D.key(D.parse('1/2/2027')), '2027-02-01');
  assert.equal(D.key(D.parse(' 2026-09-28 ')), '2026-09-28');
  assert.equal(D.key(D.parse(new Date('2026-09-15T12:00:00'))), '2026-09-15');
  assert.equal(D.parse(new Date('2026-09-15T12:00:00')).getHours(), 0);
  assert.equal(D.parse('31/02/2026'), null);
  assert.equal(D.parse('amanhã'), null);
  assert.equal(D.parse(''), null);
  assert.equal(D.parse(null), null);
  assert.equal(D.parse(45000), null);
  assert.equal(D.parse(new Date('invalid')), null);
});

test('technical dates (< 2000-01-01) are treated as missing', () => {
  const tech = new Date('1900-01-01T00:00:00');
  assert.equal(D.isTechnical(tech), true);
  assert.equal(D.isTechnical(day('1999-12-31')), true);
  assert.equal(D.isTechnical(day('2000-01-01')), false);
  assert.equal(D.isTechnical('01/01/1900'), false, 'only Date objects are "technical"; text parses to null anyway');
  assert.equal(D.parse(tech), null);
  assert.equal(D.parse('01/01/1900'), null);
  assert.equal(D.key(tech), '');
  assert.equal(D.format(tech), '');
  assert.throws(() => D.require(tech, 'Início'), /Início inválida ou ausente/);
});

test('today follows the (faked) clock in the script time zone', () => {
  assert.equal(D.todayKey(), '2026-09-29');
  assert.equal(D.key(D.today()), '2026-09-29');
});

test('addDays and diffDays cross month and year boundaries', () => {
  assert.equal(D.key(D.addDays('2026-09-28', -1)), '2026-09-27');
  assert.equal(D.key(D.addDays('2026-12-31', 1)), '2027-01-01');
  assert.equal(D.key(D.addDays('2028-02-28', 1)), '2028-02-29');
  assert.equal(D.diffDays('2026-09-28', '2026-10-05'), 7);
  assert.equal(D.diffDays('2026-10-05', '2026-09-28'), -7);
});

test('weeks start on Monday and end on Sunday', () => {
  assert.equal(D.key(D.weekStart('2026-09-28')), '2026-09-28'); // Monday
  assert.equal(D.key(D.weekStart('2026-10-04')), '2026-09-28'); // Sunday
  assert.equal(D.key(D.weekStart('2026-09-27')), '2026-09-21'); // Sunday before
  assert.equal(D.key(D.weekEnd('2026-09-30')), '2026-10-04');
});

test('format, compare, sameDay, within and age', () => {
  assert.equal(D.format('2026-09-28'), '28/09/2026');
  assert.equal(D.compare('2026-09-28', day('2026-09-29')), -1);
  assert.equal(D.compare(null, '2026-09-28'), -1);
  assert.equal(D.compare('28/09/2026', '2026-09-28'), 0);
  assert.equal(D.sameDay(null, null), false);
  assert.equal(D.within('2026-09-28', '2026-09-28', null), true);
  assert.equal(D.within('2026-09-27', '2026-09-28', null), false);
  assert.equal(D.within('2026-10-04', '2026-09-28', '2026-10-04'), true);
  assert.equal(D.within('2026-10-05', '2026-09-28', '2026-10-04'), false);
  assert.equal(D.age('2002-09-30', '2026-09-29'), 23);
  assert.equal(D.age('2002-09-29', '2026-09-29'), 24);
});
