'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plain } = require('./core_helpers');
const { load } = require('./harness');
const { bootFood } = require('./food_helpers');

const eq = (a, b, m) => assert.deepEqual(plain(a), b, m);

test('mass and volume units convert within their family only', () => {
  const ctx = bootFood();
  const U = ctx.Units;
  const rice = ctx.Foods.get('Arroz branco cozido');
  const milk = ctx.Foods.get('Leite desnatado');
  eq([U.convert(150, 'g', rice).qty, U.convert(0.2, 'kg', rice).qty, U.convert(500, 'mg', rice).qty, U.convert('1,5', 'KG', rice).qty], [150, 200, 0.5, 1500]);
  eq([U.convert(0.25, 'l', milk).qty, U.convert(200, 'ml', milk).qty, U.convert(200, '', milk).qty], [250, 200, 200]);
  const c = U.convert(0.2, 'kg', rice);
  eq([c.unit, c.estimated, c.converted, U.describe(c)], ['g', false, true, 'Informado: 0,2 kg']);
  assert.throws(() => U.convert(200, 'ml', rice), /não converto ml \(volume\) em g \(massa\) sem densidade/);
  assert.throws(() => U.convert(200, 'g', milk), /não converto g \(massa\) em ml \(volume\)/);
});

test('household units need Medida caseira + Base por medida; 2 un is never 2 g', () => {
  const ctx = bootFood();
  const U = ctx.Units;
  const egg = ctx.Foods.get('Ovo inteiro cozido');
  const c = U.convert(2, 'un', egg);
  eq([c.qty, c.unit, c.estimated, c.household], [100, 'g', true, 'un']);
  eq(U.convert(3, 'unidades', egg).qty, 150);
  assert.equal(U.describe(c), 'Informado: 2 un (medida caseira, estimada)');
  const rice = ctx.Foods.get('Arroz branco cozido');
  assert.throws(() => U.convert(2, 'un', rice), /não tem medida caseira.*2 un nunca vira 2 g/);
  assert.throws(() => U.convert(1, 'fatia', egg), /medida caseira de "Ovo inteiro cozido" é "un" \(50 g\); "fatia" não é convertido/);
  eq(U.convert(2, 'fatia', ctx.Foods.get('Pão integral')).qty, 50);
});

test('quantities must be positive numbers', () => {
  const ctx = bootFood();
  const rice = ctx.Foods.get('Arroz branco cozido');
  assert.throws(() => ctx.Units.convert(0, 'g', rice), /maior que zero/);
  assert.throws(() => ctx.Units.convert('muito', 'g', rice), /Quantidade inválida/);
  eq(ctx.Units.parseAmount('2 un'), { qty: 2, unit: 'un' });
  eq(ctx.Units.parseAmount('1,5 Fatias'), { qty: 1.5, unit: 'fatia' });
  eq(ctx.Units.parseAmount(150), { qty: 150, unit: '' });
  assert.equal(ctx.Units.parseAmount('abc'), null);
  eq(ctx.Units.tryConvert(2, 'un', rice).ok, false);
});

test('catalogue validity: base > 0, g/ml base unit, 5 macros, complete household measure', () => {
  const ctx = bootFood();
  const F = ctx.Foods;
  assert.equal(F.validity(F.get('Arroz branco cozido')), 'OK');
  assert.equal(F.validity(F.get('Granola sem cadastro completo')), 'Rever macros (carboidrato, gordura, fibra)');
  const base = { name: 'X', baseUnit: 'g', baseQty: 100, kcal: 1, protein: 0, carbs: 0, fat: 0, fiber: 0 };
  assert.equal(F.validity(base), 'OK', 'zero macros are valid values');
  assert.equal(F.validity({ ...base, baseQty: 0 }), 'Base deve ser > 0');
  assert.equal(F.validity({ ...base, baseUnit: 'un' }), 'Unidade-base deve ser g ou ml');
  assert.equal(F.validity({ ...base, householdUnit: 'un' }), 'Medida caseira incompleta (preencha medida e base por medida)');
  assert.throws(() => F.macros(F.get('Granola sem cadastro completo'), 50), /Cadastro de "Granola sem cadastro completo" incompleto/);
  eq(F.macros(F.get('Whey (rótulo a conferir)'), 15), { kcal: 60, protein: 11.5, carbs: 2, fat: 0.65, fiber: 0 });
  assert.equal(F.get(' arroz  BRANCO cozido ').name, 'Arroz branco cozido');
  assert.throws(() => F.get('Pizza'), /não está cadastrado em Alimentos/);
});

test('Fonte mapping from 3.0 Referência / Qualidade da referência', () => {
  const ctx = bootFood();
  const src = (quality, reference, name) => ctx.Foods.source({ quality, reference, name: name || 'X' });
  eq([
    src('Referência cadastrada — não auditada nesta revisão', 'TACO 4ª ed.; pelo nome'),
    src('Estimativa — conferir rótulo', 'Estimativa genérica'),
    src(null, 'Estimativa; conferir rótulo'),
    src(null, null, 'Leite integral (estimativa)'),
    src('Rótulo confirmado em 30/09', null),
    src('Rótulo confirmado', null),
    src('TACO/fonte confiável', null),
    src('Pendente', 'TACO'),
    src(null, 'Tabela TACO Unicamp'),
    src(null, null),
    src('Referência cadastrada', null),
  ], [
    'TACO/fonte confiável', 'Estimativa', 'Estimativa', 'Estimativa', 'Rótulo confirmado', 'Rótulo confirmado',
    'TACO/fonte confiável', 'Pendente', 'TACO/fonte confiável', 'Pendente', 'Pendente',
  ]);
});

test('the real 3.0 catalogue: every row valid, fonte classified, household measures present', () => {
  for (const name of ['breno_3_0', 'zoio_3_0']) {
    const ctx = load({ fixture: name, now: '2026-09-29T15:00:00-03:00' });
    const foods = ctx.Foods.all();
    assert.equal(foods.length, 110, name);
    eq(foods.filter((f) => !ctx.Foods.isValid(f)).map((f) => f.name), [], `${name}: invalid rows`);
    const counts = {};
    foods.forEach((f) => { const s = ctx.Foods.source(f); counts[s] = (counts[s] || 0) + 1; });
    eq(counts, { 'TACO/fonte confiável': 92, Estimativa: 18 }, name);
    eq(foods.filter((f) => f.householdUnit).map((f) => `${f.name}=${f.householdUnit}/${f.perHousehold}`).sort(), [
      'Ovo inteiro cozido=un/50', 'Ovo inteiro cru=un/50', 'Pão de forma tradicional=fatia/25', 'Pão francês=un/50', 'Pão integral=fatia/25',
    ], name);
  }
});
