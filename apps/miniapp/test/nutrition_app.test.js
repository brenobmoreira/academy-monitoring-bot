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
const fh = createHash('sha256').update(JSON.stringify(TABLE.foods.map((r) => [r[0].normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase(), 'g', 100, ...r.slice(1, 5), null, null]))).digest('hex');
const digest = (text) => Promise.resolve(createHash('sha256').update(text).digest('hex'));
const catalog = { ...SAMPLE, view: 'food', foods: [own.name], fv, fu, ft: 'taco4', fh };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const items = [{ kind: 'food', food: own.name, qty: '2', unit: 'un' }, { kind: 'description', description: 'pastel' }];
const storage = () => storageWith(foodDraft(today(), { items }));
const button = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);
const globals = (fetcher) => ({ ShapeCore: Object.assign({}, C, { loadFoodTable: (cat) => C.loadFoodTable(cat, fetcher, digest) }) });

test('view-scoped catalog hides and guards the switch; old catalog still switches', async () => {
  const p = await boot({ catalog: { ...catalog, ft: undefined }, storage: storage() });
  assert.equal(p.doc.querySelector('.tabs').hidden, true);
  assert.ok(p.doc.getElementById('meal-nutrition'));
  p.tab('workout');
  assert.ok(p.doc.getElementById('meal-nutrition'));
  p.press(); p.timers.run(400);
  p.tg.BackButton.handler();
  assert.equal(p.doc.querySelector('.tabs').hidden, true);
  const old = await boot({ catalog: SAMPLE });
  assert.equal(old.doc.querySelector('.tabs').hidden, false);
  old.tab('food');
  assert.ok(old.doc.getElementById('meal-nutrition'));
});

test('loading and failed shared file leave own picker, per-item kcal and sum usable', async () => {
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const p = await boot({ catalog, storage: storage(), globals: globals(() => pending) });
  assert.equal(p.doc.getElementById('food-table-status').textContent, 'Lista completa indisponível enquanto carrega.');
  assert.match(p.doc.getElementById('meal-nutrition').textContent, /^146 kcal · P 13,3 g.*1 item fora da soma$/);
  assert.match(p.doc.querySelector('.plate-meta').textContent, /146 kcal/);
  const search = p.doc.querySelectorAll('input').find((e) => e.getAttribute('aria-label') === 'Buscar alimento');
  p.input(search, 'ovo');
  assert.ok(button(p.doc, own.name));
  reject(new Error('offline'));
  await tick(); await tick();
  assert.equal(p.doc.getElementById('food-table-status').textContent, 'Lista completa indisponível.');
  assert.match(p.doc.getElementById('meal-nutrition').textContent, /^146 kcal/);
  const remove = p.doc.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Tirar ' + own.name + ' do prato');
  remove.click();
  assert.equal(p.doc.getElementById('meal-nutrition').textContent, 'Sem itens com valores disponíveis · 1 item fora da soma');
});

test('successful shared load refreshes the picker and adds a TACO item to the live sum', async () => {
  const p = await boot({ view: 'food', catalog, storage: storage(), globals: globals(() => Promise.resolve({ ok: true, json: () => Promise.resolve(TABLE) })) });
  await tick(); await tick();
  assert.equal(p.doc.getElementById('food-table-status').hidden, true);
  const search = p.doc.querySelectorAll('input').find((e) => e.getAttribute('aria-label') === 'Buscar alimento');
  p.input(search, 'grelhado peito frango');
  const name = 'Frango, peito, sem pele, grelhado';
  button(p.doc, name).click();
  const qty = p.doc.querySelectorAll('input').find((e) => e.getAttribute('aria-label') === 'Quantidade');
  p.input(qty, '100');
  button(p.doc, 'Pôr no prato').click();
  const kcal = own.kcal + TABLE.foods.find((r) => r[0] === name)[1];
  assert.match(p.doc.getElementById('meal-nutrition').textContent, new RegExp('^' + kcal + ' kcal'));
  assert.match(p.doc.getElementById('meal-nutrition').textContent, /1 item fora da soma$/);
  assert.ok(p.doc.querySelectorAll('.plate-meta').some((e) => /159 kcal/.test(e.textContent)));
});

test('stalled table request times out; late arrival cannot replace an edited form', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const p = await boot({ view: 'food', catalog, globals: globals(() => pending) });
  assert.equal(button(p.doc, 'Digitar nome da planilha'), undefined);
  p.timers.run(8000); await tick();
  assert.equal(p.doc.getElementById('food-table-status').textContent, 'Lista completa indisponível.');
  // the 575 shared names did not arrive: typing a sheet name must be possible, and it is kept
  button(p.doc, 'Digitar nome da planilha').click();
  const typed = p.doc.querySelectorAll('input').find((e) => e.value === '' && e.getAttribute('aria-label') !== 'Quantidade' && e.type !== 'date');
  p.input(typed, 'Arroz, integral, cozido');
  resolve({ ok: true, json: () => Promise.resolve(TABLE) });
  await tick(); await tick();
  assert.equal(p.doc.getElementById('food-table-status').textContent, 'Lista completa indisponível.');
});

test('table completion preserves a description being typed and its keyboard focus', async () => {
  let reject;
  const pending = new Promise((_, fail) => { reject = fail; });
  const p = await boot({ view: 'food', catalog, globals: globals(() => pending) });
  button(p.doc, 'Sem cálculo').click();
  const field = p.doc.querySelector('textarea');
  p.input(field, 'pastel de feira');
  p.focus(field);
  reject(new Error('offline')); await tick(); await tick();
  assert.equal(p.doc.querySelector('textarea').value, 'pastel de feira');
  assert.equal(p.doc.activeElement, p.doc.querySelector('textarea'));
});
