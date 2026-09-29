'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plain } = require('./core_helpers');
const { bootFood, act, foodRows, dayTotals } = require('./food_helpers');

const eq = (a, b, m) => assert.deepEqual(plain(a), b, m);
const ok = (r) => { assert.equal(r.ok, true, r.error); return r.result; };

/** Logs a breakfast on 28/09 (one household-measure item, one no-calc item). */
function breakfast(ctx, date = '2026-09-28') {
  ctx.ChangeLog.run('seed', () => {
    ctx.FoodLog.add({ date, meal: 'Café da manhã', food: 'Ovo inteiro cozido', qty: 2, unit: 'un' });
    ctx.FoodLog.add({ date, meal: 'Café da manhã', food: 'Pão integral', qty: 50 });
    ctx.FoodLog.addNoCalc({ date, meal: 'Café da manhã', description: 'Café coado' });
  });
}

test('favourites start empty and are created from a registered meal, without logging consumption', () => {
  const ctx = bootFood();
  eq(ctx.Favorites.list(), []);
  breakfast(ctx);
  ctx.__uiResponses.push('Café reforçado');
  const r = ok(act(ctx, 'foodCreateFavorite', { date: '2026-09-28', meal: 'Café da manhã' }));
  assert.equal(r.message, 'Favorita criada: Café reforçado · v1 (3 itens de Café da manhã de 28/09/2026). Nada foi lançado.');
  assert.equal(ctx.Tabs.read('food').length, 3, 'no Alimentação row added');
  eq(plain(ctx.Tabs.read('favorites').map((f) => [f.name, f.version, f.kcal, f.protein, f.note])), [
    ['Café reforçado', 'v1', 272.5, 18, 'Criada de Café da manhã de 28/09/2026'],
  ]);
  eq(plain(ctx.Tabs.read('ingredients').map((i) => [i.favorite, i.version, i.food, i.qty, i.unit, i.kcal, i.check])), [
    ['Café reforçado', 'v1', 'Ovo inteiro cozido', 100, 'g', 146, 'Estimado'],
    ['Café reforçado', 'v1', 'Pão integral', 50, 'g', 126.5, 'Calculado'],
    ['Café reforçado', 'v1', 'Café coado', null, null, null, 'Sem cálculo'],
  ]);
  assert.match(act(ctx, 'foodCreateFavorite', { date: '2026-09-29', meal: 'Almoço' }).error, /Informe o nome|Nenhum alimento/);
  ctx.__uiResponses.push('Almoço padrão');
  assert.match(act(ctx, 'foodCreateFavorite', { date: '2026-09-29', meal: 'Almoço' }).error, /Nenhum alimento em Almoço de 29\/09\/2026/);
});

test('saving the same name again creates the next version; identical ingredients are refused', () => {
  const ctx = bootFood();
  breakfast(ctx);
  ctx.ChangeLog.run('t', () => ctx.Favorites.create({ date: '2026-09-28', meal: 'Café da manhã', name: 'Café reforçado' }));
  assert.throws(() => ctx.Favorites.create({ date: '2026-09-28', meal: 'Café da manhã', name: 'café  REFORÇADO' }), /já tem exatamente esses ingredientes/);
  ctx.ChangeLog.run('t', () => {
    ctx.FoodLog.add({ date: '2026-09-29', meal: 'Café da manhã', food: 'Ovo inteiro cozido', qty: 3, unit: 'un' });
    ctx.FoodLog.add({ date: '2026-09-29', meal: 'Café da manhã', food: 'Leite desnatado', qty: 200, unit: 'ml' });
  });
  // An empty name in the dialog means "new version of the favourite chosen in Hoje".
  ctx.__uiResponses.push('');
  const r = ok(act(ctx, 'foodCreateFavorite', { date: '2026-09-29', meal: 'Café da manhã', favorite: 'Café reforçado' }));
  assert.equal(r.label, 'Café reforçado · v2');
  eq(ctx.Favorites.versions('Café reforçado').map((v) => v.version), ['v1', 'v2']);
  eq(plain(ctx.Favorites.list().map((f) => [f.label, f.ingredients.map((i) => i.food)])), [
    ['Café reforçado · v2', ['Ovo inteiro cozido', 'Leite desnatado']],
  ]);
  eq(ctx.Favorites.ingredients('Café reforçado', 'v1').length, 3, 'older version kept');
  eq(ctx.Favorites.names(), ['Café reforçado']);
});

test('Lançar favorita × portions: one row per ingredient of the latest version, with Favorita / versão', () => {
  const ctx = bootFood();
  breakfast(ctx);
  ctx.ChangeLog.run('t', () => ctx.Favorites.create({ date: '2026-09-28', meal: 'Café da manhã', name: 'Café reforçado' }));
  const r = ok(act(ctx, 'foodAddFavorite', { meal: 'Café da manhã', favorite: 'Café reforçado', portions: 1.5 }));
  assert.match(r.message, /^Lançada: Café reforçado · v1 × 1,5 \(3 itens\) em Café da manhã de 29\/09\/2026\./);
  eq(foodRows(ctx, ['date', 'food', 'qty', 'kcal', 'calc', 'favorite', 'note', 'check']).slice(3), [
    ['2026-09-29', 'Ovo inteiro cozido', 150, 219, 'Estimado', 'Café reforçado · v1', '1,5 porções', 'Item estimado na favorita'],
    ['2026-09-29', 'Pão integral', 75, 189.75, 'Calculado', 'Café reforçado · v1', '1,5 porções', 'OK'],
    ['2026-09-29', 'Café coado', null, null, 'Sem cálculo', 'Café reforçado · v1', '1,5 porções', 'Macros desconhecidos'],
  ]);
  eq(dayTotals(ctx, '2026-09-29'), { kcal: 408.8, protein: 27, carbs: 38.3, fat: 17, fiber: 5.2, noCalcItems: 1, estimatedItems: 1 });
  eq(ctx.__cleared, [['favorite', 'portions']]);
  assert.match(act(ctx, 'foodAddFavorite', { favorite: 'Inexistente', portions: 1 }).error, /não encontrada/);
  assert.match(act(ctx, 'foodAddFavorite', { favorite: 'Café reforçado', portions: 0 }).error, /Porções/);
  // Default portions = 1; correcting a favourite row keeps its estimated flag.
  ok(act(ctx, 'foodAddFavorite', { favorite: 'Café reforçado', portions: null }));
  eq(foodRows(ctx, ['qty', 'note']).slice(6, 7), [[100, null]]);
  ctx.ChangeLog.run('t', () => ctx.FoodLog.correct(12, { qty: 120 }));
  eq(foodRows(ctx, ['qty', 'calc', 'favorite'])[6], [120, 'Estimado', 'Café reforçado · v1']);
});

test('undo of Lançar favorita removes every row and restores the totals', () => {
  const ctx = bootFood();
  breakfast(ctx);
  ctx.ChangeLog.run('t', () => ctx.Favorites.create({ date: '2026-09-28', meal: 'Café da manhã', name: 'Café' }));
  ok(act(ctx, 'foodAdd', { food: 'Arroz branco cozido', quantity: 100, unit: 'g' }));
  const before = dayTotals(ctx, '2026-09-29');
  ok(act(ctx, 'foodAddFavorite', { favorite: 'Café', portions: 2 }));
  ok(ctx.Actions.run('undoLast'));
  eq(dayTotals(ctx, '2026-09-29'), before);
  assert.equal(ctx.FoodLog.rows('2026-09-29').length, 1);
});
