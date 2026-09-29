/**
 * The day's own measures on Diário (spec §3.3, §4.5) and the day state.
 *
 * Diary.save(date, fields) writes the measures typed on Hoje through Days.patch (which stamps the
 * objective, goal and plan in force on that date). Unknown is not zero:
 *   - a key that is absent or `undefined` is left untouched (an empty Hoje cell never erases);
 *   - `null` clears the cell (não informado) — Hoje produces it only from the explicit clear
 *     convention (Hoje.CLEAR_TOKENS: "-" or "limpar");
 *   - 0 is kept as zero.
 *
 * Diary.dayState(date) derives Estado do dia from the food declaration and the Diário totals:
 *   Registro alimentar = Completo → "Completo", or "Completo — cálculo parcial" when Itens sem
 *     cálculo > 0;
 *   Registro alimentar = Parcial → "Parcial";
 *   otherwise (Não informado / empty) → "Parcial" when food was logged (kcal or items without
 *     calculation present), else "Sem registro".
 * Food writes its totals through Days.patch and then calls Diary.refreshState(date).
 *
 * Listeners (Core.on): 'transition.prepare' fills the new objective's Peso inicial kg (average of
 * the weigh-ins of the 7 days ending the day before the start; else the latest weigh-in on or before
 * the start) and Cintura inicial cm (latest waist on or before the start, Diário or Medidas) unless
 * the caller gave them. 'phase.changed' re-stamps the ids of Diário and Medidas rows dated on or
 * after the change (days saved before a transition that starts on or before them).
 * Emits 'day.saved' ({date, row, fields}) after Diary.save, inside the running action.
 */
const Diary = {
  /**
   * Measures a person types for a day: key → {label, type, min?, max?, enum?}. Keys are Diário
   * column keys; labels are the Hoje labels (Portuguese).
   */
  FIELDS: {
    weightKg: { label: 'Peso kg', type: 'number', min: 20, max: 400 },
    waistCm: { label: 'Cintura cm', type: 'number', min: 30, max: 250 },
    sleepH: { label: 'Sono h', type: 'number', min: 0, max: 24 },
    steps: { label: 'Passos', type: 'integer', min: 0, max: 200000 },
    cardioMin: { label: 'Cardio min', type: 'number', min: 0, max: 1440 },
    activityMin: { label: 'Atividade min', type: 'number', min: 0, max: 1440 },
    activity: { label: 'Atividade', type: 'text' },
    hunger: { label: 'Fome 1–5', type: 'integer', min: 1, max: 5 },
    fatigue: { label: 'Cansaço 1–5', type: 'integer', min: 1, max: 5 },
    pain: { label: 'Dor 0–10', type: 'integer', min: 0, max: 10 },
    foodLog: { label: 'Registro alimentar', type: 'enum', enum: Tabs.ENUMS.FOOD_LOG },
    notes: { label: 'Observações', type: 'text' },
  },

  STATES: {
    NONE: Tabs.ENUMS.DAY_STATE[0],
    PARTIAL: Tabs.ENUMS.DAY_STATE[1],
    COMPLETE: Tabs.ENUMS.DAY_STATE[2],
    COMPLETE_PARTIAL_CALC: Tabs.ENUMS.DAY_STATE[3],
  },

  FOOD_LOG: { NONE: Tabs.ENUMS.FOOD_LOG[0], PARTIAL: Tabs.ENUMS.FOOD_LOG[1], COMPLETE: Tabs.ENUMS.FOOD_LOG[2] },

  isNum_(v) {
    return typeof v === 'number' && isFinite(v);
  },

  /** Diário rows (empty when the tab does not exist yet). */
  rows() {
    return Tabs.findSheet('diary') ? Tabs.read('diary') : [];
  },

  /**
   * Validates and converts one field value. undefined stays undefined (untouched), null/'' becomes
   * null (clear), numbers accept "67,5". Throws a Portuguese message naming the field.
   */
  coerce(key, value) {
    const f = Diary.FIELDS[key];
    if (!f) throw new Error(`Campo do dia desconhecido: ${key}`);
    if (value === undefined) return undefined;
    if (value === null || (typeof value === 'string' && value.trim() === '')) return null;
    if (f.type === 'text') return String(value).trim();
    if (f.type === 'enum') {
      const s = String(value).trim();
      if (f.enum.indexOf(s) < 0) throw new Error(`${f.label}: use ${f.enum.join(', ')}.`);
      return s;
    }
    let n = value;
    if (typeof n === 'string') n = Number(n.trim().replace(',', '.'));
    if (!Diary.isNum_(n)) throw new Error(`${f.label}: valor inválido (${JSON.stringify(value)}).`);
    if (f.type === 'integer' && Math.round(n) !== n) throw new Error(`${f.label}: use um número inteiro.`);
    if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) {
      throw new Error(`${f.label}: ${n} fora da faixa ${f.min}–${f.max}.`);
    }
    return n;
  },

  /**
   * Saves the measures of `date` (see the file header for absent / null / 0), then refreshes the
   * day state. Dates after today are refused.
   * @param {*} date
   * @param {Object} fields subset of Diary.FIELDS keys
   * @returns {{row: number|null, changed: string[], dayState: string}}
   */
  save(date, fields) {
    const day = Dates.require(date, 'Data');
    if (Dates.compare(day, Dates.today()) > 0) throw new Error(`Data no futuro: ${Dates.format(day)}.`);
    const patch = {};
    Object.keys(fields || {}).forEach((k) => {
      const v = Diary.coerce(k, fields[k]);
      if (v !== undefined) patch[k] = v;
    });
    const existing = Days.get(day);
    const keys = Object.keys(patch).filter((k) => (existing ? !Tabs.sameCell(existing[k], patch[k]) : patch[k] !== null));
    let row = existing ? existing._row : null;
    if (keys.length) {
      const out = {};
      keys.forEach((k) => { out[k] = patch[k]; });
      row = Days.patch(day, out);
    }
    const dayState = Diary.refreshState(day);
    Core.emit('day.saved', { date: day, row, fields: patch });
    return { row, changed: keys, dayState };
  },

  /** Measures of the date as {key: value|null} (all FIELDS keys), or null when no row. */
  load(date) {
    const row = Days.get(date);
    if (!row) return null;
    const out = {};
    Object.keys(Diary.FIELDS).forEach((k) => { out[k] = row[k]; });
    return out;
  },

  /**
   * Estado do dia (see the file header).
   * @param {*} dateOrRow a date or a Diário row object
   * @returns {string} one of Tabs.ENUMS.DAY_STATE
   */
  dayState(dateOrRow) {
    if (dateOrRow === null || dateOrRow === undefined) return Diary.STATES.NONE;
    const row = dateOrRow._row !== undefined ? dateOrRow : Days.get(dateOrRow);
    if (!row) return Diary.STATES.NONE;
    const noCalc = Diary.isNum_(row.noCalcItems) ? row.noCalcItems : 0;
    if (row.foodLog === Diary.FOOD_LOG.COMPLETE) return noCalc > 0 ? Diary.STATES.COMPLETE_PARTIAL_CALC : Diary.STATES.COMPLETE;
    if (row.foodLog === Diary.FOOD_LOG.PARTIAL) return Diary.STATES.PARTIAL;
    const logged = Diary.isNum_(row.kcal) || noCalc > 0 || (Diary.isNum_(row.estimatedItems) && row.estimatedItems > 0);
    return logged ? Diary.STATES.PARTIAL : Diary.STATES.NONE;
  },

  /**
   * Recomputes and writes Estado do dia on the day's row (no row is created for "Sem registro").
   * @returns {string} the state
   */
  refreshState(date) {
    const row = Days.get(date);
    const state = Diary.dayState(row);
    if (row && row.dayState !== state) Days.patch(date, { dayState: state });
    return state;
  },

  /** Rewrites Estado do dia on every row where it is stale. @returns {number} rows changed */
  refreshAllStates() {
    let n = 0;
    Diary.rows().forEach((r) => {
      if (!r.date) return;
      const state = Diary.dayState(r);
      if (r.dayState !== state) { Days.patch(r.date, { dayState: state }); n++; }
    });
    return n;
  },

  /** Weigh-ins [{date, weightKg}] in [from, to] (inclusive), by date. */
  weighIns(from, to) {
    return Diary.rows()
      .filter((r) => r.date && Diary.isNum_(r.weightKg) && Dates.within(r.date, from, to))
      .map((r) => ({ date: r.date, weightKg: r.weightKg }))
      .sort((a, b) => Dates.compare(a.date, b.date));
  },

  /** Latest weigh-in on or before `date`: {date, weightKg} or null. */
  latestWeight(date) {
    const list = Diary.weighIns(null, date);
    return list.length ? list[list.length - 1] : null;
  },

  /**
   * Initial weight of a phase starting on `start`: average of the weigh-ins of the
   * `analysis.weightTrendDays` days ending the day before (2 decimals); else the latest weigh-in on
   * or before the start; else null.
   */
  baselineWeight(start) {
    const s = Dates.require(start, 'Início');
    const days = Config.get('analysis.weightTrendDays') || 7;
    const end = Dates.addDays(s, -1);
    const list = Diary.weighIns(Dates.addDays(end, -(days - 1)), end);
    if (list.length) return Math.round(list.reduce((sum, w) => sum + w.weightKg, 0) / list.length * 100) / 100;
    const last = Diary.latestWeight(s);
    return last ? last.weightKg : null;
  },

  /** 'transition.prepare' listener: fills initial weight and waist of the new objective. */
  onTransitionPrepare_(t) {
    if (!t || !t.objective || !t.date) return;
    const o = t.objective;
    if (o.startWeightKg === undefined || o.startWeightKg === null) {
      const w = Diary.baselineWeight(t.date);
      if (w !== null) o.startWeightKg = w;
    }
    if (o.startWaistCm === undefined || o.startWaistCm === null) {
      const waist = Measures.latestWaist(t.date);
      if (waist) o.startWaistCm = waist.waistCm;
    }
  },

  /** 'phase.changed' listener: re-stamps ids of rows dated on or after the change. */
  onPhaseChanged_(e) {
    if (!e || !e.date) return;
    Diary.rows().forEach((r) => {
      if (!r.date || Dates.compare(r.date, e.date) < 0) return;
      const ids = Days.idsOn(r.date);
      if (ids.objective !== r.objective || ids.goal !== r.goal || ids.plan !== r.plan) Tabs.update('diary', r._row, ids);
    });
    Measures.restampFrom(e.date);
  },
};

Core.on('transition.prepare', (t) => Diary.onTransitionPrepare_(t));
Core.on('phase.changed', (e) => Diary.onPhaseChanged_(e));
