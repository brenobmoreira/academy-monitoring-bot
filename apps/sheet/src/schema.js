/**
 * Field vocabulary shared by the API, the validator and the sheet menu, and how diary fields map
 * to sheet columns. Columns are matched by HEADER TEXT, never by position, so the sheet owner can
 * reorder or add columns without touching code.
 */
const Schema = {
  DATE_HEADER: 'Data',

  /** diary field -> header and accepted values; the validator enforces type and bounds exactly */
  DIARY_FIELDS: {
    weightKg:     { header: 'Peso kg',        type: 'number',  min: 20, max: 400 },
    sleepH:       { header: 'Sono h',         type: 'number',  min: 0,  max: 24 },
    steps:        { header: 'Passos',         type: 'integer', min: 0,  max: 200000 },
    cardioMin:    { header: 'Cardio min',     type: 'number',  min: 0,  max: 1440 },
    muayThai:     { header: 'Muay Thai',      type: 'boolean' },
    dietComplete: { header: 'Dieta completa', type: 'boolean' },
    waistCm:      { header: 'Cintura cm',     type: 'number',  min: 30, max: 300 },
    hunger:       { header: 'Fome 1–5',       type: 'integer', min: 1,  max: 5 },
    fatigue:      { header: 'Cansaço 1–5',    type: 'integer', min: 1,  max: 5 },
    notes:        { header: 'Observações',    type: 'text',    maxLength: 500 },
  },

  /** Values the sheet expects in yes/no cells (data validation lists). */
  YES: 'Sim',
  NO: 'Não',

  PHASES: ['Adaptação', 'Regular'],
  DEFAULT_PHASE: 'Regular',
  /** Used only when "Ficha de treino" lists no session. */
  DEFAULT_SESSIONS: ['Upper', 'Lower', 'Full Body'],

  MAX_SETS: 4,
  MAX_EXERCISES: 20,
  /** Longest period diary.range and workout.range read, in days (about a quarter). */
  MAX_RANGE_DAYS: 92,

  toCell(field, value) {
    return Schema.DIARY_FIELDS[field].type === 'boolean' ? (value ? Schema.YES : Schema.NO) : value;
  },

  /**
   * Inverse of toCell for reads: Sim/Não (or a checkbox) -> boolean, text trimmed. Empty cells and
   * yes/no cells holding anything else give undefined, so the field is left out. A hand-typed
   * value that is not a number stays as it is, so the reader still sees it.
   */
  fromCell(field, cell) {
    if (cell === '' || cell === null || cell === undefined) return undefined;
    const type = Schema.DIARY_FIELDS[field].type;
    if (type === 'boolean') {
      if (typeof cell === 'boolean') return cell;
      const word = String(cell).trim();
      return word === Schema.YES ? true : word === Schema.NO ? false : undefined;
    }
    if (type === 'text' || typeof cell === 'string') return String(cell).trim() || undefined;
    return cell;
  },
};
