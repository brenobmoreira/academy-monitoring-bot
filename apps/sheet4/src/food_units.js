/**
 * Units and conversions for food quantities (spec §3.3, 3.0 Guia "Unidades").
 *
 * Every food in Alimentos has a unit-base (g or ml) and a base quantity; its macros are for that
 * portion. A quantity typed in another unit is converted to the base unit:
 *   - mass units (g, mg, kg) convert among themselves;
 *   - volume units (ml, l) convert among themselves;
 *   - mass ↔ volume is refused (no density: "não converter ml em g sem densidade");
 *   - any other unit (un, fatia, colher, porção…) is a household measure and needs the food's
 *     `Medida caseira` + `Base por medida` (Alimentos M/N); the result is flagged `estimated`.
 * "2 un" of egg is never read as 2 g: a household unit without a matching measure is an error.
 */
const Units = {
  /** Factor to the family's reference unit (g for mass, ml for volume). */
  FAMILIES: {
    mass: { label: 'massa', units: { mg: 0.001, g: 1, kg: 1000 } },
    volume: { label: 'volume', units: { ml: 1, l: 1000 } },
  },

  /** Units offered in the Hoje list (Setup). Household units need Alimentos M/N. */
  LIST: ['g', 'mg', 'kg', 'ml', 'l', 'un', 'fatia', 'colher', 'porção'],

  /** Spellings accepted for the canonical unit. */
  ALIASES: {
    grama: 'g', gramas: 'g', gr: 'g', miligrama: 'mg', miligramas: 'mg', quilo: 'kg', quilos: 'kg',
    kilo: 'kg', kilos: 'kg', mililitro: 'ml', mililitros: 'ml', litro: 'l', litros: 'l',
    unidade: 'un', unidades: 'un', und: 'un', 'un.': 'un', fatias: 'fatia', colheres: 'colher',
    porcao: 'porção', porcoes: 'porção', 'porções': 'porção',
  },

  /** Canonical spelling of a unit ('' when empty): lower case, trimmed, aliases resolved. */
  normalize(unit) {
    const u = String(unit === null || unit === undefined ? '' : unit).normalize('NFC').trim().toLowerCase();
    if (!u) return '';
    return Units.ALIASES[u] || u;
  },

  /** 'mass' | 'volume' | null (household or unknown). */
  family(unit) {
    const u = Units.normalize(unit);
    const names = Object.keys(Units.FAMILIES);
    for (let i = 0; i < names.length; i++) {
      if (u in Units.FAMILIES[names[i]].units) return names[i];
    }
    return null;
  },

  /**
   * Parses a typed quantity: a number, or text with a decimal comma or point.
   * @returns {number|null} null when empty or not a number
   */
  parseQty(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const s = String(v).trim().replace(/\s/g, '');
    if (!/^-?\d+([.,]\d+)?$/.test(s)) return null;
    return Number(s.replace(',', '.'));
  },

  /**
   * "150", "150 g", "2 un", "1,5 fatia" → {qty, unit}; unit '' when not typed.
   * @returns {{qty: number, unit: string}|null}
   */
  parseAmount(text) {
    if (typeof text === 'number') return isFinite(text) ? { qty: text, unit: '' } : null;
    const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(.*?)\s*$/.exec(String(text === null || text === undefined ? '' : text));
    if (!m) return null;
    return { qty: Number(m[1].replace(',', '.')), unit: Units.normalize(m[2]) };
  },

  round(v, digits) {
    const f = Math.pow(10, digits === undefined ? 2 : digits);
    return Math.round(v * f) / f;
  },

  /** Number for messages: Portuguese decimal comma, up to 2 decimals. */
  fmt(v) {
    return String(Units.round(v, 2)).replace('.', ',');
  },

  /**
   * Converts a quantity to the food's base unit.
   * @param {number|string} qty quantity as typed (> 0)
   * @param {string} unit unit as typed; empty means the food's base unit
   * @param {{name: string, baseUnit: string, householdUnit?: string, perHousehold?: number}} food
   * @returns {{qty: number, unit: string, estimated: boolean, household: string|null,
   *   input: {qty: number, unit: string}, converted: boolean}}
   * @throws Error with a Portuguese message when the conversion is not possible
   */
  convert(qty, unit, food) {
    const name = food && food.name ? food.name : 'alimento';
    const n = Units.parseQty(qty);
    if (n === null) throw new Error(`Quantidade inválida para "${name}": ${JSON.stringify(qty)}.`);
    if (!(n > 0)) throw new Error(`A quantidade de "${name}" deve ser maior que zero.`);
    const base = Units.normalize(food && food.baseUnit);
    const baseFamily = Units.family(base);
    if (!baseFamily) throw new Error(`"${name}" não tem unidade-base válida em Alimentos (use g ou ml).`);
    const u = Units.normalize(unit) || base;
    const input = { qty: n, unit: u };
    const fam = Units.family(u);
    if (fam) {
      if (fam !== baseFamily) {
        throw new Error(`"${name}" é medido em ${base}; não converto ${u} (${Units.FAMILIES[fam].label}) em ${base} (${Units.FAMILIES[baseFamily].label}) sem densidade. Informe em ${base}.`);
      }
      const units = Units.FAMILIES[fam].units;
      const out = Units.round(n * units[u] / units[base], 4);
      return { qty: out, unit: base, estimated: false, household: null, input, converted: u !== base };
    }
    const household = Units.normalize(food.householdUnit);
    const per = Units.parseQty(food.perHousehold);
    if (!household || !(per > 0)) {
      throw new Error(`"${name}" não tem medida caseira em Alimentos (Medida caseira + Base por medida), então "${Units.fmt(n)} ${u}" não pode ser convertido. Informe em ${base} ou cadastre a medida; ${Units.fmt(n)} ${u} nunca vira ${Units.fmt(n)} ${base}.`);
    }
    if (household !== u) {
      throw new Error(`A medida caseira de "${name}" é "${household}" (${Units.fmt(per)} ${base}); "${u}" não é convertido. Informe em ${household} ou ${base}.`);
    }
    return { qty: Units.round(n * per, 4), unit: base, estimated: true, household: u, input, converted: true };
  },

  /** convert() that returns {ok: false, error} instead of throwing. */
  tryConvert(qty, unit, food) {
    try {
      return Object.assign({ ok: true }, Units.convert(qty, unit, food));
    } catch (err) {
      return { ok: false, error: err.message };
    }
  },

  /** Text kept in the Observação of an Alimentação row when the typed unit was not the base. */
  describe(conv) {
    if (!conv || !conv.converted) return '';
    const typed = `${Units.fmt(conv.input.qty)} ${conv.input.unit}`;
    return conv.household ? `Informado: ${typed} (medida caseira, estimada)` : `Informado: ${typed}`;
  },
};
