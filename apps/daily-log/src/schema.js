/**
 * Maps entry fields to sheet columns by HEADER TEXT, never by position, so the sheet
 * owner can reorder or add columns without touching code.
 *
 * Only these columns are ever written. Everything else in the row (targets, kcal,
 * "Treinos", 7-day averages, adherence) is formula-driven and must be preserved.
 */
const Schema = {
  DATE_HEADER: 'Data',

  /** field -> { header, type } ; type drives parsing/validation and cell formatting */
  FIELDS: {
    weightKg:     { header: 'Peso kg',       type: 'number' },
    sleepH:       { header: 'Sono h',        type: 'number' },
    steps:        { header: 'Passos',        type: 'number' },
    cardioMin:    { header: 'Cardio min',    type: 'number' },
    muayThai:     { header: 'Muay Thai',     type: 'yesno'  },
    dietComplete: { header: 'Dieta completa', type: 'yesno' },
    waistCm:      { header: 'Cintura cm',    type: 'number' },
    hunger:       { header: 'Fome 1–5',      type: 'scale5' },
    fatigue:      { header: 'Cansaço 1–5',   type: 'scale5' },
    notes:        { header: 'Observações',   type: 'text'   },
  },

  /** Values the sheet expects in yes/no cells (data validation lists). */
  YES: 'Sim',
  NO: 'Não',

  toCell(field, value) {
    const type = Schema.FIELDS[field].type;
    if (type === 'yesno') return value ? Schema.YES : Schema.NO;
    return value;
  },
};
