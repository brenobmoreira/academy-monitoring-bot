'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const B = require('../src/body.js');

const keys = ['peito', 'costas', 'ombros', 'biceps', 'triceps', 'antebracos', 'abdomen', 'trapezio', 'lombar', 'quadriceps', 'posteriores', 'gluteos', 'adutores', 'panturrilhas'];
const labels = ['Peito', 'Costas', 'Ombros', 'Bíceps', 'Tríceps', 'Antebraços', 'Abdômen', 'Trapézio', 'Lombar', 'Quadríceps', 'Posteriores', 'Glúteos', 'Adutores', 'Panturrilhas'];

test('module loads without touching a DOM and exposes the fixed API', () => {
  const sandbox = { module: { exports: {} } };
  Object.defineProperty(sandbox, 'document', { get() { throw Error('DOM touched'); } });
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/body.js'), 'utf8'), sandbox);
  assert.equal(sandbox.ShapeBody, sandbox.module.exports);
  assert.deepEqual(B.MUSCLES, keys);
  assert.deepEqual(keys.map(k => B.LABELS[k]), labels);
  ['keysOf', 'levels', 'create', 'update', 'describe'].forEach(k => assert.equal(typeof B[k], 'function'));
});

test('every canonical label, key, case and accent variant maps', () => {
  keys.forEach((k, i) => {
    [k, labels[i], '  ' + labels[i].toUpperCase() + '  ', labels[i].normalize('NFD')].forEach(s => {
      assert.deepEqual(B.keysOf(s), [k], s);
    });
  });
});

test('spreadsheet synonyms, singular/plural forms and combined groups', () => {
  const aliases = {
    'Posterior de coxa': ['posteriores'], 'Posteriores de coxas': ['posteriores'],
    'Isquiotibiais': ['posteriores'], 'Isquiotibial': ['posteriores'], 'Posterior': ['posteriores'],
    'Glúteo': ['gluteos'], 'Panturrilha': ['panturrilhas'], 'Gêmeos': ['panturrilhas'], 'Gêmeo': ['panturrilhas'],
    'Dorsal': ['costas'], 'Dorsais': ['costas'], 'Peitoral': ['peito'], 'Peitorais': ['peito'],
    'Deltoides': ['ombros'], 'Deltoide': ['ombros'], 'Ombro': ['ombros'],
    'Abdominais': ['abdomen'], 'Abdominal': ['abdomen'], 'Core': ['abdomen'], 'Antebraço': ['antebracos'],
    'Pernas': ['quadriceps', 'posteriores', 'gluteos'], 'Perna': ['quadriceps', 'posteriores', 'gluteos'],
    'Braços': ['biceps', 'triceps'], 'Braço': ['biceps', 'triceps'],
    'Coxas': ['quadriceps', 'posteriores'], 'Coxa': ['quadriceps', 'posteriores'],
    'Adutor': ['adutores'], 'Trapézios': ['trapezio'], 'Lombares': ['lombar'], 'Costa': ['costas']
  };
  Object.entries(aliases).forEach(([label, expected]) => assert.deepEqual(B.keysOf(label), expected, label));
  const a = B.keysOf('Pernas'); a.pop();
  assert.deepEqual(B.keysOf('Pernas'), ['quadriceps', 'posteriores', 'gluteos']);
});

test('keysOf ignores unknown labels and non-strings', () => {
  [null, undefined, 1, true, {}, [], NaN, '', '  ', 'Cardio', '__proto__', 'constructor', 'Peitoral desconhecido'].forEach(v => {
    assert.deepEqual(B.keysOf(v), []);
  });
});

test('levels uses strict one-third and two-thirds thresholds', () => {
  assert.deepEqual(B.levels([
    { group: 'Peito', sets: 9 }, { group: 'Costas', sets: 6 }, { group: 'Ombros', sets: 3 },
    { group: 'Bíceps', sets: 3.01 }, { group: 'Tríceps', sets: 6.01 }, { group: 'Core', sets: 0.01 }
  ]), { peito: 3, costas: 2, ombros: 1, biceps: 2, triceps: 3, abdomen: 1 });
  assert.deepEqual(B.levels([{ group: 'Peitoral', sets: 1 }]), { peito: 3 });
});

test('levels aggregates synonyms and credits every key in combined groups', () => {
  const entries = [{ group: 'Braços', sets: 2 }, { group: 'Bíceps', sets: 4 }, { group: 'Pernas', sets: 3 }, { group: 'Coxas', sets: 1 }];
  const before = JSON.stringify(entries);
  assert.deepEqual(B.levels(entries), { biceps: 3, triceps: 1, quadriceps: 2, posteriores: 2, gluteos: 2 });
  assert.equal(JSON.stringify(entries), before);
});

test('levels ignores junk inputs, groups and non-positive/non-finite/non-number sets', () => {
  [undefined, null, {}, 'Peito', 4].forEach(v => assert.deepEqual(B.levels(v), {}));
  const junk = [null, undefined, true, 1, [], {}, { group: null, sets: 5 }, { group: 'unknown', sets: 100 }];
  [NaN, Infinity, -Infinity, 0, -2, '3', true, null, undefined, {}].forEach(sets => junk.push({ group: 'Peito', sets }));
  assert.deepEqual(B.levels(junk), {});
});

test('finite sets cannot overflow the relative totals', () => {
  assert.deepEqual(B.levels([
    { group: 'Peito', sets: Number.MAX_VALUE }, { group: 'Peito', sets: Number.MAX_VALUE },
    { group: 'Costas', sets: Number.MAX_VALUE }
  ]), { peito: 3, costas: 2 });
});

test('describe sorts by descending level then canonical order, with Portuguese punctuation', () => {
  assert.equal(B.describe({ triceps: 2, peito: 3, ombros: 2 }), 'Músculos trabalhados: peito, ombros e tríceps.');
  assert.equal(B.describe({ costas: 3, peito: 3 }), 'Músculos trabalhados: peito e costas.');
  assert.equal(B.describe({ abdomen: 1 }), 'Músculos trabalhados: abdômen.');
  [null, undefined, {}, [], { peito: 0, costas: 4, ombros: '3', biceps: NaN, unknown: 3 }].forEach(v => {
    assert.equal(B.describe(v), 'Nenhum músculo marcado.');
  });
  assert.equal(B.describe(Object.create({ peito: 3 })), 'Nenhum músculo marcado.');
});
