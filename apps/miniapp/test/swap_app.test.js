'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { boot, storageWith, foodDraft, today, SAMPLE, C } = require('./app_harness');
const TABLE = require('../data/foods.taco.json');
const { FOODS } = require('../../sheet4/test/food_helpers');

const own = FOODS[0]; // Ovo inteiro cozido (household 'un': 50 g)
const unvaluedOwn = 'Alimento sem tabela';
const fv = [[0, 0, own.baseQty, own.kcal, own.protein, own.carbs, own.fat, 1, own.perHousehold]];
const fu = [own.baseUnit, own.householdUnit];
const fh = createHash('sha256')
  .update(
    JSON.stringify(
      TABLE.foods.map((r) => [
        r[0].normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase(),
        'g',
        100,
        ...r.slice(1, 5),
        null,
        null,
      ]),
    ),
  )
  .digest('hex');
const digest = (text) => Promise.resolve(createHash('sha256').update(text).digest('hex'));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const button = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);

const catalog = {
  ...SAMPLE,
  view: 'food',
  foods: [own.name, unvaluedOwn],
  fav: ['Café da manhã básico'],
  fv,
  fu,
  ft: 'taco4',
  fh,
  goal: { k: 2400, p: 160, c: 260, g: 70 },
  day: { k: 500, p: 40, c: 50, g: 15, w: 1 },
};

const globals = () => ({
  ShapeCore: Object.assign({}, C, {
    loadFoodTable: (cat) => C.loadFoodTable(cat, () => Promise.resolve({ ok: true, json: () => Promise.resolve(TABLE) }), digest),
  }),
});

test('swap button renders only for catalog items with nutrition', async () => {
  const items = [
    { kind: 'food', food: own.name, qty: '2', unit: 'un' },
    { kind: 'food', food: unvaluedOwn, qty: '100', unit: 'g' },
    { kind: 'favorite', favorite: 'Café da manhã básico', portions: '1' },
    { kind: 'description', description: 'pastel de feira' },
  ];
  const p = await boot({ view: 'food', catalog, storage: storageWith(foodDraft(today(), { items })), globals: globals() });
  await tick(); await tick();

  const rows = p.doc.querySelectorAll('.plate-item');
  assert.equal(rows.length, 4);
  assert.ok(rows[0].querySelector('.btn-swap'), 'valued food has swap button');
  assert.equal(rows[1].querySelector('.btn-swap'), null, 'unvalued food has no swap button');
  assert.equal(rows[2].querySelector('.btn-swap'), null, 'favorite has no swap button');
  assert.equal(rows[3].querySelector('.btn-swap'), null, 'free description has no swap button');
});

test('swap sheet picks dominant criterion, searches, recalculates live, and updates meal, balance, draft and payload', async () => {
  const items = [
    { kind: 'food', food: 'Arroz, tipo 1, cozido', qty: '150', unit: 'g', measure: 'Pesada' },
    { kind: 'food', food: own.name, qty: '2', unit: 'un' },
  ];
  const storage = storageWith(foodDraft(today(), { items }));
  const p = await boot({ view: 'food', catalog, storage, globals: globals() });
  await tick(); await tick();

  const beforeNutrition = p.doc.getElementById('meal-nutrition').textContent;
  assert.match(beforeNutrition, /^338 kcal/); // 192 (rice) + 146 (egg)
  assert.equal(p.doc.querySelector('#daily-balance .balance-kcal').textContent, '838 / 2400 kcal');

  const swapBtn = p.doc.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Trocar Arroz, tipo 1, cozido');
  assert.ok(swapBtn);
  swapBtn.click();

  const sheet = p.doc.getElementById('sheet');
  assert.equal(sheet.hidden, false);
  assert.equal(p.doc.getElementById('sheet-title').textContent, 'Trocar alimento');

  // Rice is carb-dominant -> Carbo starts selected; smart suggestions populate immediately
  const carboBtn = button(sheet, 'Carbo');
  const kcalBtn = button(sheet, 'Calorias');
  assert.equal(carboBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(kcalBtn.getAttribute('aria-pressed'), 'false');
  assert.ok(sheet.querySelectorAll('.swap-results .result').length >= 1);

  // Searching 'Frango, peito, sem pele, grelhado' under Carbo shows zero-carb refusal state
  const search = sheet.querySelectorAll('input').find((e) => e.getAttribute('aria-label') === 'Buscar substituto');
  p.focus(search);
  p.input(search, 'frango peito grelhado');
  assert.equal(p.doc.activeElement, search, 'typing preserves search input focus');
  const chickenBtn = sheet.querySelectorAll('.swap-results .result').find((b) => /Frango, peito, sem pele, grelhado/.test(b.textContent));
  assert.ok(chickenBtn);
  assert.equal(chickenBtn.getAttribute('aria-disabled'), 'true');

  // Searching 'batata' finds 'Batata, inglesa, cozida' -> 354,2 g matching 42,15 g carbs
  p.input(search, 'batata inglesa');
  assert.equal(p.doc.activeElement, search);
  const potatoBtn = sheet.querySelectorAll('.swap-results .result').find((b) => /Batata, inglesa, cozida/.test(b.textContent));
  assert.ok(potatoBtn);
  assert.match(potatoBtn.textContent, /354,2 g/);
  potatoBtn.click();

  const preview = sheet.querySelector('.swap-preview');
  assert.equal(preview.hidden, false);
  assert.match(preview.querySelector('.swap-compare').textContent, /354,2 g/);
  assert.match(preview.querySelector('.swap-diff').textContent, /-8 kcal/);

  // Switching criterion to Calorias recalculates preview live -> 369,2 g (= 192 kcal)
  kcalBtn.click();
  assert.equal(kcalBtn.getAttribute('aria-pressed'), 'true');
  assert.match(preview.querySelector('.swap-compare').textContent, /369,2 g/);
  assert.equal(preview.querySelector('.swap-diff').textContent, '= kcal');

  // Apply swap -> closes sheet, preserves measure, updates totals, balance, say(), storage & sendData
  button(sheet, 'Aplicar troca').click();
  p.timers.run(350);
  assert.equal(sheet.hidden, true);
  assert.match(p.say(), /^Troquei Arroz, tipo 1, cozido por Batata, inglesa, cozida \(369,2 g\)\./);
  assert.ok(p.doc.querySelectorAll('.plate-item')[0].textContent.includes('Batata, inglesa, cozida'));
  assert.match(p.doc.getElementById('meal-nutrition').textContent, /^338 kcal/);
  assert.equal(p.doc.querySelector('#daily-balance .balance-kcal').textContent, '838 / 2400 kcal');

  const draftKey = [...storage.map.keys()].find((k) => k.indexOf(':f:') > 0);
  const savedDraft = JSON.parse(storage.map.get(draftKey));
  assert.deepEqual(savedDraft.items[0], {
    kind: 'food',
    food: 'Batata, inglesa, cozida',
    qty: '369,2',
    unit: 'g',
    measure: 'Pesada',
  });

  // Review & send produces standard food payload
  p.press();
  p.timers.run(400);
  assert.equal(p.review.hidden, false);
  assert.doesNotMatch(p.review.textContent, /gravado|salvo/i);
  p.press();
  assert.equal(p.tg.sent.length, 1);
  const sent = JSON.parse(p.tg.sent[0]);
  assert.equal(sent.t, 'food');
  assert.deepEqual(sent.args.items[0], {
    food: 'Batata, inglesa, cozida',
    qty: 369.2,
    unit: 'g',
    measure: 'Pesada',
  });
});
