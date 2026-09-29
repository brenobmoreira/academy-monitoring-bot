/**
 * Planning tabs computed by the script: Dieta base and Equivalências (spec §4.3).
 *
 * Both replace the 3.0 VLOOKUP formulas with values written by "Recalcular dieta base e
 * equivalências" (and by Setup/Migrate when they call BaseDiet.refresh / Equivalences.refresh).
 * Values instead of formulas because the catalogue is addressed by header (columns may move),
 * household units need Units.convert, and a missing food must read as "não calculado" (empty),
 * never as #N/A or 0. Undo restores the previous values (or the 3.0 formulas).
 *
 * The Dieta base total is the *planned* diet ("dieta base" in §4.3): it is shown next to the
 * goal and the realised intake but never feeds Diário, weeks or indicators.
 */
const BaseDiet = {
  /** Refeição text of the totals row (3.0 used the same). */
  TOTAL_LABEL: 'Total da proposta',

  isTotal_(row) {
    return Tabs.normalize_(row.meal) === Tabs.normalize_(BaseDiet.TOTAL_LABEL);
  },

  /**
   * Computes every item and the total without writing.
   * @returns {{items: {row, food, qty, unit, macros|null, error|null}[], totals: Object|null,
   *   totalRow: number|null, problems: {row, food, error}[]}}
   */
  compute() {
    const rows = Tabs.read('baseDiet');
    const items = [];
    let totalRow = null;
    rows.forEach((r) => {
      if (BaseDiet.isTotal_(r)) { totalRow = r._row; return; }
      if (!r.food && (r.qty === null || r.qty === undefined)) return;
      const item = { row: r._row, food: r.food, qty: r.qty, unit: r.unit, macros: null, error: null };
      try {
        const food = Foods.get(r.food);
        const p = Foods.portion(food, r.qty, r.unit);
        item.unit = r.unit ? Units.normalize(r.unit) : p.unit;
        item.macros = p.macros;
      } catch (err) {
        item.error = err.message;
      }
      items.push(item);
    });
    const ok = items.filter((i) => i.macros);
    let totals = null;
    if (ok.length) {
      totals = {};
      Foods.MACROS.forEach((k) => { totals[k] = Units.round(ok.reduce((s, i) => s + i.macros[k], 0), 1); });
      totals.items = ok.length;
    }
    return { items, totals, totalRow, problems: items.filter((i) => i.error).map((i) => ({ row: i.row, food: i.food, error: i.error })) };
  },

  /** Planned totals {kcal, protein, carbs, fat, fiber, items} or null (for Painel). */
  totals() {
    return BaseDiet.compute().totals;
  },

  /** Writes each item's unit/macros and the totals row (appended when missing). */
  refresh() {
    const c = BaseDiet.compute();
    c.items.forEach((i) => {
      const patch = { unit: i.unit || null };
      Foods.MACROS.forEach((k) => { patch[k] = i.macros ? i.macros[k] : null; });
      Tabs.update('baseDiet', i.row, patch);
    });
    const total = { meal: BaseDiet.TOTAL_LABEL };
    Foods.MACROS.forEach((k) => { total[k] = c.totals ? c.totals[k] : null; });
    if (c.totalRow) Tabs.update('baseDiet', c.totalRow, total);
    else if (c.items.length) Tabs.append('baseDiet', total);
    return c;
  },
};

const Equivalences = {
  /** Critério text (folded) → nutrient key. */
  CRITERIA: { proteina: 'protein', carboidrato: 'carbs', gordura: 'fat', fibra: 'fiber', kcal: 'kcal', energia: 'kcal', calorias: 'kcal' },

  criterion_(text) {
    const k = Foods.fold_(text).trim();
    return Equivalences.CRITERIA[k] || null;
  },

  /**
   * One swap: the quantity of `alternative` that gives the same amount of the criterion nutrient
   * as `baseQty` (in the base food's base unit) of `base`.
   * @returns {{equivQty, unit, kcalBase, kcalAlt, kcalDiff, proteinAlt, carbsAlt, fatAlt}}
   * @throws with a Portuguese message
   */
  swap(base, baseQty, criterion, alternative) {
    const key = Equivalences.criterion_(criterion);
    if (!key) throw new Error(`Critério inválido: "${criterion}". Use Proteína, Carboidrato ou Gordura.`);
    const b = Foods.get(base);
    const alt = Foods.get(alternative);
    const q = Units.parseQty(baseQty);
    if (!(q > 0)) throw new Error(`Qtd. base de "${base}" deve ser maior que zero.`);
    const bm = Foods.macros(b, q);
    Foods.macros(alt, alt.baseQty); // validates the alternative
    const perUnit = alt[key] / alt.baseQty;
    if (!(perUnit > 0)) throw new Error(`"${alt.name}" não tem ${Foods.MACRO_LABELS[key]}: troca impossível por esse critério.`);
    const equivQty = bm[key] / perUnit;
    const am = Foods.macros(alt, equivQty);
    const r1 = (v) => Units.round(v, 1);
    return {
      equivQty: r1(equivQty), unit: Units.normalize(alt.baseUnit), kcalBase: r1(bm.kcal), kcalAlt: r1(am.kcal),
      kcalDiff: r1(am.kcal - bm.kcal), proteinAlt: r1(am.protein), carbsAlt: r1(am.carbs), fatAlt: r1(am.fat),
    };
  },

  /** Writes the computed columns of every row; rows that cannot be computed are left empty. */
  refresh() {
    const problems = [];
    let computed = 0;
    const keys = ['equivQty', 'unit', 'kcalBase', 'kcalAlt', 'kcalDiff', 'proteinAlt', 'carbsAlt', 'fatAlt'];
    Tabs.read('equivalences').forEach((r) => {
      if (!r.base && !r.alternative) return;
      let patch;
      try {
        patch = Equivalences.swap(r.base, r.baseQty, r.criterion, r.alternative);
        computed += 1;
      } catch (err) {
        problems.push({ row: r._row, base: r.base, alternative: r.alternative, error: err.message });
        patch = {};
        keys.forEach((k) => { patch[k] = null; });
      }
      Tabs.update('equivalences', r._row, patch);
    });
    return { computed, problems };
  },
};

Actions.register({
  id: 'foodRefreshPlan', label: 'Recalcular dieta base e equivalências', group: 'food', order: 80,
  run: () => {
    const v = Foods.writeValidity();
    const d = BaseDiet.refresh();
    const e = Equivalences.refresh();
    const parts = [];
    parts.push(d.totals ? `Dieta base: ${Math.round(d.totals.kcal)} kcal, P ${Math.round(d.totals.protein)} g (planejada)` : 'Dieta base sem itens calculáveis');
    parts.push(`${e.computed} equivalências`);
    const issues = v.invalid.length + d.problems.length + e.problems.length;
    if (issues) parts.push(`${issues} pendência${issues === 1 ? '' : 's'} (Alimentos: ${v.invalid.length}, Dieta base: ${d.problems.length}, Equivalências: ${e.problems.length})`);
    return { message: `${parts.join(' · ')}.`, foods: v, baseDiet: d, equivalences: e };
  },
});
