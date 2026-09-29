'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plain } = require('./core_helpers');
const { bootFood, act, select, foodRows, dayTotals } = require('./food_helpers');

const eq = (a, b, m) => assert.deepEqual(plain(a), b, m);
const ok = (r) => { assert.equal(r.ok, true, r.error); return r.result; };

test('Lançar alimento writes base-unit quantity, macros, Cálculo, Fonte, ID and the day totals', () => {
  const ctx = bootFood();
  ok(act(ctx, 'foodAdd', { food: 'Arroz branco cozido', quantity: 0.15, unit: 'kg', measurement: 'Pesada' }));
  ok(act(ctx, 'foodAdd', { food: 'Ovo inteiro cozido', quantity: 2, unit: 'un', measurement: null }));
  eq(foodRows(ctx, ['date', 'meal', 'food', 'qty', 'unit', 'kcal', 'protein', 'measure', 'note', 'check', 'entryId', 'source', 'calc']), [
    ['2026-09-29', 'Almoço', 'Arroz branco cozido', 150, 'g', 192, 3.75, 'Pesada', 'Informado: 0,15 kg', 'OK', 'A20260929-001', 'TACO/fonte confiável', 'Calculado'],
    ['2026-09-29', 'Almoço', 'Ovo inteiro cozido', 100, 'g', 146, 13.3, 'Estimada', 'Informado: 2 un (medida caseira, estimada)', 'Medida caseira', 'A20260929-002', 'TACO/fonte confiável', 'Estimado'],
  ]);
  eq(dayTotals(ctx, '2026-09-29'), { kcal: 338, protein: 17.1, carbs: 42.8, fat: 9.8, fiber: 2.4, noCalcItems: 0, estimatedItems: 1 });
  eq(ctx.__cleared, [['food', 'quantity', 'note'], ['food', 'quantity', 'note']]);
  assert.match(ctx.__toasts.at(-1).msg, /^Lançado: Ovo inteiro cozido 100 g em Almoço de 29\/09\/2026\. Dia: 338 kcal, P 17 g · 1 estimado\.$/);
});

test('refusals: household unit without measure, unknown food, invalid catalogue row, future date', () => {
  const ctx = bootFood();
  const r1 = act(ctx, 'foodAdd', { food: 'Arroz branco cozido', quantity: 2, unit: 'un' });
  assert.match(r1.error, /não tem medida caseira/);
  assert.match(act(ctx, 'foodAdd', { food: 'Pizza', quantity: 1, unit: 'g' }).error, /não está cadastrado/);
  assert.match(act(ctx, 'foodAdd', { food: 'Granola sem cadastro completo', quantity: 40, unit: 'g' }).error, /incompleto em Alimentos/);
  assert.match(act(ctx, 'foodAdd', { food: 'Arroz branco cozido', quantity: 100, unit: 'g', date: '2026-09-30' }).error, /Data futura/);
  assert.match(act(ctx, 'foodAdd', { date: '2026-09-29', food: 'Arroz branco cozido', quantity: 100, unit: 'g', measurement: 'No olho' }).error, /Medição inválida/);
  assert.equal(ctx.Tabs.read('food').length, 0);
  assert.equal(ctx.Days.get('2026-09-29'), null, 'nothing written, no day row created');
});

test('estimated sources make the row Estimado; Medição Estimada too', () => {
  const ctx = bootFood();
  ctx.FoodLog.add({ date: '2026-09-29', meal: 'Lanche', food: 'Whey (rótulo a conferir)', qty: 30 });
  ctx.FoodLog.add({ date: '2026-09-29', meal: 'Lanche', food: 'Aveia em flocos', qty: 40, measure: 'Estimada' });
  eq(foodRows(ctx, ['source', 'calc', 'check']), [
    ['Estimativa', 'Estimado', 'Fonte: estimativa'],
    ['TACO/fonte confiável', 'Estimado', 'Quantidade estimada'],
  ]);
  assert.equal(dayTotals(ctx, '2026-09-29').estimatedItems, 2);
});

test('no-calc items keep macros empty (never 0) and do not enter the sums', () => {
  const ctx = bootFood();
  const r = ok(act(ctx, 'foodAddNoCalc', { meal: 'Jantar', noCalcDescription: 'Pizza no aniversário' }));
  assert.match(r.message, /Registrado sem cálculo: Pizza no aniversário em Jantar/);
  eq(foodRows(ctx, ['meal', 'food', 'qty', 'kcal', 'protein', 'carbs', 'fat', 'fiber', 'calc', 'source', 'check']), [
    ['Jantar', 'Pizza no aniversário', null, null, null, null, null, null, 'Sem cálculo', 'Pendente', 'Macros desconhecidos'],
  ]);
  const cells = ctx.__spreadsheet.getSheetByName('Alimentação').getRange(6, 6, 1, 5).getValues()[0];
  eq(cells, ['', '', '', '', ''], 'macro cells are empty, not 0');
  eq(dayTotals(ctx, '2026-09-29'), { kcal: null, protein: null, carbs: null, fat: null, fiber: null, noCalcItems: 1, estimatedItems: 0 });
  ctx.FoodLog.add({ date: '2026-09-29', meal: 'Jantar', food: 'Arroz branco cozido', qty: 100 });
  eq(dayTotals(ctx, '2026-09-29'), { kcal: 128, protein: 2.5, carbs: 28.1, fat: 0.2, fiber: 1.6, noCalcItems: 1, estimatedItems: 0 });
  assert.match(act(ctx, 'foodAddNoCalc', { noCalcDescription: '' }).error, /Descreva/);
  eq(ctx.__cleared, [['noCalcDescription', 'note']]);
});

test('copy a meal or the whole day; repeating the same copy is blocked', () => {
  const ctx = bootFood();
  ctx.FoodLog.add({ date: '2026-09-28', meal: 'Café da manhã', food: 'Ovo inteiro cozido', qty: 2, unit: 'un' });
  ctx.FoodLog.add({ date: '2026-09-28', meal: 'Almoço', food: 'Arroz branco cozido', qty: 150 });
  ctx.FoodLog.addNoCalc({ date: '2026-09-28', meal: 'Almoço', description: 'Sobremesa' });
  const r = ok(act(ctx, 'foodCopy', { copyFromDate: '2026-09-28', copyMeal: 'Almoço' }));
  assert.match(r.message, /Copiado: Almoço de 28\/09\/2026 para 29\/09\/2026 \(2 itens\)/);
  eq(foodRows(ctx, ['date', 'meal', 'food', 'qty', 'kcal', 'calc', 'note', 'entryId']).slice(3), [
    ['2026-09-29', 'Almoço', 'Arroz branco cozido', 150, 192, 'Calculado', 'Cópia de 28/09/2026', 'A20260929-001'],
    ['2026-09-29', 'Almoço', 'Sobremesa', null, null, 'Sem cálculo', 'Cópia de 28/09/2026', 'A20260929-002'],
  ]);
  eq(dayTotals(ctx, '2026-09-29'), { kcal: 192, protein: 3.8, carbs: 42.2, fat: 0.3, fiber: 2.4, noCalcItems: 1, estimatedItems: 0 });

  const again = act(ctx, 'foodCopy', { copyFromDate: '2026-09-28', copyMeal: 'Almoço' });
  assert.match(again.error, /Cópia já feita: Almoço de 28\/09\/2026 já foi copiado para 29\/09\/2026/);
  const all = act(ctx, 'foodCopy', { copyFromDate: '2026-09-28', copyMeal: 'Todas' });
  assert.match(all.error, /Cópia já feita: Almoço/, '"Todas" is blocked when one of its meals was already copied');
  assert.equal(ctx.Tabs.read('food').length, 5);

  const ctx2 = bootFood();
  ctx2.FoodLog.add({ date: '2026-09-28', meal: 'Café da manhã', food: 'Ovo inteiro cozido', qty: 2, unit: 'un' });
  ctx2.FoodLog.add({ date: '2026-09-28', meal: 'Almoço', food: 'Arroz branco cozido', qty: 150 });
  ok(act(ctx2, 'foodCopy', { copyFromDate: '2026-09-28', copyMeal: 'Todas' }));
  eq(foodRows(ctx2, ['date', 'meal', 'calc', 'note']).slice(2), [
    ['2026-09-29', 'Café da manhã', 'Estimado', 'Cópia de 28/09/2026 · Informado: 2 un (medida caseira, estimada)'],
    ['2026-09-29', 'Almoço', 'Calculado', 'Cópia de 28/09/2026'],
  ]);
  assert.match(act(ctx2, 'foodCopy', { copyFromDate: '2026-09-28', copyMeal: 'Café da manhã' }).error, /Cópia já feita/);
  assert.match(act(ctx2, 'foodCopy', { copyFromDate: '2026-09-29', copyMeal: 'Todas' }).error, /mesma do dia/);
  assert.match(act(ctx2, 'foodCopy', { copyFromDate: '2026-09-20', copyMeal: 'Todas' }).error, /Nada para copiar/);
  // A copy of a copy carries only the newest marker.
  ctx2.ChangeLog.run('t', () => ctx2.FoodLog.copy({ from: '2026-09-29', to: '2026-09-27', meal: 'Café da manhã' }));
  eq(foodRows(ctx2, ['date', 'note']).at(-1), ['2026-09-27', 'Cópia de 29/09/2026 · Informado: 2 un (medida caseira, estimada)']);
});

test('correct the selected row: quantity (and unit) recomputed, totals updated, copy marker kept', () => {
  const ctx = bootFood();
  ctx.FoodLog.add({ date: '2026-09-28', meal: 'Almoço', food: 'Arroz branco cozido', qty: 150 });
  ctx.FoodLog.copy({ from: '2026-09-28', to: '2026-09-29', meal: 'Almoço' });
  select(ctx, 7);
  ctx.__uiResponses.push({ button: 'OK', text: '200' });
  const r = ok(act(ctx, 'foodCorrect'));
  assert.match(r.message, /Corrigido: Arroz branco cozido 150 → 200 g \(29\/09\/2026\)\. Dia: 256 kcal/);
  eq(foodRows(ctx, ['date', 'qty', 'kcal', 'note']), [
    ['2026-09-28', 150, 192, null],
    ['2026-09-29', 200, 256, 'Cópia de 28/09/2026'],
  ]);
  eq(dayTotals(ctx, '2026-09-29').kcal, 256);
  eq(dayTotals(ctx, '2026-09-28').kcal, 192, 'other days untouched');

  ctx.FoodLog.add({ date: '2026-09-29', meal: 'Café da manhã', food: 'Ovo inteiro cozido', qty: 100 });
  const row = 8;
  ctx.FoodLog.correct(row, { qty: 3, unit: 'un' });
  eq(foodRows(ctx, ['qty', 'calc', 'note', 'check'])[2], [150, 'Estimado', 'Informado: 3 un (medida caseira, estimada)', 'Medida caseira']);
  ctx.FoodLog.correct(row, { qty: 120, unit: 'g' });
  eq(foodRows(ctx, ['qty', 'calc', 'note', 'check'])[2], [120, 'Calculado', null, 'OK']);

  ctx.FoodLog.addNoCalc({ date: '2026-09-29', meal: 'Jantar', description: 'Pizza' });
  assert.throws(() => ctx.FoodLog.correct(9, { qty: 1 }), /sem cálculo/);
  ctx.__uiResponses.push({ button: 'CANCEL', text: '' });
  select(ctx, 6);
  eq(ok(act(ctx, 'foodCorrect')).message, 'Correção cancelada.');
  select(ctx, 6, 2);
  assert.match(act(ctx, 'foodCorrect').error, /única linha/);
  ctx.SpreadsheetApp.setActiveRange(ctx.__spreadsheet.getSheetByName('Diário').getRange('A6'));
  assert.match(act(ctx, 'foodCorrect').error, /Selecione a linha na aba Alimentação/);
});

test('delete the selected rows; totals recomputed; a day left empty goes back to não informado', () => {
  const ctx = bootFood();
  ctx.FoodLog.add({ date: '2026-09-29', meal: 'Almoço', food: 'Arroz branco cozido', qty: 100 });
  ctx.FoodLog.add({ date: '2026-09-29', meal: 'Almoço', food: 'Peito de frango cozido', qty: 100 });
  ctx.FoodLog.addNoCalc({ date: '2026-09-29', meal: 'Jantar', description: 'Pizza' });
  select(ctx, 6);
  assert.match(ok(act(ctx, 'foodDelete')).message, /Excluído: Arroz branco cozido\. Dia: 163 kcal/);
  eq(dayTotals(ctx, '2026-09-29'), { kcal: 163, protein: 31.5, carbs: 0, fat: 3.2, fiber: 0, noCalcItems: 1, estimatedItems: 0 });
  select(ctx, 6, 2);
  ok(act(ctx, 'foodDelete'));
  assert.equal(ctx.Tabs.read('food').length, 0);
  eq(dayTotals(ctx, '2026-09-29'), { kcal: null, protein: null, carbs: null, fat: null, fiber: null, noCalcItems: null, estimatedItems: null });
  select(ctx, 6);
  assert.match(act(ctx, 'foodDelete').error, /Selecione uma linha com lançamento/);
});

test('undo of an entry, a correction and a deletion restores rows and totals', () => {
  const ctx = bootFood();
  ok(act(ctx, 'foodAdd', { food: 'Arroz branco cozido', quantity: 100, unit: 'g' }));
  const before = dayTotals(ctx, '2026-09-29');
  ok(act(ctx, 'foodAdd', { food: 'Peito de frango cozido', quantity: 100, unit: 'g' }));
  assert.equal(dayTotals(ctx, '2026-09-29').kcal, 291);
  ok(ctx.Actions.run('undoLast'));
  eq(dayTotals(ctx, '2026-09-29'), before);
  assert.equal(ctx.Tabs.read('food').length, 1);

  select(ctx, 6);
  ctx.__uiResponses.push('250');
  ok(act(ctx, 'foodCorrect'));
  assert.equal(dayTotals(ctx, '2026-09-29').kcal, 320);
  ok(ctx.Actions.run('undoLast'));
  eq(dayTotals(ctx, '2026-09-29'), before);
  eq(foodRows(ctx, ['qty', 'kcal']), [[100, 128]]);

  select(ctx, 6);
  ok(act(ctx, 'foodDelete'));
  assert.equal(dayTotals(ctx, '2026-09-29').kcal, null);
  ok(ctx.Actions.run('undoLast'));
  eq(dayTotals(ctx, '2026-09-29'), before);
  eq(foodRows(ctx, ['food', 'entryId']), [['Arroz branco cozido', 'A20260929-001']]);

  ok(ctx.Actions.run('undoLast'));
  assert.equal(ctx.Tabs.read('food').length, 0);
  assert.equal(ctx.Days.get('2026-09-29'), null, 'undoing the first entry removes the day row it created');
});

test('3.0 rows without Cálculo are read by their macros; ids continue after the highest of the day', () => {
  const ctx = bootFood({
    tabs: {
      food: [
        { date: '2026-09-29', meal: 'Almoço', food: 'Arroz branco cozido', qty: 100, unit: 'g', kcal: 128, protein: 2.5, carbs: 28.1, fat: 0.2, fiber: 1.6, entryId: 'A20260929-007' },
        { date: '2026-09-29', meal: 'Almoço', food: 'Feijoada', entryId: 'X1' },
      ],
    },
  });
  eq(ctx.FoodLog.dayTotals('2026-09-29'), { kcal: 128, protein: 2.5, carbs: 28.1, fat: 0.2, fiber: 1.6, noCalcItems: 1, estimatedItems: 0, items: 2, calculableItems: 1 });
  ctx.ChangeLog.run('t', () => ctx.FoodLog.add({ date: '2026-09-29', meal: 'Jantar', food: 'Arroz branco cozido', qty: 50 }));
  assert.equal(ctx.Tabs.read('food')[2].entryId, 'A20260929-008');
});

test('food actions are in the Alimentação menu in spec order; entry actions are quick', () => {
  const ctx = bootFood();
  const menu = plain(ctx.Actions.menu()).find((g) => g.label === 'Alimentação');
  eq(menu.items.map((i) => i.label), [
    'Lançar alimento', 'Lançar favorita', 'Lançar sem cálculo', 'Copiar refeição/dia', 'Corrigir linha selecionada',
    'Excluir linha selecionada', 'Criar favorita da refeição', 'Recalcular dieta base e equivalências',
  ]);
  eq(ctx.Actions.list().filter((a) => a.group === 'food' && a.quick).map((a) => a.label), ['Lançar alimento', 'Lançar favorita', 'Lançar sem cálculo', 'Copiar refeição/dia']);
});

test('wired to Hoje: reads the food card, clears only the consumed fields, refreshes state and Meta × realizado', () => {
  const ctx = bootFood({ tabs: { goals: [{ id: 'M001', start: '2026-09-28', status: 'Vigente', kcal: 2400, protein: 140, fat: 65, carbs: 313.75 }] } });
  ctx.FoodScreen.use(null);
  assert.match(act(ctx, 'foodAdd').error, /tela Hoje não está disponível/);
  ctx.Hoje.ensure();
  ctx.Hoje.write('header', { date: ctx.Dates.fromKey('2026-09-29') });
  ctx.Hoje.write('food', { meal: 'Almoço', food: 'Arroz branco cozido', qty: '150,5', unit: 'g', measure: 'Pesada', note: 'marmita' });
  const s = ctx.FoodScreen.read();
  eq([ctx.Dates.key(s.date), s.meal, s.food, s.quantity, s.measurement, s.note, s.portions], ['2026-09-29', 'Almoço', 'Arroz branco cozido', 150.5, 'Pesada', 'marmita', null]);
  ok(act(ctx, 'foodAdd'));
  eq(foodRows(ctx, ['food', 'qty', 'note']), [['Arroz branco cozido', 150.5, 'marmita']]);
  const food = ctx.Hoje.read().food;
  eq([food.meal, food.food, food.qty, food.unit, food.note], ['Almoço', null, null, 'g', null], 'meal and unit stay selected');
  assert.equal(ctx.Days.get('2026-09-29').dayState, 'Parcial', 'Estado do dia refreshed after the totals');
  const hoje = ctx.__spreadsheet.getSheetByName('Hoje');
  eq([hoje.getRange('A60').getValue(), hoje.getRange('B60').getValue()], ['kcal', 192.6], 'Meta × realizado re-rendered');
  ctx.Hoje.write('food', { noCalcText: 'Brigadeiro' });
  ok(act(ctx, 'foodAddNoCalc'));
  assert.equal(ctx.Days.get('2026-09-29').noCalcItems, 1);
  assert.equal(ctx.Hoje.read().food.noCalcText, null);
});
