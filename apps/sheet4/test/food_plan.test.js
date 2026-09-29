'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plain } = require('./core_helpers');
const { load } = require('./harness');
const { bootFood } = require('./food_helpers');

const eq = (a, b, m) => assert.deepEqual(plain(a), b, m);
const NOW = '2026-09-29T15:00:00-03:00';
const close = (a, b) => Math.abs(a - b) <= 0.06; // script values are rounded to 0.1

test('Dieta base and Equivalências computed by the script match the 3.0 formulas of both exports', () => {
  for (const name of ['breno_3_0', 'zoio_3_0']) {
    const ctx = load({ fixture: name, useCachedValues: true, now: NOW });
    const cachedTotal = ctx.Tabs.read('baseDiet').find((r) => r.meal === 'Total da proposta');
    const c = ctx.BaseDiet.compute();
    eq(c.problems, [], name);
    ctx.Foods.MACROS.forEach((k) => assert.ok(close(c.totals[k], cachedTotal[k]), `${name} ${k}: ${c.totals[k]} vs ${cachedTotal[k]}`));
    ctx.Tabs.read('equivalences').forEach((r) => {
      const s = ctx.Equivalences.swap(r.base, r.baseQty, r.criterion, r.alternative);
      ['equivQty', 'kcalBase', 'kcalAlt', 'kcalDiff', 'proteinAlt', 'carbsAlt', 'fatAlt'].forEach((k) => {
        assert.ok(close(s[k], r[k]), `${name} row ${r._row} ${k}: ${s[k]} vs ${r[k]}`);
      });
      assert.equal(s.unit, r.unit);
    });
  }
});

test('Recalcular dieta base replaces the VLOOKUP formulas with values; undo brings the formulas back', () => {
  const ctx = load({ fixture: 'breno_3_0', now: NOW });
  const diet = ctx.__spreadsheet.getSheetByName('Dieta base');
  const eqs = ctx.__spreadsheet.getSheetByName('Equivalências');
  assert.match(diet.getRange('E6').getFormula(), /^=C6\/VLOOKUP/);
  assert.match(eqs.getRange('E6').getFormula(), /VLOOKUP/);
  const r = ctx.Actions.run('foodRefreshPlan');
  assert.equal(r.ok, true, r.error);
  assert.match(r.result.message, /^Dieta base: 2441 kcal, P 145 g \(planejada\) · 20 equivalências\.$/);
  eq([diet.getRange('D6').getValue(), diet.getRange('E6').getFormula(), diet.getRange('E6').getValue(), diet.getRange('E31').getValue()], ['g', '', 214.5, 2440.7]);
  eq([eqs.getRange('E6').getFormula(), eqs.getRange('E6').getValue(), eqs.getRange('F6').getValue()], ['', 236.8, 'g']);
  const foods = ctx.__spreadsheet.getSheetByName('Alimentos');
  eq([foods.getRange('L6').getFormula(), foods.getRange('L6').getValue()], ['', 'OK']);
  assert.equal(ctx.Actions.run('undoLast').ok, true);
  assert.match(diet.getRange('E6').getFormula(), /^=C6\/VLOOKUP/);
  assert.match(diet.getRange('E31').getFormula(), /^=SUM\(E6:E29\)/);
  assert.match(eqs.getRange('E6').getFormula(), /VLOOKUP/);
  assert.match(foods.getRange('L6').getFormula(), /Rever macros/);
});

test('base diet: household units, unknown foods left empty (never 0), totals row appended when missing', () => {
  const ctx = bootFood({
    tabs: {
      baseDiet: [
        { meal: 'Café da manhã', food: 'Ovo inteiro cozido', qty: 3, unit: 'un' },
        { meal: 'Café da manhã', food: 'Pão integral', qty: 50 },
        { meal: 'Almoço', food: 'Feijoada', qty: 300, unit: 'g', kcal: 0 },
        { meal: 'Almoço', food: 'Arroz branco cozido', qty: 2, unit: 'un' },
      ],
    },
  });
  ctx.ChangeLog.run('t', () => ctx.BaseDiet.refresh());
  eq(plain(ctx.Tabs.read('baseDiet').map((r) => [r.meal, r.food, r.qty, r.unit, r.kcal, r.protein])), [
    ['Café da manhã', 'Ovo inteiro cozido', 3, 'un', 219, 19.95],
    ['Café da manhã', 'Pão integral', 50, 'g', 126.5, 4.7],
    ['Almoço', 'Feijoada', 300, 'g', null, null],
    ['Almoço', 'Arroz branco cozido', 2, 'un', null, null],
    ['Total da proposta', null, null, null, 345.5, 24.7],
  ]);
  const c = ctx.BaseDiet.compute();
  eq(c.problems.map((p) => p.food), ['Feijoada', 'Arroz branco cozido']);
  assert.match(c.problems[1].error, /não tem medida caseira/);
  eq(ctx.BaseDiet.totals(), { kcal: 345.5, protein: 24.7, carbs: 25.9, fat: 16.1, fiber: 3.5, items: 2 });
  ctx.ChangeLog.run('t', () => ctx.BaseDiet.refresh());
  assert.equal(ctx.Tabs.read('baseDiet').length, 5, 'the totals row is updated in place, not appended again');
  assert.equal(ctx.Days.get('2026-09-29'), null, 'the planned diet never feeds Diário');
});

test('equivalences: criterion validation and swaps impossible by the chosen nutrient', () => {
  const ctx = bootFood({
    tabs: {
      equivalences: [
        { base: 'Peito de frango cozido', baseQty: 100, criterion: 'Proteína', alternative: 'Ovo inteiro cozido' },
        { base: 'Arroz branco cozido', baseQty: 100, criterion: 'Carboidrato', alternative: 'Peito de frango cozido', equivQty: 5 },
        { base: 'Arroz branco cozido', baseQty: 100, criterion: 'Sabor', alternative: 'Aveia em flocos' },
      ],
    },
  });
  const r = ctx.ChangeLog.run('t', () => ctx.Equivalences.refresh());
  assert.equal(r.computed, 1);
  eq(r.problems.map((p) => p.error), [
    '"Peito de frango cozido" não tem carboidrato: troca impossível por esse critério.',
    'Critério inválido: "Sabor". Use Proteína, Carboidrato ou Gordura.',
  ]);
  eq(plain(ctx.Tabs.read('equivalences').map((x) => [x.equivQty, x.unit, x.kcalDiff])), [[236.8, 'g', 182.8], [null, null, null], [null, null, null]]);
});
