/**
 * Pure local dates (midnight in the script time zone) and their yyyy-MM-dd keys.
 *
 * Every date the code handles goes through Dates.parse, which turns a cell value (Date, key,
 * "dd/mm/yyyy" text) into local midnight or null. A date before MIN_KEY (3.0 used 01/01/1900 as a
 * "technical" start) is treated as missing: parse returns null, key returns ''. Weeks start on
 * Monday.
 */
const Dates = {
  /** Anything earlier is a technical placeholder, never a real date (spec §4.4). */
  MIN_KEY: '2000-01-01',
  DISPLAY_FORMAT: 'dd/MM/yyyy',

  tz() {
    return Session.getScriptTimeZone();
  },

  /** Local midnight for y, m (1–12), d; day overflow rolls over like Date does. */
  make(y, m, d) {
    return new Date(y, m - 1, d);
  },

  /** True for a Date object holding a valid time. */
  isDate(v) {
    return v instanceof Date && !isNaN(v.getTime());
  },

  /** A real Date before 2000-01-01 (the 3.0 "vigência técnica"). */
  isTechnical(v) {
    return Dates.isDate(v) && Dates.rawKey_(v) < Dates.MIN_KEY;
  },

  /**
   * Cell value → local-midnight Date, or null when empty, unparseable or technical.
   * Accepts a Date (time dropped), 'yyyy-MM-dd' and 'dd/mm/yyyy' (also d/m/yyyy).
   * @returns {Date|null}
   */
  parse(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) {
      if (!Dates.isDate(v) || Dates.isTechnical(v)) return null;
      return Dates.fromKey(Dates.rawKey_(v));
    }
    if (typeof v !== 'string') return null;
    const s = v.trim();
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    let y; let mo; let d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
      if (!m) return null;
      d = +m[1]; mo = +m[2]; y = +m[3];
    }
    const date = Dates.make(y, mo, d);
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
    return Dates.isTechnical(date) ? null : date;
  },

  /** Like parse, but throws a Portuguese message for missing/invalid input. */
  require(v, label) {
    const d = Dates.parse(v);
    if (!d) throw new Error(`${label || 'Data'} inválida ou ausente: ${JSON.stringify(v instanceof Date ? Dates.rawKey_(v) : v)}`);
    return d;
  },

  /** 'yyyy-MM-dd' of any date-like value; '' when missing or technical. */
  key(v) {
    const d = Dates.parse(v);
    return d ? Dates.rawKey_(d) : '';
  },

  /** Local midnight of a yyyy-MM-dd key. */
  fromKey(k) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(k));
    if (!m) throw new Error(`Chave de data inválida: ${k}`);
    return Dates.make(+m[1], +m[2], +m[3]);
  },

  /** 'dd/MM/yyyy' for display; '' when missing. */
  format(v) {
    const d = Dates.parse(v);
    return d ? Utilities.formatDate(d, Dates.tz(), Dates.DISPLAY_FORMAT) : '';
  },

  today() {
    return Dates.fromKey(Dates.todayKey());
  },

  todayKey() {
    return Dates.rawKey_(new Date());
  },

  addDays(v, n) {
    const d = Dates.require(v);
    return Dates.make(d.getFullYear(), d.getMonth() + 1, d.getDate() + n);
  },

  /** Whole days from a to b (b − a), DST-safe. */
  diffDays(a, b) {
    const da = Dates.require(a);
    const db = Dates.require(b);
    return Math.round((Date.UTC(db.getFullYear(), db.getMonth(), db.getDate()) - Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())) / 86400000);
  },

  /** Monday of the week containing v. */
  weekStart(v) {
    const d = Dates.require(v);
    const offset = (d.getDay() + 6) % 7; // Monday = 0
    return Dates.addDays(d, -offset);
  },

  /** Sunday of the week containing v. */
  weekEnd(v) {
    return Dates.addDays(Dates.weekStart(v), 6);
  },

  /** -1, 0, 1 comparing by day; missing dates sort first. */
  compare(a, b) {
    const ka = Dates.key(a);
    const kb = Dates.key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  },

  sameDay(a, b) {
    const ka = Dates.key(a);
    return ka !== '' && ka === Dates.key(b);
  },

  /** True when from ≤ d ≤ to; a missing `to` is open-ended. */
  within(d, from, to) {
    const k = Dates.key(d);
    if (!k) return false;
    const kf = Dates.key(from);
    const kt = Dates.key(to);
    return (!kf || kf <= k) && (!kt || k <= kt);
  },

  /** Whole years between birth and on (defaults to today). */
  age(birth, on) {
    const b = Dates.require(birth, 'Data de nascimento');
    const d = on ? Dates.require(on) : Dates.today();
    let years = d.getFullYear() - b.getFullYear();
    if (d.getMonth() < b.getMonth() || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate())) years--;
    return years;
  },

  rawKey_(d) {
    return Utilities.formatDate(d, Dates.tz(), 'yyyy-MM-dd');
  },
};
