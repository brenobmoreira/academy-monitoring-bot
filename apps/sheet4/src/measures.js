/**
 * Medidas e fotos (spec §3.3): one row per measurement date — waist, other circumferences, photo
 * links, conditions — stamped with the objective in force on that date (never the current one).
 *
 * Waist has two sources: Diário (`Cintura cm`, typed on Hoje) and Medidas (`Cintura umbigo cm`).
 * For a given day the Diário value wins; Medidas counts as that day's waist when Diário has none.
 * The weekly engine uses waistOn / latestWaist / waistSeries.
 *
 * Rows typed directly on the tab get their Objetivo from stampRow (called by onEditInstalled) or
 * restampAll (Recalcular). Absent keys are untouched, null clears, 0 is refused for measures
 * (a circumference of 0 is a typing error, not a value).
 */
const Measures = {
  /** Input fields: key → {label, type, min?, max?}. */
  FIELDS: {
    waistCm: { label: 'Cintura umbigo cm', type: 'number', min: 30, max: 250 },
    hipCm: { label: 'Quadril cm', type: 'number', min: 30, max: 250 },
    chestCm: { label: 'Peito cm', type: 'number', min: 30, max: 250 },
    armCm: { label: 'Braço direito cm', type: 'number', min: 10, max: 100 },
    thighCm: { label: 'Coxa direita cm', type: 'number', min: 20, max: 150 },
    photoFront: { label: 'Frente: link', type: 'text' },
    photoSide: { label: 'Lado: link', type: 'text' },
    photoBack: { label: 'Costas: link', type: 'text' },
    notes: { label: 'Condições / observações', type: 'text' },
  },

  SOURCES: { DIARY: 'Diário', MEASURES: 'Medidas' },

  isNum_(v) {
    return typeof v === 'number' && isFinite(v);
  },

  /** Rows with a valid date, ordered by date ([] when the tab does not exist). */
  list() {
    if (!Tabs.findSheet('measures')) return [];
    return Tabs.read('measures').filter((r) => r.date).sort((a, b) => Dates.compare(a.date, b.date));
  },

  /** The row of `date`, or null. */
  on(date) {
    const k = Dates.key(date);
    return k ? Measures.list().find((r) => Dates.key(r.date) === k) || null : null;
  },

  coerce(key, value) {
    const f = Measures.FIELDS[key];
    if (!f) throw new Error(`Campo de medidas desconhecido: ${key}`);
    if (value === undefined) return undefined;
    if (value === null || (typeof value === 'string' && value.trim() === '')) return null;
    if (f.type === 'text') return String(value).trim();
    const n = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : value;
    if (!Measures.isNum_(n)) throw new Error(`${f.label}: valor inválido (${JSON.stringify(value)}).`);
    if (n < f.min || n > f.max) throw new Error(`${f.label}: ${n} fora da faixa ${f.min}–${f.max}.`);
    return n;
  },

  /**
   * Creates or updates the row of `date` and stamps its objective.
   * @returns {number} the sheet row
   */
  save(date, fields) {
    const day = Dates.require(date, 'Data');
    if (Dates.compare(day, Dates.today()) > 0) throw new Error(`Data no futuro: ${Dates.format(day)}.`);
    const patch = {};
    Object.keys(fields || {}).forEach((k) => {
      const v = Measures.coerce(k, fields[k]);
      if (v !== undefined) patch[k] = v;
    });
    patch.objective = Measures.objectiveOn_(day);
    const row = Measures.on(day);
    if (row) return Tabs.update('measures', row._row, patch);
    return Tabs.append('measures', Object.assign({ date: day }, patch));
  },

  objectiveOn_(date) {
    const o = Objectives.on(date);
    return o ? o.id : null;
  },

  /** Stamps the objective of one sheet row (after a direct edit). @returns {boolean} changed */
  stampRow(row) {
    if (!Tabs.findSheet('measures') || row < Tabs.get('measures').firstDataRow) return false;
    const r = Tabs.readRow('measures', row);
    const id = r.date ? Measures.objectiveOn_(r.date) : null;
    if (!r.date || id === r.objective) return false;
    Tabs.update('measures', row, { objective: id });
    return true;
  },

  /** Re-stamps rows dated on or after `from` (all rows when from is null). @returns {number} */
  restampFrom(from) {
    let n = 0;
    Measures.list().forEach((r) => {
      if (from && Dates.compare(r.date, from) < 0) return;
      const id = Measures.objectiveOn_(r.date);
      if (id !== r.objective) { Tabs.update('measures', r._row, { objective: id }); n++; }
    });
    return n;
  },

  restampAll() {
    return Measures.restampFrom(null);
  },

  /**
   * Waist per day in [from, to] (either bound may be null): [{date, waistCm, source}], one entry
   * per day, Diário preferred over Medidas, ordered by date.
   */
  waistSeries(from, to) {
    const byDay = {};
    Measures.list().forEach((r) => {
      if (Measures.isNum_(r.waistCm) && Dates.within(r.date, from, to)) {
        byDay[Dates.key(r.date)] = { date: r.date, waistCm: r.waistCm, source: Measures.SOURCES.MEASURES };
      }
    });
    Diary.rows().forEach((r) => {
      if (r.date && Measures.isNum_(r.waistCm) && Dates.within(r.date, from, to)) {
        byDay[Dates.key(r.date)] = { date: r.date, waistCm: r.waistCm, source: Measures.SOURCES.DIARY };
      }
    });
    return Object.keys(byDay).sort().map((k) => byDay[k]);
  },

  /** The day's waist (Diário first, else Medidas), or null. */
  waistOn(date) {
    const d = Dates.parse(date);
    if (!d) return null;
    const hit = Measures.waistSeries(d, d)[0];
    return hit ? hit.waistCm : null;
  },

  /** Latest waist on or before `date` (any date when null): {date, waistCm, source} or null. */
  latestWaist(beforeOrOn) {
    const list = Measures.waistSeries(null, beforeOrOn || null);
    return list.length ? list[list.length - 1] : null;
  },
};
