/**
 * In-memory Apps Script services for the sheet 4.0 tests (fakes v2).
 *
 * Explicit methods only: an unsupported call throws "x is not a function" so gaps are visible.
 * Methods ending in `_` are test helpers that do not exist in Apps Script.
 *
 * createContext(options) -> VM global object. Options:
 *   sheets: [{name, rows}]      simple sheets (strings starting with "=" become formulas)
 *   fixture: json               JSON produced by tools/xlsx_to_fixture.py (see loadFixture)
 *   useCachedValues: bool       formula cells return the exported cached value ($value)
 *   now: Date|string|number     fixed clock: `new Date()` / `Date.now()` return it (ctx.__clock moves it)
 *   timeZone ('America/Sao_Paulo'), locale ('pt_BR'), userEmail ('owner@example.com')
 *   properties / userProperties / documentProperties: initial PropertiesService values
 *   uiResponses: [...]          scripted answers for ui.alert ('YES'|'NO'|'OK'|'CANCEL'|'CLOSE')
 *                               and ui.prompt ({button, text} or a string = text with OK)
 *   htmlFiles: {name: html}     for HtmlService.create*FromFile
 *   fetchResponses: [{code, body} | Error]  for UrlFetchApp
 *
 * SpreadsheetApp: getActive, getActiveSpreadsheet, getActiveSheet, getActiveRange, setActiveSheet,
 *   setActiveRange, getUi, flush, newDataValidation, newConditionalFormatRule; enums
 *   DataValidationCriteria, BooleanCriteria, ProtectionType, BorderStyle, WrapStrategy, Dimension,
 *   SheetType.
 * Spreadsheet: getId, getName, rename, getUrl, getSpreadsheetTimeZone/set, getSpreadsheetLocale/set,
 *   getSheets, getNumSheets, getSheetByName, getSheetById, insertSheet(name?, index?) (also
 *   insertSheet(index)), deleteSheet, getActiveSheet, setActiveSheet, moveActiveSheet(pos1),
 *   getActiveRange, setActiveRange, getActiveCell, getRange("'Tab'!A1:B2"), getRangeList,
 *   getRangeByName, setNamedRange, getNamedRanges, removeNamedRange, getProtections(type), toast.
 * Sheet: getName, setName (rewrites 'Old'! in formulas like Sheets), getSheetId, getIndex, getParent,
 *   getType, activate, getRange(A1 | "A:A" | "5:5" | "A6:C" | row, col, rows?, cols?), getRangeList,
 *   getDataRange, getSheetValues, getLastRow, getLastColumn, getMaxRows, getMaxColumns, appendRow,
 *   insertRows/insertRowsBefore/insertRowsAfter/insertRowBefore/insertRowAfter, deleteRow(s),
 *   insertColumns/insertColumnsBefore/insertColumnsAfter/insertColumnBefore/insertColumnAfter,
 *   deleteColumn(s), clear, clearContents, clearFormats, clearNotes, setFrozenRows/Columns,
 *   getFrozenRows/Columns, setColumnWidth(s), getColumnWidth, setRowHeight(s), getRowHeight,
 *   hideSheet, showSheet, isSheetHidden, setTabColor, getTabColor, setHiddenGridlines,
 *   hasHiddenGridlines, hideColumns/showColumns/hideColumn/unhideColumn/isColumnHiddenByUser,
 *   hideRows/showRows/hideRow/unhideRow/isRowHiddenByUser, getColumnGroupDepth, getRowGroupDepth,
 *   protect, getProtections, getConditionalFormatRules, setConditionalFormatRules,
 *   clearConditionalFormatRules, newChart, insertChart, updateChart, removeChart, getCharts,
 *   getNamedRanges, getFilter, setActiveRange, setActiveSelection, getActiveRange, getCurrentCell,
 *   copyTo(spreadsheet).
 * Range: getRow, getColumn, getNumRows, getNumColumns, getHeight, getWidth, getLastRow,
 *   getLastColumn, getA1Notation, getSheet, getCell, offset, activate, isBlank, getValue(s),
 *   setValue(s), getDisplayValue(s), getFormula(s), setFormula(s), getFormulaR1C1/getFormulasR1C1,
 *   setFormulaR1C1/setFormulasR1C1, clear({contentsOnly, formatOnly, validationsOnly,
 *   commentsOnly}), clearContent, clearFormat, clearNote, clearDataValidations, merge, mergeAcross,
 *   mergeVertically, breakApart, isPartOfMerge, getMergedRanges, background/fontColor/fontWeight/
 *   fontStyle/fontSize/fontFamily/horizontalAlignment/verticalAlignment/numberFormat/wrap setters and
 *   getters (singular and plural), setFontLine/getFontLine, setWrapStrategy/getWrapStrategy,
 *   setBorder(top, left, bottom, right, vertical, horizontal, color?, style?), getBorders_,
 *   setNote(s)/getNote(s), setDataValidation(s)/getDataValidation(s), insertCheckboxes,
 *   removeCheckboxes, isChecked, protect, copyTo(range, {contentsOnly, formatOnly}), sort,
 *   createFilter, shiftRowGroupDepth, shiftColumnGroupDepth, setComputedValue(s)_ (test only).
 * Builders: newDataValidation (requireValueInList, requireValueInRange, requireNumberBetween/
 *   NotBetween/EqualTo/NotEqualTo/GreaterThan/GreaterThanOrEqualTo/LessThan/LessThanOrEqualTo,
 *   requireCheckbox, requireDate, requireDateAfter/Before/OnOrAfter/OnOrBefore/Between/EqualTo,
 *   requireFormulaSatisfied, requireTextContains, requireTextIsEmail, requireTextIsUrl,
 *   withCriteria, setAllowInvalid, setHelpText, build); newConditionalFormatRule (when* for formula,
 *   empty/not empty, numbers, text, dates; setBackground, setFontColor, setBold, setItalic,
 *   setStrikethrough, setUnderline, setRanges, build); sheet.newChart() (setChartType, as*Chart,
 *   addRange, removeRange, clearRanges, setPosition, setOption, setTitle, setXAxisTitle,
 *   setYAxisTitle, setColors, setLegendPosition, setDimensions, setNumHeaders, setMergeStrategy,
 *   setTransposeRowsAndColumns, setHiddenDimensionStrategy, getChartType, getRanges, build).
 * Charts: Charts.ChartType, Position, CurveStyle, PointStyle, ChartMergeStrategy,
 *   ChartHiddenDimensionStrategy.
 * Ui: createMenu/createAddonMenu -> addItem, addSeparator, addSubMenu, addToUi; alert, prompt,
 *   showModalDialog, showModelessDialog, showSidebar; ui.Button, ui.ButtonSet.
 * HtmlService: createHtmlOutput, createHtmlOutputFromFile, createTemplate, createTemplateFromFile
 *   (evaluate supports <?= ?>, <?!= ?> and <? ?>), SandboxMode, XFrameOptionsMode.
 * ScriptApp: newTrigger(fn).timeBased()...create(), .forSpreadsheet(ss).onEdit/onOpen/onChange/
 *   onFormSubmit().create(); getProjectTriggers, getUserTriggers, deleteTrigger, getScriptId,
 *   EventType, TriggerSource, WeekDay, AuthMode.
 * PropertiesService (script/user/document), LockService (records waitLock/tryLock/releaseLock in
 *   ctx.__locks; ctx.__lockBusy = true makes them fail), CacheService (expires on the fake clock),
 *   Utilities (formatDate, parseDate, newBlob, getUuid (deterministic), sleep (advances a fixed
 *   clock), base64Encode/Decode), Session, Logger, console, UrlFetchApp, ContentService.
 *
 * Recorders on ctx: __spreadsheet, __menus (FakeMenu: name, items), __alerts, __prompts, __dialogs, __toasts, __triggers,
 *   __locks, __logs, __properties, __fetchCalls, __sentMessages, __clock {set, advance, get},
 *   __uiResponses (queue), __formulaEvaluator (fn(formula, sheet, row, col) -> value),
 *   __simulateEdit(sheetName, a1, value), __fireTrigger(handler).
 *
 * loadFixture(ctx, json, {useCachedValues}) replaces the active spreadsheet with the fixture;
 * snapshot(ctxOrSpreadsheet) returns the same JSON shape (without `source`).
 *
 * Compatibility with the first core tests (see "core additions" at the end): sheet.rows (read-only
 * 2D values, formulas as text) and spreadsheet.sheets (Map name -> sheet); toasts are recorded as
 * {msg, title, seconds}.
 *
 * Not modelled: formula evaluation (formula cells read '' unless a computed value is set),
 * automatic string -> number parsing of setValue, relative formula adjustment on copy/insert.
 */
'use strict';

const HostDate = Date;

// ---------------------------------------------------------------- A1 / rect helpers

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function indexToCol(n) {
  let s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function a1Of(rect, absolute = false) {
  const d = absolute ? '$' : '';
  const start = `${d}${indexToCol(rect.c1)}${d}${rect.r1}`;
  if (rect.r1 === rect.r2 && rect.c1 === rect.c2) return start;
  return `${start}:${d}${indexToCol(rect.c2)}${d}${rect.r2}`;
}

/** Parses A1 notation without a sheet name. maxRows/maxCols resolve "A:A", "5:5" and "A6:A". */
function parseA1(a1, maxRows = 1000, maxCols = 26) {
  const s = String(a1).replace(/\$/g, '').trim();
  let m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/i.exec(s);
  if (m) {
    const r1 = Number(m[2]); const c1 = colToIndex(m[1]);
    if (!m[3]) return { r1, c1, r2: r1, c2: c1 };
    return norm({ r1, c1, r2: m[4] ? Number(m[4]) : maxRows, c2: colToIndex(m[3]) });
  }
  m = /^([A-Z]+):([A-Z]+)$/i.exec(s);
  if (m) return norm({ r1: 1, c1: colToIndex(m[1]), r2: maxRows, c2: colToIndex(m[2]) });
  m = /^(\d+):(\d+)$/.exec(s);
  if (m) return norm({ r1: Number(m[1]), c1: 1, r2: Number(m[2]), c2: maxCols });
  throw new Error(`Range not found: ${a1}`);
}

function norm(r) {
  return { r1: Math.min(r.r1, r.r2), c1: Math.min(r.c1, r.c2), r2: Math.max(r.r1, r.r2), c2: Math.max(r.c1, r.c2) };
}

function quoteSheet(name) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

/** "'Tab'!A1:B2" -> {sheetName, a1}; sheetName null when absent. */
function splitRef(ref) {
  const m = /^(?:'((?:[^']|'')+)'|([^!']+))!(.+)$/.exec(String(ref));
  if (!m) return { sheetName: null, a1: String(ref) };
  return { sheetName: m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2], a1: m[3] };
}

function intersects(a, b) {
  return a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
}

function contains(outer, inner) {
  return outer.r1 <= inner.r1 && outer.c1 <= inner.c1 && outer.r2 >= inner.r2 && outer.c2 >= inner.c2;
}

/**
 * Canonical rectangle cover of cells: row runs, then vertical merge of identical column spans.
 * Must stay identical to cells_to_ranges() in tools/sheetjson.py.
 */
function rectsFromCells(cells) {
  const byRow = new Map();
  for (const [r, c] of cells) { if (!byRow.has(r)) byRow.set(r, []); byRow.get(r).push(c); }
  let open = new Map();
  const done = [];
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  for (const r of rows) {
    const cols = [...new Set(byRow.get(r))].sort((a, b) => a - b);
    const runs = [];
    let start = cols[0]; let prev = cols[0];
    for (const c of cols.slice(1)) {
      if (c === prev + 1) { prev = c; continue; }
      runs.push([start, prev]); start = prev = c;
    }
    runs.push([start, prev]);
    const next = new Map();
    for (const run of runs) {
      const key = `${run[0]}:${run[1]}`;
      let rect = open.get(key);
      open.delete(key);
      if (rect && rect.r2 === r - 1) rect.r2 = r;
      else {
        if (rect) done.push(rect);
        rect = { r1: r, r2: r, c1: run[0], c2: run[1] };
      }
      next.set(key, rect);
    }
    for (const rect of open.values()) done.push(rect);
    open = next;
  }
  for (const rect of open.values()) done.push(rect);
  done.sort((a, b) => a.r1 - b.r1 || a.c1 - b.c1 || a.r2 - b.r2 || a.c2 - b.c2);
  return done;
}

/** Shifts a rect for an insert (delta > 0, new lines start at `at`) or delete (delta < 0). */
function shiftRect(rect, dim, at, delta) {
  const [lo, hi] = dim === 'row' ? ['r1', 'r2'] : ['c1', 'c2'];
  const r = { ...rect };
  if (delta > 0) {
    if (r[lo] >= at) r[lo] += delta;
    if (r[hi] >= at) r[hi] += delta;
    return r;
  }
  const n = -delta; const end = at + n - 1;
  const shift = (v) => (v > end ? v - n : v);
  if (r[lo] >= at && r[hi] <= end) return null;
  const newLo = r[lo] >= at && r[lo] <= end ? at : shift(r[lo]);
  const newHi = r[hi] >= at && r[hi] <= end ? at - 1 : shift(r[hi]);
  r[lo] = newLo; r[hi] = newHi;
  return r[hi] < r[lo] ? null : r;
}

function shiftIndexMap(map, at, delta) {
  const out = new Map();
  for (const [k, v] of map) {
    if (delta < 0 && k >= at && k < at - delta) continue;
    out.set(k >= at ? k + delta : k, v);
  }
  return out;
}

// ---------------------------------------------------------------- values, colours, dates

const NAMED_COLORS = {
  white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', gray: '#808080', grey: '#808080', orange: '#ffa500', purple: '#800080',
};

function normColor(c) {
  if (c === null || c === undefined || c === '') return null;
  let s = String(c).trim().toLowerCase();
  if (NAMED_COLORS[s]) return NAMED_COLORS[s];
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  if (!/^#[0-9a-f]{6}$/.test(s)) throw new Error(`Invalid color: ${c}`);
  return s;
}

const dtfCache = new Map();
function tzParts(ms, tz) {
  if (!dtfCache.has(tz)) {
    dtfCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      second: '2-digit', weekday: 'short', hourCycle: 'h23', era: 'short',
    }));
  }
  const p = {};
  for (const part of dtfCache.get(tz).formatToParts(new HostDate(ms))) p[part.type] = part.value;
  let y = Number(p.year);
  if (p.era === 'BC') y = 1 - y;
  return { y, M: Number(p.month), d: Number(p.day), H: Number(p.hour) % 24, m: Number(p.minute), s: Number(p.second), wd: p.weekday };
}

function utcFromParts(y, M, d, H, m, s) {
  const dt = new HostDate(Date.UTC(2000, M - 1, d, H, m, s));
  dt.setUTCFullYear(y);
  return dt.getTime();
}

function tzOffset(ms, tz) {
  const whole = Math.floor(ms / 1000) * 1000;
  const p = tzParts(whole, tz);
  return utcFromParts(p.y, p.M, p.d, p.H, p.m, p.s) - whole;
}

/** Wall-clock time in `tz` -> epoch ms. */
function zonedToMs(y, M, d, H, m, s, tz) {
  const guess = utcFromParts(y, M, d, H, m, s);
  const off1 = tzOffset(guess, tz);
  let t = guess - off1;
  const off2 = tzOffset(t, tz);
  if (off2 !== off1) t = guess - off2;
  return t;
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Java SimpleDateFormat subset used by Utilities.formatDate. */
function formatDate(date, tz, pattern) {
  const p = tzParts(new HostDate(date).getTime(), tz);
  return pattern.replace(/'([^']*)'|y+|M+|d+|H+|h+|m+|s+|E+|a|S+|Z|X+/g, (tok, lit) => {
    if (lit !== undefined) return lit === '' ? "'" : lit;
    const n = tok.length;
    switch (tok[0]) {
      case 'y': return n === 2 ? pad(p.y % 100) : pad(p.y, n);
      case 'M': return n >= 4 ? MONTHS[p.M - 1] : n === 3 ? MONTHS[p.M - 1].slice(0, 3) : pad(p.M, n);
      case 'd': return pad(p.d, n);
      case 'H': return pad(p.H, n);
      case 'h': return pad(p.H % 12 || 12, n);
      case 'm': return pad(p.m, n);
      case 's': return pad(p.s, n);
      case 'E': return n >= 4 ? { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' }[p.wd] : p.wd;
      case 'a': return p.H < 12 ? 'AM' : 'PM';
      case 'S': return pad(new HostDate(date).getMilliseconds(), n);
      default: {
        const off = Math.round(tzOffset(new HostDate(date).getTime(), tz) / 60000);
        const sign = off < 0 ? '-' : '+';
        const hhmm = `${pad(Math.floor(Math.abs(off) / 60))}${tok[0] === 'X' && n >= 3 ? ':' : ''}${pad(Math.abs(off) % 60)}`;
        return tok[0] === 'X' && off === 0 ? 'Z' : sign + hhmm;
      }
    }
  });
}

/** Utilities.parseDate subset: yyyy, yy, MM, dd, HH, mm, ss and literals. */
function parseDate(text, tz, pattern) {
  const fields = [];
  const re = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/yyyy|yy|MM|M|dd|d|HH|H|mm|m|ss|s/g, (tok) => {
    fields.push(tok[0]);
    return tok.length === 4 ? '(\\d{4})' : '(\\d{1,2})';
  });
  const m = new RegExp(`^${re}$`).exec(String(text).trim());
  if (!m) throw new Error(`Unparseable date: "${text}"`);
  const v = { y: 1970, M: 1, d: 1, H: 0, m: 0, s: 0 };
  fields.forEach((f, i) => { v[f] = Number(m[i + 1]); });
  if (v.y < 100) v.y += 2000;
  return new HostDate(zonedToMs(v.y, v.M, v.d, v.H, v.m, v.s, tz));
}

function formatNumber(n, fmt, locale) {
  const dec = /^pt|^es|^fr|^de|^it/.test(locale) ? ',' : '.';
  const group = dec === ',' ? '.' : ',';
  const auto = (x) => String(Math.round(x * 1e10) / 1e10).replace('.', dec);
  if (!fmt || fmt === 'General' || fmt === '@') return auto(n);
  const sections = fmt.split(';');
  let section = sections[0];
  let value = n;
  if (n < 0 && sections[1]) { section = sections[1]; value = -n; }
  const lits = [];
  section = section.replace(/"([^"]*)"|\\(.)/g, (_, q, e) => { lits.push(q !== undefined ? q : e); return `\u0000${lits.length - 1}\u0000`; });
  const numMatch = /[#0,]*[0#](?:\.[0#]+)?%?/.exec(section);
  if (!numMatch) return auto(n);
  const token = numMatch[0];
  const pct = token.endsWith('%');
  const decimals = (token.split('.')[1] || '').replace('%', '').length;
  const grouped = token.split('.')[0].includes(',');
  let body = Math.abs(pct ? value * 100 : value).toFixed(decimals);
  let [intPart, frac] = body.split('.');
  if (grouped) intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  body = (value < 0 ? '-' : '') + intPart + (frac ? dec + frac : '') + (pct ? '%' : '');
  const out = section.slice(0, numMatch.index) + body + section.slice(numMatch.index + token.length);
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => lits[Number(i)]);
}

/** Sheets date formats (dd/mm/yyyy, mm-dd-yy, dd/MM/yyyy HH:mm...). "mm" next to h/s is minutes. */
function formatSheetsDate(date, fmt, tz) {
  const p = tzParts(date.getTime(), tz);
  const tokens = fmt.match(/"[^"]*"|yyyy|yy|mmmm|mmm|mm|m|dd|d|hh|h|ss|s|am\/pm|[^"ymdhs]+|./gi) || [];
  const out = [];
  tokens.forEach((tok, i) => {
    const t = tok.toLowerCase();
    const prev = tokens.slice(0, i).reverse().find((x) => /^[ymdhs]/i.test(x));
    const next = tokens.slice(i + 1).find((x) => /^[ymdhs]/i.test(x));
    const minutes = /^m{1,2}$/.test(t) && ((prev && /^h/i.test(prev)) || (next && /^s/i.test(next)));
    if (tok.startsWith('"')) out.push(tok.slice(1, -1));
    else if (t === 'yyyy') out.push(pad(p.y, 4));
    else if (t === 'yy') out.push(pad(p.y % 100));
    else if (t === 'mmmm') out.push(MONTHS[p.M - 1]);
    else if (t === 'mmm') out.push(MONTHS[p.M - 1].slice(0, 3));
    else if (minutes) out.push(t === 'mm' ? pad(p.m) : String(p.m));
    else if (t === 'mm') out.push(pad(p.M));
    else if (t === 'm') out.push(String(p.M));
    else if (t === 'dd') out.push(pad(p.d));
    else if (t === 'd') out.push(String(p.d));
    else if (t === 'hh') out.push(pad(p.H));
    else if (t === 'h') out.push(String(p.H));
    else if (t === 'ss') out.push(pad(p.s));
    else if (t === 's') out.push(String(p.s));
    else if (t === 'am/pm') out.push(p.H < 12 ? 'AM' : 'PM');
    else out.push(tok);
  });
  return out.join('');
}

const isDateFormat = (fmt) => !!fmt && /[dy]|h+:m/i.test(fmt.replace(/"[^"]*"/g, ''));

function isDate(v) { return v instanceof HostDate; }

function copyValue(v) {
  if (isDate(v)) return new HostDate(v.getTime());
  if (v === null || v === undefined) return '';
  return v;
}

function isEmpty(v) { return v === '' || v === null || v === undefined; }

/** Canonical JSON (sorted keys) for grouping. */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

// ---------------------------------------------------------------- R1C1 conversion

function mapOutsideStrings(formula, fn) {
  return formula.split(/("(?:[^"]|"")*")/).map((part, i) => (i % 2 ? part : fn(part))).join('');
}

function r1c1ToA1(formula, row, col) {
  return mapOutsideStrings(formula, (s) => s.replace(/(?<![A-Za-z0-9_.$])R(\[-?\d+\]|\d+)?C(\[-?\d+\]|\d+)?(?![A-Za-z0-9_(])/g, (_, R, C) => {
    const part = (spec, base) => {
      if (spec === undefined) return { n: base, abs: false };
      if (spec.startsWith('[')) return { n: base + Number(spec.slice(1, -1)), abs: false };
      return { n: Number(spec), abs: true };
    };
    const r = part(R, row); const c = part(C, col);
    return `${c.abs ? '$' : ''}${indexToCol(c.n)}${r.abs ? '$' : ''}${r.n}`;
  }));
}

function a1ToR1c1(formula, row, col) {
  return mapOutsideStrings(formula, (s) => s.replace(/(?<![A-Za-z0-9_.])(\$?)([A-Z]{1,3})(\$?)(\d+)(?![A-Za-z0-9_(])/g, (_, ca, letters, ra, digits) => {
    const c = colToIndex(letters); const r = Number(digits);
    const rp = ra ? `R${r}` : (r === row ? 'R' : `R[${r - row}]`);
    const cp = ca ? `C${c}` : (c === col ? 'C' : `C[${c - col}]`);
    return rp + cp;
  }));
}

function renameInFormula(formula, oldName, newName) {
  const esc = oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quotedOld = oldName.replace(/'/g, "''").replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return mapOutsideStrings(formula, (s) => s
    .replace(new RegExp(`'${quotedOld}'!`, 'g'), `${quoteSheet(newName)}!`)
    .replace(new RegExp(`(?<![A-Za-z0-9_'.])${esc}!`, 'g'), `${quoteSheet(newName)}!`));
}

// ---------------------------------------------------------------- formats

const FORMAT_PROPS = [
  ['background', 'Background', 'Backgrounds', '#ffffff', normColor],
  ['fontColor', 'FontColor', 'FontColors', '#000000', normColor],
  ['fontWeight', 'FontWeight', 'FontWeights', 'normal', (v) => v],
  ['fontStyle', 'FontStyle', 'FontStyles', 'normal', (v) => v],
  ['fontSize', 'FontSize', 'FontSizes', 10, (v) => (v === null ? null : Number(v))],
  ['fontFamily', 'FontFamily', 'FontFamilies', 'Arial', (v) => v],
  ['horizontalAlignment', 'HorizontalAlignment', 'HorizontalAlignments', 'general', (v) => (v === 'normal' || v === 'general' ? null : v)],
  ['verticalAlignment', 'VerticalAlignment', 'VerticalAlignments', 'bottom', (v) => v],
  ['numberFormat', 'NumberFormat', 'NumberFormats', 'General', (v) => v],
  ['wrap', 'Wrap', 'Wraps', false, (v) => (v === null ? null : Boolean(v))],
];

const BORDER_STYLE = { DOTTED: 'DOTTED', DASHED: 'DASHED', SOLID: 'SOLID', SOLID_MEDIUM: 'SOLID_MEDIUM', SOLID_THICK: 'SOLID_THICK', DOUBLE: 'DOUBLE' };

function setFmt(cell, key, value, def) {
  if (value === null || value === undefined || value === def) {
    if (cell.fmt) { delete cell.fmt[key]; if (!Object.keys(cell.fmt).length) cell.fmt = null; }
    return;
  }
  cell.fmt = cell.fmt || {};
  cell.fmt[key] = value;
}

// ---------------------------------------------------------------- data validation

const DV_CRITERIA = [
  'CHECKBOX', 'CUSTOM_FORMULA', 'DATE_AFTER', 'DATE_BEFORE', 'DATE_BETWEEN', 'DATE_EQUAL_TO',
  'DATE_IS_VALID_DATE', 'DATE_NOT_BETWEEN', 'DATE_ON_OR_AFTER', 'DATE_ON_OR_BEFORE', 'NUMBER_BETWEEN',
  'NUMBER_EQUAL_TO', 'NUMBER_GREATER_THAN', 'NUMBER_GREATER_THAN_OR_EQUAL_TO', 'NUMBER_LESS_THAN',
  'NUMBER_LESS_THAN_OR_EQUAL_TO', 'NUMBER_NOT_BETWEEN', 'NUMBER_NOT_EQUAL_TO', 'TEXT_CONTAINS',
  'TEXT_DOES_NOT_CONTAIN', 'TEXT_EQUAL_TO', 'TEXT_IS_VALID_EMAIL', 'TEXT_IS_VALID_URL', 'VALUE_IN_LIST',
  'VALUE_IN_RANGE',
];
const enumOf = (names) => Object.freeze(Object.fromEntries(names.map((n) => [n, n])));

/** Internal rule: {criteria, values, allowInvalid, helpText, showDropdown}. VALUE_IN_RANGE value is {sheet, rect} or a string. */
class FakeDataValidation {
  constructor(rule) { this.rule_ = Object.freeze({ ...rule, values: Object.freeze([...rule.values]) }); }
  getCriteriaType() { return this.rule_.criteria; }
  getCriteriaValues() {
    const { criteria, values, showDropdown } = this.rule_;
    if (criteria === 'VALUE_IN_LIST') return [[...values], showDropdown !== false];
    if (criteria === 'VALUE_IN_RANGE') {
      const v = values[0];
      return [v && v.sheet ? new FakeRange(v.sheet, v.rect) : v, showDropdown !== false];
    }
    return values.map(copyValue);
  }
  getAllowInvalid() { return this.rule_.allowInvalid; }
  getHelpText() { return this.rule_.helpText || ''; }
  copy() { return new FakeDataValidationBuilder({ ...this.rule_, values: [...this.rule_.values] }); }
}

class FakeDataValidationBuilder {
  constructor(rule) { this.rule_ = rule || { criteria: null, values: [], allowInvalid: true }; }
  crit_(criteria, values) { this.rule_.criteria = criteria; this.rule_.values = values; return this; }
  requireValueInList(values, showDropdown = true) {
    this.rule_.showDropdown = showDropdown === false ? false : undefined;
    return this.crit_('VALUE_IN_LIST', values.map(copyValue));
  }
  requireValueInRange(range, showDropdown = true) {
    this.rule_.showDropdown = showDropdown === false ? false : undefined;
    return this.crit_('VALUE_IN_RANGE', [{ sheet: range.sheet_, rect: { ...range.rect_ } }]);
  }
  requireNumberBetween(a, b) { return this.crit_('NUMBER_BETWEEN', [a, b]); }
  requireNumberNotBetween(a, b) { return this.crit_('NUMBER_NOT_BETWEEN', [a, b]); }
  requireNumberEqualTo(a) { return this.crit_('NUMBER_EQUAL_TO', [a]); }
  requireNumberNotEqualTo(a) { return this.crit_('NUMBER_NOT_EQUAL_TO', [a]); }
  requireNumberGreaterThan(a) { return this.crit_('NUMBER_GREATER_THAN', [a]); }
  requireNumberGreaterThanOrEqualTo(a) { return this.crit_('NUMBER_GREATER_THAN_OR_EQUAL_TO', [a]); }
  requireNumberLessThan(a) { return this.crit_('NUMBER_LESS_THAN', [a]); }
  requireNumberLessThanOrEqualTo(a) { return this.crit_('NUMBER_LESS_THAN_OR_EQUAL_TO', [a]); }
  requireCheckbox(checked, unchecked) {
    const values = checked === undefined ? [] : unchecked === undefined ? [checked] : [checked, unchecked];
    return this.crit_('CHECKBOX', values);
  }
  requireDate() { return this.crit_('DATE_IS_VALID_DATE', []); }
  requireDateAfter(d) { return this.crit_('DATE_AFTER', [copyValue(d)]); }
  requireDateBefore(d) { return this.crit_('DATE_BEFORE', [copyValue(d)]); }
  requireDateOnOrAfter(d) { return this.crit_('DATE_ON_OR_AFTER', [copyValue(d)]); }
  requireDateOnOrBefore(d) { return this.crit_('DATE_ON_OR_BEFORE', [copyValue(d)]); }
  requireDateEqualTo(d) { return this.crit_('DATE_EQUAL_TO', [copyValue(d)]); }
  requireDateBetween(a, b) { return this.crit_('DATE_BETWEEN', [copyValue(a), copyValue(b)]); }
  requireDateNotBetween(a, b) { return this.crit_('DATE_NOT_BETWEEN', [copyValue(a), copyValue(b)]); }
  requireFormulaSatisfied(f) { return this.crit_('CUSTOM_FORMULA', [f]); }
  requireTextContains(t) { return this.crit_('TEXT_CONTAINS', [t]); }
  requireTextDoesNotContain(t) { return this.crit_('TEXT_DOES_NOT_CONTAIN', [t]); }
  requireTextEqualTo(t) { return this.crit_('TEXT_EQUAL_TO', [t]); }
  requireTextIsEmail() { return this.crit_('TEXT_IS_VALID_EMAIL', []); }
  requireTextIsUrl() { return this.crit_('TEXT_IS_VALID_URL', []); }
  withCriteria(criteria, args) {
    if (!DV_CRITERIA.includes(criteria)) throw new Error(`Unknown criteria ${criteria}`);
    if (criteria === 'VALUE_IN_LIST') return this.requireValueInList(args[0], args[1]);
    if (criteria === 'VALUE_IN_RANGE') return this.requireValueInRange(args[0], args[1]);
    return this.crit_(criteria, [...args]);
  }
  setAllowInvalid(b) { this.rule_.allowInvalid = !!b; return this; }
  setHelpText(t) { this.rule_.helpText = t || undefined; return this; }
  getCriteriaType() { return this.rule_.criteria; }
  getAllowInvalid() { return this.rule_.allowInvalid; }
  getHelpText() { return this.rule_.helpText || ''; }
  copy() { return new FakeDataValidationBuilder({ ...this.rule_, values: [...this.rule_.values] }); }
  build() {
    if (!this.rule_.criteria) throw new Error('Data validation criteria not set');
    const rule = { criteria: this.rule_.criteria, values: this.rule_.values, allowInvalid: this.rule_.allowInvalid };
    if (this.rule_.helpText) rule.helpText = this.rule_.helpText;
    if (this.rule_.showDropdown === false) rule.showDropdown = false;
    return new FakeDataValidation(rule);
  }
}

// ---------------------------------------------------------------- conditional formats

const BOOLEAN_CRITERIA = [
  'CELL_EMPTY', 'CELL_NOT_EMPTY', 'CUSTOM_FORMULA', 'DATE_AFTER', 'DATE_BEFORE', 'DATE_EQUAL_TO',
  'NUMBER_BETWEEN', 'NUMBER_EQUAL_TO', 'NUMBER_GREATER_THAN', 'NUMBER_GREATER_THAN_OR_EQUAL_TO',
  'NUMBER_LESS_THAN', 'NUMBER_LESS_THAN_OR_EQUAL_TO', 'NUMBER_NOT_BETWEEN', 'NUMBER_NOT_EQUAL_TO',
  'TEXT_CONTAINS', 'TEXT_DOES_NOT_CONTAIN', 'TEXT_ENDS_WITH', 'TEXT_EQUAL_TO', 'TEXT_STARTS_WITH',
];

class FakeConditionalFormatRule {
  constructor(spec) { this.spec_ = spec; } // {ranges: [{sheet, rect}], condition, values, format}
  getRanges() { return this.spec_.ranges.map((r) => new FakeRange(r.sheet, r.rect)); }
  getBooleanCondition() {
    const { condition, values, format } = this.spec_;
    return {
      getCriteriaType: () => condition,
      getCriteriaValues: () => values.map(copyValue),
      getBackground: () => format.background || null,
      getFontColor: () => format.fontColor || null,
      getBold: () => format.bold || null,
      getItalic: () => format.italic || null,
      getStrikethrough: () => format.strikethrough || null,
      getUnderline: () => format.underline || null,
    };
  }
  getGradientCondition() { return null; }
  copy() { return new FakeConditionalFormatRuleBuilder(this.spec_); }
}

class FakeConditionalFormatRuleBuilder {
  constructor(spec) {
    this.spec_ = spec
      ? { ranges: spec.ranges.map((r) => ({ sheet: r.sheet, rect: { ...r.rect } })), condition: spec.condition, values: [...spec.values], format: { ...spec.format } }
      : { ranges: [], condition: null, values: [], format: {} };
  }
  when_(condition, values) { this.spec_.condition = condition; this.spec_.values = values; return this; }
  whenFormulaSatisfied(f) { return this.when_('CUSTOM_FORMULA', [f]); }
  whenCellEmpty() { return this.when_('CELL_EMPTY', []); }
  whenCellNotEmpty() { return this.when_('CELL_NOT_EMPTY', []); }
  whenNumberBetween(a, b) { return this.when_('NUMBER_BETWEEN', [a, b]); }
  whenNumberNotBetween(a, b) { return this.when_('NUMBER_NOT_BETWEEN', [a, b]); }
  whenNumberEqualTo(a) { return this.when_('NUMBER_EQUAL_TO', [a]); }
  whenNumberNotEqualTo(a) { return this.when_('NUMBER_NOT_EQUAL_TO', [a]); }
  whenNumberGreaterThan(a) { return this.when_('NUMBER_GREATER_THAN', [a]); }
  whenNumberGreaterThanOrEqualTo(a) { return this.when_('NUMBER_GREATER_THAN_OR_EQUAL_TO', [a]); }
  whenNumberLessThan(a) { return this.when_('NUMBER_LESS_THAN', [a]); }
  whenNumberLessThanOrEqualTo(a) { return this.when_('NUMBER_LESS_THAN_OR_EQUAL_TO', [a]); }
  whenTextContains(t) { return this.when_('TEXT_CONTAINS', [t]); }
  whenTextDoesNotContain(t) { return this.when_('TEXT_DOES_NOT_CONTAIN', [t]); }
  whenTextEqualTo(t) { return this.when_('TEXT_EQUAL_TO', [t]); }
  whenTextStartsWith(t) { return this.when_('TEXT_STARTS_WITH', [t]); }
  whenTextEndsWith(t) { return this.when_('TEXT_ENDS_WITH', [t]); }
  whenDateAfter(d) { return this.when_('DATE_AFTER', [copyValue(d)]); }
  whenDateBefore(d) { return this.when_('DATE_BEFORE', [copyValue(d)]); }
  whenDateEqualTo(d) { return this.when_('DATE_EQUAL_TO', [copyValue(d)]); }
  withCriteria(criteria, args) {
    if (!BOOLEAN_CRITERIA.includes(criteria)) throw new Error(`Unknown criteria ${criteria}`);
    return this.when_(criteria, [...args]);
  }
  fmt_(k, v) { if (v === null || v === undefined || v === false) delete this.spec_.format[k]; else this.spec_.format[k] = v; return this; }
  setBackground(c) { return this.fmt_('background', normColor(c)); }
  setFontColor(c) { return this.fmt_('fontColor', normColor(c)); }
  setBold(b) { return this.fmt_('bold', b ? true : null); }
  setItalic(b) { return this.fmt_('italic', b ? true : null); }
  setStrikethrough(b) { return this.fmt_('strikethrough', b ? true : null); }
  setUnderline(b) { return this.fmt_('underline', b ? true : null); }
  setRanges(ranges) { this.spec_.ranges = ranges.map((r) => ({ sheet: r.sheet_, rect: { ...r.rect_ } })); return this; }
  getRanges() { return this.spec_.ranges.map((r) => new FakeRange(r.sheet, r.rect)); }
  copy() { return new FakeConditionalFormatRuleBuilder(this.spec_); }
  build() {
    if (!this.spec_.condition) throw new Error('Conditional format condition not set');
    return new FakeConditionalFormatRule(new FakeConditionalFormatRuleBuilder(this.spec_).spec_);
  }
}

// ---------------------------------------------------------------- protections, named ranges, filters

class FakeProtection {
  constructor(sheet, type, rect) {
    Object.assign(this, { sheet_: sheet, type_: type, rect_: rect, description_: '', warningOnly_: false, editors_: [], unprotected_: [], removed_: false });
  }
  getProtectionType() { return this.type_; }
  getRange() { return this.rect_ ? new FakeRange(this.sheet_, this.rect_) : this.sheet_.getDataRange(); }
  setRange(range) { this.rect_ = { ...range.rect_ }; return this; }
  getDescription() { return this.description_; }
  setDescription(d) { this.description_ = String(d); return this; }
  isWarningOnly() { return this.warningOnly_; }
  setWarningOnly(b) { this.warningOnly_ = !!b; return this; }
  addEditor(e) { const m = typeof e === 'string' ? e : e.getEmail(); if (!this.editors_.includes(m)) this.editors_.push(m); return this; }
  addEditors(list) { list.forEach((e) => this.addEditor(e)); return this; }
  removeEditor(e) { const m = typeof e === 'string' ? e : e.getEmail(); this.editors_ = this.editors_.filter((x) => x !== m); return this; }
  removeEditors(list) { list.forEach((e) => this.removeEditor(e)); return this; }
  getEditors() { return this.editors_.map((email) => ({ getEmail: () => email })); }
  canEdit() { return true; }
  setDomainEdit(b) { this.domainEdit_ = !!b; return this; }
  canDomainEdit() { return !!this.domainEdit_; }
  setUnprotectedRanges(ranges) { this.unprotected_ = ranges.map((r) => ({ ...r.rect_ })); return this; }
  getUnprotectedRanges() { return this.unprotected_.map((r) => new FakeRange(this.sheet_, r)); }
  remove() { this.removed_ = true; this.sheet_.protections_ = this.sheet_.protections_.filter((p) => p !== this); }
}

class FakeNamedRange {
  constructor(ss, name) { this.ss_ = ss; this.name_ = name; }
  entry_() { return this.ss_.named_.get(this.name_); }
  getName() { return this.name_; }
  getRange() { const e = this.entry_(); return new FakeRange(e.sheet, e.rect); }
  setName(n) { const e = this.entry_(); this.ss_.named_.delete(this.name_); this.ss_.named_.set(n, e); this.name_ = n; return this; }
  setRange(r) { this.ss_.named_.set(this.name_, { sheet: r.sheet_, rect: { ...r.rect_ } }); return this; }
  remove() { this.ss_.named_.delete(this.name_); }
}

class FakeFilter {
  constructor(sheet) { this.sheet_ = sheet; }
  getRange() { return new FakeRange(this.sheet_, this.sheet_.filter_); }
  remove() { this.sheet_.filter_ = null; }
}

// ---------------------------------------------------------------- charts

const CHART_TYPES = ['AREA', 'BAR', 'BUBBLE', 'CANDLESTICK', 'COLUMN', 'COMBO', 'GAUGE', 'GEO', 'HISTOGRAM',
  'LINE', 'ORG', 'PIE', 'RADAR', 'SCATTER', 'SPARKLINE', 'STEPPED_AREA', 'TABLE', 'TIMELINE', 'TREEMAP', 'WATERFALL'];

class FakeChartBuilder {
  constructor(sheet, chart) {
    this.sheet_ = sheet;
    this.chartId_ = chart ? chart.id_ : null;
    this.type_ = chart ? chart.type_ : null;
    this.ranges_ = chart ? chart.ranges_.map((r) => ({ ...r })) : [];
    this.options_ = chart ? { ...chart.options_ } : {};
    this.position_ = chart ? { ...chart.position_ } : { row: 1, column: 1, offsetX: 0, offsetY: 0 };
  }
  setChartType(t) { if (!CHART_TYPES.includes(t)) throw new Error(`Unknown chart type ${t}`); this.type_ = t; return this; }
  getChartType() { return this.type_; }
  asAreaChart() { return this.setChartType('AREA'); }
  asBarChart() { return this.setChartType('BAR'); }
  asColumnChart() { return this.setChartType('COLUMN'); }
  asComboChart() { return this.setChartType('COMBO'); }
  asLineChart() { return this.setChartType('LINE'); }
  asPieChart() { return this.setChartType('PIE'); }
  asScatterChart() { return this.setChartType('SCATTER'); }
  asTableChart() { return this.setChartType('TABLE'); }
  addRange(range) { this.ranges_.push({ sheet: range.sheet_, rect: { ...range.rect_ } }); return this; }
  removeRange(range) {
    this.ranges_ = this.ranges_.filter((r) => !(r.sheet === range.sheet_ && stable(r.rect) === stable(range.rect_)));
    return this;
  }
  clearRanges() { this.ranges_ = []; return this; }
  getRanges() { return this.ranges_.map((r) => new FakeRange(r.sheet, r.rect)); }
  setPosition(row, column, offsetX, offsetY) { this.position_ = { row, column, offsetX: offsetX || 0, offsetY: offsetY || 0 }; return this; }
  setOption(k, v) { this.options_[k] = v; return this; }
  setTitle(t) { return this.setOption('title', t); }
  setXAxisTitle(t) { return this.setOption('hAxis.title', t); }
  setYAxisTitle(t) { return this.setOption('vAxis.title', t); }
  setColors(c) { return this.setOption('colors', [...c]); }
  setLegendPosition(p) { return this.setOption('legend.position', p); }
  setDimensions(w, h) { this.setOption('width', w); return this.setOption('height', h); }
  setNumHeaders(n) { return this.setOption('numHeaders', n); }
  setMergeStrategy(s) { return this.setOption('mergeStrategy', s); }
  setTransposeRowsAndColumns(b) { return this.setOption('transposeRowsAndColumns', !!b); }
  setHiddenDimensionStrategy(s) { return this.setOption('hiddenDimensionStrategy', s); }
  setCurveStyle(s) { return this.setOption('curveType', s); }
  setPointStyle(s) { return this.setOption('pointStyle', s); }
  setStacked() { return this.setOption('isStacked', true); }
  build() {
    if (!this.type_) throw new Error('Chart type not set');
    return new FakeEmbeddedChart(this.sheet_, this.chartId_, this.type_, this.ranges_, this.options_, this.position_);
  }
}

class FakeEmbeddedChart {
  constructor(sheet, id, type, ranges, options, position) {
    Object.assign(this, { sheet_: sheet, id_: id, type_: type, ranges_: ranges.map((r) => ({ ...r })), options_: { ...options }, position_: { ...position } });
  }
  getChartId() { return this.id_; }
  getId() { return this.id_ === null ? null : `u${this.id_}`; }
  getType_() { return this.type_; }
  getRanges() { return this.ranges_.map((r) => new FakeRange(r.sheet, r.rect)); }
  getOptions() { const o = { ...this.options_ }; return { get: (k) => (k in o ? o[k] : null) }; }
  getContainerInfo() {
    const p = this.position_;
    return { getAnchorRow: () => p.row, getAnchorColumn: () => p.column, getOffsetX: () => p.offsetX, getOffsetY: () => p.offsetY };
  }
  modify() { return new FakeChartBuilder(this.sheet_, this); }
  getAs() { throw new Error('getAs is not supported by the fakes'); }
}

// ---------------------------------------------------------------- Range

class FakeRange {
  constructor(sheet, rect) {
    this.sheet_ = sheet;
    this.rect_ = { ...rect };
    const { r1, c1, r2, c2 } = rect;
    if (!(r1 >= 1 && c1 >= 1)) throw new Error('The starting row and column of the range must be at least 1.');
    if (r2 > sheet.maxRows_ || c2 > sheet.maxCols_) {
      throw new Error(`The coordinates of the range are outside the dimensions of the sheet. (${sheet.name_}!${a1Of(rect)}; sheet is ${sheet.maxRows_}x${sheet.maxCols_})`);
    }
  }
  // geometry
  getRow() { return this.rect_.r1; }
  getColumn() { return this.rect_.c1; }
  getNumRows() { return this.rect_.r2 - this.rect_.r1 + 1; }
  getNumColumns() { return this.rect_.c2 - this.rect_.c1 + 1; }
  getHeight() { return this.getNumRows(); }
  getWidth() { return this.getNumColumns(); }
  getLastRow() { return this.rect_.r2; }
  getLastColumn() { return this.rect_.c2; }
  getA1Notation() { return a1Of(this.rect_); }
  getSheet() { return this.sheet_; }
  getGridId() { return this.sheet_.id_; }
  getCell(r, c) {
    if (r < 1 || c < 1 || r > this.getNumRows() || c > this.getNumColumns()) throw new Error('Cell reference out of range');
    return this.sheet_.range_(this.rect_.r1 + r - 1, this.rect_.c1 + c - 1, 1, 1);
  }
  offset(dr, dc, nr, nc) {
    return this.sheet_.range_(this.rect_.r1 + dr, this.rect_.c1 + dc, nr === undefined ? this.getNumRows() : nr, nc === undefined ? this.getNumColumns() : nc);
  }
  activate() { this.sheet_.ss_.active_ = this.sheet_; this.sheet_.ss_.activeRange_ = this; return this; }
  activateAsCurrentCell() { return this.activate(); }
  each_(fn) {
    for (let r = this.rect_.r1; r <= this.rect_.r2; r++) for (let c = this.rect_.c1; c <= this.rect_.c2; c++) fn(r, c, r - this.rect_.r1, c - this.rect_.c1);
    return this;
  }
  map_(fn) {
    const out = [];
    for (let r = this.rect_.r1; r <= this.rect_.r2; r++) {
      const line = [];
      for (let c = this.rect_.c1; c <= this.rect_.c2; c++) line.push(fn(this.sheet_.cellAt_(r, c), r, c));
      out.push(line);
    }
    return out;
  }
  checkShape_(values, what) {
    if (!Array.isArray(values) || values.length !== this.getNumRows() || values.some((l) => !Array.isArray(l) || l.length !== this.getNumColumns())) {
      const cols = Array.isArray(values) && Array.isArray(values[0]) ? values[0].length : '?';
      throw new Error(`${what}: the data has ${Array.isArray(values) ? values.length : '?'} rows x ${cols} columns but the range has ${this.getNumRows()} x ${this.getNumColumns()}.`);
    }
  }
  // values
  getValues() { return this.map_((cell, r, c) => this.sheet_.valueOf_(cell, r, c)); }
  getValue() { return this.getValues()[0][0]; }
  setValues(values) {
    this.checkShape_(values, 'setValues');
    this.each_((r, c, i, j) => this.sheet_.write_(r, c, values[i][j]));
    return this;
  }
  setValue(v) { return this.each_((r, c) => this.sheet_.write_(r, c, v)); }
  isBlank() { return this.map_((cell) => cell).every((l) => l.every((cell) => !cell || (isEmpty(cell.v) && !cell.f))); }
  getDisplayValues() { return this.map_((cell, r, c) => this.sheet_.display_(cell, r, c)); }
  getDisplayValue() { return this.getDisplayValues()[0][0]; }
  getFormulas() { return this.map_((cell) => (cell && cell.f) || ''); }
  getFormula() { return this.getFormulas()[0][0]; }
  setFormulas(formulas) {
    this.checkShape_(formulas, 'setFormulas');
    return this.each_((r, c, i, j) => this.sheet_.writeFormula_(r, c, formulas[i][j]));
  }
  setFormula(f) { return this.each_((r, c) => this.sheet_.writeFormula_(r, c, f)); }
  getFormulasR1C1() { return this.map_((cell, r, c) => (cell && cell.f ? a1ToR1c1(cell.f, r, c) : '')); }
  getFormulaR1C1() { return this.getFormulasR1C1()[0][0]; }
  setFormulasR1C1(formulas) {
    this.checkShape_(formulas, 'setFormulasR1C1');
    return this.each_((r, c, i, j) => this.sheet_.writeFormula_(r, c, formulas[i][j] ? r1c1ToA1(formulas[i][j], r, c) : ''));
  }
  setFormulaR1C1(f) { return this.each_((r, c) => this.sheet_.writeFormula_(r, c, r1c1ToA1(f, r, c))); }
  /** Test helper: the value a formula cell evaluates to (Sheets would compute it). */
  setComputedValue_(v) { return this.each_((r, c) => { this.sheet_.cellAt_(r, c, true).computed = copyValue(v); }); }
  setComputedValues_(values) {
    this.checkShape_(values, 'setComputedValues_');
    return this.each_((r, c, i, j) => { this.sheet_.cellAt_(r, c, true).computed = copyValue(values[i][j]); });
  }
  // clearing
  clear(options) {
    const o = options || {};
    const any = o.contentsOnly || o.formatOnly || o.validationsOnly || o.commentsOnly;
    if (!any || o.contentsOnly) this.clearContent();
    if (!any || o.formatOnly) this.clearFormat();
    if (o.validationsOnly) this.clearDataValidations();
    if (o.commentsOnly) this.clearNote();
    return this;
  }
  clearContent() { return this.each_((r, c) => this.sheet_.write_(r, c, '')); }
  clearFormat() { return this.each_((r, c) => { const cell = this.sheet_.cellAt_(r, c); if (cell) cell.fmt = null; }); }
  clearNote() { return this.each_((r, c) => { const cell = this.sheet_.cellAt_(r, c); if (cell) cell.note = ''; }); }
  clearDataValidations() { return this.each_((r, c) => { const cell = this.sheet_.cellAt_(r, c); if (cell) cell.dv = null; }); }
  // merges
  merge() { this.sheet_.addMerge_({ ...this.rect_ }); return this; }
  mergeAcross() { for (let r = this.rect_.r1; r <= this.rect_.r2; r++) this.sheet_.addMerge_({ ...this.rect_, r1: r, r2: r }); return this; }
  mergeVertically() { for (let c = this.rect_.c1; c <= this.rect_.c2; c++) this.sheet_.addMerge_({ ...this.rect_, c1: c, c2: c }); return this; }
  breakApart() { this.sheet_.merges_ = this.sheet_.merges_.filter((m) => !intersects(m, this.rect_)); return this; }
  isPartOfMerge() { return this.sheet_.merges_.some((m) => intersects(m, this.rect_)); }
  getMergedRanges() { return this.sheet_.merges_.filter((m) => intersects(m, this.rect_)).map((m) => new FakeRange(this.sheet_, m)); }
  // formats
  setFontLine(line) {
    return this.each_((r, c) => {
      const cell = this.sheet_.cellAt_(r, c, true);
      setFmt(cell, 'underline', line === 'underline' ? true : null);
      setFmt(cell, 'strikethrough', line === 'line-through' ? true : null);
    });
  }
  getFontLine() {
    const f = (this.sheet_.cellAt_(this.rect_.r1, this.rect_.c1) || {}).fmt || {};
    return f.underline ? 'underline' : f.strikethrough ? 'line-through' : 'none';
  }
  setWrapStrategy(s) {
    return this.each_((r, c) => {
      const cell = this.sheet_.cellAt_(r, c, true);
      setFmt(cell, 'wrap', s === 'WRAP' ? true : null, false);
      setFmt(cell, 'wrapStrategy', s === 'CLIP' ? 'CLIP' : null);
    });
  }
  getWrapStrategy() {
    const f = (this.sheet_.cellAt_(this.rect_.r1, this.rect_.c1) || {}).fmt || {};
    return f.wrap ? 'WRAP' : f.wrapStrategy || 'OVERFLOW';
  }
  setBorder(top, left, bottom, right, vertical, horizontal, color, style) {
    const spec = { style: style || 'SOLID', color: normColor(color) || '#000000' };
    const { r1, c1, r2, c2 } = this.rect_;
    const apply = (cell, side, flag) => {
      if (flag === null || flag === undefined) return;
      const borders = { ...((cell.fmt && cell.fmt.borders) || {}) };
      if (flag) borders[side] = { ...spec }; else delete borders[side];
      setFmt(cell, 'borders', Object.keys(borders).length ? borders : null);
    };
    return this.each_((r, c) => {
      const cell = this.sheet_.cellAt_(r, c, true);
      apply(cell, 'top', r === r1 ? top : horizontal);
      apply(cell, 'bottom', r === r2 ? bottom : horizontal);
      apply(cell, 'left', c === c1 ? left : vertical);
      apply(cell, 'right', c === c2 ? right : vertical);
    });
  }
  getBorders_() { return this.map_((cell) => ({ ...((cell && cell.fmt && cell.fmt.borders) || {}) })); }
  // notes
  setNote(n) { return this.each_((r, c) => { this.sheet_.cellAt_(r, c, true).note = n === null || n === undefined ? '' : String(n); }); }
  setNotes(notes) {
    this.checkShape_(notes, 'setNotes');
    return this.each_((r, c, i, j) => { this.sheet_.cellAt_(r, c, true).note = notes[i][j] ? String(notes[i][j]) : ''; });
  }
  getNote() { return this.getNotes()[0][0]; }
  getNotes() { return this.map_((cell) => (cell && cell.note) || ''); }
  // validation
  setDataValidation(rule) { return this.each_((r, c) => { this.sheet_.cellAt_(r, c, true).dv = rule || null; }); }
  setDataValidations(rules) {
    this.checkShape_(rules, 'setDataValidations');
    return this.each_((r, c, i, j) => { this.sheet_.cellAt_(r, c, true).dv = rules[i][j] || null; });
  }
  getDataValidation() { return this.getDataValidations()[0][0]; }
  getDataValidations() { return this.map_((cell) => (cell && cell.dv) || null); }
  insertCheckboxes(checked, unchecked) {
    const b = new FakeDataValidationBuilder();
    if (checked === undefined) b.requireCheckbox(); else b.requireCheckbox(checked, unchecked);
    const rule = b.build();
    return this.each_((r, c) => {
      this.sheet_.cellAt_(r, c, true).dv = rule;
      this.sheet_.write_(r, c, checked === undefined ? false : (unchecked === undefined ? '' : unchecked));
    });
  }
  removeCheckboxes() {
    return this.each_((r, c) => {
      const cell = this.sheet_.cellAt_(r, c);
      if (cell && cell.dv && cell.dv.getCriteriaType() === 'CHECKBOX') { cell.dv = null; this.sheet_.write_(r, c, ''); }
    });
  }
  isChecked() {
    const vals = this.getValues().flat();
    if (vals.every((v) => v === true)) return true;
    if (vals.every((v) => v === false)) return false;
    return null;
  }
  // protection
  protect() {
    const p = new FakeProtection(this.sheet_, 'RANGE', { ...this.rect_ });
    this.sheet_.protections_.push(p);
    return p;
  }
  // copy / sort / filter / groups
  copyTo(dest, options) {
    const o = typeof options === 'object' && options ? options : {};
    const src = this.map_((cell) => (cell ? { ...cell, fmt: cell.fmt ? JSON.parse(JSON.stringify(cell.fmt)) : null, v: copyValue(cell.v) } : null));
    const d = dest.rect_;
    src.forEach((line, i) => line.forEach((cell, j) => {
      const target = dest.sheet_.cellAt_(d.r1 + i, d.c1 + j, true);
      if (!o.formatOnly) {
        if (cell && cell.f) dest.sheet_.writeFormula_(d.r1 + i, d.c1 + j, cell.f);
        else dest.sheet_.write_(d.r1 + i, d.c1 + j, cell ? cell.v : '');
      }
      if (!o.contentsOnly) {
        target.fmt = cell ? cell.fmt : null;
        target.dv = cell ? cell.dv : null;
        target.note = cell ? cell.note : '';
      }
    }));
    return this;
  }
  sort(spec) {
    const specs = (Array.isArray(spec) ? spec : [spec]).map((s) => (typeof s === 'number' ? { column: s, ascending: true } : { ascending: true, ...s }));
    const { r1, r2, c1, c2 } = this.rect_;
    const rows = [];
    for (let r = r1; r <= r2; r++) rows.push(this.sheet_.grid_[r - 1] ? this.sheet_.grid_[r - 1].slice(c1 - 1, c2) : []);
    const key = (row, col) => { const cell = row[col - c1]; return cell ? cell.v : ''; };
    const cmp = (a, b) => {
      if (isEmpty(a) && isEmpty(b)) return 0;
      if (isEmpty(a)) return 1;
      if (isEmpty(b)) return -1;
      const x = isDate(a) ? a.getTime() : a; const y = isDate(b) ? b.getTime() : b;
      if (typeof x === 'number' && typeof y === 'number') return x - y;
      if (typeof x === 'number') return -1;
      if (typeof y === 'number') return 1;
      return String(x).localeCompare(String(y));
    };
    rows.sort((a, b) => {
      for (const s of specs) {
        const va = key(a, s.column); const vb = key(b, s.column);
        const res = cmp(va, vb);
        if (res) return isEmpty(va) || isEmpty(vb) ? res : (s.ascending ? res : -res);
      }
      return 0;
    });
    rows.forEach((line, i) => {
      const r = r1 + i;
      if (!this.sheet_.grid_[r - 1]) this.sheet_.grid_[r - 1] = [];
      for (let c = c1; c <= c2; c++) this.sheet_.grid_[r - 1][c - 1] = line[c - c1];
    });
    return this;
  }
  createFilter() {
    if (this.sheet_.filter_) throw new Error('You can\'t create a filter in a sheet that already has a filter.');
    this.sheet_.filter_ = { ...this.rect_ };
    return new FakeFilter(this.sheet_);
  }
  getFilter() { return this.sheet_.filter_ && intersects(this.sheet_.filter_, this.rect_) ? new FakeFilter(this.sheet_) : null; }
  shiftRowGroupDepth(delta) { for (let r = this.rect_.r1; r <= this.rect_.r2; r++) this.sheet_.shiftGroup_(this.sheet_.rowGroups_, r, delta); return this; }
  shiftColumnGroupDepth(delta) { for (let c = this.rect_.c1; c <= this.rect_.c2; c++) this.sheet_.shiftGroup_(this.sheet_.colGroups_, c, delta); return this; }
}

for (const [key, one, many, def, normalize] of FORMAT_PROPS) {
  FakeRange.prototype[`set${one}`] = function setOne(v) {
    const value = normalize(v === undefined ? null : v);
    return this.each_((r, c) => setFmt(this.sheet_.cellAt_(r, c, true), key, value, def));
  };
  FakeRange.prototype[`set${many}`] = function setMany(values) {
    this.checkShape_(values, `set${many}`);
    return this.each_((r, c, i, j) => setFmt(this.sheet_.cellAt_(r, c, true), key, normalize(values[i][j] === undefined ? null : values[i][j]), def));
  };
  FakeRange.prototype[`get${many}`] = function getMany() {
    return this.map_((cell) => (cell && cell.fmt && key in cell.fmt ? cell.fmt[key] : def));
  };
  FakeRange.prototype[`get${one}`] = function getOne() { return this[`get${many}`]()[0][0]; };
}

class FakeRangeList {
  constructor(ranges) { this.ranges_ = ranges; }
  getRanges() { return [...this.ranges_]; }
  activate() { if (this.ranges_.length) this.ranges_[this.ranges_.length - 1].activate(); return this; }
}
for (const name of ['setValue', 'setFormula', 'setFormulaR1C1', 'clear', 'clearContent', 'clearFormat', 'clearNote',
  'clearDataValidations', 'setBorder', 'setNote', 'setDataValidation', 'insertCheckboxes', 'removeCheckboxes',
  'setFontLine', 'setWrapStrategy', 'breakApart',
  ...FORMAT_PROPS.map((p) => `set${p[1]}`)]) {
  FakeRangeList.prototype[name] = function each(...args) { this.ranges_.forEach((r) => r[name](...args)); return this; };
}

// ---------------------------------------------------------------- Sheet

class FakeSheet {
  constructor(ss, name, id, { maxRows = 1000, maxCols = 26 } = {}) {
    Object.assign(this, {
      ss_: ss, name_: name, id_: id, maxRows_: maxRows, maxCols_: maxCols,
      grid_: [], merges_: [], cfRules_: [], protections_: [], charts_: [],
      colWidths_: new Map(), rowHeights_: new Map(), hiddenCols_: new Set(), hiddenRows_: new Set(),
      colGroups_: new Map(), rowGroups_: new Map(),
      frozenRows_: 0, frozenCols_: 0, hidden_: false, tabColor_: null, hiddenGridlines_: false,
      filter_: null, tables_: [],
    });
  }
  // cell storage
  cellAt_(r, c, create = false) {
    let line = this.grid_[r - 1];
    if (!line) { if (!create) return undefined; line = this.grid_[r - 1] = []; }
    let cell = line[c - 1];
    if (!cell && create) cell = line[c - 1] = { v: '', f: null, fmt: null, note: '', dv: null };
    return cell;
  }
  write_(r, c, v) {
    if (typeof v === 'string' && v.startsWith('=') && v.length > 1) return this.writeFormula_(r, c, v);
    const cell = this.cellAt_(r, c, true);
    cell.v = copyValue(v);
    cell.f = null; delete cell.cached; delete cell.computed;
    return cell;
  }
  writeFormula_(r, c, f) {
    if (!f) return this.write_(r, c, '');
    const cell = this.cellAt_(r, c, true);
    cell.f = f.startsWith('=') ? f : `=${f}`;
    cell.v = ''; delete cell.cached; delete cell.computed;
    return cell;
  }
  valueOf_(cell, r, c) {
    if (!cell) return '';
    if (cell.f) {
      if ('computed' in cell) return copyValue(cell.computed);
      const ctx = this.ss_.ctx_;
      if (ctx && typeof ctx.__formulaEvaluator === 'function') return copyValue(ctx.__formulaEvaluator(cell.f, this, r, c));
      if (this.ss_.useCachedValues_ && 'cached' in cell) return copyValue(cell.cached);
      return '';
    }
    return copyValue(cell.v);
  }
  display_(cell, r, c) {
    const v = this.valueOf_(cell, r, c);
    if (isEmpty(v)) return '';
    const fmt = cell && cell.fmt ? cell.fmt.numberFormat : null;
    const tz = this.ss_.timeZone_;
    if (isDate(v)) {
      if (fmt && isDateFormat(fmt)) return formatSheetsDate(v, fmt, tz);
      const p = tzParts(v.getTime(), tz);
      return p.H || p.m || p.s ? formatSheetsDate(v, 'dd/mm/yyyy hh:mm:ss', tz) : formatSheetsDate(v, 'dd/mm/yyyy', tz);
    }
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') return formatNumber(v, fmt, this.ss_.locale_);
    return String(v);
  }
  range_(row, col, numRows = 1, numCols = 1) {
    if (numRows < 1) throw new Error('The number of rows in the range must be at least 1.');
    if (numCols < 1) throw new Error('The number of columns in the range must be at least 1.');
    return new FakeRange(this, { r1: row, c1: col, r2: row + numRows - 1, c2: col + numCols - 1 });
  }
  hasContent_(cell) { return cell && (!isEmpty(cell.v) || cell.f); }
  addMerge_(rect) {
    this.merges_ = this.merges_.filter((m) => !intersects(m, rect));
    if (rect.r1 === rect.r2 && rect.c1 === rect.c2) return;
    this.merges_.push(rect);
    for (let r = rect.r1; r <= rect.r2; r++) {
      for (let c = rect.c1; c <= rect.c2; c++) if (r !== rect.r1 || c !== rect.c1) this.write_(r, c, '');
    }
  }
  shiftGroup_(map, i, delta) {
    const depth = Math.max(0, Math.min(8, (map.get(i) || 0) + delta));
    if (depth) map.set(i, depth); else map.delete(i);
  }
  // identity
  getName() { return this.name_; }
  setName(name) {
    name = String(name);
    if (name === this.name_) return this;
    if (this.ss_.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists. Please enter another name.`);
    const old = this.name_;
    this.name_ = name;
    this.ss_.renameReferences_(old, name);
    return this;
  }
  getSheetId() { return this.id_; }
  getIndex() { return this.ss_.sheets_.indexOf(this) + 1; }
  getParent() { return this.ss_; }
  getType() { return 'GRID'; }
  activate() { this.ss_.active_ = this; this.hidden_ = false; return this; }
  // ranges
  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const { sheetName, a1 } = splitRef(a);
      if (sheetName !== null && sheetName !== this.name_) throw new Error(`Range ${a} is not on sheet ${this.name_}`);
      return new FakeRange(this, parseA1(a1, this.maxRows_, this.maxCols_));
    }
    return this.range_(a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
  }
  getRangeList(a1s) { return new FakeRangeList(a1s.map((x) => this.getRange(x))); }
  getDataRange() { return this.range_(1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn())); }
  getSheetValues(r, c, nr, nc) {
    const rows = nr === -1 ? this.getLastRow() - r + 1 : nr;
    const cols = nc === -1 ? this.getLastColumn() - c + 1 : nc;
    return this.range_(r, c, rows, cols).getValues();
  }
  getLastRow() {
    for (let r = this.grid_.length; r >= 1; r--) if ((this.grid_[r - 1] || []).some((cell) => this.hasContent_(cell))) return r;
    return 0;
  }
  getLastColumn() {
    let max = 0;
    this.grid_.forEach((line) => (line || []).forEach((cell, i) => { if (this.hasContent_(cell)) max = Math.max(max, i + 1); }));
    return max;
  }
  getMaxRows() { return this.maxRows_; }
  getMaxColumns() { return this.maxCols_; }
  appendRow(values) {
    const r = this.getLastRow() + 1;
    if (r > this.maxRows_) this.maxRows_ = r;
    if (values.length > this.maxCols_) this.maxCols_ = values.length;
    values.forEach((v, i) => this.write_(r, i + 1, v));
    return this;
  }
  // structure
  insert_(dim, at, n) {
    if (n < 1) throw new Error('Number of rows/columns to insert must be at least 1.');
    if (dim === 'row') {
      this.grid_.splice(at - 1, 0, ...Array.from({ length: n }, () => []));
      this.maxRows_ += n;
      this.rowHeights_ = shiftIndexMap(this.rowHeights_, at, n);
      this.hiddenRows_ = new Set([...shiftIndexMap(new Map([...this.hiddenRows_].map((x) => [x, true])), at, n).keys()]);
      this.rowGroups_ = shiftIndexMap(this.rowGroups_, at, n);
    } else {
      this.grid_.forEach((line) => { if (line && line.length >= at) line.splice(at - 1, 0, ...Array(n)); });
      this.maxCols_ += n;
      this.colWidths_ = shiftIndexMap(this.colWidths_, at, n);
      this.hiddenCols_ = new Set([...shiftIndexMap(new Map([...this.hiddenCols_].map((x) => [x, true])), at, n).keys()]);
      this.colGroups_ = shiftIndexMap(this.colGroups_, at, n);
    }
    this.shiftRects_(dim, at, n);
    return this;
  }
  delete_(dim, at, n) {
    if (dim === 'row') {
      if (at < 1 || at + n - 1 > this.maxRows_) throw new Error('Those rows are out of bounds.');
      if (n >= this.maxRows_) throw new Error('You can\'t delete all the rows on the sheet.');
      this.grid_.splice(at - 1, n);
      this.maxRows_ -= n;
      this.rowHeights_ = shiftIndexMap(this.rowHeights_, at, -n);
      this.hiddenRows_ = new Set([...shiftIndexMap(new Map([...this.hiddenRows_].map((x) => [x, true])), at, -n).keys()]);
      this.rowGroups_ = shiftIndexMap(this.rowGroups_, at, -n);
    } else {
      if (at < 1 || at + n - 1 > this.maxCols_) throw new Error('Those columns are out of bounds.');
      if (n >= this.maxCols_) throw new Error('You can\'t delete all the columns on the sheet.');
      this.grid_.forEach((line) => { if (line) line.splice(at - 1, n); });
      this.maxCols_ -= n;
      this.colWidths_ = shiftIndexMap(this.colWidths_, at, -n);
      this.hiddenCols_ = new Set([...shiftIndexMap(new Map([...this.hiddenCols_].map((x) => [x, true])), at, -n).keys()]);
      this.colGroups_ = shiftIndexMap(this.colGroups_, at, -n);
    }
    this.shiftRects_(dim, at, -n);
    return this;
  }
  shiftRects_(dim, at, delta) {
    const shift = (rect) => shiftRect(rect, dim, at, delta);
    this.merges_ = this.merges_.map(shift).filter((m) => m && !(m.r1 === m.r2 && m.c1 === m.c2));
    if (this.filter_) this.filter_ = shift(this.filter_);
    this.protections_ = this.protections_.filter((p) => {
      if (!p.rect_) return true;
      p.rect_ = shift(p.rect_);
      p.unprotected_ = p.unprotected_.map(shift).filter(Boolean);
      return !!p.rect_;
    });
    this.cfRules_ = this.cfRules_.map((rule) => {
      const spec = rule.spec_;
      const ranges = spec.ranges.map((r) => (r.sheet === this ? { sheet: r.sheet, rect: shift(r.rect) } : r)).filter((r) => r.rect);
      return ranges.length ? new FakeConditionalFormatRule({ ...spec, ranges }) : null;
    }).filter(Boolean);
    for (const [name, e] of [...this.ss_.named_]) {
      if (e.sheet !== this) continue;
      const rect = shift(e.rect);
      if (rect) e.rect = rect; else this.ss_.named_.delete(name);
    }
    for (const sheet of this.ss_.sheets_) {
      for (const chart of sheet.charts_) chart.ranges_ = chart.ranges_.map((r) => (r.sheet === this ? { ...r, rect: shift(r.rect) } : r)).filter((r) => r.rect);
    }
    for (const chart of this.charts_) {
      const key = dim === 'row' ? 'row' : 'column';
      if (delta > 0 && chart.position_[key] >= at) chart.position_[key] += delta;
      if (delta < 0 && chart.position_[key] >= at) chart.position_[key] = Math.max(at, chart.position_[key] + delta);
    }
  }
  insertRows(before, n = 1) { return this.insert_('row', before, n); }
  insertRowsBefore(before, n) { return this.insert_('row', before, n); }
  insertRowsAfter(after, n) { return this.insert_('row', after + 1, n); }
  insertRowBefore(before) { return this.insert_('row', before, 1); }
  insertRowAfter(after) { return this.insert_('row', after + 1, 1); }
  deleteRow(r) { return this.delete_('row', r, 1); }
  deleteRows(r, n) { return this.delete_('row', r, n); }
  insertColumns(before, n = 1) { return this.insert_('col', before, n); }
  insertColumnsBefore(before, n) { return this.insert_('col', before, n); }
  insertColumnsAfter(after, n) { return this.insert_('col', after + 1, n); }
  insertColumnBefore(before) { return this.insert_('col', before, 1); }
  insertColumnAfter(after) { return this.insert_('col', after + 1, 1); }
  deleteColumn(c) { return this.delete_('col', c, 1); }
  deleteColumns(c, n) { return this.delete_('col', c, n); }
  clear(options) { this.range_(1, 1, this.maxRows_, this.maxCols_).clear(options); return this; }
  clearContents() { this.range_(1, 1, this.maxRows_, this.maxCols_).clearContent(); return this; }
  clearFormats() { this.range_(1, 1, this.maxRows_, this.maxCols_).clearFormat(); return this; }
  clearNotes() { this.range_(1, 1, this.maxRows_, this.maxCols_).clearNote(); return this; }
  // view
  setFrozenRows(n) { this.frozenRows_ = n; return this; }
  getFrozenRows() { return this.frozenRows_; }
  setFrozenColumns(n) { this.frozenCols_ = n; return this; }
  getFrozenColumns() { return this.frozenCols_; }
  setColumnWidth(c, px) { this.colWidths_.set(c, px); return this; }
  setColumnWidths(c, n, px) { for (let i = 0; i < n; i++) this.colWidths_.set(c + i, px); return this; }
  getColumnWidth(c) { return this.colWidths_.has(c) ? this.colWidths_.get(c) : 100; }
  setRowHeight(r, px) { this.rowHeights_.set(r, px); return this; }
  setRowHeights(r, n, px) { for (let i = 0; i < n; i++) this.rowHeights_.set(r + i, px); return this; }
  setRowHeightsForced(r, n, px) { return this.setRowHeights(r, n, px); }
  getRowHeight(r) { return this.rowHeights_.has(r) ? this.rowHeights_.get(r) : 21; }
  hideSheet() {
    if (!this.hidden_ && this.ss_.sheets_.filter((s) => !s.hidden_).length === 1) throw new Error('You can\'t hide all the sheets in a document.');
    this.hidden_ = true;
    if (this.ss_.active_ === this) this.ss_.active_ = this.ss_.sheets_.find((s) => !s.hidden_);
    return this;
  }
  showSheet() { this.hidden_ = false; return this; }
  isSheetHidden() { return this.hidden_; }
  setTabColor(c) { this.tabColor_ = normColor(c); return this; }
  getTabColor() { return this.tabColor_; }
  setHiddenGridlines(b) { this.hiddenGridlines_ = !!b; return this; }
  hasHiddenGridlines() { return this.hiddenGridlines_; }
  hideColumns(c, n = 1) { for (let i = 0; i < n; i++) this.hiddenCols_.add(c + i); return this; }
  showColumns(c, n = 1) { for (let i = 0; i < n; i++) this.hiddenCols_.delete(c + i); return this; }
  hideColumn(range) { return this.hideColumns(range.getColumn(), range.getNumColumns()); }
  unhideColumn(range) { return this.showColumns(range.getColumn(), range.getNumColumns()); }
  isColumnHiddenByUser(c) { return this.hiddenCols_.has(c); }
  hideRows(r, n = 1) { for (let i = 0; i < n; i++) this.hiddenRows_.add(r + i); return this; }
  showRows(r, n = 1) { for (let i = 0; i < n; i++) this.hiddenRows_.delete(r + i); return this; }
  hideRow(range) { return this.hideRows(range.getRow(), range.getNumRows()); }
  unhideRow(range) { return this.showRows(range.getRow(), range.getNumRows()); }
  isRowHiddenByUser(r) { return this.hiddenRows_.has(r); }
  getColumnGroupDepth(c) { return this.colGroups_.get(c) || 0; }
  getRowGroupDepth(r) { return this.rowGroups_.get(r) || 0; }
  // selection
  setActiveRange(range) { return range.activate(); }
  setActiveSelection(a1) { return this.getRange(a1).activate(); }
  getActiveRange() { return this.ss_.activeRange_ && this.ss_.activeRange_.sheet_ === this ? this.ss_.activeRange_ : this.range_(1, 1); }
  getActiveCell() { const r = this.getActiveRange(); return this.range_(r.getRow(), r.getColumn()); }
  getCurrentCell() { return this.getActiveCell(); }
  // protection
  protect() {
    const existing = this.protections_.find((p) => p.type_ === 'SHEET');
    if (existing) return existing;
    const p = new FakeProtection(this, 'SHEET', null);
    this.protections_.push(p);
    return p;
  }
  getProtections(type) { return this.protections_.filter((p) => p.type_ === type); }
  // conditional formats
  getConditionalFormatRules() { return [...this.cfRules_]; }
  setConditionalFormatRules(rules) {
    this.cfRules_ = rules.map((r) => (r instanceof FakeConditionalFormatRule ? r : r.build()));
    return this;
  }
  clearConditionalFormatRules() { this.cfRules_ = []; return this; }
  // charts
  newChart() { return new FakeChartBuilder(this, null); }
  insertChart(chart) {
    if (chart.id_ === null) chart.id_ = this.ss_.nextChartId_++;
    chart.sheet_ = this;
    this.charts_.push(chart);
    return this;
  }
  updateChart(chart) {
    const i = this.charts_.findIndex((c) => c.id_ === chart.id_);
    if (i < 0) throw new Error('Chart not found on this sheet.');
    this.charts_[i] = chart;
    return this;
  }
  removeChart(chart) { this.charts_ = this.charts_.filter((c) => c.id_ !== chart.id_); return this; }
  getCharts() { return [...this.charts_]; }
  // misc
  getNamedRanges() { return [...this.ss_.named_].filter(([, e]) => e.sheet === this).map(([n]) => new FakeNamedRange(this.ss_, n)); }
  getFilter() { return this.filter_ ? new FakeFilter(this) : null; }
  copyTo(ss) {
    const data = snapshotSheet(this);
    let name = `Copy of ${this.name_}`;
    for (let i = 2; ss.getSheetByName(name); i++) name = `Copy of ${this.name_} ${i}`;
    data.name = name;
    const sheet = ss.addSheet_(name, ss.sheets_.length, { maxRows: data.maxRows, maxCols: data.maxColumns });
    fillSheet(sheet, data);
    return sheet;
  }
}

// ---------------------------------------------------------------- Spreadsheet

class FakeSpreadsheet {
  constructor(ctx, { timeZone, locale } = {}) {
    Object.assign(this, {
      ctx_: ctx, sheets_: [], named_: new Map(), active_: null, activeRange_: null, nextSheetId_: 0, nextChartId_: 1,
      timeZone_: timeZone || 'America/Sao_Paulo', locale_: locale || 'pt_BR', name_: 'Fake spreadsheet', useCachedValues_: false,
    });
  }
  addSheet_(name, index, dims) {
    const sheet = new FakeSheet(this, name, this.nextSheetId_++, dims);
    this.sheets_.splice(index === undefined ? this.sheets_.length : index, 0, sheet);
    return sheet;
  }
  renameReferences_(oldName, newName) {
    for (const sheet of this.sheets_) {
      for (const line of sheet.grid_) for (const cell of line || []) if (cell && cell.f) cell.f = renameInFormula(cell.f, oldName, newName);
      for (const rule of sheet.cfRules_) {
        if (rule.spec_.condition === 'CUSTOM_FORMULA') rule.spec_.values = rule.spec_.values.map((f) => renameInFormula(String(f), oldName, newName));
      }
    }
  }
  getId() { return 'fake-spreadsheet-id'; }
  getName() { return this.name_; }
  rename(n) { this.name_ = n; }
  getUrl() { return 'https://docs.google.com/spreadsheets/d/fake-spreadsheet-id/edit'; }
  getSpreadsheetTimeZone() { return this.timeZone_; }
  setSpreadsheetTimeZone(tz) { this.timeZone_ = tz; }
  getSpreadsheetLocale() { return this.locale_; }
  setSpreadsheetLocale(l) { this.locale_ = l; }
  getSheets() { return [...this.sheets_]; }
  getNumSheets() { return this.sheets_.length; }
  getSheetByName(name) { return this.sheets_.find((s) => s.name_ === name) || null; }
  getSheetById(id) { return this.sheets_.find((s) => s.id_ === id) || null; }
  insertSheet(a, b) {
    let name; let index;
    if (typeof a === 'number') index = a;
    else if (typeof a === 'string') { name = a; if (typeof b === 'number') index = b; }
    if (index !== undefined && (index < 0 || index > this.sheets_.length)) throw new Error(`Invalid sheet index ${index}`);
    if (name === undefined) { let i = this.sheets_.length + 1; while (this.getSheetByName(`Sheet${i}`)) i++; name = `Sheet${i}`; }
    if (this.getSheetByName(name)) throw new Error(`A sheet with the name "${name}" already exists. Please enter another name.`);
    const sheet = this.addSheet_(name, index);
    this.active_ = sheet;
    return sheet;
  }
  deleteSheet(sheet) {
    if (this.sheets_.length === 1) throw new Error('You can\'t remove all the sheets in a document.');
    this.sheets_ = this.sheets_.filter((s) => s !== sheet);
    for (const [n, e] of [...this.named_]) if (e.sheet === sheet) this.named_.delete(n);
    if (this.active_ === sheet) this.active_ = this.sheets_[0];
    if (this.activeRange_ && this.activeRange_.sheet_ === sheet) this.activeRange_ = null;
  }
  getActiveSheet() { return this.active_ || this.sheets_[0] || null; }
  setActiveSheet(sheet) { return sheet.activate(); }
  moveActiveSheet(pos) {
    const sheet = this.getActiveSheet();
    this.sheets_ = this.sheets_.filter((s) => s !== sheet);
    this.sheets_.splice(Math.max(0, Math.min(pos - 1, this.sheets_.length)), 0, sheet);
  }
  getActiveRange() { return this.activeRange_ || (this.getActiveSheet() ? this.getActiveSheet().getActiveRange() : null); }
  setActiveRange(range) { return range.activate(); }
  getActiveCell() { return this.getActiveSheet().getActiveCell(); }
  getRange(ref) {
    const { sheetName, a1 } = splitRef(ref);
    const sheet = sheetName === null ? this.getActiveSheet() : this.getSheetByName(sheetName);
    if (!sheet) throw new Error(`Range not found: ${ref}`);
    return sheet.getRange(a1);
  }
  getRangeList(refs) { return new FakeRangeList(refs.map((r) => this.getRange(r))); }
  getRangeByName(name) { const e = this.named_.get(name); return e ? new FakeRange(e.sheet, e.rect) : null; }
  setNamedRange(name, range) { this.named_.set(name, { sheet: range.sheet_, rect: { ...range.rect_ } }); }
  getNamedRanges() { return [...this.named_.keys()].map((n) => new FakeNamedRange(this, n)); }
  removeNamedRange(name) { this.named_.delete(name); }
  getProtections(type) { return this.sheets_.flatMap((s) => s.getProtections(type)); }
  toast(msg, title, seconds) { this.ctx_.__toasts.push({ msg, title: title === undefined ? '' : title, seconds: seconds === undefined ? 5 : seconds }); }
}

// ---------------------------------------------------------------- UI, HTML, triggers

/** Recorded menu: `name`, `items` = [label, fnName] | [caption, FakeMenu] (sub menu) | ['---']. */
class FakeMenu {
  constructor(name, ctx) { this.name = name; this.items = []; Object.defineProperty(this, 'ctx_', { value: ctx }); }
  addItem(label, fn) { this.items.push([label, fn]); return this; }
  addSeparator() { this.items.push(['---']); return this; }
  addSubMenu(menu) { this.items.push([menu.name, menu]); return this; }
  addToUi() { this.ctx_.__menus.push(this); }
  /** Test helper: every function name reachable from this menu, depth first. */
  functions_() { return this.items.flatMap((i) => (i[1] instanceof FakeMenu ? i[1].functions_() : i.length === 2 ? [i[1]] : [])); }
}

class FakeHtmlOutput {
  constructor(content = '') { Object.assign(this, { content_: String(content), title_: '', width_: null, height_: null }); }
  getContent() { return this.content_; }
  setContent(c) { this.content_ = String(c); return this; }
  append(c) { this.content_ += c; return this; }
  appendUntrusted(c) { this.content_ += String(c).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`); return this; }
  setTitle(t) { this.title_ = t; return this; }
  getTitle() { return this.title_; }
  setWidth(w) { this.width_ = w; return this; }
  getWidth() { return this.width_; }
  setHeight(h) { this.height_ = h; return this; }
  getHeight() { return this.height_; }
  setSandboxMode() { return this; }
  setXFrameOptionsMode() { return this; }
  addMetaTag() { return this; }
  setFaviconUrl() { return this; }
}

function compileTemplate(src) {
  let code = 'var __o = [];\nwith (__data) {\n';
  const re = /<\?(!?=)?([\s\S]*?)\?>/g;
  let last = 0; let m;
  while ((m = re.exec(src))) {
    code += `__o.push(${JSON.stringify(src.slice(last, m.index))});\n`;
    if (m[1] === '=') code += `__o.push(__esc(${m[2]}));\n`;
    else if (m[1] === '!=') code += `__o.push(String(${m[2]}));\n`;
    else code += `${m[2]}\n`;
    last = re.lastIndex;
  }
  code += `__o.push(${JSON.stringify(src.slice(last))});\n}\nreturn __o.join('');`;
  // eslint-disable-next-line no-new-func
  return new Function('__data', '__esc', code);
}

class FakeHtmlTemplate {
  constructor(src) { Object.defineProperty(this, 'src_', { value: String(src), enumerable: false }); }
  getRawContent() { return this.src_; }
  getCode() { return this.src_; }
  evaluate() {
    const esc = (v) => String(v === undefined || v === null ? '' : v).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    const data = { ...this };
    return new FakeHtmlOutput(compileTemplate(this.src_)(data, esc));
  }
}

// ---------------------------------------------------------------- fixtures

function decodeValue(v, tz) {
  if (v === null || v === undefined) return '';
  if (typeof v !== 'object') return v;
  if ('$date' in v) { const [y, M, d] = v.$date.split('-').map(Number); return new HostDate(zonedToMs(y, M, d, 0, 0, 0, tz)); }
  if ('$datetime' in v) {
    const m = /^(-?\d+)-(\d+)-(\d+)T(\d+):(\d+):(\d+)/.exec(v.$datetime);
    return new HostDate(zonedToMs(+m[1], +m[2], +m[3], +m[4], +m[5], +m[6], tz));
  }
  if ('$time' in v) { const [H, m, s] = v.$time.split(':').map(Number); return new HostDate(zonedToMs(1899, 12, 30, H, m, s || 0, tz)); }
  if ('$duration' in v) return v.$duration / 86400;
  throw new Error(`Unknown fixture value ${JSON.stringify(v)}`);
}

function encodeValue(v, tz) {
  if (isEmpty(v)) return null;
  if (isDate(v)) {
    const p = tzParts(v.getTime(), tz);
    const date = `${pad(p.y, 4)}-${pad(p.M)}-${pad(p.d)}`;
    const time = `${pad(p.H)}:${pad(p.m)}:${pad(p.s)}`;
    if (p.y === 1899 && p.M === 12 && p.d === 30) return { $time: time };
    if (time === '00:00:00') return { $date: date };
    return { $datetime: `${date}T${time}` };
  }
  return v;
}

function resolveRangeRef(ss, ref) {
  const { sheetName, a1 } = splitRef(ref);
  const sheet = sheetName === null ? null : ss.getSheetByName(sheetName);
  if (!sheet) return String(ref);
  try { return { sheet, rect: parseA1(a1, sheet.maxRows_, sheet.maxCols_) }; } catch (e) { return String(ref); }
}

function formatRangeRef(v, absolute) {
  if (!v || typeof v === 'string') return v;
  return `${quoteSheet(v.sheet.name_)}!${a1Of(v.rect, absolute)}`;
}

function fillSheet(sheet, data) {
  const ss = sheet.ss_;
  const tz = ss.timeZone_;
  const eachRef = (refs, fn) => refs.forEach((ref) => {
    const rect = parseA1(ref, sheet.maxRows_, sheet.maxCols_);
    for (let r = rect.r1; r <= rect.r2; r++) for (let c = rect.c1; c <= rect.c2; c++) fn(sheet.cellAt_(r, c, true), r, c);
  });
  sheet.hidden_ = !!data.hidden;
  sheet.tabColor_ = data.tabColor ? normColor(data.tabColor) : null;
  sheet.frozenRows_ = data.frozenRows || 0;
  sheet.frozenCols_ = data.frozenColumns || 0;
  sheet.hiddenGridlines_ = !!data.hiddenGridlines;
  for (const [letters, px] of Object.entries(data.columnWidths || {})) sheet.colWidths_.set(colToIndex(letters), px);
  for (const [a, b, px] of data.rowHeights || []) for (let r = a; r <= b; r++) sheet.rowHeights_.set(r, px);
  for (const [a, b] of data.hiddenColumns || []) for (let c = a; c <= b; c++) sheet.hiddenCols_.add(c);
  for (const [a, b] of data.hiddenRows || []) for (let r = a; r <= b; r++) sheet.hiddenRows_.add(r);
  for (const [a, b, d] of data.columnGroups || []) for (let c = a; c <= b; c++) sheet.colGroups_.set(c, d);
  for (const [a, b, d] of data.rowGroups || []) for (let r = a; r <= b; r++) sheet.rowGroups_.set(r, d);
  (data.values || []).forEach((line, i) => line.forEach((v, j) => {
    if (v && typeof v === 'object' && '$formula' in v) {
      const cell = sheet.writeFormula_(i + 1, j + 1, v.$formula);
      if ('$value' in v) cell.cached = decodeValue(v.$value, tz);
    } else if (!isEmpty(v)) {
      const cell = sheet.cellAt_(i + 1, j + 1, true);
      cell.v = decodeValue(v, tz);
    }
  }));
  sheet.merges_ = (data.merges || []).map((m) => parseA1(m, sheet.maxRows_, sheet.maxCols_));
  for (const [a1, text] of Object.entries(data.notes || {})) sheet.cellAt_(parseA1(a1).r1, parseA1(a1).c1, true).note = text;
  for (const group of data.formats || []) {
    eachRef(group.ranges, (cell) => { cell.fmt = JSON.parse(JSON.stringify(group.format)); });
  }
  for (const dv of data.dataValidations || []) {
    const { ranges, criteria, values, allowInvalid, helpText, showDropdown } = dv;
    const rule = { criteria, values: values.map((v) => (criteria === 'VALUE_IN_RANGE' ? resolveRangeRef(ss, v) : decodeValue(v, tz))), allowInvalid: allowInvalid !== false };
    if (helpText) rule.helpText = helpText;
    if (showDropdown === false) rule.showDropdown = false;
    const built = new FakeDataValidation(rule);
    eachRef(ranges, (cell) => { cell.dv = built; });
  }
  sheet.cfRules_ = (data.conditionalFormats || []).map((cf) => new FakeConditionalFormatRule({
    ranges: cf.ranges.map((r) => ({ sheet, rect: parseA1(r, sheet.maxRows_, sheet.maxCols_) })),
    condition: cf.condition,
    values: (cf.values || []).map((v) => decodeValue(v, tz)),
    format: { ...(cf.format || {}) },
  }));
  sheet.protections_ = (data.protections || []).map((p) => {
    const prot = new FakeProtection(sheet, p.type, p.range ? parseA1(p.range, sheet.maxRows_, sheet.maxCols_) : null);
    prot.description_ = p.description || '';
    prot.warningOnly_ = !!p.warningOnly;
    prot.unprotected_ = (p.unprotectedRanges || []).map((r) => parseA1(r, sheet.maxRows_, sheet.maxCols_));
    return prot;
  });
  sheet.charts_ = (data.charts || []).map((ch) => new FakeEmbeddedChart(sheet, ss.nextChartId_++, ch.type,
    (ch.ranges || []).map((ref) => resolveRangeRef(ss, ref.includes('!') ? ref : `${quoteSheet(sheet.name_)}!${ref}`)).filter((r) => typeof r === 'object'),
    ch.options || {}, ch.position || { row: 1, column: 1, offsetX: 0, offsetY: 0 }));
  sheet.filter_ = data.filter ? parseA1(data.filter, sheet.maxRows_, sheet.maxCols_) : null;
  sheet.tables_ = JSON.parse(JSON.stringify(data.tables || []));
}

/** Replaces the context's spreadsheet contents with a fixture (tools/xlsx_to_fixture.py shape). */
function loadFixture(ctx, json, { useCachedValues = false } = {}) {
  const ss = ctx.__spreadsheet;
  ss.sheets_ = []; ss.named_ = new Map(); ss.active_ = null; ss.activeRange_ = null;
  ss.useCachedValues_ = useCachedValues;
  const sheets = json.sheets.map((s) => ss.addSheet_(s.name, undefined, { maxRows: s.maxRows || 1000, maxCols: s.maxColumns || 26 }));
  json.sheets.forEach((s, i) => fillSheet(sheets[i], s));
  for (const nr of json.namedRanges || []) {
    const sheet = ss.getSheetByName(nr.sheet);
    if (sheet) ss.named_.set(nr.name, { sheet, rect: parseA1(nr.range, sheet.maxRows_, sheet.maxCols_) });
  }
  ss.active_ = ss.sheets_.find((s) => !s.hidden_) || ss.sheets_[0] || null;
  return ss;
}

function runs(entries) {
  const out = [];
  for (const [i, v] of entries) {
    const last = out[out.length - 1];
    if (last && last[1] === i - 1 && stable(last[2]) === stable(v)) last[1] = i;
    else out.push([i, i, v]);
  }
  return out;
}

function groupCells(sheet, pick) {
  const groups = new Map();
  sheet.grid_.forEach((line, i) => (line || []).forEach((cell, j) => {
    const v = cell ? pick(cell) : null;
    if (v === null || v === undefined) return;
    const key = stable(v);
    if (!groups.has(key)) groups.set(key, { value: v, cells: [] });
    groups.get(key).cells.push([i + 1, j + 1]);
  }));
  return [...groups.values()]
    .map((g) => ({ rects: rectsFromCells(g.cells), value: g.value }))
    .sort((a, b) => a.rects[0].r1 - b.rects[0].r1 || a.rects[0].c1 - b.rects[0].c1);
}

function snapshotSheet(sheet) {
  const tz = sheet.ss_.timeZone_;
  const values = [];
  const last = sheet.getLastRow();
  for (let r = 1; r <= last; r++) {
    const line = sheet.grid_[r - 1] || [];
    const out = [];
    for (let i = 0; i < line.length; i++) {
      const cell = line[i];
      if (!cell) out.push(null);
      else if (cell.f) {
        const f = { $formula: cell.f };
        if ('cached' in cell) f.$value = encodeValue(cell.cached, tz);
        out.push(f);
      } else out.push(encodeValue(cell.v, tz));
    }
    while (out.length && out[out.length - 1] === null) out.pop();
    values.push(out);
  }
  const notes = {};
  sheet.grid_.forEach((line, i) => (line || []).forEach((cell, j) => { if (cell && cell.note) notes[a1Of({ r1: i + 1, c1: j + 1, r2: i + 1, c2: j + 1 })] = cell.note; }));
  const sortedIdx = (set) => [...set].sort((a, b) => a - b);
  const byRect = (a, b) => a.r1 - b.r1 || a.c1 - b.c1;
  return {
    name: sheet.name_,
    hidden: sheet.hidden_,
    tabColor: sheet.tabColor_,
    maxRows: sheet.maxRows_,
    maxColumns: sheet.maxCols_,
    frozenRows: sheet.frozenRows_,
    frozenColumns: sheet.frozenCols_,
    hiddenGridlines: sheet.hiddenGridlines_,
    columnWidths: Object.fromEntries(sortedIdx(sheet.colWidths_.keys()).map((c) => [indexToCol(c), sheet.colWidths_.get(c)])),
    rowHeights: runs(sortedIdx(sheet.rowHeights_.keys()).map((r) => [r, sheet.rowHeights_.get(r)])),
    hiddenColumns: runs(sortedIdx(sheet.hiddenCols_).map((c) => [c, true])).map(([a, b]) => [a, b]),
    hiddenRows: runs(sortedIdx(sheet.hiddenRows_).map((r) => [r, true])).map(([a, b]) => [a, b]),
    columnGroups: runs(sortedIdx(sheet.colGroups_.keys()).map((c) => [c, sheet.colGroups_.get(c)])),
    rowGroups: runs(sortedIdx(sheet.rowGroups_.keys()).map((r) => [r, sheet.rowGroups_.get(r)])),
    values,
    merges: [...sheet.merges_].sort(byRect).map((m) => a1Of(m)),
    notes,
    formats: groupCells(sheet, (cell) => (cell.fmt && Object.keys(cell.fmt).length ? cell.fmt : null))
      .map((g) => ({ ranges: g.rects.map((r) => a1Of(r)), format: JSON.parse(JSON.stringify(g.value)) })),
    dataValidations: groupCells(sheet, (cell) => {
      if (!cell.dv) return null;
      const { criteria, values: vals, allowInvalid, helpText, showDropdown } = cell.dv.rule_;
      const out = { criteria, values: vals.map((v) => (criteria === 'VALUE_IN_RANGE' ? formatRangeRef(v, true) : encodeValue(v, tz))), allowInvalid };
      if (helpText) out.helpText = helpText;
      if (showDropdown === false) out.showDropdown = false;
      return out;
    }).map((g) => ({ ranges: g.rects.map((r) => a1Of(r)), ...g.value })),
    conditionalFormats: sheet.cfRules_.map((rule) => ({
      ranges: rule.spec_.ranges.filter((r) => r.sheet === sheet).map((r) => r.rect).sort(byRect).map((r) => a1Of(r)),
      condition: rule.spec_.condition,
      values: rule.spec_.values.map((v) => encodeValue(v, tz)),
      format: { ...rule.spec_.format },
    })),
    protections: sheet.protections_.map((p) => ({
      type: p.type_,
      range: p.rect_ ? a1Of(p.rect_) : null,
      description: p.description_,
      warningOnly: p.warningOnly_,
      unprotectedRanges: p.unprotected_.map((r) => a1Of(r)),
    })),
    charts: sheet.charts_.map((ch) => ({
      type: ch.type_,
      position: { ...ch.position_ },
      ranges: ch.ranges_.map((r) => formatRangeRef(r, false)),
      options: JSON.parse(JSON.stringify(ch.options_)),
    })),
    filter: sheet.filter_ ? a1Of(sheet.filter_) : null,
    tables: JSON.parse(JSON.stringify(sheet.tables_)),
  };
}

/** Dumps the fake spreadsheet in the fixture JSON shape (no `source`). */
function snapshot(ctxOrSpreadsheet) {
  const ss = ctxOrSpreadsheet instanceof FakeSpreadsheet ? ctxOrSpreadsheet : ctxOrSpreadsheet.__spreadsheet;
  return {
    sheets: ss.sheets_.map(snapshotSheet),
    namedRanges: [...ss.named_].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, e]) => ({ name, sheet: e.sheet.name_, range: a1Of(e.rect) })),
  };
}

// ---------------------------------------------------------------- context

function createContext(options = {}) {
  const {
    sheets = [], properties = {}, userProperties = {}, documentProperties = {}, fetchResponses = [], now,
    timeZone = 'America/Sao_Paulo', locale = 'pt_BR', userEmail = 'owner@example.com', uiResponses = [],
    htmlFiles = {}, fixture, useCachedValues = false,
  } = options;

  const clock = { now: now === undefined || now === null ? null : new HostDate(now).getTime() };
  class FakeDate extends HostDate {
    constructor(...a) {
      if (a.length) super(...a);
      else if (clock.now === null) super();
      else super(clock.now);
    }
    static now() { return clock.now === null ? HostDate.now() : clock.now; }
    static [Symbol.hasInstance](x) { return x instanceof HostDate; }
  }

  const ctx = {
    JSON, Object, Array, Number, String, Boolean, Math, Error, TypeError, RangeError, RegExp, Map, Set, WeakMap,
    Intl, Symbol, Promise, parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
    Date: FakeDate,
    __clock: {
      set: (d) => { clock.now = new HostDate(d).getTime(); },
      advance: (ms) => { if (clock.now === null) clock.now = HostDate.now(); clock.now += ms; },
      get: () => new HostDate(clock.now === null ? HostDate.now() : clock.now),
    },
    __menus: [], __alerts: [], __prompts: [], __dialogs: [], __toasts: [], __locks: [], __logs: [], __sleeps: [],
    __fetchCalls: [], __sentMessages: [], __triggers: [], __uiResponses: [...uiResponses],
    __formulaEvaluator: null, __lockBusy: false,
  };

  const ss = new FakeSpreadsheet(ctx, { timeZone, locale });
  ctx.__spreadsheet = ss;
  for (const s of sheets) {
    const rows = s.rows || [];
    const sheet = ss.addSheet_(s.name, undefined, {
      maxRows: Math.max(1000, rows.length),
      maxCols: Math.max(26, ...rows.map((r) => r.length)),
    });
    rows.forEach((line, i) => line.forEach((v, j) => sheet.write_(i + 1, j + 1, v)));
  }
  ss.active_ = ss.sheets_[0] || null;

  // Logging
  const log = (...a) => { ctx.__logs.push(a); };
  ctx.console = { log, info: log, warn: log, error: log, debug: log };
  ctx.Logger = { log: (...a) => { log(...a); return ctx.Logger; }, getLog: () => ctx.__logs.map((a) => a.join(' ')).join('\n'), clear: () => { ctx.__logs.length = 0; } };

  // SpreadsheetApp
  const ButtonSet = enumOf(['OK', 'OK_CANCEL', 'YES_NO', 'YES_NO_CANCEL']);
  const Button = enumOf(['OK', 'CANCEL', 'YES', 'NO', 'CLOSE']);
  const defaultButton = (set) => (set === 'YES_NO' || set === 'YES_NO_CANCEL' ? 'YES' : 'OK');
  const ui = {
    Button, ButtonSet,
    createMenu: (caption) => new FakeMenu(caption, ctx),
    createAddonMenu: () => new FakeMenu('Add-on', ctx),
    alert: (...a) => {
      let title = ''; let message; let buttons = 'OK';
      if (a.length === 1) [message] = a;
      else if (a.length === 2 && ButtonSet[a[1]]) [message, buttons] = a;
      else [title, message, buttons = 'OK'] = a;
      const scripted = ctx.__uiResponses.length ? ctx.__uiResponses.shift() : defaultButton(buttons);
      const response = typeof scripted === 'object' ? scripted.button : scripted;
      ctx.__alerts.push({ title, message, buttons, response });
      return response;
    },
    prompt: (...a) => {
      let title = ''; let message; let buttons = 'OK';
      if (a.length === 1) [message] = a;
      else if (a.length === 2 && ButtonSet[a[1]]) [message, buttons] = a;
      else [title, message, buttons = 'OK'] = a;
      const scripted = ctx.__uiResponses.length ? ctx.__uiResponses.shift() : { button: defaultButton(buttons), text: '' };
      const answer = typeof scripted === 'string' ? { button: defaultButton(buttons), text: scripted } : { button: defaultButton(buttons), text: '', ...scripted };
      ctx.__prompts.push({ title, message, buttons, response: answer });
      return { getResponseText: () => answer.text, getSelectedButton: () => answer.button };
    },
    showModalDialog: (out, title) => { ctx.__dialogs.push({ kind: 'modal', title, html: out.getContent(), width: out.getWidth(), height: out.getHeight() }); },
    showModelessDialog: (out, title) => { ctx.__dialogs.push({ kind: 'modeless', title, html: out.getContent(), width: out.getWidth(), height: out.getHeight() }); },
    showSidebar: (out) => { ctx.__dialogs.push({ kind: 'sidebar', title: out.getTitle(), html: out.getContent(), width: out.getWidth(), height: out.getHeight() }); },
  };
  ctx.SpreadsheetApp = {
    getActive: () => ss,
    getActiveSpreadsheet: () => ss,
    getActiveSheet: () => ss.getActiveSheet(),
    getActiveRange: () => ss.getActiveRange(),
    setActiveSheet: (s) => ss.setActiveSheet(s),
    setActiveRange: (r) => ss.setActiveRange(r),
    getUi: () => ui,
    flush: () => {},
    newDataValidation: () => new FakeDataValidationBuilder(),
    newConditionalFormatRule: () => new FakeConditionalFormatRuleBuilder(),
    DataValidationCriteria: enumOf(DV_CRITERIA),
    BooleanCriteria: enumOf(BOOLEAN_CRITERIA),
    ProtectionType: enumOf(['RANGE', 'SHEET']),
    BorderStyle: Object.freeze({ ...BORDER_STYLE }),
    WrapStrategy: enumOf(['WRAP', 'OVERFLOW', 'CLIP']),
    Dimension: enumOf(['ROWS', 'COLUMNS']),
    SheetType: enumOf(['GRID', 'OBJECT', 'DATASOURCE']),
  };
  ctx.Charts = {
    ChartType: enumOf(CHART_TYPES),
    Position: enumOf(['TOP', 'RIGHT', 'BOTTOM', 'NONE']),
    CurveStyle: enumOf(['NORMAL', 'SMOOTH']),
    PointStyle: enumOf(['NONE', 'TINY', 'MEDIUM', 'LARGE', 'HUGE']),
    ChartMergeStrategy: enumOf(['MERGE_COLUMNS', 'MERGE_ROWS']),
    ChartHiddenDimensionStrategy: enumOf(['IGNORE_BOTH', 'IGNORE_ROWS', 'IGNORE_COLUMNS', 'SHOW_BOTH']),
  };

  ctx.HtmlService = {
    createHtmlOutput: (html) => new FakeHtmlOutput(html === undefined ? '' : html),
    createHtmlOutputFromFile: (name) => {
      if (!(name in htmlFiles)) throw new Error(`No HTML file named ${name} was found.`);
      return new FakeHtmlOutput(htmlFiles[name]);
    },
    createTemplate: (src) => new FakeHtmlTemplate(src),
    createTemplateFromFile: (name) => {
      if (!(name in htmlFiles)) throw new Error(`No HTML file named ${name} was found.`);
      return new FakeHtmlTemplate(htmlFiles[name]);
    },
    SandboxMode: enumOf(['IFRAME', 'NATIVE', 'EMULATED']),
    XFrameOptionsMode: enumOf(['ALLOWALL', 'DEFAULT']),
  };

  // ScriptApp
  let triggerSeq = 0;
  const wrapTrigger = (t) => ({
    getHandlerFunction: () => t.handler,
    getEventType: () => t.eventType,
    getTriggerSource: () => t.source,
    getTriggerSourceId: () => t.sourceId,
    getUniqueId: () => t.id,
  });
  const triggerBuilder = (handler) => {
    const t = { handler, eventType: null, source: null, sourceId: null, schedule: {} };
    const create = () => { t.id = `trigger-${++triggerSeq}`; ctx.__triggers.push(t); return wrapTrigger(t); };
    const clockB = {
      at: (d) => { t.schedule.at = new HostDate(d).toISOString(); return clockB; },
      after: (ms) => { t.schedule.after = ms; return clockB; },
      everyMinutes: (n) => { t.schedule.everyMinutes = n; return clockB; },
      everyHours: (n) => { t.schedule.everyHours = n; return clockB; },
      everyDays: (n) => { t.schedule.everyDays = n; return clockB; },
      everyWeeks: (n) => { t.schedule.everyWeeks = n; return clockB; },
      onWeekDay: (d) => { t.schedule.onWeekDay = d; return clockB; },
      onMonthDay: (d) => { t.schedule.onMonthDay = d; return clockB; },
      atHour: (h) => { t.schedule.atHour = h; return clockB; },
      nearMinute: (m) => { t.schedule.nearMinute = m; return clockB; },
      inTimezone: (tz) => { t.schedule.timezone = tz; return clockB; },
      create,
    };
    const ssB = {
      onEdit: () => { t.eventType = 'ON_EDIT'; return ssB; },
      onOpen: () => { t.eventType = 'ON_OPEN'; return ssB; },
      onChange: () => { t.eventType = 'ON_CHANGE'; return ssB; },
      onFormSubmit: () => { t.eventType = 'ON_FORM_SUBMIT'; return ssB; },
      create,
    };
    return {
      timeBased: () => { t.eventType = 'CLOCK'; t.source = 'CLOCK'; return clockB; },
      forSpreadsheet: (target) => { t.source = 'SPREADSHEETS'; t.sourceId = typeof target === 'string' ? target : target.getId(); return ssB; },
    };
  };
  ctx.ScriptApp = {
    newTrigger: triggerBuilder,
    getProjectTriggers: () => ctx.__triggers.map(wrapTrigger),
    getUserTriggers: () => ctx.__triggers.map(wrapTrigger),
    deleteTrigger: (trigger) => {
      const id = trigger.getUniqueId();
      const i = ctx.__triggers.findIndex((t) => t.id === id);
      if (i >= 0) ctx.__triggers.splice(i, 1);
    },
    getScriptId: () => 'fake-script-id',
    EventType: enumOf(['CLOCK', 'ON_OPEN', 'ON_EDIT', 'ON_FORM_SUBMIT', 'ON_CHANGE', 'ON_EVENT_UPDATED']),
    TriggerSource: enumOf(['SPREADSHEETS', 'CLOCK', 'FORMS', 'DOCUMENTS', 'CALENDAR']),
    WeekDay: enumOf(['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY']),
    AuthMode: enumOf(['NONE', 'CUSTOM_FUNCTION', 'LIMITED', 'FULL']),
  };

  // Properties, locks, cache
  const makeProps = (store) => {
    const api = {
      getProperty: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
      setProperty: (k, v) => { store[k] = String(v); return api; },
      getProperties: () => ({ ...store }),
      setProperties: (obj, deleteAllOthers) => {
        if (deleteAllOthers) Object.keys(store).forEach((k) => delete store[k]);
        Object.entries(obj).forEach(([k, v]) => { store[k] = String(v); });
        return api;
      },
      deleteProperty: (k) => { delete store[k]; return api; },
      deleteAllProperties: () => { Object.keys(store).forEach((k) => delete store[k]); return api; },
      getKeys: () => Object.keys(store),
    };
    return api;
  };
  const stores = {
    script: Object.fromEntries(Object.entries(properties).map(([k, v]) => [k, String(v)])),
    user: Object.fromEntries(Object.entries(userProperties).map(([k, v]) => [k, String(v)])),
    document: Object.fromEntries(Object.entries(documentProperties).map(([k, v]) => [k, String(v)])),
  };
  ctx.__properties = stores.script;
  ctx.__userProperties = stores.user;
  ctx.__documentProperties = stores.document;
  ctx.PropertiesService = {
    getScriptProperties: () => makeProps(stores.script),
    getUserProperties: () => makeProps(stores.user),
    getDocumentProperties: () => makeProps(stores.document),
  };

  const makeLock = (kind) => {
    let held = false;
    return {
      waitLock: (ms) => {
        ctx.__locks.push('wait');
        if (ctx.__lockBusy) throw new Error(`Lock timeout: another process was holding the ${kind} lock for too long (${ms} ms).`);
        held = true;
      },
      tryLock: () => { ctx.__locks.push('try'); if (ctx.__lockBusy) return false; held = true; return true; },
      releaseLock: () => { ctx.__locks.push('release'); held = false; },
      hasLock: () => held,
    };
  };
  ctx.LockService = { getScriptLock: () => makeLock('script'), getDocumentLock: () => makeLock('document'), getUserLock: () => makeLock('user') };

  const caches = { script: new Map(), user: new Map(), document: new Map() };
  const makeCache = (store) => {
    const alive = (k) => { const e = store.get(k); if (!e) return null; if (e.expires <= FakeDate.now()) { store.delete(k); return null; } return e.value; };
    return {
      get: (k) => alive(k),
      getAll: (keys) => Object.fromEntries(keys.map((k) => [k, alive(k)]).filter(([, v]) => v !== null)),
      put: (k, v, ttl = 600) => { store.set(k, { value: String(v), expires: FakeDate.now() + Math.min(ttl, 21600) * 1000 }); },
      putAll: (obj, ttl = 600) => { Object.entries(obj).forEach(([k, v]) => store.set(k, { value: String(v), expires: FakeDate.now() + Math.min(ttl, 21600) * 1000 })); },
      remove: (k) => { store.delete(k); },
      removeAll: (keys) => { keys.forEach((k) => store.delete(k)); },
    };
  };
  ctx.CacheService = { getScriptCache: () => makeCache(caches.script), getUserCache: () => makeCache(caches.user), getDocumentCache: () => makeCache(caches.document) };

  // Utilities, Session
  let uuidSeq = 0;
  const makeBlob = (data, contentType, name) => {
    let bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data || []);
    const blob = {
      getDataAsString: () => bytes.toString('utf8'),
      getBytes: () => [...bytes].map((b) => (b > 127 ? b - 256 : b)),
      setDataFromString: (s) => { bytes = Buffer.from(s, 'utf8'); return blob; },
      getContentType: () => contentType || null,
      setContentType: (t) => { contentType = t; return blob; },
      getName: () => name || null,
      setName: (n) => { name = n; return blob; },
      copyBlob: () => makeBlob(Buffer.from(bytes), contentType, name),
    };
    return blob;
  };
  const toBuffer = (d) => (typeof d === 'string' ? Buffer.from(d, 'utf8') : Buffer.from(d.map((b) => (b < 0 ? b + 256 : b))));
  ctx.Utilities = {
    formatDate: (d, tz, pattern) => formatDate(d, tz, pattern),
    parseDate: (text, tz, pattern) => parseDate(text, tz, pattern),
    newBlob: makeBlob,
    getUuid: () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`,
    sleep: (ms) => { ctx.__sleeps.push(ms); if (clock.now !== null) clock.now += ms; },
    base64Encode: (d) => toBuffer(d).toString('base64'),
    base64EncodeWebSafe: (d) => toBuffer(d).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
    base64Decode: (s) => [...Buffer.from(s, 'base64')].map((b) => (b > 127 ? b - 256 : b)),
    Charset: enumOf(['US_ASCII', 'UTF_8']),
  };
  ctx.Session = {
    getScriptTimeZone: () => timeZone,
    getActiveUser: () => ({ getEmail: () => userEmail }),
    getEffectiveUser: () => ({ getEmail: () => userEmail }),
    getActiveUserLocale: () => locale.split('_')[0],
    getTemporaryActiveUserKey: () => 'fake-user-key',
  };

  // Bot web app services (as in apps/sheet)
  const responses = [...fetchResponses];
  ctx.UrlFetchApp = {
    fetch: (url, opts) => {
      ctx.__fetchCalls.push({ url, options: opts });
      const next = responses.length ? responses.shift() : { code: 200, body: '{}' };
      if (next instanceof Error) throw next;
      return { getResponseCode: () => next.code, getContentText: () => next.body };
    },
  };
  ctx.ContentService = {
    MimeType: { TEXT: 'text', JSON: 'json' },
    createTextOutput: (text) => ({ text, mimeType: 'text', setMimeType(m) { this.mimeType = m; return this; }, getContent() { return this.text; } }),
  };

  // Test drivers
  ctx.__simulateEdit = (sheetName, a1, value) => {
    const range = ss.getSheetByName(sheetName).getRange(a1);
    const oldValue = range.getValue();
    range.setValue(value);
    const e = { range, value, oldValue, source: ss, user: { getEmail: () => userEmail }, authMode: 'FULL' };
    if (typeof ctx.onEdit === 'function') ctx.onEdit({ ...e, authMode: 'LIMITED' });
    for (const t of ctx.__triggers.filter((x) => x.eventType === 'ON_EDIT')) {
      if (typeof ctx[t.handler] !== 'function') throw new Error(`Trigger handler ${t.handler} is not defined`);
      ctx[t.handler]({ ...e, triggerUid: t.id });
    }
    return e;
  };
  ctx.__fireTrigger = (handler) => {
    const t = ctx.__triggers.find((x) => x.handler === handler);
    if (!t) throw new Error(`No trigger for ${handler}`);
    return ctx[handler]({ triggerUid: t.id, authMode: 'FULL' });
  };

  if (fixture) loadFixture(ctx, fixture, { useCachedValues });
  return ctx;
}

module.exports = {
  createContext, loadFixture, snapshot, formatDate, parseA1, a1Of, rectsFromCells, colToIndex, indexToCol,
  FakeSpreadsheet, FakeSheet, FakeRange, FakeRangeList, FakeDataValidation, FakeDataValidationBuilder,
  FakeConditionalFormatRule, FakeConditionalFormatRuleBuilder, FakeProtection, FakeEmbeddedChart,
  FakeChartBuilder, FakeMenu, FakeHtmlOutput, FakeHtmlTemplate,
};

// --- core additions ---
// Other modules may extend the fakes below this line (e.g. FakeRange.prototype.x = function () {...};
// and add the name to module.exports). Keep additions explicit and documented in the header.

/** Read-only view of the grid as the v1 fakes stored it: formulas as text, '' for empty cells. */
Object.defineProperty(FakeSheet.prototype, 'rows', {
  get() {
    const last = this.getLastRow();
    const out = [];
    for (let r = 1; r <= last; r++) {
      const line = this.grid_[r - 1] || [];
      const row = [];
      for (let c = 0; c < line.length; c++) {
        const cell = line[c];
        row.push(!cell ? '' : cell.f ? cell.f : copyValue(cell.v));
      }
      out.push(row);
    }
    return out;
  },
});
/** Map sheet name -> sheet, in tab order (v1 fakes). */
Object.defineProperty(FakeSpreadsheet.prototype, 'sheets', {
  get() { return new Map(this.sheets_.map((s) => [s.name_, s])); },
});
/** v1 cell accessors: raw value (formula text for formulas, '' when empty) and raw write. */
FakeSheet.prototype.cell_ = function cell(r, c) {
  const found = this.cellAt_(r, c);
  if (!found) return '';
  return found.f ? found.f : copyValue(found.v);
};
FakeSheet.prototype.setCell_ = function setCell(r, c, v) { this.write_(r, c, v); };
