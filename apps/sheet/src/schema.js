/**
 * The Entry object both adapters (chat, sheet menu) produce, and how its diary part maps to
 * sheet columns. Columns are matched by HEADER TEXT, never by position, so the sheet owner can
 * reorder or add columns without touching code.
 *
 * Entry = {
 *   date: Date,                       // local midnight
 *   diary?:   { <field>: value, ... } // fields below
 *   workout?: { session, phase?, exercises: [{ name, sets: [{kg, reps}], rir?, pain?, note?, equipment? }] }
 * }
 */
const Schema = {
  DATE_HEADER: 'Data',

  /** diary field -> { header, type } ; type drives validation and cell formatting */
  DIARY_FIELDS: {
    weightKg:     { header: 'Peso kg',        type: 'number' },
    sleepH:       { header: 'Sono h',         type: 'number' },
    steps:        { header: 'Passos',         type: 'number' },
    cardioMin:    { header: 'Cardio min',     type: 'number' },
    muayThai:     { header: 'Muay Thai',      type: 'yesno'  },
    dietComplete: { header: 'Dieta completa', type: 'yesno'  },
    waistCm:      { header: 'Cintura cm',     type: 'number' },
    hunger:       { header: 'Fome 1–5',       type: 'scale5' },
    fatigue:      { header: 'Cansaço 1–5',    type: 'scale5' },
    notes:        { header: 'Observações',    type: 'text'   },
  },

  /** Values the sheet expects in yes/no cells (data validation lists). */
  YES: 'Sim',
  NO: 'Não',

  MAX_SETS: 4,

  toCell(field, value) {
    const type = Schema.DIARY_FIELDS[field].type;
    if (type === 'yesno') return value ? Schema.YES : Schema.NO;
    return value;
  },

  /** Drops unknown fields and coerces types; throws on out-of-range values. */
  normalizeDiary(diary) {
    const out = {};
    Object.keys(Schema.DIARY_FIELDS).forEach((field) => {
      const value = diary[field];
      if (value === undefined || value === null || value === '') return;
      const type = Schema.DIARY_FIELDS[field].type;
      if (type === 'text') { out[field] = String(value); return; }
      if (type === 'yesno') { out[field] = Schema.toBoolean_(value); return; }
      const n = Schema.toNumber_(value);
      if (n === null) throw new Error(`${field}: not a number (${value})`);
      if (type === 'scale5' && (n < 1 || n > 5)) throw new Error(`${field}: must be 1-5 (${n})`);
      if (n < 0) throw new Error(`${field}: must be positive (${n})`);
      out[field] = n;
    });
    return out;
  },

  toNumber_(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const n = Number(String(value).trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  },

  toBoolean_(value) {
    if (typeof value === 'boolean') return value;
    const s = String(value).trim().toLowerCase();
    return ['sim', 's', 'yes', 'y', 'true', '1'].includes(s);
  },
};
