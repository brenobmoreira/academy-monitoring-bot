'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, storageWith, foodDraft, today, SAMPLE, C } = require('./app_harness');
const { FOODS } = require('../../sheet4/test/food_helpers');

const own = FOODS[0]; // Ovo inteiro cozido (household 'un': 50 g)
const button = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);
const input = (root, label) => root.querySelectorAll('input').find((e) => e.getAttribute('aria-label') === label);

const catalog = (extra) => ({
  ...SAMPLE,
  view: 'food',
  today: today(),
  foods: [own.name],
  fv: [[0, 0, own.baseQty, own.kcal, own.protein, own.carbs, own.fat, 1, own.perHousehold]],
  fu: [own.baseUnit, own.householdUnit],
  goal: { k: 2400, p: 160, c: 260, g: 70 },
  day: { k: 200, w: 1.5 },
  ...extra,
});

function assertNoQuickWater(p) {
  const box = p.doc.getElementById('daily-balance');
  assert.equal(button(box, '+250 ml'), undefined);
  assert.equal(button(box, '+500 ml'), undefined);
  assert.equal(box.querySelector('#water-send'), null);
  assert.match(box.querySelector('.water-note').textContent, /Água rápida indisponível/);
}

test('quick water is off on "Ontem": adding to an unknown total would overwrite it', async () => {
  const p = await boot({ view: 'food', catalog: catalog() });
  button(p.doc.getElementById('daily-balance'), '+500 ml').click();
  p.doc.getElementById('dates').children[1].click();
  assertNoQuickWater(p);
  assert.equal(p.tg.MainButton.params.text, 'Revisar refeição', 'the pending water does not follow the date');

  p.doc.getElementById('dates').children[0].click();
  assert.ok(button(p.doc.getElementById('daily-balance'), '+500 ml'), 'back today the chips return');
});

test('quick water is off when the day baseline did not come in the link (trimmed or stale)', async () => {
  for (const extra of [{ day: undefined }, { day: { k: 200 } }, { today: '2020-01-01' }]) {
    const p = await boot({ view: 'food', catalog: catalog(extra) });
    assertNoQuickWater(p);
    p.press();
    p.timers.run(400);
    p.press();
    assert.equal(p.tg.sent.filter((s) => JSON.parse(s).t === 'water').length, 0);
  }
  const zero = await boot({ view: 'food', catalog: catalog({ day: { w: 0 } }) });
  assert.ok(button(zero.doc.getElementById('daily-balance'), '+250 ml'), 'a known zero is a baseline');
});

function sendWater(p) {
  button(p.doc.getElementById('daily-balance'), '+500 ml').click();
  p.doc.getElementById('daily-balance').querySelector('#water-send').click();
  p.timers.run(400);
  p.press();
  return JSON.parse(p.tg.sent[0]);
}

function restore(p, label) {
  button(p.doc.getElementById('view'), 'Restaurar último envio').click();
  p.doc.getElementById('sheet').querySelectorAll('.result').find((b) => label.test(b.textContent)).click();
}

test('"Restaurar último envio" on Refeição brings a water send back under the same id', async () => {
  const storage = storageWith();
  const first = await boot({ view: 'food', catalog: catalog(), storage });
  const sent = sendWater(first);

  // A meal on the plate is not "busy" for water; water already being added is.
  const p = await boot({ view: 'food', catalog: catalog(), storage });
  const asked = [];
  p.tg.showConfirm = (text, cb) => { asked.push(text); cb(true); };
  restore(p, /^Água 2 L/);
  assert.equal(asked.length, 0);
  assert.equal(p.tg.MainButton.params.text, 'Revisar água (+500 ml)');
  restore(p, /^Água 2 L/);
  assert.equal(asked.length, 1);
  p.press();
  p.timers.run(400);
  p.press();
  assert.deepEqual(JSON.parse(p.tg.sent[0]), sent);
});

test('a water send is not restored where the day total is unknown', async () => {
  const storage = storageWith();
  sendWater(await boot({ view: 'food', catalog: catalog(), storage }));
  const p = await boot({ view: 'food', catalog: catalog({ day: undefined }), storage });
  restore(p, /^Água/);
  assert.match(p.say(), /^Não dá para restaurar essa água/);
  assert.equal(p.tg.MainButton.params.text, 'Revisar refeição');
});

test('the chat draft id becomes the submission id, and foods take the catalog spelling', async () => {
  const id = '0123456789abcdef0123456789abcdef';
  const df = { id, d: today(), m: 'Almoço', i: [{ f: `  ${own.name.toUpperCase()}  `, q: 2, u: 'un' }] };
  const p = await boot({ view: 'food', catalog: catalog({ df }) });
  assert.equal(p.doc.querySelector('.plate-name').textContent, own.name);
  p.press();
  p.timers.run(400);
  p.press();
  const sent = JSON.parse(p.tg.sent[0]);
  assert.equal(sent.id, id);
  assert.equal(sent.args.items[0].food, own.name);
});

test('quantity is edited on the plate, keeping focus while macros and the payload follow', async () => {
  const items = [{ kind: 'food', food: own.name, qty: '2', unit: 'un' }];
  const p = await boot({ view: 'food', catalog: catalog(), storage: storageWith(foodDraft(today(), { items })) });
  const qty = input(p.doc.getElementById('view'), `Quantidade de ${own.name}`);
  assert.equal(qty.value, '2');
  const before = p.doc.getElementById('meal-nutrition').textContent;

  p.focus(qty);
  p.input(qty, '4');
  assert.equal(p.doc.activeElement, qty);
  assert.equal(input(p.doc.getElementById('view'), `Quantidade de ${own.name}`), qty, 'the row is not rebuilt');
  assert.notEqual(p.doc.getElementById('meal-nutrition').textContent, before);
  const kcal = Math.round(C.foodNutrition({ ...items[0], qty: '4' }, C.normalizeCatalog(catalog())).kcal);
  assert.match(p.doc.querySelector('.plate-meta').textContent, new RegExp(`${kcal} kcal`));

  p.press();
  p.timers.run(400);
  p.press();
  assert.equal(JSON.parse(p.tg.sent[0]).args.items[0].qty, 4);
});

test('core: canonical names, draft id, sent types and swap refusal reasons', () => {
  const cat = C.normalizeCatalog(catalog());
  assert.equal(C.canonicalFood(`  ${own.name.toLowerCase()} `, cat), own.name);
  assert.equal(C.canonicalFood('Outro', cat), 'Outro');
  assert.deepEqual(C.buildFoodItem({ kind: 'food', food: own.name.toUpperCase(), qty: '1' }, cat).value, { food: own.name, qty: 1 });

  const df = { m: 'Almoço', i: [{ ds: 'x' }] };
  assert.equal(C.parsePrefillFood({ ...df, id: 'a'.repeat(32) }).id, 'a'.repeat(32));
  assert.equal(C.parsePrefillFood({ ...df, id: 'nope' }).id, undefined);

  const store = C.draftStore(storageWith(), 'x');
  ['food', 'water', 'workout'].forEach((t) => store.recordSent({ t }, 1));
  assert.deepEqual(store.sent(['food', 'water']).map((e) => e.t), ['water', 'food']);
  assert.deepEqual(store.sent('workout').map((e) => e.t), ['workout']);

  const row = (protein) => ({ baseUnit: 'g', baseQty: 100, kcal: 100, protein, carbs: 0, fat: 0, householdUnit: '', perHousehold: null });
  const swap = { nutrition: { rico: row(100), ralo: row(0.01), nada: row(0) }, foods: ['rico', 'ralo', 'nada'] };
  const item = { kind: 'food', food: 'rico', qty: '1000', unit: 'g' };
  assert.equal(C.computeSwap(item, 'ralo', 'protein', swap).reason, 'out_of_range');
  assert.equal(C.computeSwap(item, 'nada', 'protein', swap).reason, 'no_target_value');
});

test('swap results say "fora do limite" apart from "sem <critério>"', async () => {
  const nutri = (protein) => [0, 100, 100, protein, 1, 1, null, null];
  const cat = catalog({ foods: ['Rico', 'Ralo', 'Nada'], fu: ['g'], fv: [[0, ...nutri(100)], [1, ...nutri(0.01)], [2, ...nutri(0)]] });
  const items = [{ kind: 'food', food: 'Rico', qty: '1000', unit: 'g' }];
  const p = await boot({ view: 'food', catalog: cat, storage: storageWith(foodDraft(today(), { items })) });
  p.doc.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Trocar Rico').click();
  const sheet = p.doc.getElementById('sheet');
  button(sheet, 'Proteína').click();
  const search = input(sheet, 'Buscar substituto');
  const tagFor = (name) => {
    p.input(search, name);
    return sheet.querySelector('.swap-results .result .tag').textContent;
  };
  assert.equal(tagFor('Ralo'), 'fora do limite');
  assert.equal(tagFor('Nada'), 'sem proteína');
});
