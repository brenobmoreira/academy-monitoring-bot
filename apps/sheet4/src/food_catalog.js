/**
 * Food catalogue: the Alimentos tab (spec §3, layer 3).
 *
 * A food is valid when its Base is > 0, its unit-base is a mass or volume unit and the 5 macros
 * (kcal, proteína, carboidrato, gordura, fibra) are numbers (0 is a valid value, empty is not).
 * A household measure (Medida caseira + Base por medida) is optional but must be complete.
 *
 * Source quality: 4.0 classifies every food into the `Fonte` enum (Rótulo confirmado |
 * TACO/fonte confiável | Estimativa | Pendente). 3.0 kept free text in `Referência` and
 * `Qualidade da referência`; Foods.source() maps that text (see SOURCE_RULES) so the 3.0
 * catalogue works unchanged, and a 4.0 catalogue may simply type the enum value in
 * `Qualidade da referência`.
 */
const Foods = {
  MACROS: ['kcal', 'protein', 'carbs', 'fat', 'fiber'],
  MACRO_LABELS: { kcal: 'kcal', protein: 'proteína', carbs: 'carboidrato', fat: 'gordura', fiber: 'fibra' },

  SOURCE: {
    LABEL: 'Rótulo confirmado',
    TRUSTED: 'TACO/fonte confiável',
    ESTIMATE: 'Estimativa',
    PENDING: 'Pendente',
  },

  /**
   * Ordered rules over the normalized text "quality · reference · name" (lower case, no accents).
   * The first match wins; an exact enum value in `Qualidade da referência` wins before them.
   */
  SOURCE_RULES: [
    { re: /\bpendente\b/, source: 'Pendente' },
    { re: /estimativ|estimad|a conferir|conferir rotulo|nao confirmad/, source: 'Estimativa' },
    { re: /rotulo (confirmado|conferido|verificado)|conforme rotulo|do rotulo/, source: 'Rótulo confirmado' },
    { re: /\btaco\b|\btbca\b|\busda\b|fonte confiavel|tabela brasileira/, source: 'TACO/fonte confiável' },
  ],

  VALID_OK: 'OK',

  key_(name) {
    return Tabs.normalize_(name);
  },

  fold_(text) {
    return String(text === null || text === undefined ? '' : text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  },

  isNum_(v) {
    return typeof v === 'number' && isFinite(v);
  },

  /** Every food row (objects keyed by column key, with _row), in sheet order. */
  all() {
    return Tabs.read('foods').filter((f) => f.name !== null && String(f.name).trim() !== '');
  },

  /** Food names for validation lists. */
  names() {
    return Foods.all().map((f) => String(f.name).trim());
  },

  /** The food named `name` (case/spacing-insensitive), or null. */
  find(name) {
    const k = Foods.key_(name);
    if (!k) return null;
    return Foods.all().find((f) => Foods.key_(f.name) === k) || null;
  },

  /** Like find, but throws a Portuguese message. */
  get(name) {
    if (!Foods.key_(name)) throw new Error('Informe o alimento.');
    const f = Foods.find(name);
    if (!f) throw new Error(`Alimento "${String(name).trim()}" não está cadastrado em Alimentos. Cadastre-o ou use Lançar sem cálculo.`);
    return f;
  },

  /**
   * Problems of a catalogue row, as short Portuguese texts ([] when valid).
   * @returns {string[]}
   */
  problems(food) {
    const out = [];
    if (!food || !Foods.key_(food.name)) return ['Sem nome'];
    const fam = Units.family(food.baseUnit);
    if (!fam) out.push('Unidade-base deve ser g ou ml');
    else if (Units.normalize(food.baseUnit) !== 'g' && Units.normalize(food.baseUnit) !== 'ml') out.push('Unidade-base deve ser g ou ml');
    if (!Foods.isNum_(food.baseQty) || food.baseQty <= 0) out.push('Base deve ser > 0');
    const missing = Foods.MACROS.filter((k) => !Foods.isNum_(food[k]));
    if (missing.length) out.push(`Rever macros (${missing.map((k) => Foods.MACRO_LABELS[k]).join(', ')})`);
    else if (Foods.MACROS.some((k) => food[k] < 0)) out.push('Macros negativos');
    const hasUnit = Foods.key_(food.householdUnit) !== '';
    const hasPer = food.perHousehold !== null && food.perHousehold !== undefined && food.perHousehold !== '';
    if (hasUnit !== hasPer) out.push('Medida caseira incompleta (preencha medida e base por medida)');
    else if (hasPer && !(Foods.isNum_(food.perHousehold) && food.perHousehold > 0)) out.push('Base por medida deve ser > 0');
    else if (hasUnit && Units.family(food.householdUnit)) out.push('Medida caseira não pode ser g/ml');
    return out;
  },

  isValid(food) {
    return Foods.problems(food).length === 0;
  },

  /** 'OK' or the problems joined, as written in `Cadastro válido`. */
  validity(food) {
    const p = Foods.problems(food);
    return p.length ? p.join('; ') : Foods.VALID_OK;
  },

  /**
   * Maps the 3.0 free text (or a 4.0 enum value) to the Fonte enum.
   * @returns {string} one of Tabs.ENUMS.FOOD_SOURCE
   */
  source(food) {
    const quality = food ? String(food.quality === null || food.quality === undefined ? '' : food.quality).trim() : '';
    if (Tabs.ENUMS.FOOD_SOURCE.indexOf(quality) >= 0) return quality;
    const text = [quality, food && food.reference, food && food.name].map(Foods.fold_).join(' · ');
    for (let i = 0; i < Foods.SOURCE_RULES.length; i++) {
      if (Foods.SOURCE_RULES[i].re.test(text)) return Foods.SOURCE_RULES[i].source;
    }
    return Foods.SOURCE.PENDING;
  },

  /** True when the source makes a calculated value an estimate. */
  isEstimatedSource(source) {
    return source === Foods.SOURCE.ESTIMATE || source === Foods.SOURCE.PENDING;
  },

  /**
   * Macros for a quantity already in the food's base unit, rounded to 2 decimals.
   * @returns {{kcal, protein, carbs, fat, fiber}}
   * @throws when the food is not valid
   */
  macros(food, baseQty) {
    const p = Foods.problems(food);
    if (p.length) {
      throw new Error(`Cadastro de "${food && food.name}" incompleto em Alimentos: ${p.join('; ')}. Corrija o cadastro ou use Lançar sem cálculo.`);
    }
    const ratio = baseQty / food.baseQty;
    const out = {};
    Foods.MACROS.forEach((k) => { out[k] = Units.round(food[k] * ratio, 2); });
    return out;
  },

  /**
   * Converts and computes in one step.
   * @returns {{qty, unit, estimated, household, input, converted, macros, source}}
   */
  portion(food, qty, unit) {
    const conv = Units.convert(qty, unit, food);
    return Object.assign(conv, { macros: Foods.macros(food, conv.qty), source: Foods.source(food) });
  },

  /**
   * Writes `Cadastro válido` for every food (replaces the 3.0 formula with values).
   * @returns {{checked: number, invalid: {row: number, name: string, problems: string[]}[]}}
   */
  writeValidity() {
    const invalid = [];
    const rows = Foods.all();
    const hasColumn = !!Tabs.headerMap('foods').valid;
    rows.forEach((f) => {
      const v = Foods.validity(f);
      if (v !== Foods.VALID_OK) invalid.push({ row: f._row, name: f.name, problems: Foods.problems(f) });
      if (hasColumn) Tabs.update('foods', f._row, { valid: v }); // unchanged values are skipped
    });
    return { checked: rows.length, invalid };
  },
};
