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

test('quick water works on "Ontem" with atomic waterDeltaL without inventing a fake total, and switching dates clears pending water', async () => {
  const p = await boot({ view: 'food', catalog: catalog() });
  const yesterday = C.addDays(today(), -1);
  button(p.doc.getElementById('daily-balance'), '+500 ml').click();
  p.doc.getElementById('dates').children[1].click();
  assert.equal(p.tg.MainButton.params.text, 'Revisar refeição', 'the pending water does not follow the date');

  const yestBox = p.doc.getElementById('daily-balance');
  assert.ok(button(yestBox, '+250 ml'));
  assert.ok(button(yestBox, '+500 ml'));
  button(yestBox, '+500 ml').click();
  assert.equal(p.tg.MainButton.params.text, 'Revisar água (+500 ml)');
  p.press();
  p.timers.run(400);
  assert.match(p.review.textContent, /\+0,5 L \(será somado ao total já registrado na planilha\)/);
  assert.doesNotMatch(p.review.textContent, /total estimado|gravado|salvo/i);
  p.press();
  assert.deepEqual(JSON.parse(p.tg.sent[0]).args, { date: yesterday, waterDeltaL: 0.5 });
});

test('quick water works when day was trimmed or link is stale, showing honest review copy vs estimated total when fresh', async () => {
  for (const extra of [{ day: undefined }, { day: { k: 200 } }, { today: '2020-01-01' }]) {
    const p = await boot({ view: 'food', catalog: catalog(extra) });
    const box = p.doc.getElementById('daily-balance');
    assert.equal(box.querySelector('.water-note'), null);
    button(box, '+250 ml').click();
    p.press();
    p.timers.run(400);
    assert.match(p.review.textContent, /\+0,25 L \(será somado ao total já registrado na planilha\)/);
    assert.doesNotMatch(p.review.textContent, /total estimado|gravado|salvo/i);
    p.press();
    assert.deepEqual(JSON.parse(p.tg.sent[0]).args, { date: today(), waterDeltaL: 0.25 });
  }
  const fresh = await boot({ view: 'food', catalog: catalog({ day: { w: 2 } }) });
  button(fresh.doc.getElementById('daily-balance'), '+500 ml').click();
  fresh.press();
  fresh.timers.run(400);
  assert.match(fresh.review.textContent, /\+0,5 L \(total estimado: 2,5 L\)/);
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

test('"Restaurar último envio" on Refeição brings a waterDeltaL send back under the same id even without day snapshot', async () => {
  const storage = storageWith();
  const first = await boot({ view: 'food', catalog: catalog(), storage });
  const sent = sendWater(first);
  assert.deepEqual(sent.args, { date: today(), waterDeltaL: 0.5 });

  // A meal on the plate is not "busy" for water; water already being added is. Works even when day is trimmed.
  const p = await boot({ view: 'food', catalog: catalog({ day: undefined }), storage });
  const asked = [];
  p.tg.showConfirm = (text, cb) => { asked.push(text); cb(true); };
  restore(p, /^Água \+500 ml/);
  assert.equal(asked.length, 0);
  assert.equal(p.tg.MainButton.params.text, 'Revisar água (+500 ml)');
  restore(p, /^Água \+500 ml/);
  assert.equal(asked.length, 1);
  p.press();
  p.timers.run(400);
  p.press();
  assert.deepEqual(JSON.parse(p.tg.sent[0]), sent);
});

test('"Restaurar último envio" preserves legacy waterL history entries (including main addWaterL form) and resets addWaterL if edited', async () => {
  const storage = storageWith();
  const legacyId = 'fedcba9876543210fedcba9876543210';
  const legacyJson = JSON.stringify({ v: 1, t: 'water', id: legacyId, args: { date: today(), waterL: 2 } });
  const store = C.draftStore(storage, SAMPLE.client);
  // Exact main history format: json had args.waterL=2 while form stored addWaterL=0.5
  store.recordSent({
    t: 'water',
    label: 'Água 2 L, hoje',
    json: legacyJson,
    form: { id: legacyId, date: today(), addWaterL: 0.5 },
  });

  // Untouched resend preserves the exact legacy waterL payload and idempotency id (without showing +500 ml)
  const p = await boot({ view: 'food', catalog: catalog({ day: { w: 1.5 } }), storage });
  restore(p, /^Água 2 L/);
  assert.equal(p.doc.getElementById('daily-balance').querySelector('.water-delta'), null);
  assert.equal(button(p.doc.getElementById('daily-balance'), '−250 ml'), undefined);
  assert.equal(p.tg.MainButton.params.text, 'Revisar água (2 L)');
  p.press();
  p.timers.run(400);
  assert.match(p.review.textContent, /Água total2 L/);
  p.press();
  assert.equal(p.tg.sent[0], legacyJson);

  // Restoring legacy waterL and then tapping +250 ml starts from 0 (0.25 L, NOT 0.5 + 0.25 = 0.75 L) with a new id
  const p2 = await boot({ view: 'food', catalog: catalog(), storage });
  restore(p2, /^Água 2 L/);
  button(p2.doc.getElementById('daily-balance'), '+250 ml').click();
  assert.equal(p2.tg.MainButton.params.text, 'Revisar água (+250 ml)');
  p2.press();
  p2.timers.run(400);
  p2.press();
  const edited = JSON.parse(p2.tg.sent[0]);
  assert.notEqual(edited.id, legacyId);
  assert.deepEqual(edited.args, { date: today(), waterDeltaL: 0.25 });
});

test('"Restaurar último envio" with a date older than Ontem asks explicit confirmation and mints a new id instead of reusing the old id on Hoje', async () => {
  const storage = storageWith();
  const oldId = '11223344556677889900aabbccddeeff';
  const oldDate = C.addDays(today(), -3);
  const store = C.draftStore(storage, SAMPLE.client);
  store.recordSent({
    t: 'water',
    label: `Água +500 ml, ${C.shortDate(oldDate)}`,
    json: JSON.stringify({ v: 1, t: 'water', id: oldId, args: { date: oldDate, waterDeltaL: 0.5 } }),
    form: { id: oldId, date: oldDate, waterDeltaL: 0.5 },
  });

  // Declining confirmation leaves the form untouched
  const declined = await boot({ view: 'food', catalog: catalog(), storage });
  const prompts = [];
  declined.tg.showConfirm = (text, cb) => { prompts.push(text); cb(false); };
  restore(declined, /^Água \+500 ml/);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /saiu da lista.*novo lançamento em Hoje/i);
  assert.equal(declined.tg.MainButton.params.text, 'Revisar refeição');

  // Accepting prepares a brand-new submission on Hoje with a fresh id (never oldId + today)
  const accepted = await boot({ view: 'food', catalog: catalog(), storage });
  accepted.tg.showConfirm = (_text, cb) => cb(true);
  restore(accepted, /^Água \+500 ml/);
  assert.equal(accepted.tg.MainButton.params.text, 'Revisar água (+500 ml)');
  accepted.press();
  accepted.timers.run(400);
  accepted.press();
  const resent = JSON.parse(accepted.tg.sent[0]);
  assert.notEqual(resent.id, oldId);
  assert.deepEqual(resent.args, { date: today(), waterDeltaL: 0.5 });
});

test('"Restaurar último envio" allows idempotent resend near the 20 L cap even when day.w already reflects the saved delta', async () => {
  const storage = storageWith();
  const first = await boot({ view: 'food', catalog: catalog({ day: { w: 19.25 } }), storage });
  const sent = sendWater(first);
  assert.deepEqual(sent.args, { date: today(), waterDeltaL: 0.5 });

  // Reopened with day.w = 19.75 (the previous +0.5 L already landed in the sheet):
  // fresh +500 ml is clamped to +250 ml, whereas untouched "Restaurar último envio" is allowed to resend with the same id
  const freshNearCap = await boot({ view: 'food', catalog: catalog({ day: { w: 19.75 } }) });
  button(freshNearCap.doc.getElementById('daily-balance'), '+500 ml').click();
  assert.equal(freshNearCap.tg.MainButton.params.text, 'Revisar água (+250 ml)');

  const reopened = await boot({ view: 'food', catalog: catalog({ day: { w: 19.75 } }), storage });
  restore(reopened, /^Água \+500 ml/);
  assert.equal(reopened.tg.MainButton.params.text, 'Revisar água (+500 ml)');
  reopened.press();
  reopened.timers.run(400);
  assert.doesNotMatch(reopened.review.textContent, /20,25/);
  reopened.press();
  assert.deepEqual(JSON.parse(reopened.tg.sent[0]), sent);
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
