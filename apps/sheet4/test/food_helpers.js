/** Test helpers for the food module: a small catalogue, a scripted Hoje food block, selection. */
'use strict';
const { boot, plain } = require('./core_helpers');

const TACO = { reference: 'TACO 4ª ed.; pelo nome', quality: 'Referência cadastrada — não auditada nesta revisão' };
const ESTIMATE = { reference: 'Estimativa genérica', quality: 'Estimativa — conferir rótulo' };

/** Values copied from the 3.0 Alimentos tab (same numbers, fewer rows). */
const FOODS = [
  { name: 'Ovo inteiro cozido', baseUnit: 'g', baseQty: 100, kcal: 146, protein: 13.3, carbs: 0.6, fat: 9.5, fiber: 0, householdUnit: 'un', perHousehold: 50, ...TACO },
  { name: 'Arroz branco cozido', baseUnit: 'g', baseQty: 100, kcal: 128, protein: 2.5, carbs: 28.1, fat: 0.2, fiber: 1.6, ...TACO },
  { name: 'Peito de frango cozido', baseUnit: 'g', baseQty: 100, kcal: 163, protein: 31.5, carbs: 0, fat: 3.2, fiber: 0, ...TACO },
  { name: 'Pão integral', baseUnit: 'g', baseQty: 100, kcal: 253, protein: 9.4, carbs: 49.9, fat: 3.7, fiber: 6.9, householdUnit: 'fatia', perHousehold: 25, ...TACO },
  { name: 'Leite desnatado', baseUnit: 'ml', baseQty: 100, kcal: 35, protein: 3, carbs: 4.7, fat: 0.2, fiber: 0, ...TACO },
  { name: 'Whey (rótulo a conferir)', baseUnit: 'g', baseQty: 30, kcal: 120, protein: 23, carbs: 4, fat: 1.3, fiber: 0, ...ESTIMATE },
  { name: 'Aveia em flocos', baseUnit: 'g', baseQty: 100, kcal: 394, protein: 13.9, carbs: 66.6, fat: 8.5, fiber: 9.1, ...TACO },
  { name: 'Granola sem cadastro completo', baseUnit: 'g', baseQty: 100, kcal: 420, protein: 9, ...TACO },
];

const EMPTY_TABS = () => ({
  objectives: [], goals: [], plans: [], diary: [], food: [], foods: FOODS.map((f) => ({ ...f })),
  favorites: [], ingredients: [], baseDiet: [], equivalences: [],
});

/**
 * Boots a context with the food tabs and a scripted Hoje food block in ctx.__screen
 * (FoodScreen.use). Cleared fields become null, like Hoje.clearFood would do.
 */
function bootFood(opts = {}) {
  const ctx = boot({ tabs: Object.assign(EMPTY_TABS(), opts.tabs || {}), now: opts.now });
  ctx.__screen = Object.assign({ date: '2026-09-29', meal: 'Almoço' }, opts.screen || {});
  ctx.__cleared = [];
  ctx.FoodScreen.use({
    read: () => ctx.__screen,
    clear: (keys) => { ctx.__cleared.push(keys); keys.forEach((k) => { ctx.__screen[k] = null; }); },
  });
  return ctx;
}

/** Sets the Hoje food block fields and runs an action by id. */
function act(ctx, id, screen) {
  if (screen) Object.assign(ctx.__screen, screen);
  return ctx.Actions.run(id);
}

/** Selects rows [row, row + n) of a tab (default Alimentação). */
function select(ctx, row, n = 1, tab = 'Alimentação') {
  const sheet = ctx.__spreadsheet.getSheetByName(tab);
  ctx.SpreadsheetApp.setActiveRange(sheet.getRange(row, 1, n, 3));
}

/** Alimentação rows reduced to the given keys (dates as yyyy-MM-dd). */
function foodRows(ctx, keys) {
  return plain(ctx.Tabs.read('food').map((r) => keys.map((k) => (k === 'date' ? ctx.Dates.key(r.date) : r[k]))));
}

const TOTAL_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'noCalcItems', 'estimatedItems'];

/** Diário food totals of a date, or null when the day row does not exist. */
function dayTotals(ctx, date) {
  const d = ctx.Days.get(date);
  if (!d) return null;
  return plain(Object.fromEntries(TOTAL_KEYS.map((k) => [k, d[k]])));
}

module.exports = { bootFood, act, select, foodRows, dayTotals, FOODS, TOTAL_KEYS };
