/**
 * In-memory stand-ins for the Apps Script services the code touches.
 * Only the subset of the API that src/ uses is implemented.
 */
'use strict';

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function parseA1(a1) {
  const m = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(a1);
  if (!m) throw new Error(`Unsupported A1 notation: ${a1}`);
  const row = Number(m[2]);
  const col = colToIndex(m[1]);
  if (!m[3]) return { row, col, numRows: 1, numCols: 1 };
  return { row, col, numRows: Number(m[4]) - row + 1, numCols: colToIndex(m[3]) - col + 1 };
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const line = [];
      for (let c = 0; c < this.numCols; c++) line.push(this.sheet.cell_(this.row + r, this.col + c));
      out.push(line);
    }
    return out;
  }
  getDisplayValues() {
    return this.getValues().map((line) => line.map((v) => {
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      return v === null || v === undefined ? '' : String(v);
    }));
  }
  /** Cells hold formulas as text starting with "="; any other cell has no formula. */
  getFormulas() {
    return this.getValues().map((line) => line.map((v) => (typeof v === 'string' && v.startsWith('=') ? v : '')));
  }
  getValue() { return this.getValues()[0][0]; }
  setValues(values) {
    if (values.length !== this.numRows || values[0].length !== this.numCols) {
      throw new Error(`setValues shape ${values.length}x${values[0].length} != ${this.numRows}x${this.numCols}`);
    }
    values.forEach((line, r) => line.forEach((v, c) => this.sheet.setCell_(this.row + r, this.col + c, v)));
    return this;
  }
  setValue(v) { this.sheet.setCell_(this.row, this.col, v); return this; }
  setFormula(f) { this.sheet.setCell_(this.row, this.col, f); return this; }
  clearContent() {
    for (let r = 0; r < this.numRows; r++) for (let c = 0; c < this.numCols; c++) this.sheet.setCell_(this.row + r, this.col + c, '');
    return this;
  }
}

class FakeSheet {
  constructor(name, rows = []) {
    this.name = name;
    this.rows = rows.map((r) => [...r]);
  }
  getName() { return this.name; }
  cell_(r, c) {
    const line = this.rows[r - 1];
    if (!line || line[c - 1] === undefined || line[c - 1] === null) return '';
    return line[c - 1];
  }
  setCell_(r, c, v) {
    while (this.rows.length < r) this.rows.push([]);
    const line = this.rows[r - 1];
    while (line.length < c) line.push('');
    line[c - 1] = v;
  }
  getRange(a, b, c, d) {
    if (typeof a === 'string') { const p = parseA1(a); return new FakeRange(this, p.row, p.col, p.numRows, p.numCols); }
    return new FakeRange(this, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
  }
  getLastRow() {
    for (let r = this.rows.length; r >= 1; r--) {
      if (this.rows[r - 1].some((v) => v !== '' && v !== null && v !== undefined)) return r;
    }
    return 0;
  }
  getLastColumn() {
    return this.rows.reduce((max, line) => {
      let last = 0;
      line.forEach((v, i) => { if (v !== '' && v !== null && v !== undefined) last = i + 1; });
      return Math.max(max, last);
    }, 0);
  }
  appendRow(values) { this.setCell_(this.getLastRow() + 1, 1, values[0]); values.forEach((v, i) => this.setCell_(this.getLastRow(), i + 1, v)); return this; }
  setFrozenRows() { return this; }
}

class FakeSpreadsheet {
  constructor(sheets) { this.sheets = new Map(sheets.map((s) => [s.name, s])); }
  getSheetByName(name) { return this.sheets.get(name) || null; }
  insertSheet(name) { const s = new FakeSheet(name); this.sheets.set(name, s); return s; }
}

function formatDate(date, tz, pattern) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]));
  return pattern
    .replace('yyyy', parts.year).replace('MM', parts.month).replace('dd', parts.day)
    .replace('HH', parts.hour === '24' ? '00' : parts.hour).replace('mm', parts.minute);
}

function createContext({ sheets = [], properties = {}, fetchResponses = [], now } = {}) {
  const spreadsheet = new FakeSpreadsheet(sheets.map((s) => new FakeSheet(s.name, s.rows)));
  const props = { ...properties };
  const fetchCalls = [];
  const sentMessages = [];
  const triggers = [];
  const logs = [];

  const ctx = {
    console: { log: (...a) => logs.push(a), error: (...a) => logs.push(a), warn: (...a) => logs.push(a) },
    JSON, Object, Array, Number, String, Boolean, Math, Date, Error, RegExp, Map, Set, Intl,
    __fetchCalls: fetchCalls, __sentMessages: sentMessages, __triggers: triggers, __logs: logs, __spreadsheet: spreadsheet, __properties: props,
    SpreadsheetApp: {
      getActive: () => spreadsheet,
      getActiveSpreadsheet: () => spreadsheet,
      getUi: () => ({
        createMenu: (name) => {
          const menu = { name, items: [], addItem(label, fn) { this.items.push([label, fn]); return this; }, addToUi() { ctx.__menus.push(menu); } };
          return menu;
        },
        alert: (msg) => ctx.__alerts.push(msg),
      }),
    },
    __menus: [], __alerts: [], __locks: [],
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in props ? props[k] : null),
        setProperty: (k, v) => { props[k] = v; },
      }),
    },
    Session: { getScriptTimeZone: () => 'America/Sao_Paulo' },
    Utilities: { formatDate },
    UrlFetchApp: {
      fetch: (url, options) => {
        fetchCalls.push({ url, options });
        const next = fetchResponses.length ? fetchResponses.shift() : { code: 200, body: '{}' };
        if (next instanceof Error) throw next;
        return { getResponseCode: () => next.code, getContentText: () => next.body };
      },
    },
    ContentService: {
      MimeType: { TEXT: 'text', JSON: 'json' },
      createTextOutput: (text) => ({ text, mimeType: 'text', setMimeType(m) { this.mimeType = m; return this; } }),
    },
    LockService: {
      getScriptLock: () => ({ waitLock: () => { ctx.__locks.push('wait'); }, releaseLock: () => { ctx.__locks.push('release'); } }),
    },
    ScriptApp: {
      getProjectTriggers: () => triggers.map((t) => ({ getHandlerFunction: () => t.fn, ...t })),
      deleteTrigger: (t) => { const i = triggers.findIndex((x) => x.fn === t.fn); if (i >= 0) triggers.splice(i, 1); },
      newTrigger: (fn) => {
        const t = { fn };
        const b = { timeBased: () => b, everyDays: (n) => { t.everyDays = n; return b; }, atHour: (h) => { t.atHour = h; return b; }, create: () => { triggers.push(t); return t; } };
        return b;
      },
    },
  };
  if (now) ctx.Date = class extends Date { constructor(...a) { a.length ? super(...a) : super(now); } static now() { return new Date(now).getTime(); } };
  return ctx;
}

module.exports = { createContext, FakeSheet, formatDate };
