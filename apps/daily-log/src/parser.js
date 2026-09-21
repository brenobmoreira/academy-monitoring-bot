/**
 * Turns free text into a partial entry: `date` plus any subset of Schema.FIELDS.
 * Fields not found are left undefined so the upsert preserves what is already stored.
 *
 * F0: only `date` and `notes` (the raw text). F1 adds regex extraction; F3 an LLM fallback.
 */
const Parser = {
  /** @returns {{date: Date, notes?: string, weightKg?: number, sleepH?: number, ...}} */
  parse(text) {
    return {
      date: Parser.today_(),
      notes: text,
    };
  },

  /** Local midnight so the cell holds a pure date, matching rows typed by hand. */
  today_() {
    const tz = Session.getScriptTimeZone();
    const ymd = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
    return new Date(`${ymd}T00:00:00`);
  },
};
