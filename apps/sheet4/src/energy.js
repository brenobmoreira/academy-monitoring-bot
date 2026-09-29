/**
 * Energy numbers (spec §4.3). Four distinct quantities, always shown with their labels:
 * TMB (basal, equation) · gasto estimado (TMB × activity factor, an estimate) · meta da fase
 * (chosen by a person, stored in the goal) · dieta base (planned) · ingestão realizada (logged).
 * Missing inputs give null, never a guessed number.
 */
const Energy = {
  /** BMR equations by Config `energy.bmrMethod`. */
  METHODS: {
    mifflin: {
      label: 'Mifflin-St Jeor',
      /** 10·kg + 6.25·cm − 5·age + 5 (M) / − 161 (F). */
      bmr: ({ sex, weightKg, heightCm, age }) => 10 * weightKg + 6.25 * heightCm - 5 * age + (sex === 'F' ? -161 : 5),
    },
  },

  isNum_(v) {
    return typeof v === 'number' && isFinite(v);
  },

  /**
   * @param {{sex: 'M'|'F', weightKg: number, heightCm: number, age: number, method?: string}} p
   * @returns {number|null}
   */
  bmr(p) {
    const method = Energy.METHODS[(p && p.method) || 'mifflin'];
    if (!method) throw new Error(`Método de TMB desconhecido: ${p.method}`);
    if (!p || (p.sex !== 'M' && p.sex !== 'F')) return null;
    if (![p.weightKg, p.heightCm, p.age].every(Energy.isNum_)) return null;
    return Energy.round_(method.bmr(p), 2);
  },

  /** Estimated expenditure: BMR × activity factor. */
  tdee(bmr, factor) {
    if (!Energy.isNum_(bmr) || !Energy.isNum_(factor)) return null;
    return Energy.round_(bmr * factor, 2);
  },

  /** Carbohydrate grams left after protein and fat: (kcal − 4·P − 9·G) / 4. */
  carbs(kcal, proteinG, fatG) {
    if (![kcal, proteinG, fatG].every(Energy.isNum_)) return null;
    return Energy.round_((kcal - 4 * proteinG - 9 * fatG) / 4, 2);
  },

  /** kcal of given macros (4/4/9). */
  kcalOf(proteinG, carbsG, fatG) {
    if (![proteinG, carbsG, fatG].every(Energy.isNum_)) return null;
    return Energy.round_(4 * proteinG + 4 * carbsG + 9 * fatG, 2);
  },

  /** Protein grams per kg of body weight. */
  proteinPerKg(proteinG, weightKg) {
    if (!Energy.isNum_(proteinG) || !Energy.isNum_(weightKg) || weightKg <= 0) return null;
    return Energy.round_(proteinG / weightKg, 2);
  },

  /**
   * BMR and estimated expenditure from Config (sex, age on `date`, height, method, factor) and a
   * weight (opts.weightKg, else client.startWeightKg). `missing` lists the Config labels absent.
   * @returns {{bmr, method, methodLabel, activityFactor, tdee, weightKg, age, missing: string[]}}
   */
  fromConfig(opts) {
    const o = opts || {};
    const method = Config.get('energy.bmrMethod');
    const p = {
      method,
      sex: Config.get('client.sex'),
      heightCm: Config.get('client.heightCm'),
      age: Config.ageOn(o.date || Dates.today()),
      weightKg: Energy.isNum_(o.weightKg) ? o.weightKg : Config.get('client.startWeightKg'),
    };
    const factor = Config.get('energy.activityFactor');
    const missing = [];
    if (!p.sex) missing.push(Config.DEFAULTS['client.sex'].label);
    if (!Energy.isNum_(p.age)) missing.push(Config.DEFAULTS['client.age'].label);
    if (!Energy.isNum_(p.heightCm)) missing.push(Config.DEFAULTS['client.heightCm'].label);
    if (!Energy.isNum_(p.weightKg)) missing.push(Config.DEFAULTS['client.startWeightKg'].label);
    const bmr = Energy.bmr(p);
    return {
      bmr, method, methodLabel: Energy.METHODS[method].label, activityFactor: factor,
      tdee: Energy.tdee(bmr, factor), weightKg: p.weightKg, age: p.age, missing,
    };
  },

  /**
   * Labelled values for display, in the spec's order. Each: {key, label, value, unit, kind}
   * with kind 'estimado' | 'meta' | 'planejado' | 'realizado'.
   * @param {{bmr?, tdee?, methodLabel?, goalKcal?, baseDietKcal?, intakeKcal?}} v
   */
  labelled(v) {
    return [
      { key: 'bmr', label: `TMB (${v.methodLabel || Energy.METHODS.mifflin.label})`, value: Energy.orNull_(v.bmr), unit: 'kcal', kind: 'estimado' },
      { key: 'tdee', label: 'Gasto estimado', value: Energy.orNull_(v.tdee), unit: 'kcal', kind: 'estimado' },
      { key: 'goal', label: 'Meta da fase', value: Energy.orNull_(v.goalKcal), unit: 'kcal', kind: 'meta' },
      { key: 'baseDiet', label: 'Dieta base (planejada)', value: Energy.orNull_(v.baseDietKcal), unit: 'kcal', kind: 'planejado' },
      { key: 'intake', label: 'Ingestão realizada', value: Energy.orNull_(v.intakeKcal), unit: 'kcal', kind: 'realizado' },
    ];
  },

  orNull_(v) {
    return Energy.isNum_(v) ? v : null;
  },

  round_(v, digits) {
    const f = Math.pow(10, digits);
    return Math.round(v * f) / f;
  },
};
