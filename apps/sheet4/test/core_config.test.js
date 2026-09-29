'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');
const { boot, NOW, plain } = require('./core_helpers');

const SPEC_KEYS = ['client.name', 'client.sex', 'client.birthDate', 'client.age', 'client.heightCm', 'client.startWeightKg',
  'client.startDate', 'client.reviewer', 'routine.strengthPerWeek', 'routine.cardioPerWeek', 'routine.activities',
  'routine.activitiesPerWeek', 'routine.sessionRotation', 'routine.rotationMode', 'energy.bmrMethod', 'energy.activityFactor',
  'analysis.weightTrendDays', 'analysis.minWeighInsPerWeek', 'analysis.minCompleteFoodDays', 'analysis.kcalTolerance',
  'analysis.fatTolerance', 'analysis.waistNoiseCm', 'analysis.weightNoisePctPerWeek', 'analysis.sleepMinH',
  'analysis.fatigueHigh', 'analysis.hungerHigh', 'analysis.painHigh', 'analysis.reviewEveryDays',
  'analysis.minWeeksForPhaseReview', 'analysis.weightFastPctPerWeek', 'analysis.adherenceMin', 'analysis.phaseReviewStreak', 'system.schemaVersion', 'system.timezone'];

test('DEFAULTS covers every key of spec §3.2 with Portuguese label, unit and description', () => {
  const C = load({ now: NOW }).Config;
  assert.deepEqual(plain(C.keys()), SPEC_KEYS);
  C.keys().forEach((k) => {
    const d = C.DEFAULTS[k];
    assert.ok(d.label && d.description !== undefined && d.unit !== undefined, k);
    assert.ok(C.SECTIONS.includes(d.section), k);
  });
  assert.deepEqual(plain(C.sections().map((s) => s.section)), ['Perfil', 'Rotina', 'Energia', 'Análise', 'Sistema']);
  assert.equal(C.sections()[0].items[0].key, 'client.name');
});

test('without a Config tab every key returns its default (no client data in defaults)', () => {
  const C = load({ now: NOW }).Config;
  assert.equal(C.get('analysis.weightTrendDays'), 7);
  assert.equal(C.get('analysis.minWeighInsPerWeek'), 3);
  assert.equal(C.get('analysis.minCompleteFoodDays'), 4);
  assert.equal(C.get('analysis.kcalTolerance'), 0.05);
  assert.equal(C.get('analysis.fatTolerance'), 0.15);
  assert.equal(C.get('analysis.waistNoiseCm'), 0.5);
  assert.equal(C.get('analysis.weightNoisePctPerWeek'), 0.25);
  assert.equal(C.get('analysis.sleepMinH'), 7);
  assert.equal(C.get('analysis.fatigueHigh'), 4);
  assert.equal(C.get('analysis.hungerHigh'), 4);
  assert.equal(C.get('analysis.painHigh'), 4);
  assert.equal(C.get('analysis.reviewEveryDays'), 7);
  assert.equal(C.get('analysis.minWeeksForPhaseReview'), 8);
  assert.equal(C.get('energy.bmrMethod'), 'mifflin');
  assert.equal(C.get('routine.rotationMode'), 'continuous');
  assert.deepEqual(plain(C.get('routine.sessionRotation')), []);
  ['client.name', 'client.sex', 'client.age', 'client.heightCm', 'client.startWeightKg', 'client.reviewer',
    'routine.strengthPerWeek', 'system.schemaVersion'].forEach((k) => assert.equal(C.get(k), null, k));
  assert.equal(C.timezone(), 'America/Sao_Paulo');
  assert.throws(() => C.get('nope'), /Unknown config key/);
});

test('typed values from the sheet: numbers with comma or %, lists, enums, dates', () => {
  const ctx = boot({
    config: {
      'client.name': 'Cliente', 'client.heightCm': '179,5', 'analysis.kcalTolerance': '5%', 'client.age': 24,
      'routine.sessionRotation': 'Upper, Lower , Full Body', 'client.sex': 'm', 'client.startDate': '28/09/2026',
      'routine.rotationMode': 'Weekly', 'analysis.sleepMinH': '',
    },
  });
  const C = ctx.Config;
  assert.equal(C.get('client.name'), 'Cliente');
  assert.equal(C.get('client.heightCm'), 179.5);
  assert.equal(C.get('analysis.kcalTolerance'), 0.05);
  assert.deepEqual(plain(C.getList('routine.sessionRotation')), ['Upper', 'Lower', 'Full Body']);
  assert.equal(C.get('client.sex'), 'M');
  assert.equal(C.get('routine.rotationMode'), 'weekly');
  assert.equal(ctx.Dates.key(C.get('client.startDate')), '2026-09-28');
  assert.equal(C.get('analysis.sleepMinH'), 7, 'empty cell → default');
  assert.equal(C.has('analysis.sleepMinH'), false);
  assert.equal(C.has('client.name'), true);
  assert.equal(C.ageOn('2026-09-29'), 24);
});

test('invalid values throw a message naming the parameter', () => {
  const C = boot({ config: { 'client.age': 'vinte', 'client.sex': 'X', 'analysis.painHigh': 4.5, 'client.birthDate': '01/01/1900' } }).Config;
  assert.throws(() => C.get('client.age'), /Config: valor inválido para "Idade" \(client.age\)/);
  assert.throws(() => C.get('client.sex'), /Sexo/);
  assert.equal(C.get('analysis.painHigh'), 4.5, 'number type accepts decimals');
  assert.throws(() => C.get('client.birthDate'), /Data de nascimento/, 'technical date is not a valid birth date');
});

test('set updates the key row or appends it with label, unit and description', () => {
  const ctx = boot({ config: { 'client.name': 'A' } });
  const C = ctx.Config;
  C.set('client.name', 'B');
  C.set('routine.sessionRotation', ['Push', 'Pull', 'Legs']);
  C.set('client.startDate', '2026-09-28');
  assert.equal(C.get('client.name'), 'B');
  assert.deepEqual(plain(C.get('routine.sessionRotation')), ['Push', 'Pull', 'Legs']);
  const row = ctx.Tabs.findBy('config', 'key', 'routine.sessionRotation');
  assert.equal(row.value, 'Push, Pull, Legs');
  assert.equal(row.label, 'Rotação de sessões');
  assert.equal(row.unit, 'lista');
  assert.equal(ctx.Tabs.read('config').length, 3);
  assert.throws(() => C.set('client.sex', 'X'), /valor inválido/);
});

test('section title rows (no Chave) are ignored', () => {
  const ctx = boot({ tabs: { config: [{ label: 'Perfil' }, { key: 'client.name', value: 'Z' }, { label: 'Rotina' }] } });
  assert.equal(ctx.Config.get('client.name'), 'Z');
});

test('secrets come from Script Properties', () => {
  const C = load({ now: NOW, properties: { SHEET_API_KEY: 'k' } }).Config;
  assert.equal(C.sheetApiKey(), 'k');
  assert.equal(C.secret('OTHER', 'fb'), 'fb');
  assert.throws(() => C.secret('OTHER'), /Script Property ausente: OTHER/);
  C.setSecret('OTHER', 'v');
  assert.equal(C.secret('OTHER'), 'v');
});
