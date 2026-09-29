'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, plain } = require('./core_helpers');

const E = boot().Energy;

test('Mifflin-St Jeor matches the spec examples', () => {
  assert.equal(E.bmr({ sex: 'M', age: 24, heightCm: 179, weightKg: 67 }), 1673.75);
  assert.equal(E.bmr({ sex: 'M', age: 25, heightCm: 185, weightKg: 85 }), 1886.25);
  assert.equal(E.bmr({ sex: 'F', age: 24, heightCm: 179, weightKg: 67 }), 1673.75 - 166);
});

test('missing inputs give null, not a guess', () => {
  assert.equal(E.bmr({ age: 24, heightCm: 179, weightKg: 67 }), null);
  assert.equal(E.bmr({ sex: 'M', heightCm: 179, weightKg: 67 }), null);
  assert.equal(E.tdee(null, 1.55), null);
  assert.equal(E.carbs(2400, null, 65), null);
  assert.equal(E.proteinPerKg(140, 0), null);
  assert.throws(() => E.bmr({ sex: 'M', method: 'harris' }), /desconhecido/);
});

test('carbs from kcal, protein and fat', () => {
  assert.equal(E.carbs(2400, 140, 65), 313.75);
  assert.equal(E.carbs(2650, 170, 70), 335);
  assert.equal(E.kcalOf(140, 313.75, 65), 2400);
});

test('TDEE and protein per kg', () => {
  assert.equal(E.tdee(1673.75, 1.55), 2594.31);
  assert.equal(E.proteinPerKg(140, 67), 2.09);
});

test('fromConfig reads the profile and reports what is missing', () => {
  const ctx = boot({ config: { 'client.sex': 'M', 'client.age': 25, 'client.heightCm': 185, 'client.startWeightKg': 85, 'energy.activityFactor': 1.4 } });
  const e = plain(ctx.Energy.fromConfig());
  assert.equal(e.bmr, 1886.25);
  assert.equal(e.tdee, 2640.75);
  assert.equal(e.methodLabel, 'Mifflin-St Jeor');
  assert.deepEqual(e.missing, []);
  assert.equal(ctx.Energy.fromConfig({ weightKg: 80 }).bmr, 1836.25);
  const empty = plain(boot().Energy.fromConfig());
  assert.equal(empty.bmr, null);
  assert.deepEqual(empty.missing, ['Sexo (TMB)', 'Idade', 'Altura', 'Peso inicial']);
});

test('age comes from the birth date on the given day when set', () => {
  const ctx = boot({ config: { 'client.sex': 'M', 'client.birthDate': '30/09/2001', 'client.age': 99, 'client.heightCm': 179, 'client.startWeightKg': 67 } });
  assert.equal(ctx.Energy.fromConfig({ date: '2026-09-29' }).age, 24);
  assert.equal(ctx.Energy.fromConfig({ date: '2026-09-30' }).age, 25);
});

test('labelled values keep the five numbers distinct', () => {
  const rows = plain(E.labelled({ bmr: 1673.75, tdee: 2594.31, goalKcal: 2400, baseDietKcal: 2440.7 }));
  assert.deepEqual(rows.map((r) => [r.key, r.kind, r.value]), [
    ['bmr', 'estimado', 1673.75], ['tdee', 'estimado', 2594.31], ['goal', 'meta', 2400],
    ['baseDiet', 'planejado', 2440.7], ['intake', 'realizado', null],
  ]);
  assert.equal(rows[0].label, 'TMB (Mifflin-St Jeor)');
});
