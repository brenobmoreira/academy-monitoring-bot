/**
 * Script lock, a tiny event bus, the change log and undo (spec §5.3–5.4).
 *
 * Every write made through Tabs while an action runs (ChangeLog.run) is appended to the hidden
 * Log tab *before* the sheet is written: one Log row per changed row (or per group of layout
 * cells), all rows of one action sharing `ID ação`. A change is
 *   {kind: 'update'|'append'|'delete'|'cells', tab: sheet name, row, before, after}
 * with before/after as {header text (or '#col', or A1 for 'cells'): value}; `before` is null for
 * an append and `after` null for a delete. JSON encodes dates as {"$d": iso} and formulas as
 * {"$f": "=..."}. Structural changes (used by the migration) are kind 'structure' with
 * after = {op, ...}: renameSheet {from, to}, insertSheet {name}, insertColumns {after, count},
 * namedRange {name}; ChangeLog.structure() logs one before it is made, and Undo reverses it.
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

  /** Calls every listener of the event with payload (none while the event is muted); returns the payload. */
  emit(event, payload) {
    if (Core.muted_[event]) return payload;
    (Core.listeners_[event] || []).forEach((fn) => fn(payload));
    return payload;
  },

  /** Events whose listeners do not run (see mute). */
  muted_: {},

  /**
   * Runs fn with the listeners of these events silenced, e.g. the derived refreshes (Semanas,
   * Painel) that a staged migration runs once, as steps of their own.
   */
  mute(events, fn) {
    const before = Object.assign({}, Core.muted_);
    events.forEach((e) => { Core.muted_[e] = true; });
    try { return fn(); } finally { Core.muted_ = before; }
  },
};

const ChangeLog = {
  KIND_LABELS: { update: 'Alteração', append: 'Inclusão', delete: 'Exclusão', cells: 'Células', structure: 'Estrutura' },

  /** The action being recorded: {id, label} or null. */
  current_: null,
  /** Changes tracked in the current action, for rollback on error. */
  pending_: [],
  /** Outcome of the latest outermost ChangeLog.run call (read by SheetApi for writeState). */
  lastRunState_: 'idle',

  active() {
    return ChangeLog.current_ ? { id: ChangeLog.current_.id, label: ChangeLog.current_.label } : null;
  },

  /** Changes recorded so far by the running action (0 when none runs). */
  changeCount() {
    return ChangeLog.current_ ? ChangeLog.pending_.length : 0;
  },

  /** Attaches a non-duplicate warning code to an action result object. */
  warn_(result, code) {
    if (!result || typeof result !== 'object') return;
    const prev = Array.isArray(result.warnings) ? result.warnings : [];
    if (!prev.includes(code)) result.warnings = prev.concat([code]);
  },

  /**
   * Checks made before an outermost action starts: fn(label, opts) throws to refuse it (an open
   * staged migration refuses other writes, see Migrate.guard_). Modules register their own.
   */
  GUARDS: [],

  /**
   * Why a write that does not go through ChangeLog.run (a trigger, a screen or menu action that
   * logs nothing) must not run now, as the guards' error; null when it may. Callers refuse or
   * postpone the write instead of changing cells an open operation still has to restore.
   */
  blockedReason(label) {
    try {
      ChangeLog.GUARDS.forEach((g) => g(label, {}));
      return null;
    } catch (err) {
      return err;
    }
  },

  /**
   * Runs fn as one undoable action. Nested calls join the outer action. When fn throws, the
   * changes it made are reverted (newest first), verified against `before`, their Log rows marked
   * undone, and the error rethrown (or `rollback_failed` thrown if any change is not proven
   * restored).
   * opts.id = the id to give a new action, chosen (and saved) by the caller before it starts, so
   *   a run stopped midway can be found in the Log; it must not be in the Log yet.
   * opts.join = the id of an earlier action this run continues (a staged migration spread over
   *   several executions), so one undo reverts them all. Only the latest action not undone can
   *   be continued: joining anything older would put its changes out of order in the Log.
   */
  run(label, fn, opts) {
    if (ChangeLog.current_) return fn();
    ChangeLog.lastRunState_ = 'not_started';
    const o = opts || {};
    ChangeLog.GUARDS.forEach((g) => g(label, o));
    if (o.join && Undo.pending().map((a) => a.id)[0] !== o.join) {
      throw Undo.error_('join_refused', `A ação ${o.join} não é a última pendente do Log; não pode ser continuada.`);
    }
    if (o.id && ChangeLog.entries().some((e) => e.actionId === o.id)) {
      throw Undo.error_('id_in_use', `A ação ${o.id} já existe no Log.`);
    }
    ChangeLog.current_ = { id: o.join || o.id || ChangeLog.newId_(), label };
    ChangeLog.pending_ = [];
    ChangeLog.lastRunState_ = 'running';
    let result;
    let tabs;
    try {
      result = fn();
      tabs = ChangeLog.touched_();
      ChangeLog.lastRunState_ = 'committed';
    } catch (err) {
      try {
        ChangeLog.rollback_();
        ChangeLog.lastRunState_ = 'rolled_back';
      } catch (rbErr) {
        ChangeLog.lastRunState_ = 'rollback_failed';
        throw rbErr;
      }
      throw err;
    } finally {
      ChangeLog.current_ = null;
      ChangeLog.pending_ = [];
    }
    // After the action closes, so listeners' own writes (derived tabs) are not part of it.
    if (tabs.length) {
      try {
        Core.emit('action.committed', { label, tabs });
      } catch (err) {
        console.error(err);
        ChangeLog.warn_(result, 'derived_refresh_failed');
      }
    }
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
    ChangeLog.split_(change).forEach((part) => {
      const row = ChangeLog.write_(ChangeLog.current_, part);
      ChangeLog.pending_.push({ change: part, logRow: row });
    });
  },

  /** A Log cell holds at most 50 000 characters; a big 'cells' change is logged as several. */
  MAX_JSON: 40000,

  /** The change, or its cells in groups whose before/after JSON each fit in one Log cell. */
  split_(change) {
    if (change.kind !== 'cells' || !change.after) return [change];
    const max = ChangeLog.MAX_JSON;
    const size = (o) => (o ? ChangeLog.encode(o).length : 0);
    if (size(change.before) <= max && size(change.after) <= max) return [change];
    const parts = [];
    let cur = null;
    let nb = 0;
    let na = 0;
    Object.keys(change.after).forEach((k) => {
      const hasBefore = !!change.before && k in change.before;
      const lb = hasBefore ? size({ [k]: change.before[k] }) : 0;
      const la = size({ [k]: change.after[k] });
      if (!cur || nb + lb > max || na + la > max) {
        cur = { before: {}, after: {} };
        parts.push(cur);
        nb = 0;
        na = 0;
      }
      if (hasBefore) cur.before[k] = change.before[k];
      cur.after[k] = change.after[k];
      nb += lb;
      na += la;
    });
    return parts.map((p) => Object.assign({}, change, { before: change.before ? p.before : null, after: p.after }));
  },

  /**
   * Logs a structural change (sheet rename/insert, columns inserted, named range created) just
   * before the caller makes it. `tab` is the sheet name after the change.
   * @param {string} tab
   * @param {{op: string}} after
   */
  structure(tab, after) {
    ChangeLog.track({ kind: 'structure', tab, row: null, before: null, after });
  },

  /**
   * Logs changes already described by the caller (writes made outside Tabs) as one new action.
   * @param {string} action label
   * @param {Object[]} changes [{kind, tab, row, before, after}]
   * @returns {string} action id
   */
  record(action, changes) {
    if (!ChangeLog.current_) ChangeLog.GUARDS.forEach((g) => g(action, {}));
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
    let allProven = true;
    const failedDeletes = [];
    pending.forEach((p) => {
      const c = p.change;
      let proven = false;
      const shiftedByFailedDelete = c && c.kind !== 'cells' && c.kind !== 'structure' && c.row !== null && c.row !== undefined
        && failedDeletes.some((d) => d.tab === c.tab && d.row <= c.row);
      if (!shiftedByFailedDelete) {
        let restoreThrew = false;
        try {
          Undo.restore_(c);
        } catch (err) {
          restoreThrew = true;
          console.error(err);
        }
        if (!restoreThrew) {
          try {
            proven = Undo.restored_(c) === true;
          } catch (err) {
            proven = false;
            console.error(err);
          }
        }
      }
      p.restored = proven;
      if (!proven) {
        allProven = false;
        if (c && c.kind === 'delete') failedDeletes.push(c);
      }
    });
    const now = new Date();
    const cleanAction = allProven && ChangeLog.current_ ? Undo.cleanLabel_(ChangeLog.current_.label) : null;
    pending.forEach((p) => {
      if (!p.restored) return;
      try {
        const patch = { undone: now };
        if (cleanAction) patch.action = cleanAction;
        Tabs.update('log', p.logRow, patch);
      } catch (err) {
        console.error(err);
      }
    });
    if (!allProven) {
      throw Undo.rollbackError_('Não foi possível reverter toda a alteração após um erro; confira a planilha.');
    }
  },

  /**
   * JSON with dates and formulas tagged. Only snapshot formulas ({$f}, Tabs.snapCell) are tagged:
   * a string that starts with "=" is literal text and stays a string.
   */
  encode(obj) {
    const out = {};
    Object.keys(obj).forEach((k) => {
      const v = obj[k];
      if (v instanceof Date) out[k] = { $d: v.toISOString() };
      else if (Tabs.isSnapFormula(v)) out[k] = v.legacy ? { $f: v.$f } : { $f: v.$f, $v: 2 };
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
      else if (v && typeof v === 'object' && v.$f !== undefined) {
        out[k] = Tabs.snapCell(String(v.$f), v.$f);
        // Before $v: 2, any text starting with "=" was tagged {$f}, formula or not: undo refuses these.
        if (v.$v !== 2 && Tabs.isSnapFormula(out[k])) out[k].legacy = true;
      }
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
  /** Stage of the latest Undo.last / Undo.action call (read by SheetApi for writeState). */
  lastApplyState_: 'idle',

  /** Strips trailing API metadata JSON (` {"op":...}`) from a Log action label for user-facing messages. */
  cleanLabel_(label) {
    const s = String(label === null || label === undefined ? '' : label);
    const i = s.indexOf(' {"op":');
    return i > 0 ? s.slice(0, i) : s;
  },

  /**
   * Undoes the latest action not yet undone.
   * @returns {{actionId: string, action: string, changes: number}}
   */
  last() {
    Undo.lastApplyState_ = 'not_started';
    const act = Undo.pending()[0];
    if (!act) throw Undo.error_('nothing_to_undo', 'Nada para desfazer.');
    return Undo.apply_(act);
  },

  /**
   * Undoes one action by id; only the latest pending action may be undone (row positions of
   * later actions depend on it).
   */
  action(actionId) {
    Undo.lastApplyState_ = 'not_started';
    const pending = Undo.pending();
    const act = ChangeLog.actions().find((a) => a.id === actionId);
    if (!act) throw Undo.error_('not_found', `Ação ${actionId} não encontrada no Log.`);
    if (act.undone) throw Undo.error_('already_undone', `Ação ${actionId} já foi desfeita.`);
    if (pending[0].id !== actionId) throw Undo.error_('not_latest', `Só a última alteração pode ser desfeita; desfaça antes "${Undo.cleanLabel_(pending[0].label)}".`);
    return Undo.apply_(act);
  },

  /** Actions not undone, newest first. */
  pending() {
    return ChangeLog.actions().filter((a) => !a.undone).reverse();
  },

  apply_(act) {
    Undo.lastApplyState_ = 'not_started';
    const result = Core.withLock(() => {
      const changes = act.changes.filter((c) => !c.undone);
      const conflicts = [];
      // Newest first: a cell written again later in the same action is checked against that later
      // change only (its earlier `after` was overwritten on purpose).
      const later = new Set();
      changes.map((c, i) => i).reverse().forEach((i) => {
        const c = changes[i];
        const row = Undo.currentRow_(c, changes.slice(i + 1));
        if (row === null) return; // the row was deleted later in the same action
        const located = Object.assign({}, c, { row });
        const msg = Undo.conflict_(located, later);
        if (msg) conflicts.unshift(msg);
        Undo.cellKeys_(located).forEach((k) => later.add(k));
      });
      if (conflicts.length) {
        throw Undo.error_('conflict', `Não foi possível desfazer "${Undo.cleanLabel_(act.label)}": ${conflicts.join('; ')}. Nada foi alterado; corrija direto na planilha.`);
      }
      Undo.lastApplyState_ = 'reverting';
      let allProven = true;
      const reverted = [];
      changes.slice().reverse().forEach((c) => {
        let ok = false;
        try {
          const sheet = c.kind === 'append' ? SpreadsheetApp.getActive().getSheetByName(c.tab) : null;
          const deletedMidSheet = Boolean(sheet && c.row < sheet.getLastRow());
          const prevLastRow = deletedMidSheet ? sheet.getLastRow() : 0;
          const insCols = c.kind === 'structure' && c.after && c.after.op === 'insertColumns' ? c.after : null;
          const structSheet = insCols && insCols.sheet ? SpreadsheetApp.getActive().getSheetByName(insCols.sheet) : null;
          const prevMaxCols = structSheet ? structSheet.getMaxColumns() : 0;
          Undo.revert_(c);
          if (deletedMidSheet) ok = sheet.getLastRow() === prevLastRow - 1;
          else if (insCols) ok = Boolean(structSheet) && structSheet.getMaxColumns() === prevMaxCols - insCols.count;
          else ok = Undo.restored_(c) === true;
        } catch (err) {
          ok = false;
          console.error(err);
        }
        if (ok) reverted.push(c);
        else allProven = false;
      });
      const now = new Date();
      reverted.slice().reverse().forEach((c) => {
        try {
          Tabs.update('log', c.logRow, { undone: now });
        } catch (err) {
          allProven = false;
          console.error(err);
        }
      });
      Tabs.invalidate();
      if (typeof Config !== 'undefined') Config.invalidate();
      if (!allProven) {
        throw Undo.rollbackError_(`Não foi possível desfazer toda a alteração "${Undo.cleanLabel_(act.label)}"; confira a planilha.`);
      }
      return { actionId: act.id, action: act.label, changes: changes.length, tabs: changes.map((c) => c.tab) };
    });
    Undo.lastApplyState_ = 'committed';
    if (!Undo.quiet_(act.label)) {
      try {
        Core.emit('action.committed', { label: act.label, tabs: result.tabs.filter((t, i, all) => all.indexOf(t) === i), undo: true });
      } catch (err) {
        console.error(err);
        ChangeLog.warn_(result, 'derived_refresh_failed');
      }
    }
    return result;
  },

  /**
   * Label prefixes whose undo does not announce a commit: the derived refreshes (Semanas, Painel)
   * would rewrite, outside the Log, cells that an older action of the same operation still has
   * to restore (the staged migration and its steps, registered by Migrate).
   */
  QUIET_PREFIXES: [],

  quiet_(label) {
    const s = Undo.cleanLabel_(label);
    return Undo.QUIET_PREFIXES.some((p) => s === p || s.indexOf(`${p} — `) === 0);
  },

  /**
   * Where the row of change c is now, given the changes made after it in the same action
   * (a later delete above it moves it up); null when a later change deleted it. Undo reverts in
   * reverse order, so by the time c is reverted its original row number is right again.
   */
  currentRow_(c, later) {
    if (c.kind === 'cells' || c.kind === 'structure') return 0; // not row-addressed
    let row = c.row;
    for (let i = 0; i < later.length; i++) {
      const l = later[i];
      if (l.tab !== c.tab || l.kind !== 'delete') continue;
      if (l.row === row) return null;
      if (l.row < row) row--;
    }
    return row;
  },

  /** "tab|row|col" of the cells a change wrote (none for deletes and structural changes). */
  cellKeys_(c) {
    if (c.kind === 'delete' || c.kind === 'structure') return [];
    const sheet = SpreadsheetApp.getActive().getSheetByName(c.tab);
    if (!sheet) return [];
    return Undo.locate_(sheet, c, c.after || {}).filter((x) => x.col && x.range)
      .map((x) => `${c.tab}|${x.range.getRow()}|${x.range.getColumn()}`);
  },

  conflict_(c, skip) {
    if (c.kind === 'structure') return Undo.structureConflict_(c.after || {});
    // What undo would write back: an old-format {$f} may have been literal text, so it is refused.
    const old = c.kind === 'append' ? [] : Object.keys(c.before || {}).filter((k) => Tabs.isSnapFormula(c.before[k]) && c.before[k].legacy);
    if (old.length) return `"${c.tab}" (${old.join(', ')}) foi registrada antes da proteção contra fórmulas, e o registro não distingue texto de fórmula`;
    const sheet = SpreadsheetApp.getActive().getSheetByName(c.tab);
    if (!sheet) return `aba "${c.tab}" não existe mais`;
    if (c.kind === 'delete') return null;
    const cells = Undo.locate_(sheet, c, c.after || {});
    const bad = cells.filter((x) => !x.col || (!(skip && x.range && skip.has(`${c.tab}|${x.range.getRow()}|${x.range.getColumn()}`))
      && !Undo.same_(Undo.cellValue_(x.range), x.value)));
    if (!bad.length) return null;
    return c.kind === 'cells' ? `células ${bad.map((x) => x.name).join(', ')} de "${c.tab}" mudaram`
      : `linha ${c.row} de "${c.tab}" mudou (${bad.map((x) => x.name).join(', ')})`;
  },

  /** True when the sheet shows the change as full `after`. */
  applied_(c) {
    if (c.kind !== 'delete') return !Undo.conflict_(c);
    const sheet = SpreadsheetApp.getActive().getSheetByName(c.tab);
    if (!sheet) return false;
    const still = Undo.locate_(sheet, c, c.before || {}).every((x) => x.col && Undo.same_(Undo.cellValue_(x.range), x.value));
    return !still;
  },

  /**
   * Restores every cell (or row / structure) of change c that differs from `before` during
   * rollback, even when c was only partially applied. Unknown change kinds are left untouched so
   * `Undo.restored_` rejects them.
   */
  restore_(c) {
    if (!c || typeof c !== 'object') return;
    if (c.kind === 'structure') {
      Undo.restoreStructure_(c.after || {});
      Tabs.invalidate();
      return;
    }
    if (c.kind !== 'update' && c.kind !== 'append' && c.kind !== 'delete' && c.kind !== 'cells') return;
    const sheet = SpreadsheetApp.getActive().getSheetByName(c.tab);
    if (!sheet) throw new Error(`Aba "${c.tab}" não encontrada`);
    if (c.kind === 'append') {
      if (!Number.isInteger(c.row) || c.row < 1) throw new Error(`Linha inválida em "${c.tab}"`);
      const width = Undo.rowWidth_(sheet, c, c.after || {});
      const range = sheet.getRange(c.row, 1, 1, width);
      const values = range.getValues()[0];
      const formulas = range.getFormulas()[0];
      const dirty = values.some((v, i) => Boolean(formulas[i]) || !Tabs.sameCell(v, ''));
      if (dirty) range.clearContent();
      Tabs.invalidate(c.tab);
      return;
    }
    if (!c.before || typeof c.before !== 'object') {
      throw new Error(`Snapshot anterior ausente em "${c.tab}"`);
    }
    if (c.kind === 'delete') {
      if (!Number.isInteger(c.row) || c.row < 1) throw new Error(`Linha inválida em "${c.tab}"`);
      const cells = Undo.locate_(sheet, c, c.before);
      cells.forEach((x) => {
        if (!x.col) throw new Error(`Coluna "${x.name}" não encontrada em "${c.tab}"`);
        if (Tabs.isSnapFormula(x.value) && x.value.legacy) {
          throw new Error(`"${c.tab}" (${x.name}) usa formato antigo de fórmula`);
        }
      });
      let cellErr = null;
      if (!Undo.rowMatchesSnapshot_(sheet, c.row, cells)) {
        if (c.row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), c.row - sheet.getMaxRows());
        else if (c.row <= sheet.getLastRow()) sheet.insertRowBefore(c.row);
        const width = Math.max(sheet.getLastColumn(), ...cells.map((x) => x.col || 0), 1);
        const byCol = {};
        cells.forEach((x) => { byCol[x.col] = x.value; });
        for (let col = 1; col <= width; col++) {
          const target = Object.prototype.hasOwnProperty.call(byCol, col) ? byCol[col] : '';
          try {
            const range = sheet.getRange(c.row, col);
            if (!Undo.same_(Undo.cellValue_(range), target)) Undo.setCell_(range, target);
          } catch (err) {
            if (!cellErr) cellErr = err;
            else console.error(err);
          }
        }
      }
      Tabs.invalidate(c.tab);
      if (cellErr) throw cellErr;
      return;
    }
    // 'update' or 'cells'
    if (c.kind === 'update' && (!Number.isInteger(c.row) || c.row < 1)) {
      throw new Error(`Linha inválida em "${c.tab}"`);
    }
    const cells = Undo.locate_(sheet, c, c.before);
    let cellErr = null;
    cells.forEach((x) => {
      try {
        if (!x.col || !x.range) throw new Error(`Coluna "${x.name}" não encontrada em "${c.tab}"`);
        if (Tabs.isSnapFormula(x.value) && x.value.legacy) {
          throw new Error(`"${c.tab}" (${x.name}) usa formato antigo de fórmula`);
        }
        if (!Undo.same_(Undo.cellValue_(x.range), x.value)) Undo.setCell_(x.range, x.value);
      } catch (err) {
        if (!cellErr) cellErr = err;
        else console.error(err);
      }
    });
    Tabs.invalidate(c.tab);
    if (cellErr) throw cellErr;
  },

  /**
   * Re-reads the sheet and verifies that every cell (or row / structure) of change c equals
   * `before` exactly. Returns false for unknown change kinds or missing snapshots/columns.
   */
  restored_(c) {
    if (!c || typeof c !== 'object') return false;
    if (c.kind === 'structure') return Undo.structureRestored_(c.after || {});
    if (c.kind !== 'update' && c.kind !== 'append' && c.kind !== 'delete' && c.kind !== 'cells') return false;
    const sheet = SpreadsheetApp.getActive().getSheetByName(c.tab);
    if (!sheet) return false;
    if (c.kind === 'append') {
      if (!Number.isInteger(c.row) || c.row < 1) return false;
      if (c.before !== null && c.before !== undefined) return false;
      const width = Undo.rowWidth_(sheet, c, c.after || {});
      const range = sheet.getRange(c.row, 1, 1, width);
      const values = range.getValues()[0];
      const formulas = range.getFormulas()[0];
      return values.every((v, i) => !formulas[i] && Tabs.sameCell(v, ''));
    }
    if (!c.before || typeof c.before !== 'object') return false;
    if (c.kind === 'delete') {
      if (!Number.isInteger(c.row) || c.row < 1 || c.row > sheet.getMaxRows()) return false;
      const cells = Undo.locate_(sheet, c, c.before);
      if (cells.some((x) => !x.col || (Tabs.isSnapFormula(x.value) && x.value.legacy))) return false;
      return Undo.rowMatchesSnapshot_(sheet, c.row, cells);
    }
    if (c.kind === 'update' && (!Number.isInteger(c.row) || c.row < 1)) return false;
    if (c.after && typeof c.after === 'object') {
      const missingBefore = Object.keys(c.after).some((k) => !Object.prototype.hasOwnProperty.call(c.before, k));
      if (missingBefore) return false;
    }
    const cells = Undo.locate_(sheet, c, c.before);
    if (!cells.length && Object.keys(c.after || {}).length > 0) return false;
    return cells.every((x) => Boolean(x.col && x.range)
      && !(Tabs.isSnapFormula(x.value) && x.value.legacy)
      && Undo.same_(Undo.cellValue_(x.range), x.value));
  },

  rowWidth_(sheet, c, snapshot) {
    const cols = Undo.locate_(sheet, c, snapshot || {}).map((x) => x.col || 0);
    return Math.max(sheet.getLastColumn(), ...cols, 1);
  },

  rowMatchesSnapshot_(sheet, row, cells) {
    if (row > sheet.getMaxRows()) return false;
    const width = Math.max(sheet.getLastColumn(), ...cells.map((x) => x.col || 0), 1);
    const range = sheet.getRange(row, 1, 1, width);
    const values = range.getValues()[0];
    const formulas = range.getFormulas()[0];
    const byCol = {};
    cells.forEach((x) => { if (x.col) byCol[x.col] = x.value; });
    for (let col = 1; col <= width; col++) {
      const target = Object.prototype.hasOwnProperty.call(byCol, col) ? byCol[col] : '';
      const actual = Tabs.snapCell(formulas[col - 1], values[col - 1]);
      if (!Undo.same_(actual, target)) return false;
    }
    return true;
  },

  /** Restores one change (no conflict check, no logging). */
  revert_(c) {
    if (c.kind === 'structure') { Undo.revertStructure_(c.after || {}); Tabs.invalidate(); return; }
    const sheet = SpreadsheetApp.getActive().getSheetByName(c.tab);
    if (!sheet) throw new Error(`Aba "${c.tab}" não encontrada`);
    if (c.kind === 'append') {
      // An appended row at the end is cleared rather than deleted, so the grid keeps its size (the
      // row count, filters and row formats of the tab are as before the action).
      if (c.row >= sheet.getLastRow()) sheet.getRange(c.row, 1, 1, Math.max(sheet.getLastColumn(), 1)).clearContent();
      else sheet.deleteRow(c.row);
    } else if (c.kind === 'delete') {
      if (c.row <= sheet.getLastRow()) sheet.insertRowBefore(c.row);
      Undo.locate_(sheet, c, c.before || {}).forEach((x) => { if (x.col) Undo.setCell_(x.range, x.value); });
    } else {
      Undo.locate_(sheet, c, c.before || {}).forEach((x) => { if (x.range) Undo.setCell_(x.range, x.value); });
    }
    Tabs.invalidate(c.tab);
  },

  /** Why a structural change can no longer be undone (its result is gone), or null. */
  structureConflict_(s) {
    const ss = SpreadsheetApp.getActive();
    switch (s.op) {
      case 'renameSheet':
        if (!ss.getSheetByName(s.to)) return `aba "${s.to}" não existe mais`;
        return ss.getSheetByName(s.from) ? `já existe uma aba "${s.from}"` : null;
      case 'insertSheet':
        return ss.getSheetByName(s.name) ? null : `aba "${s.name}" não existe mais`;
      case 'insertColumns': {
        const sheet = ss.getSheetByName(s.sheet);
        if (!sheet) return `aba "${s.sheet}" não existe mais`;
        return sheet.getMaxColumns() < s.after + s.count ? `colunas de "${s.sheet}" mudaram` : null;
      }
      case 'namedRange':
        return null;
      default:
        return `alteração estrutural desconhecida (${s.op})`;
    }
  },

  revertStructure_(s) {
    const ss = SpreadsheetApp.getActive();
    switch (s.op) {
      case 'renameSheet': ss.getSheetByName(s.to).setName(s.from); break;
      case 'insertSheet': ss.deleteSheet(ss.getSheetByName(s.name)); break;
      case 'insertColumns': ss.getSheetByName(s.sheet).deleteColumns(s.after + 1, s.count); break;
      case 'namedRange': ss.removeNamedRange(s.name); break;
      default: throw new Error(`Unknown structure op: ${s.op}`);
    }
  },

  restoreStructure_(s) {
    const ss = SpreadsheetApp.getActive();
    switch (s.op) {
      case 'renameSheet': {
        if (ss.getSheetByName(s.from) && !ss.getSheetByName(s.to)) return;
        const sh = ss.getSheetByName(s.to);
        if (!sh) throw new Error(`Aba "${s.to}" não encontrada`);
        sh.setName(s.from);
        break;
      }
      case 'insertSheet': {
        const sh = ss.getSheetByName(s.name);
        if (sh) ss.deleteSheet(sh);
        break;
      }
      case 'insertColumns': {
        const sh = ss.getSheetByName(s.sheet);
        if (!sh) throw new Error(`Aba "${s.sheet}" não encontrada`);
        if (sh.getMaxColumns() >= s.after + s.count) sh.deleteColumns(s.after + 1, s.count);
        break;
      }
      case 'namedRange':
        if (ss.getRangeByName(s.name)) ss.removeNamedRange(s.name);
        break;
      default:
        throw new Error(`Unknown structure op: ${s.op}`);
    }
  },

  structureRestored_(s) {
    if (!s || typeof s !== 'object') return false;
    const ss = SpreadsheetApp.getActive();
    switch (s.op) {
      case 'renameSheet':
        return Boolean(s.from && ss.getSheetByName(s.from)) && Boolean(!s.to || !ss.getSheetByName(s.to));
      case 'insertSheet':
        return Boolean(s.name) && !ss.getSheetByName(s.name);
      case 'insertColumns': {
        const sh = s.sheet ? ss.getSheetByName(s.sheet) : null;
        return Boolean(sh) && sh.getMaxColumns() === s.after;
      }
      case 'namedRange':
        return Boolean(s.name) && !ss.getRangeByName(s.name);
      default:
        return false;
    }
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
    return Tabs.snapCell(range.getFormulas()[0][0], range.getValue());
  },

  /** Writes a snapshot cell back: a formula only when it was recorded as one, text as text. */
  setCell_(range, value) {
    if (Tabs.isSnapFormula(value)) { range.setFormula(value.$f); return; }
    const v = value === null || value === undefined ? '' : value;
    // The value being restored may predate a strict validation added later (the 4.0 layout after a
    // migration). Apps Script would reject the write, and only at the next read, so drop that rule first.
    if (Undo.rejects_(range.getDataValidation(), v)) range.clearDataValidations();
    range.setValue(Tabs.text(v));
  },

  /** True when a strict list or range validation would refuse v (other criteria are not checked). */
  rejects_(rule, v) {
    if (!rule || rule.getAllowInvalid() || v === '') return false;
    const type = String(rule.getCriteriaType());
    let allowed;
    try {
      if (type === 'VALUE_IN_LIST') allowed = rule.getCriteriaValues()[0];
      else if (type === 'VALUE_IN_RANGE') allowed = [].concat(...rule.getCriteriaValues()[0].getValues());
      else return false;
    } catch (err) {
      return false;
    }
    const key = Undo.ruleKey_(v);
    return !allowed.some((a) => a !== '' && a !== null && Undo.ruleKey_(a) === key);
  },

  /**
   * A value as a list/range validation compares it: dates by instant (a range holds Date objects,
   * the value restored from the Log is a Date too), booleans as Sheets shows them, numbers and
   * text as text (a list item "0" accepts the number 0).
   */
  ruleKey_(v) {
    if (v instanceof Date) return `d:${v.getTime()}`;
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  },

  same_(a, b) {
    if (Tabs.isSnapFormula(a) || Tabs.isSnapFormula(b)) return Tabs.isSnapFormula(a) && Tabs.isSnapFormula(b) && a.$f === b.$f;
    return Tabs.sameCell(a, b);
  },

  /** Error with apiErrors, the shape SheetApi returns as {ok: false, errors}. */
  error_(code, message) {
    const err = new Error(message);
    err.apiErrors = [{ path: 'args', code, message }];
    return err;
  },

  /** Error thrown when rollback or undo cannot prove every change was restored. */
  rollbackError_(message) {
    const err = new Error(message);
    err.code = 'rollback_failed';
    err.writeState = 'unknown';
    return err;
  },
};
