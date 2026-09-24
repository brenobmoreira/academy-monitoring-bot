/**
 * Undo log: the last writes of diary.upsert and workout.upsert, each with the previous content of
 * every cell it changed, in Script Property UNDO_LOG (JSON array, oldest first). catalog.recent
 * reads the same entries (UndoLog.recent), so each one also keeps a summary: when, which op, date, session,
 * field names or exercise names.
 *
 * Only cells a write actually set are captured, so formula columns it never touches are never
 * restored either. Undo puts the captured values back; a row the write created gets its cells
 * back to empty (cleared, not deleted, so the rows of later writes keep their numbers).
 *
 * Entry: {id, at, op, sheet, date, session?, fields?, exercises?, rows, undone?}
 *   rows: [{r: row, n?: 1 (created by the write), c: [col | [col, before]]}]; a bare col means the
 *   cell was empty; before is a plain value, {d: iso} for a date or {f: '=...'} for a formula.
 * An undone entry drops its rows; one too large for the property keeps only its summary.
 */
const UndoLog = {
  PROPERTY: 'UNDO_LOG',
  MAX_ENTRIES: 30,
  /** Script Properties hold at most 9 kB per value; the margin covers the key and rounding. */
  MAX_BYTES: 8800,
  /** How far back catalog.recent looks. */
  RECENT_MINUTES: 30,

  /** A recorder the repos write through; see UndoCapture_. */
  capture() {
    return new UndoCapture_();
  },

  /**
   * Appends the write to the log and returns its id. The sheet is already written at this point,
   * so a log failure is reported to the console and costs only the id, never the write.
   * @param {UndoCapture_} capture
   * @param {{op: string, date: string, session?: string, fields?: string[], exercises?: string[]}} summary
   * @returns {string|null}
   */
  record(capture, summary) {
    try {
      const log = UndoLog.read_();
      const entry = { id: UndoLog.newId_(log), at: new Date().toISOString(), ...summary, sheet: capture.sheetName, rows: capture.rows };
      log.push(entry);
      UndoLog.save_(log);
      return entry.id;
    } catch (err) {
      console.error(err);
      return null;
    }
  },

  /**
   * Restores the cells of one write: `writeId`, or the most recent write not yet undone.
   * Refuses when the row no longer holds the write's date (sorted, deleted or cleared by hand, or
   * an older write undone out of order), since restoring would then overwrite another day.
   * @returns {{writeId: string, undone: {op, date, session?, fields?, exercises?}}}
   */
  undo(writeId) {
    const log = UndoLog.read_();
    let entry;
    if (writeId === undefined) {
      entry = log.slice().reverse().find((e) => !e.undone);
      if (!entry) throw UndoLog.error_('args', 'nothing_to_undo', 'nada para desfazer: nenhuma gravação recente pendente');
    } else {
      entry = log.find((e) => e.id === writeId);
      if (!entry) throw UndoLog.error_('args.writeId', 'not_found', `gravação ${JSON.stringify(writeId)} não encontrada; o registro guarda só as últimas ${UndoLog.MAX_ENTRIES}`);
      if (entry.undone) throw UndoLog.error_('args.writeId', 'already_undone', `gravação ${writeId} já foi desfeita`);
    }
    if (!entry.rows) throw UndoLog.error_('args.writeId', 'not_undoable', 'gravação grande demais para o registro de desfazer; corrija direto na planilha');

    const sheet = SpreadsheetApp.getActive().getSheetByName(entry.sheet);
    if (!sheet) throw new Error(`Sheet "${entry.sheet}" not found`);
    const dateCol = Sheets.columnIndex(sheet, Config.headerRow())[Schema.DATE_HEADER];
    if (!dateCol) throw new Error(`Header "${Schema.DATE_HEADER}" not found on row ${Config.headerRow()}`);
    const moved = entry.rows.filter((r) => {
      const v = sheet.getRange(r.r, dateCol).getValue();
      return !(v instanceof Date) || Sheets.dayKey(v) !== entry.date;
    });
    if (moved.length) {
      throw UndoLog.error_('args.writeId', 'conflict', `a linha ${moved.map((r) => r.r).join(', ')} de "${entry.sheet}" não é mais de ${entry.date}; nada foi desfeito, corrija direto na planilha`);
    }

    entry.rows.forEach((r) => r.c.forEach((cell) => {
      const [col, before] = Array.isArray(cell) ? cell : [cell, ''];
      const range = sheet.getRange(r.r, col);
      if (before !== null && typeof before === 'object' && before.f !== undefined) range.setFormula(before.f);
      else if (before !== null && typeof before === 'object' && before.d !== undefined) range.setValue(new Date(before.d));
      else range.setValue(before);
    }));
    entry.undone = new Date().toISOString();
    delete entry.rows;
    UndoLog.save_(log);
    return { writeId: entry.id, undone: UndoLog.summary_(entry) };
  },

  /**
   * Writes of the last RECENT_MINUTES not undone, newest first, as summaries the model can use
   * to continue or correct them (catalog.recent).
   * @returns {{writeId: string, at: string, op: string, date: string, session?: string, fields?: string[], exercises?: string[]}[]}
   */
  recent() {
    const since = Date.now() - UndoLog.RECENT_MINUTES * 60 * 1000;
    return UndoLog.read_()
      .filter((e) => !e.undone && Date.parse(e.at) >= since)
      .reverse()
      .map((e) => ({ writeId: e.id, at: e.at, ...UndoLog.summary_(e) }));
  },

  /** Entries oldest first; a missing or unreadable property is an empty log. */
  read_() {
    const text = PropertiesService.getScriptProperties().getProperty(UndoLog.PROPERTY);
    if (!text) return [];
    try {
      const log = JSON.parse(text);
      return Array.isArray(log) ? log : [];
    } catch (err) {
      console.error(err);
      return [];
    }
  },

  /** Keeps the newest MAX_ENTRIES that fit in MAX_BYTES; the newest alone keeps its summary. */
  save_(log) {
    let kept = log.slice(-UndoLog.MAX_ENTRIES);
    while (kept.length > 1 && UndoLog.bytes_(JSON.stringify(kept)) > UndoLog.MAX_BYTES) kept = kept.slice(1);
    if (UndoLog.bytes_(JSON.stringify(kept)) > UndoLog.MAX_BYTES) delete kept[0].rows;
    PropertiesService.getScriptProperties().setProperty(UndoLog.PROPERTY, JSON.stringify(kept));
  },

  summary_(entry) {
    const out = { op: entry.op, date: entry.date };
    ['session', 'fields', 'exercises'].forEach((k) => { if (entry[k] !== undefined) out[k] = entry[k]; });
    return out;
  },

  /** 12 chars: time in base 36 plus 4 random ones, unique within the log. */
  newId_(log) {
    let id;
    do {
      id = Date.now().toString(36) + Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0');
    } while (log.some((e) => e.id === id));
    return id;
  },

  /** UTF-8 length, which is what the property limit counts. */
  bytes_(text) {
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      n += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code < 0xe000 ? 2 : 3;
    }
    return n;
  },

  /** An API error SheetApi.run returns as {ok: false, errors}. */
  error_(path, code, message) {
    const err = new Error(message);
    err.apiErrors = [{ path, code, message }];
    return err;
  },
};

/**
 * Writes cells and remembers what each held before. The first cell set on a row reads the whole
 * row once (values and formulas); a cell set to what it already held is not recorded.
 */
class UndoCapture_ {
  constructor() {
    this.sheetName = null;
    this.rows = [];
    this.snapshots_ = {};
  }

  /** Marks a row the write creates (its date cell was empty). */
  newRow(sheet, row) {
    this.row_(sheet, row).record.n = 1;
  }

  set(sheet, row, col, value) {
    const { record, values, formulas } = this.row_(sheet, row);
    const old = col <= values.length ? values[col - 1] : '';
    const formula = col <= formulas.length ? formulas[col - 1] : '';
    const done = record.c.some((cell) => (Array.isArray(cell) ? cell[0] : cell) === col);
    if (!done && (formula || !UndoCapture_.same_(old, value))) {
      if (formula) record.c.push([col, { f: formula }]);
      else if (old === '' || old === null || old === undefined) record.c.push(col);
      else record.c.push([col, old instanceof Date ? { d: old.toISOString() } : old]);
    }
    sheet.getRange(row, col).setValue(value);
  }

  row_(sheet, row) {
    if (this.sheetName === null) this.sheetName = sheet.getName();
    if (sheet.getName() !== this.sheetName) throw new Error(`one write, one sheet: "${this.sheetName}" then "${sheet.getName()}"`);
    if (!this.snapshots_[row]) {
      const lastCol = sheet.getLastColumn();
      const range = lastCol ? sheet.getRange(row, 1, 1, lastCol) : null;
      const record = { r: row, c: [] };
      this.rows.push(record);
      this.snapshots_[row] = { record, values: range ? range.getValues()[0] : [], formulas: range ? range.getFormulas()[0] : [] };
    }
    return this.snapshots_[row];
  }

  static same_(a, b) {
    if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    return a === b;
  }
}
