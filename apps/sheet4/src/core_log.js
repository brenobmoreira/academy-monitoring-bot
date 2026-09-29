/**
 * Script lock, a tiny event bus, the change log and undo (spec §5.3–5.4).
 *
 * Every write made through Tabs while an action runs (ChangeLog.run) is appended to the hidden
 * Log tab *before* the sheet is written: one Log row per changed row (or per group of layout
 * cells), all rows of one action sharing `ID ação`. A change is
 *   {kind: 'update'|'append'|'delete'|'cells', tab: sheet name, row, before, after}
 * with before/after as {header text (or '#col', or A1 for 'cells'): value}; `before` is null for
 * an append and `after` null for a delete. JSON encodes dates as {"$d": iso} and formulas as
 * {"$f": "=..."}.
 *
 * Undo.last() restores the latest action not yet undone, across every tab it touched, in reverse
 * order: updated cells get their old values, appended rows are deleted, deleted rows are
 * re-inserted. It first checks that every touched cell still holds what the action wrote and
 * refuses otherwise (the sheet was edited since), so it never overwrites someone else's data.
 * Undo writes are not logged (undoing twice goes one action further back, never "redo").
 */
const Core = {
  LOCK_TIMEOUT_MS: 30000,
  lockDepth_: 0,
  listeners_: {},

  /**
   * Runs fn holding the script lock (re-entrant within one execution).
   * @template T
   * @param {function(): T} fn
   * @returns {T}
   */
  withLock(fn, timeoutMs) {
    if (Core.lockDepth_ > 0) {
      Core.lockDepth_++;
      try { return fn(); } finally { Core.lockDepth_--; }
    }
    const lock = LockService.getScriptLock();
    try {
      lock.waitLock(timeoutMs || Core.LOCK_TIMEOUT_MS);
    } catch (err) {
      throw new Error('Outra alteração está em andamento. Tente de novo em alguns segundos.');
    }
    Core.lockDepth_ = 1;
    try {
      return fn();
    } finally {
      Core.lockDepth_ = 0;
      lock.releaseLock();
    }
  },

  /** Subscribes to an event (e.g. 'phase.changed'); listeners run synchronously in order. */
  on(event, fn) {
    (Core.listeners_[event] = Core.listeners_[event] || []).push(fn);
  },

  /** Calls every listener of the event with payload; returns the payload. */
  emit(event, payload) {
    (Core.listeners_[event] || []).forEach((fn) => fn(payload));
    return payload;
  },
};

const ChangeLog = {
  KIND_LABELS: { update: 'Alteração', append: 'Inclusão', delete: 'Exclusão', cells: 'Células' },

  /** The action being recorded: {id, label} or null. */
  current_: null,
  /** Changes tracked in the current action, for rollback on error. */
  pending_: [],

  active() {
    return ChangeLog.current_ ? { id: ChangeLog.current_.id, label: ChangeLog.current_.label } : null;
  },

  /** Changes recorded so far by the running action (0 when none runs). */
  changeCount() {
    return ChangeLog.current_ ? ChangeLog.pending_.length : 0;
  },

  /**
   * Runs fn as one undoable action. Nested calls join the outer action. When fn throws, the
   * changes it made are reverted (newest first), their Log rows marked undone, and the error
   * rethrown.
   */
  run(label, fn) {
    if (ChangeLog.current_) return fn();
    ChangeLog.current_ = { id: ChangeLog.newId_(), label };
    ChangeLog.pending_ = [];
    let result;
    let tabs;
    try {
      result = fn();
      tabs = ChangeLog.touched_();
    } catch (err) {
      ChangeLog.rollback_();
      throw err;
    } finally {
      ChangeLog.current_ = null;
      ChangeLog.pending_ = [];
    }
    // After the action closes, so listeners' own writes (derived tabs) are not part of it.
    if (tabs.length) Core.emit('action.committed', { label, tabs });
    return result;
  },

  /** Names of the tabs written by the running action. */
  touched_() {
    const names = [];
    ChangeLog.pending_.forEach((p) => { if (p.change.tab && !names.includes(p.change.tab)) names.push(p.change.tab); });
    return names;
  },

  /** Called by Tabs before each write; logs only while an action runs. */
  track(change) {
    if (!ChangeLog.current_) return;
    const row = ChangeLog.write_(ChangeLog.current_, change);
    ChangeLog.pending_.push({ change, logRow: row });
  },

  /**
   * Logs changes already described by the caller (writes made outside Tabs) as one new action.
   * @param {string} action label
   * @param {Object[]} changes [{kind, tab, row, before, after}]
   * @returns {string} action id
   */
  record(action, changes) {
    const act = ChangeLog.current_ || { id: ChangeLog.newId_(), label: action };
    changes.forEach((c) => {
      const row = ChangeLog.write_(act, c);
      if (ChangeLog.current_) ChangeLog.pending_.push({ change: c, logRow: row });
    });
    return act.id;
  },

  write_(act, change) {
    if (!ChangeLog.KIND_LABELS[change.kind]) throw new Error(`Unknown change kind: ${change.kind}`);
    Tabs.ensure('log');
    return Tabs.append('log', {
      at: new Date(),
      actionId: act.id,
      action: act.label,
      tab: change.tab,
      row: change.row === null || change.row === undefined ? null : change.row,
      kind: ChangeLog.KIND_LABELS[change.kind],
      before: change.before === null || change.before === undefined ? null : ChangeLog.encode(change.before),
      after: change.after === null || change.after === undefined ? null : ChangeLog.encode(change.after),
    });
  },

  rollback_() {
    const pending = ChangeLog.pending_.slice().reverse();
    // A change is tracked just before its write; skip one whose write never happened.
    pending.forEach((p) => {
      try { if (Undo.applied_(p.change)) Undo.revert_(p.change); } catch (err) { console.error(err); }
    });
    const now = new Date();
    pending.forEach((p) => {
      try { Tabs.update('log', p.logRow, { undone: now }); } catch (err) { console.error(err); }
    });
  },

  /** JSON with dates and formulas tagged. */
  encode(obj) {
    const out = {};
    Object.keys(obj).forEach((k) => {
      const v = obj[k];
      if (v instanceof Date) out[k] = { $d: v.toISOString() };
      else if (typeof v === 'string' && v.charAt(0) === '=') out[k] = { $f: v };
      else out[k] = v === undefined ? null : v;
    });
    return JSON.stringify(out);
  },

  decode(text) {
    if (text === null || text === undefined || text === '') return null;
    const obj = JSON.parse(text);
    const out = {};
    Object.keys(obj).forEach((k) => {
      const v = obj[k];
      if (v && typeof v === 'object' && v.$d !== undefined) out[k] = new Date(v.$d);
      else if (v && typeof v === 'object' && v.$f !== undefined) out[k] = v.$f;
      else out[k] = v === null ? '' : v;
    });
    return out;
  },

  /** Log rows as changes: [{logRow, at, actionId, action, kind, tab, row, before, after, undone}]. */
  entries() {
    if (!Tabs.findSheet('log')) return [];
    const kinds = {};
    Object.keys(ChangeLog.KIND_LABELS).forEach((k) => { kinds[ChangeLog.KIND_LABELS[k]] = k; });
    return Tabs.read('log').map((r) => ({
      logRow: r._row, at: r.at, actionId: r.actionId, action: r.action, kind: kinds[r.kind], tab: r.tab,
      row: r.row, before: ChangeLog.decode(r.before), after: ChangeLog.decode(r.after), undone: r.undone,
    }));
  },

  /** Actions in log order (oldest first): [{id, label, at, undone, changes}]. */
  actions() {
    const byId = {};
    const order = [];
    ChangeLog.entries().forEach((e) => {
      if (!byId[e.actionId]) {
        byId[e.actionId] = { id: e.actionId, label: e.action, at: e.at, undone: true, changes: [] };
        order.push(e.actionId);
      }
      const act = byId[e.actionId];
      act.changes.push(e);
      if (!e.undone) act.undone = false;
    });
    return order.map((id) => byId[id]);
  },

  /** 12 chars: time in base 36 plus random suffix. */
  newId_() {
    return Date.now().toString(36) + Math.floor(Math.random() * Math.pow(36, 4)).toString(36).padStart(4, '0');
  },
};

const Undo = {
  /**
   * Undoes the latest action not yet undone.
   * @returns {{actionId: string, action: string, changes: number}}
   */
  last() {
    const act = Undo.pending()[0];
    if (!act) throw Undo.error_('nothing_to_undo', 'Nada para desfazer.');
    return Undo.apply_(act);
  },

  /**
   * Undoes one action by id; only the latest pending action may be undone (row positions of
   * later actions depend on it).
   */
  action(actionId) {
    const pending = Undo.pending();
    const act = ChangeLog.actions().find((a) => a.id === actionId);
    if (!act) throw Undo.error_('not_found', `Ação ${actionId} não encontrada no Log.`);
    if (act.undone) throw Undo.error_('already_undone', `Ação ${actionId} já foi desfeita.`);
    if (pending[0].id !== actionId) throw Undo.error_('not_latest', `Só a última alteração pode ser desfeita; desfaça antes "${pending[0].label}".`);
    return Undo.apply_(act);
  },

  /** Actions not undone, newest first. */
  pending() {
    return ChangeLog.actions().filter((a) => !a.undone).reverse();
  },

  apply_(act) {
    const result = Core.withLock(() => {
      const changes = act.changes.filter((c) => !c.undone);
      const conflicts = [];
      changes.forEach((c, i) => {
        const later = changes.slice(i + 1);
        const row = Undo.currentRow_(c, later);
        if (row === null) return; // the row was deleted later in the same action
        const msg = Undo.conflict_(Object.assign({}, c, { row }), Undo.overwritten_(c, later));
        if (msg) conflicts.push(msg);
      });
      if (conflicts.length) {
        throw Undo.error_('conflict', `Não foi possível desfazer "${act.label}": ${conflicts.join('; ')}. Nada foi alterado; corrija direto na planilha.`);
      }
      changes.slice().reverse().forEach((c) => Undo.revert_(c));
      const now = new Date();
      changes.forEach((c) => Tabs.update('log', c.logRow, { undone: now }));
      Tabs.invalidate();
      if (typeof Config !== 'undefined') Config.invalidate();
      return { actionId: act.id, action: act.label, changes: changes.length, tabs: changes.map((c) => c.tab) };
    });
    Core.emit('action.committed', { label: act.label, tabs: result.tabs.filter((t, i, all) => all.indexOf(t) === i), undo: true });
    return result;
  },

  /**
   * Where the row of change c is now, given the changes made after it in the same action
   * (a later delete above it moves it up); null when a later change deleted it. Undo reverts in
   * reverse order, so by the time c is reverted its original row number is right again.
   */
  currentRow_(c, later) {
    if (c.kind === 'cells') return c.row;
    let row = c.row;
    for (let i = 0; i < later.length; i++) {
      const l = later[i];
      if (l.tab !== c.tab || l.kind !== 'delete') continue;
      if (l.row === row) return null;
      if (l.row < row) row--;
    }
    return row;
  },

  /**
   * Cells of change c that a later change of the same action wrote again (same tab and row):
   * those hold the later value, so only the latest write of a cell is checked for conflicts.
   */
  overwritten_(c, later) {
    const names = {};
    later.forEach((l) => {
      if (l.tab !== c.tab || l.row !== c.row || (l.kind !== 'update' && l.kind !== 'cells')) return;
      Object.keys(l.after || {}).forEach((n) => { names[n] = true; });
    });
    return names;
  },

  /** Why a change can no longer be undone, or null. `skip`: cell names not to check. */
  conflict_(c, skip) {
    const sheet = SpreadsheetApp.getActive().getSheetByName(c.tab);
    if (!sheet) return `aba "${c.tab}" não existe mais`;
    if (c.kind === 'delete') return null;
    const cells = Undo.locate_(sheet, c, c.after || {}).filter((x) => !(skip && skip[x.name]));
    const bad = cells.filter((x) => !x.col || !Undo.same_(Undo.cellValue_(x.range), x.value));
    if (!bad.length) return null;
    return c.kind === 'cells' ? `células ${bad.map((x) => x.name).join(', ')} de "${c.tab}" mudaram`
      : `linha ${c.row} de "${c.tab}" mudou (${bad.map((x) => x.name).join(', ')})`;
  },

  /** True when the sheet shows the change as done (used by rollback). */
  applied_(c) {
    if (c.kind !== 'delete') return !Undo.conflict_(c);
    const sheet = SpreadsheetApp.getActive().getSheetByName(c.tab);
    if (!sheet) return false;
    const still = Undo.locate_(sheet, c, c.before || {}).every((x) => x.col && Undo.same_(Undo.cellValue_(x.range), x.value));
    return !still;
  },

  /** Restores one change (no conflict check, no logging). */
  revert_(c) {
    const sheet = SpreadsheetApp.getActive().getSheetByName(c.tab);
    if (!sheet) throw new Error(`Aba "${c.tab}" não encontrada`);
    if (c.kind === 'append') {
      sheet.deleteRow(c.row);
    } else if (c.kind === 'delete') {
      if (c.row <= sheet.getLastRow()) sheet.insertRowBefore(c.row);
      Undo.locate_(sheet, c, c.before || {}).forEach((x) => { if (x.col) Undo.setCell_(x.range, x.value); });
    } else {
      Undo.locate_(sheet, c, c.before || {}).forEach((x) => { if (x.range) Undo.setCell_(x.range, x.value); });
    }
    Tabs.invalidate(c.tab);
  },

  /** [{name, col, range, value}] for the cells named in a snapshot of change c. */
  locate_(sheet, c, snapshot) {
    const names = Object.keys(snapshot);
    if (c.kind === 'cells') {
      return names.map((a1) => ({ name: a1, col: 1, range: sheet.getRange(a1), value: snapshot[a1] }));
    }
    const spec = typeof Tabs !== 'undefined' ? Tabs.byName(c.tab) : null;
    const headerRow = spec && spec.headerRow ? spec.headerRow : Tabs.HEADER_ROW;
    const lastCol = sheet.getLastColumn();
    const headers = lastCol ? sheet.getRange(headerRow, 1, 1, lastCol).getValues()[0] : [];
    const index = {};
    headers.forEach((h, i) => { const t = String(h).trim(); if (t && !(t in index)) index[t] = i + 1; });
    return names.map((name) => {
      const m = /^#(\d+)$/.exec(name);
      const col = m ? Number(m[1]) : index[name];
      return { name, col, range: col ? sheet.getRange(c.row, col) : null, value: snapshot[name] };
    });
  },

  cellValue_(range) {
    const f = range.getFormulas()[0][0];
    return f || range.getValue();
  },

  setCell_(range, value) {
    if (typeof value === 'string' && value.charAt(0) === '=') range.setFormula(value);
    else range.setValue(value === null || value === undefined ? '' : value);
  },

  same_(a, b) {
    return Tabs.sameCell(a, b);
  },

  /** Error with apiErrors, the shape SheetApi returns as {ok: false, errors}. */
  error_(code, message) {
    const err = new Error(message);
    err.apiErrors = [{ path: 'args', code, message }];
    return err;
  },
};
