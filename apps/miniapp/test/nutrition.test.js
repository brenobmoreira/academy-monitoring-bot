'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const C = require('../src/core');
const TABLE = require('../data/foods.taco.json');
const { FOODS } = require('../../sheet4/test/food_helpers');
const { load, plain } = require('../../sheet4/test/harness');

const digest = (text) => Promise.resolve(createHash('sha256').update(text).digest('hex'));
const canonical = TABLE.foods.map((r) => ['g', 100, ...r.slice(1, 5), null, null]);
const fh = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
const OWN = { v: 1, foods: FOODS.slice(0, -1).map((f) => f.name), fv: FOODS.slice(0, -1).map((f, i) =>
  [i, f.baseUnit, f.baseQty, f.kcal, f.protein, f.carbs, f.fat, f.householdUnit || null, f.perHousehold || null]) };
const item = (food, qty, unit) => ({ kind: 'food', food, qty, unit });
const response = () => Promise.resolve({ ok: true, json: () => Promise.resolve(TABLE) });

test('page arithmetic matches real sheet conversion and per-item rounding for all unit aliases', () => {
  const ctx = load(), catalog = C.normalizeCatalog(OWN);
  const units = [...ctx.Units.LIST, ...Object.keys(ctx.Units.ALIASES), '', 'x', '__proto__', 'constructor'];
  let checked = 0;
  for (const f of FOODS.slice(0, -1)) for (const unit of units) for (const qty of ['0,001', '1', '1,23456', '150', '100000']) {
    // The sheet currently uses `in` for family membership. Prototype property names are not
    // real units and the page conservatively refuses them rather than reproducing NaN.
    let expected = null;
    try {
      const value = plain(ctx.Foods.portion(f, qty, unit).macros);
      if (Object.values(value).every(Number.isFinite)) {
        delete value.fiber;
        expected = value;
      }
    } catch (_) { /* impossible units must stay out of the page total */ }
    assert.deepEqual(C.foodNutrition(item(f.name, qty, unit), catalog), expected, `${f.name}: ${qty} ${unit}`);
    checked++;
  }
  assert.ok(checked > 1000);
});

test('food identity keeps accents, valid zero nutrients count, unknowns are excluded without zero guesses', () => {
  const catalog = C.normalizeCatalog(OWN);
  const food = FOODS[0];
  const value = C.foodNutrition(item('  OVO  INTEIRO COZIDO ', '2', 'unidades'), catalog);
  assert.equal(value.kcal, food.kcal);
  assert.equal(C.foodNutrition(item('Pao integral', '100', 'g'), catalog), null);
  assert.equal(C.foodNutrition(item(food.name, '', 'g'), catalog), null);
  assert.equal(C.foodNutrition(item(food.name, '8 0', 'g'), catalog), null);
  assert.equal(C.foodNutrition(item(food.name, '100001', 'g'), catalog), null);
  const total = C.mealNutrition([item(food.name, '2', 'un'), item(food.name, '2', 'ml'),
    { kind: 'description', description: 'sem cálculo' }, { kind: 'favorite', favorite: 'Favorita' }], catalog);
  assert.equal(total.included, 1);
  assert.equal(total.excluded, 3);
  assert.equal(total.kcal, food.kcal);
  assert.equal(C.nutritionText(total), '146 kcal · P 13,3 g · C 0,6 g · G 9,5 g · 3 itens fora da soma');
  assert.equal(C.nutritionText(C.mealNutrition([{ kind: 'description' }], catalog)), 'Sem itens com valores disponíveis · 1 item fora da soma');
});

test('trimmed, malformed and duplicate own values cannot produce a number', () => {
  for (const fv of [undefined, [[999, ...OWN.fv[0].slice(1)]], [[0, ...OWN.fv[0].slice(1), null]],
    [OWN.fv[0], OWN.fv[0]], [[0, ...OWN.fv[0].slice(1, 7), 'ml', 50]]]) {
    const cat = C.normalizeCatalog({ ...OWN, fv });
    assert.equal(C.foodNutrition(item(FOODS[0].name, 100, 'g'), cat), null);
  }
});

test('unit dictionary decodes numeric indices; bad indices never produce a sum', () => {
  const raw = { v: 1, foods: [FOODS[0].name], fu: ['g', 'un'],
    fv: [[0, 0, ...OWN.fv[0].slice(2, 7), 1, FOODS[0].perHousehold]] };
  assert.equal(C.foodNutrition(item(FOODS[0].name, 2, 'un'), C.normalizeCatalog(raw)).kcal, FOODS[0].kcal);
  raw.fv[0][1] = 999;
  assert.equal(C.foodNutrition(item(FOODS[0].name, 2, 'un'), C.normalizeCatalog(raw)), null);
});

test('shared loader verifies values, merges 575 + own names, and finds name parts in any order', async () => {
  const cat = await C.loadFoodTable(C.normalizeCatalog({ ...OWN, ft: 'taco4', fh }), (url) => {
    assert.equal(url, 'data/foods.taco.json'); return response();
  }, digest);
  assert.equal(cat.tableStatus, 'ready');
  assert.equal(cat.foods.length, 575 + OWN.foods.length);
  assert.ok(C.search('FRANGO peito', cat.foods, 7).includes('Frango, peito, sem pele, grelhado'));
  assert.ok(C.search('grelhado peito frango', cat.foods, 7).includes('Frango, peito, sem pele, grelhado'));
  assert.ok(C.search('ACUCAR cristal', cat.foods, 7).includes('Açúcar, cristal'));
  const f = TABLE.foods[0];
  assert.equal(C.foodNutrition(item(f[0], 100, 'g'), cat).kcal, f[1]);
  assert.equal(C.foodNutrition(item(f[0], 1, 'ml'), cat), null);
  assert.equal(C.foodNutrition(item(f[0], 1, 'un'), cat), null);
});

test('HTTP, network or bad table failure keeps own food names and totals usable', async () => {
  for (const fetcher of [() => Promise.reject(new Error('offline')), () => Promise.resolve({ ok: false }),
    () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })]) {
    const cat = await C.loadFoodTable(C.normalizeCatalog({ ...OWN, ft: 'taco4', fh }), fetcher, digest);
    assert.equal(cat.tableStatus, 'unavailable');
    assert.deepEqual(cat.foods, OWN.foods);
    assert.equal(C.foodNutrition(item(FOODS[0].name, 100, 'g'), cat).kcal, FOODS[0].kcal);
  }
});

test('missing/mismatched digest or unavailable WebCrypto keeps shared names but no shared values', async () => {
  for (const hash of ['', '0'.repeat(64), fh]) {
    const cat = await C.loadFoodTable(C.normalizeCatalog({ ...OWN, ft: 'taco4', fh: hash }), response,
      hash === fh ? () => Promise.reject(new Error('no crypto')) : digest);
    assert.equal(cat.tableStatus, 'values_unavailable');
    assert.ok(cat.foods.includes(TABLE.foods[0][0]));
    assert.equal(C.foodNutrition(item(TABLE.foods[0][0], 100, 'g'), cat), null);
    assert.equal(C.foodNutrition(item(FOODS[0].name, 100, 'g'), cat).kcal, FOODS[0].kcal);
  }
});

test('unknown table and old bot links never fetch; dropped own names retain manual food entry', async () => {
  const cat = C.normalizeCatalog({ v: 1, ft: 'future' });
  assert.equal(await C.loadFoodTable(cat, () => assert.fail('unexpected fetch')), cat);
  const loaded = await C.loadFoodTable(C.normalizeCatalog({ v: 1, ft: 'taco4', fh }), response, digest);
  assert.equal(loaded.freeFoods, true);
  assert.equal(C.buildFoodItem(item('Nome da planilha', '10', 'g'), loaded).errors.length, 0);
});

module.exports = { TABLE, OWN, fh, response, digest };
