'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { boot, storageWith, foodDraft, today, SAMPLE, C } = require('./app_harness');
const TABLE = require('../data/foods.taco.json');
const { FOODS } = require('../../sheet4/test/food_helpers');

const own = FOODS[0];
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

const baseCatalog = {
  ...SAMPLE,
  foods: [own.name],
  fav: ['Café da manhã básico'],
  fv,
  fu,
  ft: 'taco4',
  fh,
  goal: { k: 2400, p: 160, c: 260, g: 70 },
  day: { k: 200, p: 10, c: 25, g: 5, w: 1 },
};

const globals = () => ({
  ShapeCore: Object.assign({}, C, {
    loadFoodTable: (cat) =>
      C.loadFoodTable(cat, () => Promise.resolve({ ok: true, json: () => Promise.resolve(TABLE) }), digest),
  }),
});

test('df prefill boots straight into food form, calculates TACO nutrition, and allows live edit/swap before send', async () => {
  const prefill = {
    d: today(),
    m: 'Almoço',
    i: [
      { f: 'Arroz, tipo 1, cozido', q: 150, u: 'g', ms: 'Estimada' },
      { f: own.name, q: 2, u: 'un', ms: 'Estimada' },
      { fav: 'Café da manhã básico', p: 1 },
      { ds: 'molho de tomate caseiro', q: 30, u: 'g' },
    ],
  };
  const oldDraft = foodDraft(today(), {
    meal: 'Jantar',
    items: [{ kind: 'description', description: 'lanche antigo' }],
  });
  const p = await boot({
    view: 'workout',
    catalog: { ...baseCatalog, df: prefill },
    storage: storageWith(oldDraft),
    globals: globals(),
  });
  await tick();
  await tick();

  // Switches to food tab regardless of initial view and keeps the agent prefill instead of old saved draft
  assert.match(p.say(), /^Rascunho carregado! Ajuste as gramas ou troque itens antes de enviar\./);
  assert.equal(p.doc.querySelector('h1.view-title').textContent, 'Almoço');
  const checkedMeal = p.doc
    .querySelectorAll('.chip')
    .find((c) => c.getAttribute('aria-checked') === 'true');
  assert.ok(checkedMeal && checkedMeal.textContent === 'Almoço');
  const rows = p.doc.querySelectorAll('.plate-item');
  assert.equal(rows.length, 4);
  assert.ok(rows[0].textContent.includes('Arroz, tipo 1, cozido'));
  assert.ok(rows[1].textContent.includes(own.name));
  assert.ok(rows[2].textContent.includes('Café da manhã básico'));
  assert.ok(rows[3].textContent.includes('molho de tomate caseiro'));

  // Calculates TACO + own-food nutrition immediately on load and updates daily balance
  const nutritionText = p.doc.getElementById('meal-nutrition').textContent;
  assert.match(nutritionText, /^338 kcal/);
  assert.equal(p.doc.querySelector('#daily-balance .balance-kcal').textContent, '538 / 2400 kcal');

  // Adjust favorite portions via stepper and swap rice via Swap & Adjust before submitting
  const plusHalfBtn = rows[2]
    .querySelectorAll('button')
    .find((b) => b.getAttribute('aria-label') === 'Mais meia porção');
  assert.ok(plusHalfBtn);
  plusHalfBtn.click();

  const swapBtn = p.doc
    .querySelectorAll('button')
    .find((b) => b.getAttribute('aria-label') === 'Trocar Arroz, tipo 1, cozido');
  assert.ok(swapBtn);
  swapBtn.click();
  const sheet = p.doc.getElementById('sheet');
  assert.equal(sheet.hidden, false);
  const search = sheet
    .querySelectorAll('input')
    .find((e) => e.getAttribute('aria-label') === 'Buscar substituto');
  p.input(search, 'batata inglesa');
  const potatoBtn = sheet
    .querySelectorAll('.swap-results .result')
    .find((b) => /Batata, inglesa, cozida/.test(b.textContent));
  assert.ok(potatoBtn);
  potatoBtn.click();
  button(sheet, 'Aplicar troca').click();
  p.timers.run(350);

  assert.match(p.doc.getElementById('meal-nutrition').textContent, /^330 kcal/);

  // Submit produces a normal food payload with adjusted items and preserved Estimada measure
  p.press();
  p.timers.run(400);
  assert.equal(p.review.hidden, false);
  assert.doesNotMatch(p.review.textContent, /gravado|salvo/i);
  p.press();
  assert.equal(p.tg.sent.length, 1);

  const payload = JSON.parse(p.tg.sent[0]);
  assert.equal(payload.t, 'food');
  assert.equal(payload.args.date, today());
  assert.equal(payload.args.meal, 'Almoço');
  assert.deepEqual(payload.args.items[0], {
    food: 'Batata, inglesa, cozida',
    qty: 354.2,
    unit: 'g',
    measure: 'Estimada',
  });
  assert.equal(payload.args.items[1].food, own.name);
  assert.equal(payload.args.items[1].qty, 2);
  assert.equal(payload.args.items[1].unit, 'un');
  assert.equal(payload.args.items[1].measure, 'Estimada');
  assert.deepEqual(payload.args.items[2], { favorite: 'Café da manhã básico', portions: 1.5 });
  assert.deepEqual(payload.args.items[3], { description: 'molho de tomate caseiro', qty: 30, unit: 'g' });
});

test('df prefill falls back to today when draft date is outside the selector window', async () => {
  const p = await boot({
    view: 'workout',
    catalog: {
      ...baseCatalog,
      df: {
        d: '2020-01-01',
        m: 'Jantar',
        i: [{ f: own.name, q: 2, u: 'un', ms: 'Estimada' }],
      },
    },
    globals: globals(),
  });
  await tick();
  await tick();

  p.press();
  p.timers.run(400);
  p.press();
  assert.equal(p.tg.sent.length, 1);
  const payload = JSON.parse(p.tg.sent[0]);
  assert.equal(payload.args.date, today());
  assert.equal(payload.args.meal, 'Jantar');
});
