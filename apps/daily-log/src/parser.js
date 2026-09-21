/**
 * Turns free text into a partial log entry. Fields not found are left undefined so the
 * upsert preserves whatever was already stored for the day.
 *
 * F0: returns only the raw text. F1 adds the regex extraction; F3 adds an LLM fallback.
 */
const Parser = {
  /** @returns {{date: string, raw: string, weightKg?: number, sleepH?: number, load?: number, trained?: boolean}} */
  parse(text) {
    return {
      date: Parser.today_(),
      raw: text,
    };
  },

  today_() {
    return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  },
};
