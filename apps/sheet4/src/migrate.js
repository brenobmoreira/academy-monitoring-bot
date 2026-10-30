/**
 * Migration 3.0 → 4.0 (spec §9). Also the "Configuração inicial" of an empty spreadsheet: the same
 * steps create every tab and write Config and the first objective/goal from a client JSON.
 *
 *   Migrate.run(client, opts) → {ok, alreadyMigrated, changes, report, findingsBefore,
 *                                findingsAfter, postSteps, message}
 *
 * `client` is the client JSON (clients/<name>.json, object or text): {config: {key: value},
 * otherClientNames: [], history: {objectives: [], goals: [], plans: []}, review: [{area, message}]}.
 * No client value lives in this file: names, dates, targets and texts come from that JSON, from the
 * 3.0 profile tab and from Tabs.SPEC / Config.DEFAULTS.
 *
 * Guarantees: idempotent (Config `system.schemaVersion` = 4.0 is written last; a second run is a
 * no-op), never deletes a data row (3.0 text that has no place in 4.0 is quoted in Auditoria before
 * it is cleared), every change is listed in Auditoria with its previous value, and the whole
 * migration is one undoable action ("Migrar 3.0 → 4.0"): tab renames/creations, inserted columns
 * and named ranges are logged as structural changes, cells as ordinary changes. Recomputing weeks
 * and applying the layout (Weeks.recomputeAll, Setup.apply, only when those modules exist) run
 * inside the same action, after the schema marker, so one "Desfazer última alteração" returns the
 * file to 3.0 (formatting applied by Setup is not in the change log and stays). A failing post step
 * is reported (status 'erro' in the result and in Auditoria) without cancelling the migration.
 */
const Migrate = {
  LABEL: 'Migrar 3.0 → 4.0',
  FORMAT: 'academy-client/1',

  /** Tabs whose per-row values the 4.0 script writes (per-row formulas are removed). */
  SCRIPT_WRITTEN: ['diary', 'weeks', 'progression', 'evolution'],

  /** Named ranges of the 3.0 product used by validations → the 4.0 column they listed. */
  LEGACY_LISTS: { ListaExercicios: { tab: 'exercises', key: 'name' } },

  /** 3.0 profile rows ("Macros e perfil": Parâmetro | Valor editável | Unidade | Origem) → Config keys. */
  LEGACY_PROFILE: {
    'Nome': 'client.name',
    'Idade': 'client.age',
    'Altura': 'client.heightCm',
    'Peso inicial': 'client.startWeightKg',
    'Início do acompanhamento': 'client.startDate',
    'Meta de musculação': 'routine.strengthPerWeek',
    'Cardio extra': 'routine.cardioPerWeek',
    'Revisor': 'client.reviewer',
  },

  /** 3.0 profile rows holding the initial goal → goal fields (fallback when the JSON has none). */
  LEGACY_GOAL: {
    'Energia de referência': 'kcal',
    'Proteína de referência': 'protein',
    'Proteína faixa inferior': 'proteinMin',
    'Proteína faixa superior': 'proteinMax',
    'Gordura de referência': 'fat',
  },

  /** 3.0 profile rows describing the objective → objective fields (value, origin column). */
  LEGACY_OBJECTIVE: { 'Objetivo': { value: 'name', origin: 'expectation' } },

  /** Replaces stale 3.0 status lines on layout tabs (Hoje, Painel). */
  STATUS_TEXT: 'Planilha 4.0: objetivo, meta e ficha em vigor vêm das abas Objetivos, Metas e Fichas.',

  GOAL_FIELDS: ['kcal', 'protein', 'proteinMin', 'proteinMax', 'fat', 'fiber', 'kcalTolerance', 'fatTolerance',
    'strengthPerWeek', 'cardioPerWeek', 'activitiesPerWeek', 'stepsPerDay', 'reason', 'reviewer', 'objective'],
  OBJECTIVE_FIELDS: ['name', 'analysisType', 'startWeightKg', 'startWaistCm', 'reason', 'expectation',
    'weightRateMinPct', 'weightRateMaxPct', 'kcal', 'protein', 'fat', 'strengthPerWeek', 'cardioPerWeek',
    'activitiesPerWeek', 'reviewer', 'notes'],
  PLAN_FIELDS: [],

  /* Public API -------------------------------------------------------------------------------- */

  /** True when Config says the spreadsheet is already on schema 4.0. */
  isMigrated() {
    Tabs.invalidate();
    Config.invalidate();
    const sheet = Tabs.findSheet('config');
    if (!sheet || !Audit.isConfigLayout_(sheet)) return false;
    return String(Config.raw('system.schemaVersion') || '') === Config.SCHEMA_VERSION;
  },

  /**
   * Runs the migration (or the initial setup of an empty spreadsheet).
   * @param {Object|string=} client client JSON
   * @param {{postSteps?: boolean, staged?: boolean}=} opts postSteps=false skips Weeks.recomputeAll /
   *   Setup.apply; staged=true (the dialog) also skips both audits and the derived refreshes of the
   *   commit (Semanas, Painel), which then run as STAGED_STEPS, one Apps Script execution each:
   *   a real spreadsheet does not fit all of it in one run's 6 minutes.
   */
  run(client, opts) {
    const o = Object.assign({}, opts || {});
    if (o.staged) o.postSteps = false;
    const already = { ok: true, alreadyMigrated: true, changes: 0, report: [], postSteps: [], findingsAfter: [], message: 'A planilha já está na versão 4.0; nada foi alterado.' };
    const parsed = Migrate.parseClient(client);
    Migrate.t0_ = Date.now();
    Migrate.log_('início');
    // One lock from the decision to the commit: a second window (or a retry after a lost answer)
    // waits, then finds the operation already applied instead of migrating again.
    const result = Core.withLock(() => {
      if (o.staged) {
        // A staged migration is finished only when its steps are: confirming again resumes it.
        const st = Migrate.status();
        if (st.state === 'done' || st.state === 'unverified') return Object.assign(already, { status: Migrate.publicStatus_(st) });
        if (st.state === 'running' || st.state === 'failed') {
          return Object.assign(already, { alreadyMigrated: false, resumed: true, status: Migrate.publicStatus_(st), message: 'A migração já foi aplicada; continuando as etapas que faltam.' });
        }
      } else if (Migrate.isMigrated()) {
        return already;
      }
      if (parsed.errors.length) throw new Error(`Configuração do cliente inválida: ${parsed.errors.join(' ')}`);
      const cc = parsed.client;
      const tablesConverted = Migrate.unwrapTables_();
      Migrate.log_(`tabelas nativas: ${tablesConverted.length}`);
      const findingsBefore = o.staged ? [] : Audit.findings({ otherNames: cc.otherClientNames });
      if (!o.staged) Migrate.log_('auditoria inicial');
      // Staged: the action id is saved before the first write, so a run killed midway (no catch or
      // finally runs at the 6-minute limit) is found by status() and rolled back before a retry.
      const op = o.staged ? Migrate.saveOp_(Object.assign(Migrate.beginOp_(), { phase: 'migrating', actionId: ChangeLog.newId_() })) : null;
      const migrate = () => {
        const r = ChangeLog.run(Migrate.LABEL, () => Migrate.steps_(cc, o), op ? { id: op.actionId } : undefined);
        // The schema marker is the body's last write; if the run dies before this save, status()
        // sees the marker and moves on to the steps.
        if (op) Migrate.startSteps_(op.actionId);
        return r;
      };
      const r = o.staged ? Core.mute(Migrate.DERIVED_EVENTS, migrate) : migrate();
      r.tablesConverted = tablesConverted;
      r.findingsBefore = findingsBefore;
      if (o.staged) r.status = Migrate.publicStatus_(Migrate.status());
      return r;
    });
    if (result.alreadyMigrated || result.resumed) return result;
    Migrate.log_('migração concluída');
    result.ok = true;
    result.alreadyMigrated = false;
    const open = result.findingsAfter.filter((f) => f.severity === 'Erro').length;
    result.message = `Migração concluída: ${result.changes} ${result.changes === 1 ? 'alteração' : 'alterações'} registradas na Auditoria`
      + `${open ? `; ${open} ${open === 1 ? 'erro continua aberto' : 'erros continuam abertos'}` : ''}. Desfazer última alteração reverte a migração.`;
    return result;
  },

  /** Events whose listeners re-analyse Semanas and re-render the Painel after a commit. */
  DERIVED_EVENTS: ['action.committed', 'weeks.refreshed'],

  /** Seconds since the run started and what was done, in the execution log (Apps Script → Execuções). */
  log_(what) {
    if (!Migrate.t0_) Migrate.t0_ = Date.now();
    console.log(`[migração ${Math.round((Date.now() - Migrate.t0_) / 1000)}s] ${what}`);
  },

  /* Native tables ------------------------------------------------------------------------------ */

  /**
   * Hidden sheet holding a copy of every native table while it is converted. A copy is written
   * and read back before its table is removed, and dropped once every converted range is checked
   * against it, so an execution stopped at any point (Apps Script kills a run at 6 minutes, no
   * catch/finally runs) leaves either the table or its copy; the next run restores from the copy.
   * The name proves nothing: the sheet is the migration's only with the token saved in the
   * document properties (BACKUP_KEY) before it was created, written after its headers.
   */
  BACKUP_SHEET: 'Migração — cópia das tabelas',
  BACKUP_HEADERS: ['Tabela', 'Rótulo', 'Aba', 'Intervalo', 'Estado', 'Parte', 'Partes', 'Tamanho', 'Conteúdo'],
  BACKUP_KEY: 'migration.backup',
  BACKUP_MARK: 'migration-backup:',
  /** Characters of copy per cell (Sheets allows 50 000). */
  BACKUP_CHUNK: 40000,

  /**
   * Native Sheets tables ("Formatar como tabela") turned into plain ranges before migrating: a
   * table refuses an empty header cell, grows over cells written next to it and types its columns,
   * and the 4.0 code writes plain ranges. The Sheets API offers no "convert to range" request
   * (deleteTable removes the table and its contents), so per table: snapshot (values, formulas,
   * literal "=" text, number formats) → durable copy, read back → deleteTable → write back →
   * compare with the copy. A conversion interrupted earlier is finished first (recoverTables_).
   *
   * Refused before anything is removed: a table whose sheet or range cannot be read, formulas that
   * refer to a table by name (Tabela1, Tabela1[Coluna], Tabela_de_dados for "Tabela de dados"),
   * which would break without it, and INDIRECT with a table's name in its text (not analysable).
   * Not kept: the table itself (name, column types, banding, filter views) and its validations
   * (Setup.apply writes the 4.0 rules). Not part of the undoable migration: undoing it restores the
   * 3.0 values in the plain ranges. Without the Sheets advanced service nothing is done.
   * @returns {string[]} "Tab (table name)" of every table converted or recovered
   */
  unwrapTables_() {
    if (typeof Sheets === 'undefined' || !Sheets || !Sheets.Spreadsheets) return [];
    const ss = SpreadsheetApp.getActive();
    const recovered = Migrate.recoverTables_(ss);
    const tables = Migrate.listTables_(ss);
    if (!tables.length) {
      Migrate.dropBackup_(ss);
      return recovered;
    }
    const snaps = tables.map((t) => Migrate.snapshotTable_(ss, t));
    Migrate.checkTableRefs_(ss, tables);
    Migrate.saveBackup_(ss, snaps);
    Migrate.log_(`cópia de ${snaps.length} tabela(s) gravada e conferida`);
    snaps.forEach((snap) => {
      Sheets.Spreadsheets.batchUpdate({ requests: [{ deleteTable: { tableId: snap.id } }] }, ss.getId());
      Migrate.restoreTable_(ss, snap);
      Migrate.markBackup_(ss, snap.id, 'restaurada');
      Migrate.log_(`tabela convertida: ${snap.label}`);
    });
    Migrate.dropBackup_(ss);
    Tabs.invalidate();
    return recovered.concat(snaps.map((s) => s.label));
  },

  /** [{id, name, label, sheet, a1}] of the native tables, from the Sheets API. */
  listTables_(ss) {
    const meta = Sheets.Spreadsheets.get(ss.getId(), { fields: 'sheets(properties(sheetId,title),tables(tableId,name,range))' });
    const out = [];
    (meta.sheets || []).forEach((s) => (s.tables || []).forEach((t) => {
      const title = s.properties.title;
      const sheet = ss.getSheetByName(title);
      if (!sheet) throw new Error(`Tabela "${t.name}": a aba "${title}" não foi encontrada; nada foi convertido.`);
      const g = t.range || {};
      const r1 = (g.startRowIndex || 0) + 1;
      const c1 = (g.startColumnIndex || 0) + 1;
      const r2 = g.endRowIndex || sheet.getMaxRows();
      const c2 = g.endColumnIndex || sheet.getMaxColumns();
      if (r2 < r1 || c2 < c1 || r2 > sheet.getMaxRows() || c2 > sheet.getMaxColumns()) {
        throw new Error(`Tabela "${t.name}" (${title}): intervalo fora da aba; nada foi convertido.`);
      }
      out.push({ id: String(t.tableId), name: t.name, label: `${title} (${t.name})`, sheet: title, a1: sheet.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1).getA1Notation() });
    }));
    return out;
  },

  /**
   * The table's cells as data: {f} formula, {d} date (ISO), {v} anything else (a text starting
   * with "=" whose cell has no formula is literal text and stays {v}), plus number formats.
   */
  snapshotTable_(ss, t) {
    const range = ss.getSheetByName(t.sheet).getRange(t.a1);
    const values = range.getValues();
    const formulas = range.getFormulas();
    const cells = values.map((line, i) => line.map((v, j) => {
      if (formulas[i][j]) return { f: formulas[i][j] };
      if (v instanceof Date) return { d: v.toISOString() };
      return { v };
    }));
    return Object.assign({}, t, { cells, formats: range.getNumberFormats() });
  },

  /**
   * Where formulas depend on the tables: {refs: [A1…], opaque: [A1…]}. A table is referenced in a
   * formula by its name, alone (=SUM(Tabela1)) or with a column (Tabela1[Valor]), spaces written
   * as "_" (support.google.com/docs/answer/15637642); names match case-insensitively. Text inside
   * quotes is not a reference, and Name!A1 is a sheet, not a table. INDIRECT builds references
   * from text, so one whose text names a table cannot be analysed and is reported apart.
   */
  tableRefs_(ss, tables) {
    const forms = [];
    tables.forEach((t) => {
      const n = String(t.name || '');
      if (n) [n, n.replace(/ /g, '_')].forEach((x) => { if (forms.indexOf(x) < 0) forms.push(x); });
    });
    const out = { refs: [], opaque: [] };
    if (!forms.length) return out;
    const alt = forms.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const word = 'A-Za-z0-9_.\\u00C0-\\u024F';
    const ref = new RegExp(`(^|[^${word}])(${alt})(?![${word}(!])`, 'i');
    const named = new RegExp(`(^|[^${word}])(${alt})(?![${word}])`, 'i');
    ss.getSheets().forEach((sheet) => {
      if (!sheet.getLastRow() || !sheet.getLastColumn()) return;
      sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getFormulas().forEach((line, i) => line.forEach((f, j) => {
        if (!f) return;
        const where = `${sheet.getName()}!${Audit.a1_(i + 1, j + 1)}`;
        const texts = f.match(/"(?:[^"]|"")*"/g) || [];
        const code = f.replace(/"(?:[^"]|"")*"/g, '""').replace(/'(?:[^']|'')*'!/g, '');
        if (ref.test(code)) out.refs.push(where);
        else if (/INDIRECT\s*\(/i.test(code) && texts.some((x) => named.test(x.slice(1, -1)))) out.opaque.push(where);
      }));
    });
    return out;
  },

  /** Refuses (before anything is removed) formulas that use a table, or may (INDIRECT). */
  checkTableRefs_(ss, tables) {
    const found = Migrate.tableRefs_(ss, tables);
    if (found.refs.length) {
      throw new Error(`Fórmulas usam uma tabela pelo nome (${found.refs.slice(0, 5).join(', ')}); converta essas tabelas manualmente (Converter em intervalo) ou troque as referências por intervalos comuns. Nada foi convertido.`);
    }
    if (found.opaque.length) {
      throw new Error(`Não foi possível conferir se ${found.opaque.slice(0, 5).join(', ')} usa uma tabela (INDIRECT com o nome dela); confira essas fórmulas antes de migrar. Nada foi convertido.`);
    }
  },

  backupRecord_() {
    try {
      return JSON.parse(PropertiesService.getDocumentProperties().getProperty(Migrate.BACKUP_KEY) || 'null');
    } catch (err) {
      return null;
    }
  },

  /**
   * The migration's copy sheet, or null when there is none. Its identity is a random token,
   * saved in the document properties before the sheet is created and part of the sheet's name
   * ("Migração — cópia das tabelas <token>"), so no sheet made by someone else can carry it: a
   * run killed between the save and insertSheet leaves no sheet (a new one is created with the
   * same name), one killed after insertSheet leaves an empty sheet with that name (completed),
   * and the token is also written in J1 and the sheet id saved. Sheets with any other name, the
   * bare "Migração — cópia das tabelas" included, are never read, written or deleted.
   */
  backupSheet_(ss, create) {
    const props = PropertiesService.getDocumentProperties();
    const col = Migrate.BACKUP_HEADERS.length + 1;
    const mark = (rec) => `${Migrate.BACKUP_MARK}${rec.token}`;
    const save = (rec) => props.setProperty(Migrate.BACKUP_KEY, JSON.stringify(rec));
    const writeHeader = (s, rec) => s.getRange(1, 1, 1, col).setValues([Migrate.BACKUP_HEADERS.concat([mark(rec)])]);
    let rec = Migrate.backupRecord_();
    if (rec && rec.token && rec.name) {
      const sheet = ss.getSheetByName(rec.name);
      if (sheet) {
        if (rec.sheetId && rec.sheetId !== sheet.getSheetId()) {
          throw new Error(`A aba "${rec.name}" não é a cópia registrada pela migração; nada foi convertido.`);
        }
        const marked = sheet.getMaxColumns() >= col && String(sheet.getRange(1, col).getValue()) === mark(rec);
        if (!marked) {
          if (sheet.getLastRow() || sheet.getLastColumn()) throw new Error(`A aba "${rec.name}" tem conteúdo sem a marca da migração; nada foi convertido.`);
          writeHeader(sheet, rec); // created by the run that was killed before its header
        }
        if (!rec.sheetId) save(Object.assign(rec, { sheetId: sheet.getSheetId() }));
        return sheet;
      }
      if (rec.sheetId && !create) return null; // created and deleted already
    }
    if (!create) return null;
    if (!rec || !rec.token || !rec.name) {
      const token = Utilities.getUuid().replace(/[^A-Za-z0-9]/g, '').slice(0, 12);
      rec = { token, name: `${Migrate.BACKUP_SHEET} ${token}`, sheetId: null };
      save(rec);
    }
    const created = ss.insertSheet(rec.name);
    writeHeader(created, rec);
    created.hideSheet();
    save(Object.assign(rec, { sheetId: created.getSheetId() }));
    return created;
  },

  /** Writes the copies (several cells each when long), then reads them back; throws if they differ. */
  saveBackup_(ss, snaps) {
    const sheet = Migrate.backupSheet_(ss, true);
    const rows = [];
    snaps.forEach((s) => {
      const text = JSON.stringify({ cells: s.cells, formats: s.formats });
      const parts = Math.max(1, Math.ceil(text.length / Migrate.BACKUP_CHUNK));
      for (let p = 0; p < parts; p++) {
        rows.push([s.id, s.label, s.sheet, s.a1, 'copiada', p + 1, parts, text.length, text.slice(p * Migrate.BACKUP_CHUNK, (p + 1) * Migrate.BACKUP_CHUNK)]);
      }
    });
    const first = Math.max(sheet.getLastRow(), 1) + 1;
    if (sheet.getMaxRows() < first + rows.length - 1) sheet.insertRowsAfter(sheet.getMaxRows(), first + rows.length - 1 - sheet.getMaxRows());
    sheet.getRange(first, 1, rows.length, Migrate.BACKUP_HEADERS.length).setNumberFormat('@').setValues(rows.map((r) => r.map((v) => Tabs.input(v))));
    SpreadsheetApp.flush();
    const saved = Migrate.readBackup_(ss);
    snaps.forEach((s) => {
      const e = saved[s.id];
      if (!e || e.error || JSON.stringify({ cells: e.cells, formats: e.formats }) !== JSON.stringify({ cells: s.cells, formats: s.formats })) {
        throw new Error(`A cópia da tabela ${s.label} não confere depois de gravada; nada foi convertido.`);
      }
    });
  },

  /** {tableId: {id, label, sheet, a1, state, rows, cells, formats} | {…, error}} from the copy sheet. */
  readBackup_(ss) {
    const sheet = Migrate.backupSheet_(ss, false);
    if (!sheet || sheet.getLastRow() < 2) return {};
    const lines = sheet.getRange(2, 1, sheet.getLastRow() - 1, Migrate.BACKUP_HEADERS.length).getValues();
    const byId = {};
    lines.forEach((l, i) => {
      const id = String(l[0]);
      if (!id) return;
      const e = byId[id] = byId[id] || { id, label: String(l[1]), sheet: String(l[2]), a1: String(l[3]), state: String(l[4]), parts: Number(l[6]), size: Number(l[7]), chunks: {}, rows: [] };
      e.chunks[Number(l[5])] = String(l[8]);
      e.rows.push(i + 2);
      if (String(l[4]) !== 'copiada') e.state = String(l[4]);
    });
    Object.keys(byId).forEach((id) => {
      const e = byId[id];
      let text = '';
      for (let p = 1; p <= e.parts; p++) {
        if (!(p in e.chunks)) { e.error = `parte ${p} de ${e.parts} ausente`; return; }
        text += e.chunks[p];
      }
      if (Object.keys(e.chunks).length !== e.parts || text.length !== e.size) { e.error = 'partes repetidas ou tamanho diferente'; return; }
      try {
        const data = JSON.parse(text);
        e.cells = data.cells;
        e.formats = data.formats;
      } catch (err) {
        e.error = 'conteúdo ilegível';
      }
    });
    return byId;
  },

  markBackup_(ss, id, state) {
    const sheet = Migrate.backupSheet_(ss, false);
    const e = Migrate.readBackup_(ss)[id];
    if (!sheet || !e) return;
    e.rows.forEach((r) => sheet.getRange(r, 5).setValue(state));
    SpreadsheetApp.flush();
  },

  /**
   * Deletes the migration's copy sheet once every copy in it was restored and checked (a copy
   * unreadable or not restored keeps it). Repeating after a failed delete is safe.
   */
  dropBackup_(ss) {
    const sheet = Migrate.backupSheet_(ss, false);
    if (!sheet) return;
    const entries = Migrate.readBackup_(ss);
    if (Object.keys(entries).some((id) => entries[id].error || entries[id].state !== 'restaurada')) return;
    ss.deleteSheet(sheet);
    PropertiesService.getDocumentProperties().deleteProperty(Migrate.BACKUP_KEY);
  },

  /**
   * Finishes conversions an earlier run left half done, from the copy sheet: a copy whose table
   * still exists is stale (the table was never removed; it is converted again from a new copy);
   * for a removed table the range is compared with the copy: equal → done, only empty or equal
   * cells → written back, anything else (someone typed there since) → stop, nothing overwritten.
   * @returns {string[]} labels of the tables finished here
   */
  recoverTables_(ss) {
    const entries = Migrate.readBackup_(ss);
    const ids = Object.keys(entries).filter((id) => entries[id].state !== 'restaurada');
    if (!ids.length) return [];
    const live = {};
    Migrate.listTables_(ss).forEach((t) => { live[t.id] = true; });
    const sheet = Migrate.backupSheet_(ss, false);
    const done = [];
    const stale = [];
    ids.forEach((id) => {
      const e = entries[id];
      if (live[id]) { stale.push(...e.rows); return; }
      if (e.error) throw new Error(`A cópia da tabela ${e.label} está incompleta (${e.error}) e a tabela já foi removida; restaure a planilha pelo histórico de versões.`);
      const diff = Migrate.compareTable_(ss, e);
      if (diff.changed.length) {
        throw new Error(`A tabela ${e.label} foi removida numa conversão interrompida e as células ${diff.changed.slice(0, 5).join(', ')} mudaram desde então; confira a aba e o histórico de versões antes de migrar. Nada foi alterado.`);
      }
      if (diff.missing.length || diff.formats.length) Migrate.restoreTable_(ss, e);
      Migrate.markBackup_(ss, id, 'restaurada');
      Migrate.log_(`tabela recuperada: ${e.label}`);
      done.push(e.label);
    });
    stale.sort((a, b) => b - a).forEach((r) => sheet.deleteRow(r));
    return done;
  },

  /**
   * The range against a copy: {missing: A1s empty now, changed: A1s with other content,
   * formats: A1s whose number format differs}. Everything the conversion keeps is compared, so a
   * run stopped after the values but before the formats is not taken for finished.
   */
  compareTable_(ss, snap) {
    const range = ss.getSheetByName(snap.sheet).getRange(snap.a1);
    const values = range.getValues();
    const formulas = range.getFormulas();
    const numberFormats = range.getNumberFormats();
    const out = { missing: [], changed: [], formats: [] };
    snap.cells.forEach((line, i) => line.forEach((c, j) => {
      const a1 = Audit.a1_(range.getRow() + i, range.getColumn() + j);
      if (snap.formats && String(numberFormats[i][j]) !== String(snap.formats[i][j])) out.formats.push(a1);
      const now = formulas[i][j] ? { f: formulas[i][j] } : values[i][j] instanceof Date ? { d: values[i][j].toISOString() } : { v: values[i][j] };
      if (JSON.stringify(now) === JSON.stringify(c)) return;
      if (!now.f && (now.v === '' || now.v === null)) out.missing.push(a1);
      else out.changed.push(a1);
    }));
    return out;
  },

  /**
   * Writes a copy back into its range and checks it; throws when a cell reads differently.
   * Text goes in with a leading apostrophe when Sheets would otherwise read it as something else
   * (a formula, a number, a date, a boolean), so it stays the same text.
   */
  restoreTable_(ss, snap) {
    const range = ss.getSheetByName(snap.sheet).getRange(snap.a1);
    const asText = (s) => (/^[='+\-@\s]|^[\d.,]|^(true|false|verdadeiro|falso)$/i.test(s) || /\d[/:-]\d/.test(s) ? `'${s}` : s);
    // Validations first: a strict rule would refuse old values (Setup.apply writes the 4.0 rules).
    range.clearDataValidations();
    range.setValues(snap.cells.map((line) => line.map((c) => {
      if (c.f) return '';
      if (c.d) return new Date(c.d);
      return typeof c.v === 'string' && c.v ? asText(c.v) : c.v;
    })));
    snap.cells.forEach((line, i) => line.forEach((c, j) => { if (c.f) range.getCell(i + 1, j + 1).setFormula(c.f); }));
    if (snap.formats) range.setNumberFormats(snap.formats);
    SpreadsheetApp.flush();
    const diff = Migrate.compareTable_(ss, snap);
    const bad = diff.missing.concat(diff.changed, diff.formats);
    if (bad.length) throw new Error(`A tabela ${snap.label} não foi restaurada por completo (${bad.slice(0, 5).join(', ')}); a cópia continua na aba "${Migrate.BACKUP_SHEET}" e a próxima tentativa termina a conversão.`);
  },

  /**
   * Validates and normalizes a client JSON: {client, errors}. Dates become Date, config values are
   * coerced with Config's types. Unknown config keys and bad ids are errors.
   */
  parseClient(input) {
    const errors = [];
    let raw = input;
    if (raw === undefined || raw === null || raw === '') raw = {};
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch (err) { return { client: null, errors: [`JSON inválido: ${err.message}`] }; }
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) return { client: null, errors: ['O JSON do cliente deve ser um objeto.'] };
    if (raw.format && raw.format !== Migrate.FORMAT) errors.push(`Formato "${raw.format}" desconhecido (esperado ${Migrate.FORMAT}).`);
    const client = { config: {}, otherClientNames: [], history: { objectives: [], goals: [], plans: [] }, review: [] };

    Object.keys(raw.config || {}).forEach((key) => {
      const def = Config.DEFAULTS[key];
      if (!def) { errors.push(`Chave de Config desconhecida: ${key}.`); return; }
      const v = raw.config[key];
      if (v === null || v === '') { client.config[key] = null; return; }
      const value = Config.coerce_(def, Array.isArray(v) ? v.join(', ') : v);
      if (value === undefined) errors.push(`Valor inválido para ${key} (${def.label}): ${JSON.stringify(v)}.`);
      else client.config[key] = value;
    });

    const names = raw.otherClientNames || [];
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) errors.push('otherClientNames deve ser uma lista de nomes.');
    else client.otherClientNames = names.map((n) => n.trim()).filter(Boolean);

    const hist = raw.history || {};
    [['objectives', 'O', Migrate.OBJECTIVE_FIELDS], ['goals', 'M', Migrate.GOAL_FIELDS], ['plans', 'F', Migrate.PLAN_FIELDS]].forEach(([entity, prefix, fields]) => {
      (hist[entity] || []).forEach((item, i) => {
        const where = `history.${entity}[${i}]`;
        if (!item || !new RegExp(`^${prefix}\\d{3}$`).test(item.id || '')) { errors.push(`${where}: id deve ser ${prefix}001, ${prefix}002…`); return; }
        const out = { id: item.id, start: null, end: undefined, fields: {} };
        if (item.start !== undefined && item.start !== null) {
          out.start = Dates.parse(item.start);
          if (!out.start) errors.push(`${where}: início inválido (${JSON.stringify(item.start)}).`);
        }
        if (item.end !== undefined) {
          out.end = item.end === null ? null : Dates.parse(item.end);
          if (item.end !== null && !out.end) errors.push(`${where}: fim inválido (${JSON.stringify(item.end)}).`);
        }
        Object.keys(item).forEach((k) => {
          if (k === 'id' || k === 'start' || k === 'end' || k === 'carbs' || k.charAt(0) === '_') return;
          if (fields.indexOf(k) < 0) { errors.push(`${where}: campo desconhecido "${k}".`); return; }
          out.fields[k] = item[k];
        });
        if (entity === 'objectives' && out.fields.analysisType !== undefined && Tabs.ENUMS.ANALYSIS_TYPES.indexOf(out.fields.analysisType) < 0) {
          errors.push(`${where}: tipo de análise "${out.fields.analysisType}" inválido (use ${Tabs.ENUMS.ANALYSIS_TYPES.join(', ')}).`);
        }
        if (entity === 'goals') {
          ['kcal', 'protein', 'proteinMin', 'proteinMax', 'fat'].forEach((k) => {
            const v = out.fields[k];
            if (v !== undefined && v !== null && (typeof v !== 'number' || !isFinite(v) || v < 0)) errors.push(`${where}: ${k} deve ser um número positivo.`);
          });
          const f = out.fields;
          if (typeof f.proteinMin === 'number' && typeof f.proteinMax === 'number' && f.proteinMin > f.proteinMax) errors.push(`${where}: proteína mínima maior que a máxima.`);
          if (typeof item.carbs === 'number' && Energy.carbs(f.kcal, f.protein, f.fat) !== null && Math.abs(item.carbs - Energy.carbs(f.kcal, f.protein, f.fat)) > 0.01) {
            errors.push(`${where}: carboidrato ${item.carbs} não confere com (kcal − 4·P − 9·G)/4 = ${Energy.carbs(f.kcal, f.protein, f.fat)}.`);
          }
        }
        client.history[entity].push(out);
      });
    });

    (raw.review || []).forEach((r, i) => {
      if (!r || !r.message) errors.push(`review[${i}]: falta a mensagem.`);
      else client.review.push({ area: String(r.area || 'Revisar'), message: String(r.message) });
    });
    return { client, errors };
  },

  /**
   * The 3.0 profile (tab "Macros e perfil", or "Config" still in the 3.0 layout), or null:
   * {sheet, rows: [{row, label, value, unit, origin, formula}], config: {key: {value, label, row}},
   *  goal: {field: value}, objective: {field: value}}.
   */
  legacyProfile() {
    const { sheet } = Audit.locate_('config');
    if (!sheet || Audit.isConfigLayout_(sheet)) return null;
    const spec = Tabs.get('config');
    const lastRow = sheet.getLastRow();
    const lastCol = Math.max(sheet.getLastColumn(), 4);
    const out = { sheet, rows: [], config: {}, goal: {}, objective: {} };
    if (lastRow < spec.firstDataRow) return out;
    const range = sheet.getRange(spec.firstDataRow, 1, lastRow - spec.firstDataRow + 1, lastCol);
    const values = range.getValues();
    const formulas = range.getFormulas();
    values.forEach((line, i) => {
      const label = String(line[0] === null || line[0] === undefined ? '' : line[0]).trim();
      const row = { row: spec.firstDataRow + i, label, value: line[1], unit: line[2], origin: line[3], formula: formulas[i][1] || '', cells: line };
      if (!line.some((v) => v !== '' && v !== null) && !formulas[i].some(Boolean)) return;
      out.rows.push(row);
      if (!label || row.formula) return;
      const key = Migrate.LEGACY_PROFILE[label];
      if (key && row.value !== '' && row.value !== null) {
        let v = row.value;
        if (key === 'client.heightCm' && typeof v === 'number' && (String(row.unit).trim() === 'm' || v < 3)) v = Math.round(v * 1000) / 10;
        const value = Config.coerce_(Config.DEFAULTS[key], v);
        if (value !== undefined) out.config[key] = { value, label, row: row.row, converted: v !== row.value };
      }
      const g = Migrate.LEGACY_GOAL[label];
      if (g && typeof row.value === 'number') out.goal[g] = row.value;
      const ob = Migrate.LEGACY_OBJECTIVE[label];
      if (ob) {
        if (row.value !== '' && row.value !== null) out.objective[ob.value] = String(row.value);
        if (row.origin) out.objective[ob.origin] = String(row.origin);
      }
    });
    return out;
  },

  /**
   * Config values after merging the client JSON (first), the 3.0 profile, the values already on a
   * 4.0 Config and the defaults: {key: {value, source: 'json'|'3.0'|'config'|'padrão', legacy}}.
   */
  resolveConfig(cc, legacy) {
    const current = {};
    const sheet = Tabs.findSheet('config');
    if (sheet && Audit.isConfigLayout_(sheet)) {
      Config.invalidate();
      Config.keys().forEach((k) => { if (Config.has(k)) { try { current[k] = Config.get(k); } catch (err) { /* reported by the audit */ } } });
    }
    const out = {};
    Config.keys().forEach((k) => {
      const leg = legacy && legacy.config[k] ? legacy.config[k] : null;
      let value;
      let source;
      if (cc && Object.prototype.hasOwnProperty.call(cc.config, k)) { value = cc.config[k]; source = 'json'; }
      else if (k in current) { value = current[k]; source = 'config'; }
      else if (leg) { value = leg.value; source = '3.0'; }
      else { value = Config.DEFAULTS[k].default; source = 'padrão'; }
      if (k === 'system.otherClientNames' && cc && cc.otherClientNames.length) { value = cc.otherClientNames.slice(); source = 'json'; }
      if (k === 'system.schemaVersion') { value = current[k] || null; source = 'config'; }
      out[k] = { value: Config.copy_(value), source, legacy: leg ? leg.value : null };
    });
    return out;
  },

  /* Steps --------------------------------------------------------------------------------------- */

  steps_(cc, opts) {
    const report = [];
    const rep = (severity, code, tab, cell, finding, action, before, state) => report.push({
      severity, code, tab: tab || '', cell: cell || '', finding, action: action || '', before: before === undefined ? null : before, state: state || 'Corrigido',
    });

    Migrate.renameTabs_(rep);
    const legacy = Migrate.legacyProfile();
    const created = Migrate.createTabs_(rep);
    const config = Migrate.resolveConfig(cc, legacy);
    Migrate.writeConfig_(config, legacy, rep);
    Tabs.ids().forEach((id) => {
      const spec = Tabs.get(id);
      if (spec.kind === 'table' && ['config', 'audit', 'log'].indexOf(id) < 0 && created.indexOf(id) < 0) {
        Migrate.migrateTable_(id, rep);
        Migrate.log_(`aba migrada: ${spec.name}`);
      }
    });
    Migrate.fixVersions_(cc, legacy, rep);
    Migrate.log_('versões (objetivos, metas, fichas)');
    Migrate.fixResidues_(cc.otherClientNames.length ? cc.otherClientNames : config['system.otherClientNames'].value || [], rep);
    Migrate.log_('resíduos de outros clientes');
    Migrate.fixStaleTexts_(rep);
    Migrate.stampIds_(rep);
    Migrate.log_('textos e IDs');
    Migrate.fixTechnicalDates_(rep);
    Migrate.fixNamedRanges_(rep);
    Migrate.clearLayoutFormulas_('dashboard', rep);
    Migrate.log_('correções concluídas');

    const audit = (findingsAfter) => {
      const at = new Date();
      const rows = report.map((f) => Audit.row(f, at, f.state))
        .concat(cc.review.map((r) => Audit.row({ severity: 'Aviso', code: 'review', tab: '', cell: r.area, finding: r.message, action: 'Confirmar com o revisor e ajustar em Config/Metas se preciso.' }, at, 'Revisar')))
        .concat(findingsAfter.map((f) => Audit.row(f, at, 'Aberto')));
      Tabs.appendMany('audit', rows);
    };
    if (opts && opts.staged) {
      // Staged: the schema marker is the very last write, so a spreadsheet on 4.0 proves the whole
      // body ran (status() relies on it after an execution killed midway). The final audit is a
      // step of its own (finalAudit_), after the layout.
      rep('Info', 'schema_version', Tabs.get('config').name, 'system.schemaVersion', `Versão do esquema gravada: ${Config.SCHEMA_VERSION}.`, 'Rodar a migração de novo não altera nada.', null);
      audit([]);
      Config.set('system.schemaVersion', Config.SCHEMA_VERSION);
      Tabs.invalidate();
      Config.invalidate();
      return { changes: report.length, report, findingsAfter: [], review: cc.review, postSteps: [] };
    }

    Config.set('system.schemaVersion', Config.SCHEMA_VERSION);
    rep('Info', 'schema_version', Tabs.get('config').name, 'system.schemaVersion', `Versão do esquema gravada: ${Config.SCHEMA_VERSION}.`, 'Rodar a migração de novo não altera nada.', null);

    const postSteps = opts && opts.postSteps === false ? [] : Migrate.postSteps_();
    postSteps.forEach((p) => {
      if (p.status === 'ok') rep('Info', 'post_step', '', p.step, `${p.step}: concluído.`, 'Parte da mesma ação da migração (um Desfazer reverte tudo).', null);
      else if (p.status === 'erro') rep('Erro', 'post_step', '', p.step, `${p.step} falhou: ${p.message}`, 'Rodar de novo pelo menu depois de corrigir.', null, 'Aberto');
      else rep('Aviso', 'post_step', '', p.step, `${p.step}: módulo ainda não instalado.`, 'Rodar pelo menu quando estiver disponível.', null, 'Aberto');
    });

    Tabs.invalidate();
    Config.invalidate();
    const findingsAfter = Audit.findings({ otherNames: cc.otherClientNames });
    audit(findingsAfter);
    return { changes: report.length, report, findingsAfter, review: cc.review, postSteps };
  },

  /**
   * Weeks.recomputeAll and Setup.apply when defined, inside the running migration action (their
   * logged writes join it). An error is caught and reported; what the step wrote before failing
   * stays in the action, so undoing the migration also removes it.
   */
  postSteps_() {
    return ['weeks', 'layout'].map((id) => Migrate.postStep_(id));
  },

  /**
   * The steps that follow the migration: id → {step, fn() → function or null}. Inside a single run
   * (postSteps_) they are weeks and layout; a staged migration runs STAGED_STEPS, one execution each.
   */
  POST_STEPS: {
    weeks: { step: 'Recalcular semanas', fn: () => (typeof Weeks !== 'undefined' && Weeks && typeof Weeks.recomputeAll === 'function' ? () => Weeks.recomputeAll() : null) },
    layout: { step: 'Aplicar layout', fn: () => (typeof Setup !== 'undefined' && Setup && typeof Setup.apply === 'function' ? () => Setup.apply() : null) },
    styles: {
      step: 'Aplicar layout',
      fn: () => (typeof Setup !== 'undefined' && Setup && typeof Setup.apply === 'function'
        ? (tabs) => Setup.apply({ dashboard: false, deadline: Date.now() + Migrate.STEP_BUDGET_MS, tabs: Array.isArray(tabs) ? tabs : undefined })
        : null),
    },
    dashboard: { step: 'Atualizar painel', fn: () => (typeof Dashboard !== 'undefined' && Dashboard && typeof Dashboard.render === 'function' ? () => Dashboard.render() : null) },
    audit: { step: 'Auditoria final', fn: () => () => Migrate.finalAudit_() },
  },

  /** What the dialog runs after a staged migration, in order. */
  STAGED_STEPS: ['weeks', 'styles', 'dashboard', 'audit'],

  /** Work time a resumable step takes before handing the rest to the next execution (of 6 min). */
  STEP_BUDGET_MS: 270000,

  /**
   * The audit of the migrated spreadsheet, its findings appended to Auditoria as open items.
   * @returns {string} the step's message
   */
  finalAudit_() {
    let otherNames = [];
    try { otherNames = Config.get('system.otherClientNames') || []; } catch (err) { otherNames = []; }
    const findings = Audit.findings({ otherNames: Array.isArray(otherNames) ? otherNames : [] });
    const at = new Date();
    // A finding already open in Auditoria (this step run again after a lost answer) is not repeated.
    const key = (f) => [f.code, f.tab, f.cell, f.finding].map((x) => String(x === null || x === undefined ? '' : x)).join('\u0000');
    const open_ = {};
    Tabs.read('audit').forEach((r) => { if (r.state === 'Aberto') open_[key(r)] = true; });
    const fresh = findings.filter((f) => !open_[key(f)]);
    if (fresh.length) Tabs.appendMany('audit', fresh.map((f) => Audit.row(f, at, 'Aberto')));
    const open = findings.filter((f) => f.severity === 'Erro').length;
    return { open, message: open ? `${open} ${open === 1 ? 'erro em aberto' : 'erros em aberto'}; veja a aba Auditoria` : 'nenhum erro em aberto' };
  },

  /**
   * One post step, its error caught: {step, status: 'ok'|'erro'|'ausente', message, again?}. `again`
   * (the work left, e.g. tab ids) asks for another call with it as `arg`, in a new execution.
   */
  postStep_(id, arg) {
    const s = Migrate.POST_STEPS[id];
    if (!s) return { step: String(id), status: 'erro', message: 'Passo desconhecido.' };
    const fn = s.fn();
    if (!fn) return { step: s.step, status: 'ausente', message: 'Módulo ainda não instalado; rode depois pelo menu.' };
    try {
      Tabs.invalidate();
      Config.invalidate();
      const out = fn(arg);
      Tabs.invalidate();
      Config.invalidate();
      if (out && Array.isArray(out.pending) && out.pending.length) {
        return { step: s.step, status: 'ok', message: `continua (${out.pending.length} abas)`, again: out.pending };
      }
      return { step: s.step, status: 'ok', message: typeof out === 'string' ? out : (out && out.message) || '' };
    } catch (err) {
      Tabs.invalidate();
      Config.invalidate();
      return { step: s.step, status: 'erro', message: err.message };
    }
  },

  /* Staged operation ---------------------------------------------------------------------------- */

  /**
   * A staged migration (the dialog) is one operation spread over executions: tables, the
   * migration body, then STAGED_STEPS. Its state lives in the document properties, so a new
   * execution, a second window or a reopened dialog sees the same thing:
   *   {v, id, phase: 'tables'|'migrating'|'steps', actionId (the migration's Log action, chosen
   *    and saved before its first write), next: [step ids left], cursor (tabs the layout still
   *    has to style), failed: {step, message} | null, auditOpen, legacy, unverified, seq, ...}
   * Each step writes under the migration's action id (ChangeLog.run join) with its Log rows
   * labelled "Migrar 3.0 → 4.0 — <step>", so the Log alone tells which steps ran, and one
   * "Desfazer última alteração" reverts the whole operation. While steps are left, other writes
   * are refused (guard_): they would sit between the migration's rows in the Log, and their undo
   * would rerun the derived refreshes over cells the migration's undo restores. The derived
   * refreshes stay muted while the operation runs and while it is undone (Undo.QUIET_PREFIXES).
   */
  OP_KEY: 'migration.op',
  OP_VERSION: 2,

  op_() {
    const text = PropertiesService.getDocumentProperties().getProperty(Migrate.OP_KEY);
    if (!text) return null;
    try { return JSON.parse(text); } catch (err) { return null; }
  },

  saveOp_(op) {
    op.v = Migrate.OP_VERSION;
    op.seq = (op.seq || 0) + 1;
    op.updated = new Date().toISOString();
    PropertiesService.getDocumentProperties().setProperty(Migrate.OP_KEY, JSON.stringify(op));
    return op;
  },

  dropOp_() {
    PropertiesService.getDocumentProperties().deleteProperty(Migrate.OP_KEY);
  },

  /** Starts (or returns) the operation before its first destructive step (the tables). */
  beginOp_() {
    const op = Migrate.op_();
    if (op && op.v === Migrate.OP_VERSION && op.phase === 'tables') return op;
    return Migrate.saveOp_({ id: ChangeLog.newId_(), phase: 'tables', actionId: null, next: [], cursor: null, failed: null, started: new Date().toISOString() });
  },

  /** After the migration body: every staged step is left. */
  startSteps_(actionId) {
    const op = Migrate.op_() || { id: ChangeLog.newId_(), started: new Date().toISOString() };
    Object.assign(op, { phase: 'steps', actionId, next: Migrate.STAGED_STEPS.slice(), cursor: null, failed: null });
    return Migrate.saveOp_(op);
  },

  /** Log label of a step's rows: "Migrar 3.0 → 4.0 — <step>". */
  stepLabel_(id) {
    return `${Migrate.LABEL} — ${Migrate.POST_STEPS[id].step}`;
  },

  /** The latest migration action not undone, or null. */
  migrationAction_() {
    return Undo.pending().find((a) => Undo.cleanLabel_(a.label) === Migrate.LABEL) || null;
  },

  /** Open errors (severity Erro, state Aberto) in Auditoria. */
  openErrors_() {
    if (!Tabs.findSheet('audit')) return 0;
    return Tabs.read('audit').filter((r) => r.severity === 'Erro' && r.state === 'Aberto').length;
  },

  /**
   * Where the operation stands, from the saved state checked against the spreadsheet:
   * {state: 'none'|'tables'|'running'|'failed'|'done'|'unverified', op}.
   * - phase 'migrating' (a body was started): the schema marker, the body's last write, says
   *   whether it finished; if not, the run was killed midway and what it wrote is rolled back
   *   (recoverBody_) before anything else.
   * - a state whose migration action was undone (or that a version restore took away) is dropped.
   * - a spreadsheet already on 4.0 without state is read from its Log (legacyOp_).
   */
  status() {
    let op = Migrate.op_();
    if (op && op.v !== Migrate.OP_VERSION) {
      // Saved before this version: a state derived from the Log is derived again; an operation
      // in progress gets its phase from its action id.
      if (op.legacy) { Migrate.dropOp_(); op = null; } else op = Migrate.saveOp_(Object.assign(op, { phase: op.actionId ? 'steps' : 'tables' }));
    }
    const migrated = Migrate.isMigrated();
    if (op && op.phase === 'migrating') {
      if (migrated) op = Migrate.startSteps_(op.actionId);
      else {
        Migrate.recoverBody_(op);
        op = Migrate.saveOp_(Object.assign(op, { phase: 'tables', actionId: null }));
      }
    }
    const live = (id) => !!id && ChangeLog.actions().some((a) => a.id === id && !a.undone);
    if (op && op.phase === 'steps' && !op.unverified && !live(op.actionId)) { Migrate.dropOp_(); op = null; }
    if (op && op.phase === 'tables' && migrated) { Migrate.dropOp_(); op = null; }
    if (op && op.phase === 'tables') return { state: 'tables', op };
    if (!op && migrated) op = Migrate.legacyOp_();
    else if (op && op.legacy && !op.unverified) op = Migrate.reconcileLegacy_(op);
    if (!op) return { state: 'none', op: null };
    if (op.unverified) return { state: 'unverified', op };
    if (!op.next.length) return { state: 'done', op };
    return { state: op.failed ? 'failed' : 'running', op };
  },

  /**
   * A spreadsheet on 4.0 without saved state (migrated by an older dialog, or its state lost):
   * the steps left are read from the Log (stepsLeft_). Without a migration action in the Log the
   * state is 'unverified', never done.
   */
  legacyOp_() {
    const a = Migrate.migrationAction_();
    const op = { id: ChangeLog.newId_(), phase: 'steps', actionId: a ? a.id : null, cursor: null, failed: null, legacy: true, started: new Date().toISOString() };
    if (!a) return Migrate.saveOp_(Object.assign(op, { next: [], unverified: true }));
    op.next = Migrate.stepsLeft_(a);
    if (!op.next.length) op.auditOpen = Migrate.openErrors_();
    return Migrate.saveOp_(op);
  },

  /**
   * A saved legacy state is only a cache of the Log: it is read again on every status, so undoing
   * (or restoring) a step that made it done brings the step back. The layout cursor and a failure
   * are kept while the same step is still the next one.
   */
  reconcileLegacy_(op) {
    const a = Migrate.migrationAction_();
    if (!a || a.id !== op.actionId) return Migrate.legacyOp_();
    const next = Migrate.stepsLeft_(a);
    const same = next[0] === op.next[0];
    const auditOpen = next.length ? op.auditOpen || 0 : Migrate.openErrors_();
    if (JSON.stringify(next) === JSON.stringify(op.next) && auditOpen === (op.auditOpen || 0)) return op;
    return Migrate.saveOp_(Object.assign(op, { next, auditOpen, cursor: same ? op.cursor : null, failed: same ? op.failed : null }));
  },

  /**
   * The steps still to run after migration action `a`, from Log rows not undone that come after
   * its first row, the steps in order, each one after the previous: a step is done when its
   * "step_done" Auditoria row (markStepDone_, written in the step's own action) is there, or, for
   * steps run by an older dialog, when rows labelled "Migrar 3.0 → 4.0 — <step>" are. An older
   * layout (several executions) is proven only by a later Painel; an older audit that wrote
   * nothing left no trace and runs again (it does not repeat open findings).
   */
  stepsLeft_(a) {
    const first = Math.min(...a.changes.map((c) => c.logRow));
    const audit = Tabs.get('audit').name;
    const rows = {};
    const done = {};
    Migrate.STAGED_STEPS.forEach((id) => { rows[id] = []; done[id] = []; });
    ChangeLog.entries().forEach((e) => {
      if (e.undone || e.logRow < first) return;
      const label = Undo.cleanLabel_(e.action);
      Migrate.STAGED_STEPS.forEach((id) => {
        const step = Migrate.stepLabel_(id);
        if (label !== step && label !== `${step}${Migrate.CONTINUED}`) return;
        // Rows of an older dialog's step action count by themselves; rows written by this code
        // (joined to the migration, or "(continuação)") count only with their step_done row, so
        // a step stopped midway is never taken for done.
        if (label === step && e.actionId !== a.id) rows[id].push(e.logRow);
        const vals = e.kind === 'append' && e.tab === audit ? Object.keys(e.after || {}).map((k) => e.after[k]) : [];
        if (vals.indexOf(Migrate.STEP_DONE) >= 0 && vals.indexOf(id) >= 0) done[id].push(e.logRow);
      });
    });
    const after = (list, row) => list.filter((r) => r > row);
    let prev = first;
    const steps = Migrate.STAGED_STEPS;
    for (let i = 0; i < steps.length; i++) {
      const id = steps[i];
      const proof = after(done[id], prev);
      if (proof.length) { prev = Math.max(...proof); continue; }
      if (id === 'styles') {
        // Older dialog: the layout is proven by a later Painel run (checked as the next step).
        const later = after(rows.dashboard, prev);
        if (after(rows.styles, prev).length && later.length) continue;
        return steps.slice(i);
      }
      const legacy = after(rows[id], prev);
      if (!legacy.length) return steps.slice(i);
      prev = Math.max(...legacy);
    }
    return [];
  },

  /** Code of the Auditoria row a finished step writes (its durable proof, see stepsLeft_). */
  STEP_DONE: 'step_done',

  /** Label suffix of a step this code runs as an action of its own (legacy spreadsheets). */
  CONTINUED: ' (continuação)',

  /** Writes the "step done" row of step `id` (inside the step's action, so undo removes it). */
  markStepDone_(id) {
    Tabs.append('audit', Audit.row({ severity: 'Info', code: Migrate.STEP_DONE, tab: '', cell: id, finding: `${Migrate.POST_STEPS[id].step}: concluída.`, action: 'Parte da migração (Desfazer última alteração reverte tudo).' }, new Date(), 'Corrigido'));
  },

  /**
   * Rolls back what a migration body killed midway wrote (Log rows of op.actionId, schema marker
   * missing) so the retry starts from the 3.0 file. Two phases, safe to stop at any point and run
   * again (a recovery killed midway is finished by the next one; nothing it did is redone):
   *  1. plan, nothing written: every cell the body logged must hold one of the values the body
   *     wrote there or the value it had before; a column the body inserted is removed only when
   *     the tab has exactly the expected width and those columns hold nothing but cells the body
   *     wrote; a tab the body created is removed only when it holds nothing but its skeleton and
   *     cells the body wrote; a rename is undone only when the old name is free; a named range
   *     only when it still points where the migration put it. Anything else (someone edited, a
   *     column was inserted by hand…) throws 'interrupted_conflict' and nothing is changed.
   *  2. apply: each cell straight to its value before the body (cells already there are left),
   *     then the structures newest first (already undone ones are recognised), then the Log rows
   *     are marked undone.
   * Cells are located without trusting the current header row (the recovery may already have put
   * the 3.0 headers back): row-addressed changes use the header texts the body itself wrote.
   * @returns {number} Log rows reverted
   */
  recoverBody_(op) {
    const all = ChangeLog.entries().filter((e) => e.actionId === op.actionId);
    const changes = all.filter((e) => !e.undone);
    if (!changes.length) return 0;
    const ss = SpreadsheetApp.getActive();
    // Rows already marked by a recovery killed midway still tell which tabs were renamed or
    // created, which header texts were written and each cell's value before the body, so the
    // rest is found where it is now and put back to the original, not to an intermediate value.
    const plan = Migrate.recoveryPlan_(ss, changes, all);
    if (plan.conflicts.length) {
      throw Undo.error_('interrupted_conflict', `A migração foi interrompida no meio e ${plan.conflicts.slice(0, 5).join('; ')}; nada foi desfeito. Confira a planilha (ou restaure a versão anterior pelo histórico de versões) antes de migrar de novo.`);
    }
    plan.cells.forEach((x) => {
      if (Undo.same_(Migrate.gridValue_(plan.grids, x), x.target)) return;
      Undo.setCell_(ss.getSheetByName(x.sheet).getRange(x.row, x.col), x.target);
    });
    plan.structures.forEach((s) => s.apply());
    const now = new Date();
    changes.forEach((c) => Tabs.update('log', c.logRow, { undone: now }));
    Tabs.invalidate();
    Config.invalidate();
    Migrate.log_(`migração interrompida desfeita: ${changes.length} alterações`);
    return changes.length;
  },

  /** Current value (formula text or value) of a planned cell, from the grids read by the plan. */
  gridValue_(grids, x) {
    const g = grids[x.sheet];
    return g.formulas[x.row - 1][x.col - 1] || g.values[x.row - 1][x.col - 1];
  },

  /** 1-based column of letters ("AH" → 34). */
  colOf_(letters) {
    return String(letters).toLowerCase().split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 96, 0);
  },

  /**
   * {cells: [{sheet, row, col, target}], structures: [{apply}], grids, conflicts: [text]} for the
   * changes of an interrupted body (oldest first). Reads every touched sheet once; writes nothing.
   */
  recoveryPlan_(ss, changes, all) {
    const conflicts = [];
    const context = all || changes;
    const structs = context.filter((c) => c.kind === 'structure').map((c) => c.after || {});
    const renamedFrom = {};
    structs.filter((s) => s.op === 'renameSheet').forEach((s) => { renamedFrom[s.to] = s.from; });
    const created = structs.filter((s) => s.op === 'insertSheet').map((s) => s.name);
    const inserts = structs.filter((s) => s.op === 'insertColumns');
    // The sheet now holding a tab the body named `name` (renamed back already: under its old name).
    const sheetOf = (name) => ss.getSheetByName(name) || (renamedFrom[name] && ss.getSheetByName(renamedFrom[name])) || null;
    const specOf = (name) => Tabs.byName(name) || Tabs.byName(renamedFrom[name] || '');
    const headerRowOf = (name) => { const spec = specOf(name); return spec && spec.headerRow ? spec.headerRow : Tabs.HEADER_ROW; };
    const grids = {};
    const grid = (name) => {
      const sheet = sheetOf(name);
      if (!sheet) return null;
      const key = sheet.getName();
      if (!grids[key]) {
        const rows = sheet.getMaxRows();
        const cols = sheet.getMaxColumns();
        const range = sheet.getRange(1, 1, rows, cols);
        grids[key] = { sheet, rows, cols, values: range.getValues(), formulas: range.getFormulas() };
      }
      return grids[key];
    };
    // Header texts the body wrote ("cells" changes on a header row), so a row-addressed change is
    // found even after the recovery put the 3.0 headers back.
    const headerAfter = {};
    context.forEach((c) => {
      if (c.kind !== 'cells' || !c.after) return;
      const headerRow = headerRowOf(c.tab);
      Object.keys(c.after).forEach((a1) => {
        const m = /^([A-Za-z]+)(\d+)$/.exec(a1);
        if (m && Number(m[2]) === headerRow) (headerAfter[c.tab] = headerAfter[c.tab] || {})[Migrate.colOf_(m[1])] = c.after[a1];
      });
    });
    const columnOf = (c, name) => {
      const m = /^#(\d+)$/.exec(name);
      if (m) return Number(m[1]);
      const g = grid(c.tab);
      const texts = {};
      if (g) (g.values[headerRowOf(c.tab) - 1] || []).forEach((h, i) => { texts[i + 1] = h; });
      Object.assign(texts, headerAfter[c.tab] || {});
      const col = Object.keys(texts).map(Number).sort((a, b) => a - b).find((i) => String(texts[i]).trim() === name);
      return col || null;
    };
    // A cell gone with a structure the recovery already removed: a tab the body created, or a
    // column it inserted, when that tab/column no longer exists.
    const gone = (name, col) => {
      const g = grid(name);
      if (!g) return created.indexOf(name) >= 0;
      const now = g.sheet.getName();
      return col > g.cols && inserts.some((s) => (s.sheet === name || s.sheet === now) && col > s.after && col <= s.after + s.count && g.cols <= s.after);
    };
    const blank = (v) => (v === null || v === undefined ? '' : v);
    // Every cell the body logged: its value before the body and every value it was given. Built
    // from the whole action in Log order, rows already marked by a killed recovery included, so a
    // cell whose first row is marked still goes back to the value before its first write (A in
    // A → B → C, never B). Only cells with a row still pending are part of the plan; the marked
    // rows are evidence, not work.
    const pendingRows = new Set(changes.map((c) => c.logRow));
    const history = context.slice().sort((a, b) => a.logRow - b.logRow);
    const cells = new Map();
    history.forEach((c) => {
      const pending = pendingRows.has(c.logRow);
      const fail = (text) => { if (pending) conflicts.push(text); };
      if (c.kind === 'structure') return;
      if (c.kind === 'delete') { fail(`a exclusão da linha ${c.row} de "${c.tab}" não pode ser desfeita automaticamente`); return; }
      const after = c.after || {};
      const before = c.before || {};
      // A tab the body created and the recovery already removed took these cells with it.
      if (!grid(c.tab) && created.indexOf(c.tab) >= 0) return;
      Object.keys(after).forEach((name) => {
        let row;
        let col;
        if (c.kind === 'cells') {
          const m = /^([A-Za-z]+)(\d+)$/.exec(name);
          if (!m) { fail(`célula ${name} de "${c.tab}" ilegível no Log`); return; }
          row = Number(m[2]);
          col = Migrate.colOf_(m[1]);
        } else {
          row = c.row;
          col = columnOf(c, name);
          if (!col) { fail(`coluna "${name}" de "${c.tab}" não encontrada`); return; }
        }
        if (gone(c.tab, col)) return;
        const g = grid(c.tab);
        if (!g) { fail(`aba "${c.tab}" não existe mais`); return; }
        if (row > g.rows || col > g.cols) { fail(`${c.tab}!${Audit.a1_(row, col)} está fora da aba`); return; }
        const was = c.kind === 'append' ? '' : blank(name in before ? before[name] : '');
        const key = `${g.sheet.getName()}|${row}|${col}`;
        if (!cells.has(key)) cells.set(key, { sheet: g.sheet.getName(), row, col, target: was, seen: [], pending: false });
        const x = cells.get(key);
        x.seen.push(blank(after[name]), was);
        if (pending) x.pending = true;
      });
    });
    // A cell whose rows are all marked was put back by the killed recovery before its first mark
    // (cells go back before any row is marked): it is no longer the recovery's to check or write.
    cells.forEach((x, key) => { if (!x.pending) cells.delete(key); });
    cells.forEach((x) => {
      const now = Migrate.gridValue_(grids, x);
      if (!x.seen.some((v) => Undo.same_(now, v))) conflicts.push(`${x.sheet}!${Audit.a1_(x.row, x.col)} mudou`);
    });
    const written = (sheetName, row, col) => {
      const x = cells.get(`${sheetName}|${row}|${col}`);
      return !!x && x.target === '';
    };
    const empty = (v) => v === '' || v === null || v === undefined;
    // Structures, newest first, against a simulated state (widths change as columns go).
    const widths = {};
    const structures = [];
    changes.slice().reverse().forEach((c) => {
      if (c.kind !== 'structure') return;
      const s = c.after || {};
      if (s.op === 'insertColumns') {
        const g = grid(s.sheet);
        if (!g) { if (created.indexOf(s.sheet) < 0) conflicts.push(`aba "${s.sheet}" não existe mais`); return; }
        const name = g.sheet.getName();
        const w = name in widths ? widths[name] : g.cols;
        if (w === s.after) return; // removed already (or never inserted)
        if (w !== s.after + s.count) {
          conflicts.push(`as colunas de "${name}" mudaram (${w} colunas; a migração deixou ${s.after + s.count})`);
          return;
        }
        for (let r = 1; r <= g.rows; r++) {
          for (let col = s.after + 1; col <= s.after + s.count; col++) {
            const v = g.formulas[r - 1][col - 1] || g.values[r - 1][col - 1];
            if (!empty(v) && !written(name, r, col)) { conflicts.push(`${name}!${Audit.a1_(r, col)} tem conteúdo que a migração não escreveu`); return; }
          }
        }
        widths[name] = s.after;
        structures.push({ apply: () => { const sh = ss.getSheetByName(name); if (sh && sh.getMaxColumns() === s.after + s.count) sh.deleteColumns(s.after + 1, s.count); } });
      } else if (s.op === 'insertSheet') {
        if (!ss.getSheetByName(s.name)) return; // removed already (or never created)
        const g = grid(s.name);
        const spec = Tabs.byName(s.name);
        const skeleton = {};
        if (spec) {
          skeleton[`${Tabs.TITLE_ROW}|1`] = spec.title || spec.name;
          if (spec.help) skeleton[`${Tabs.HELP_ROW}|1`] = spec.help;
          Tabs.headers(spec.id).forEach((h, i) => { skeleton[`${spec.headerRow}|${i + 1}`] = h; });
        }
        for (let r = 1; r <= g.rows; r++) {
          for (let col = 1; col <= g.cols; col++) {
            const v = g.formulas[r - 1][col - 1] || g.values[r - 1][col - 1];
            if (empty(v) || written(s.name, r, col)) continue;
            if (`${r}|${col}` in skeleton && Undo.same_(v, skeleton[`${r}|${col}`])) continue;
            conflicts.push(`a aba "${s.name}", criada pela migração, tem conteúdo que ela não escreveu (${Audit.a1_(r, col)})`);
            return;
          }
        }
        structures.push({ apply: () => { const sh = ss.getSheetByName(s.name); if (sh) ss.deleteSheet(sh); } });
      } else if (s.op === 'renameSheet') {
        const to = ss.getSheetByName(s.to);
        const from = ss.getSheetByName(s.from);
        if (from && !to) return; // renamed back already (or never renamed)
        if (!to || from) { conflicts.push(`a aba "${s.to}" não pode voltar a se chamar "${s.from}"`); return; }
        structures.push({ apply: () => { const sh = ss.getSheetByName(s.to); if (sh && !ss.getSheetByName(s.from)) sh.setName(s.from); } });
      } else if (s.op === 'namedRange') {
        const range = ss.getRangeByName(s.name);
        if (!range) return; // removed already (or never created)
        const known = Migrate.LEGACY_LISTS[s.name];
        if (!known || range.getSheet().getName() !== Tabs.get(known.tab).name) {
          conflicts.push(`o intervalo nomeado "${s.name}" não aponta para onde a migração o criou`);
          return;
        }
        structures.push({ apply: () => { if (ss.getRangeByName(s.name)) ss.removeNamedRange(s.name); } });
      } else {
        conflicts.push(`alteração estrutural desconhecida (${s.op})`);
      }
    });
    return { cells: Array.from(cells.values()), structures, grids, conflicts };
  },

  /**
   * ChangeLog guard: while a staged migration has steps left (or a body was started and not yet
   * reconciled), other actions are refused with a recognizable error. Nothing reaches the Log, so
   * a refused bot write is not taken for done and its retry runs normally later. Reads, the
   * operation's own runs (id/join, "Migrar 3.0 → 4.0" labels) and undo are not affected.
   */
  guard_(label, opts) {
    if (opts.join || opts.id || Undo.quiet_(label)) return;
    const op = Migrate.op_();
    if (!op || op.legacy || op.v !== Migrate.OP_VERSION) return;
    const open = op.phase === 'migrating'
      || (op.phase === 'steps' && op.next && op.next.length && ChangeLog.actions().some((a) => a.id === op.actionId && !a.undone));
    if (open) {
      throw Undo.error_('migration_in_progress', 'A migração 3.0 → 4.0 está em andamento: termine-a em Acompanhamento → Sistema → Migrar 3.0 → 4.0 (Continuar a migração) e tente de novo. Nada foi gravado.');
    }
  },

  /** The state as the dialog gets it. */
  publicStatus_(st) {
    const op = st.op || {};
    const s = { state: st.state, opId: op.id || null, seq: op.seq || 0, next: (op.next || [])[0] || null, left: (op.next || []).length, cursor: op.cursor || null, failed: op.failed || null, auditOpen: op.auditOpen || 0 };
    if (st.state === 'done') {
      s.message = s.auditOpen
        ? `Migração concluída, mas a auditoria final encontrou ${s.auditOpen} ${s.auditOpen === 1 ? 'erro em aberto' : 'erros em aberto'}: veja a aba Auditoria.`
        : 'Migração concluída. Pode fechar esta janela.';
    } else if (st.state === 'failed') {
      s.message = `A etapa "${(Migrate.POST_STEPS[op.failed.step] || {}).step || op.failed.step}" falhou: ${op.failed.message}. Nada dela ficou gravado; tente de novo.`;
    } else if (st.state === 'running') {
      s.message = `Migração em andamento: falta${s.left === 1 ? '' : 'm'} ${s.left} ${s.left === 1 ? 'etapa' : 'etapas'}.`;
    } else if (st.state === 'tables') {
      s.message = 'Tabelas convertidas; falta confirmar a migração.';
    } else if (st.state === 'unverified') {
      s.message = 'A planilha está na versão 4.0, mas o Log não tem o registro da migração para conferir as etapas. Rode Acompanhamento → Sistema → Auditoria e confira os erros em aberto.';
    }
    return s;
  },

  /**
   * Runs the next step of the operation, in an execution of its own (each Apps Script run has 6
   * minutes, and the layout alone takes most of them on a real spreadsheet). The caller names what
   * it believes comes next (opId, step id, layout cursor); anything else (a second window, a
   * repeated click, an answer that came back late) changes nothing and gets the current state.
   * A step that throws is rolled back by ChangeLog.run and recorded as failed. A step continues
   * the migration's action only while it is the latest one in the Log; a spreadsheet migrated by
   * an older dialog (legacy) gets the step as an action of its own instead.
   * @returns {{step?, status?: 'ok'|'erro', message?, stale?: boolean, state: Object}}
   */
  runStep(opId, id, cursor) {
    Migrate.t0_ = Date.now();
    return Core.withLock(() => {
      const st = Migrate.status();
      const op = st.op;
      const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);
      if (!op || op.id !== opId || op.phase !== 'steps' || !op.next.length || op.next[0] !== id || !same(op.cursor, cursor)) {
        return { stale: true, state: Migrate.publicStatus_(st) };
      }
      const s = Migrate.POST_STEPS[id];
      const fn = s ? s.fn() : null;
      Migrate.log_(`${s ? s.step : id}: início`);
      const fail = (message) => {
        op.failed = { step: id, message };
        Migrate.saveOp_(op);
        Migrate.log_(`${s ? s.step : id}: erro (${message})`);
        return { step: s ? s.step : id, status: 'erro', message, state: Migrate.publicStatus_(Migrate.status()) };
      };
      if (!fn) return fail('módulo ainda não instalado');
      const latest = (Undo.pending()[0] || {}).id;
      if (latest !== op.actionId && !op.legacy) {
        return fail('há alterações no Log depois da migração; desfaça-as (Desfazer última alteração) ou restaure a versão anterior antes de continuar');
      }
      let out;
      try {
        Tabs.invalidate();
        Config.invalidate();
        const joined = latest === op.actionId;
        const label = joined ? Migrate.stepLabel_(id) : `${Migrate.stepLabel_(id)}${Migrate.CONTINUED}`;
        out = Core.mute(Migrate.DERIVED_EVENTS, () => ChangeLog.run(label, () => {
          const o = fn(cursor || undefined);
          // The step's durable proof, in its own action: only once it has nothing left to do.
          if (!(o && Array.isArray(o.pending) && o.pending.length)) Migrate.markStepDone_(id);
          return o;
        }, joined ? { join: op.actionId } : {}));
      } catch (err) {
        console.error(err);
        Tabs.invalidate();
        Config.invalidate();
        return fail(err.message);
      }
      Tabs.invalidate();
      Config.invalidate();
      const pending = out && Array.isArray(out.pending) && out.pending.length ? out.pending : null;
      if (pending) op.cursor = pending;
      else { op.next.shift(); op.cursor = null; }
      if (id === 'audit') op.auditOpen = out.open;
      op.failed = null;
      Migrate.saveOp_(op);
      const message = pending ? `continua (${pending.length} abas)` : (out && out.message) || '';
      Migrate.log_(`${s.step}: ok${message ? ` (${message})` : ''}`);
      return { step: s.step, status: 'ok', message, state: Migrate.publicStatus_(Migrate.status()) };
    });
  },

  /* Tabs, columns and cells --------------------------------------------------------------------- */

  /** Returns the tab's sheet, creating it (logged as a structural change) when missing. */
  ensureTab(id) {
    const existing = Tabs.findSheet(id);
    if (existing) return { sheet: existing, created: false };
    const name = Tabs.get(id).name;
    ChangeLog.structure(name, { op: 'insertSheet', name });
    const sheet = Tabs.ensure(id);
    const cols = Tabs.columns(id).length;
    Tabs.invalidate();
    return { sheet, created: true, cols };
  },

  renameTabs_(rep) {
    const ss = SpreadsheetApp.getActive();
    Tabs.ids().forEach((id) => {
      const spec = Tabs.get(id);
      if (ss.getSheetByName(spec.name)) {
        (spec.legacyNames || []).forEach((old) => {
          if (ss.getSheetByName(old)) rep('Aviso', 'tab_legacy_duplicate', old, '', `Existem as abas "${old}" (3.0) e "${spec.name}" (4.0).`, 'Nada foi renomeado; confira e apague a aba antiga à mão se estiver vazia.', null, 'Aberto');
        });
        return;
      }
      const old = (spec.legacyNames || []).find((n) => ss.getSheetByName(n));
      if (!old) return;
      ChangeLog.structure(spec.name, { op: 'renameSheet', from: old, to: spec.name });
      ss.getSheetByName(old).setName(spec.name);
      rep('Info', 'tab_renamed', spec.name, '', `Aba "${old}" renomeada para "${spec.name}" (mesma aba: links e gráficos continuam).`, 'Renomeada no lugar.', old);
    });
    Tabs.invalidate();
  },

  createTabs_(rep) {
    const created = [];
    Tabs.ids().forEach((id) => {
      if (Tabs.findSheet(id)) return;
      Migrate.ensureTab(id);
      created.push(id);
      rep('Info', 'tab_created', Tabs.get(id).name, '', `Aba "${Tabs.get(id).name}" criada.`, Tabs.get(id).kind === 'layout' ? 'Criada vazia; o script desenha o conteúdo.' : 'Criada com título, ajuda e cabeçalho da 4.0.', null);
    });
    return created;
  },

  /** Inserts columns at the right (logged) so the sheet has at least `n` columns. */
  ensureColumns_(sheet, n) {
    const max = sheet.getMaxColumns();
    if (n <= max) return;
    ChangeLog.structure(sheet.getName(), { op: 'insertColumns', sheet: sheet.getName(), after: max, count: n - max });
    sheet.insertColumnsAfter(max, n - max);
  },

  /**
   * Writes cells ({"row,col": value}) logged as one 'cells' change; unchanged cells are skipped.
   * A value starting with "=" is written as a formula. @returns {number} cells changed
   */
  write_(sheet, cells) {
    const list = Object.keys(cells).map((k) => { const p = k.split(','); return { r: Number(p[0]), c: Number(p[1]), v: cells[k] === null || cells[k] === undefined ? '' : cells[k] }; });
    if (!list.length) return 0;
    const r1 = Math.min(...list.map((x) => x.r));
    const r2 = Math.max(...list.map((x) => x.r));
    const c1 = Math.min(...list.map((x) => x.c));
    const c2 = Math.max(...list.map((x) => x.c));
    Migrate.ensureColumns_(sheet, c2);
    const range = sheet.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1);
    const values = range.getValues();
    const formulas = range.getFormulas();
    const changed = list.filter((x) => {
      const f = formulas[x.r - r1][x.c - c1];
      const old = f || values[x.r - r1][x.c - c1];
      if (f ? f === x.v : Tabs.sameCell(old, x.v)) return false;
      x.old = old;
      return true;
    });
    if (!changed.length) return 0;
    const before = {};
    const after = {};
    changed.forEach((x) => { const a1 = Audit.a1_(x.r, x.c); before[a1] = x.old; after[a1] = x.v; });
    ChangeLog.track({ kind: 'cells', tab: sheet.getName(), row: null, before, after });
    // One setValues per run of adjacent cells in a row (each call is a round trip on a real
    // spreadsheet); formulas are set one by one so they are never written as text.
    const isFormula = (x) => typeof x.v === 'string' && x.v.charAt(0) === '=';
    changed.filter(isFormula).forEach((x) => sheet.getRange(x.r, x.c).setFormula(x.v));
    const plainCells = changed.filter((x) => !isFormula(x)).sort((a, b) => a.r - b.r || a.c - b.c);
    let run = [];
    const flush = () => {
      if (run.length) sheet.getRange(run[0].r, run[0].c, 1, run.length).setValues([run.map((x) => Tabs.input(x.v))]);
      run = [];
    };
    plainCells.forEach((x) => {
      const last = run[run.length - 1];
      if (last && (last.r !== x.r || last.c + 1 !== x.c)) flush();
      run.push(x);
    });
    flush();
    Tabs.invalidate(sheet.getName());
    return changed.length;
  },

  key_(row, col) {
    return `${row},${col}`;
  },

  /** Title (row 2) and help (row 3) of a table tab as in Tabs.SPEC. */
  titleCells_(spec, sheet, cells, rep) {
    const cur = sheet.getRange(Tabs.TITLE_ROW, 1, 2, 1).getValues();
    const title = spec.title || spec.name;
    const olds = [];
    if (cur[0][0] !== title) { cells[Migrate.key_(Tabs.TITLE_ROW, 1)] = title; if (cur[0][0] !== '') olds.push(cur[0][0]); }
    if (spec.help && cur[1][0] !== spec.help) { cells[Migrate.key_(Tabs.HELP_ROW, 1)] = spec.help; if (cur[1][0] !== '') olds.push(cur[1][0]); }
    if (cur[0][0] !== title || (spec.help && cur[1][0] !== spec.help)) {
      rep('Info', 'title_help', sheet.getName(), 'A2:A3', 'Título e ajuda da aba trocados pelos da 4.0 (sem nomes de cliente nem textos da 3.0).', 'Reescritos.', olds.join(' | '));
    }
  },

  /**
   * One data tab: title/help, per-row formulas of script-written tabs, header (rebuilt when the tab
   * has no data; otherwise 3.0 header texts renamed and missing columns appended at the right),
   * and dates typed as text or with a time of day.
   */
  migrateTable_(id, rep) {
    const spec = Tabs.get(id);
    const sheet = Tabs.findSheet(id);
    if (!sheet) return;
    const name = sheet.getName();
    const cells = {};
    Migrate.titleCells_(spec, sheet, cells, rep);

    // Per-row formulas of tabs the script writes: keep the computed value, drop the formula.
    let lastRow = sheet.getLastRow();
    let lastCol = sheet.getLastColumn();
    const grid = lastRow >= spec.firstDataRow && lastCol
      ? sheet.getRange(spec.firstDataRow, 1, lastRow - spec.firstDataRow + 1, lastCol) : null;
    const values = grid ? grid.getValues() : [];
    const formulas = grid ? grid.getFormulas() : [];
    if (Migrate.SCRIPT_WRITTEN.indexOf(id) >= 0) {
      let n = 0;
      let first = null;
      formulas.forEach((line, i) => line.forEach((f, j) => {
        if (!f) return;
        const v = values[i][j];
        const keep = v instanceof Date || (v !== '' && v !== null && !(typeof v === 'string' && Audit.ERROR_VALUE.test(v)));
        cells[Migrate.key_(spec.firstDataRow + i, j + 1)] = keep ? v : '';
        values[i][j] = keep ? v : '';
        formulas[i][j] = '';
        if (!first) first = f;
        n++;
      }));
      if (n) rep('Info', 'formulas_removed', name, `linhas ${spec.firstDataRow}+`, `${n} ${n === 1 ? 'fórmula por linha removida' : 'fórmulas por linha removidas'}; na 4.0 o script grava os valores (sem intervalos fixos).`, 'Valores calculados mantidos; fórmulas retiradas.', first);
    }
    const hasData = values.some((line) => line.some((v) => v !== '' && v !== null)) || formulas.some((line) => line.some(Boolean));

    const m = Audit.headerMatch(sheet, id);
    const matched = Object.keys(m.map).length;
    const allCalc = spec.columns.every((c) => c.role !== 'input');
    const width = spec.columns.length;
    const rebuild = !hasData || (allCalc && matched < width / 2);
    if (rebuild) {
      if (hasData) {
        values.forEach((line, i) => {
          const texts = line.map((v) => Audit.quote(v)).filter((s) => s !== '');
          if (!texts.length) return;
          const row = spec.firstDataRow + i;
          rep('Info', 'layout_archived', name, `linha ${row}`, 'Conteúdo da 3.0 sem lugar na aba 4.0 (gerada pelo script) arquivado aqui.', 'Texto citado nesta linha; células limpas.', texts.join(' | '));
          line.forEach((v, j) => { if (v !== '' && v !== null) cells[Migrate.key_(row, j + 1)] = ''; });
        });
      }
      const oldHeader = m.texts.map((t) => String(t === null ? '' : t)).filter((t) => t !== '');
      const target = Tabs.headers(id);
      const span = Math.max(m.lastCol, width);
      let changed = false;
      for (let c = 1; c <= span; c++) {
        const want = c <= width ? target[c - 1] : '';
        const have = c <= m.lastCol ? m.texts[c - 1] : '';
        if (String(have === null ? '' : have).trim() !== want) { cells[Migrate.key_(spec.headerRow, c)] = want; changed = true; }
      }
      if (changed) {
        rep('Info', 'header_rebuilt', name, `linha ${spec.headerRow}`, hasData ? 'Cabeçalho refeito na ordem da 4.0 (aba gerada pelo script).' : 'Aba sem dados: cabeçalho refeito na ordem da 4.0.', `Colunas: ${target.join(', ')}.`, oldHeader.join(' | '));
      }
    } else {
      const renamed = [];
      m.aliasUsed.forEach((a) => {
        const header = Tabs.column(id, a.key).header;
        cells[Migrate.key_(spec.headerRow, a.col)] = header;
        renamed.push(`${a.text} → ${header}`);
      });
      if (renamed.length) rep('Info', 'header_renamed', name, `linha ${spec.headerRow}`, 'Cabeçalhos da 3.0 renomeados (mesma coluna, dados no lugar).', renamed.join('; '), m.aliasUsed.map((a) => a.text).join(' | '));
      const missing = spec.columns.filter((c) => !m.map[c.key]);
      missing.forEach((c, i) => { cells[Migrate.key_(spec.headerRow, m.lastCol + 1 + i)] = c.header; });
      if (missing.length) {
        rep('Info', 'columns_added', name, `${Audit.col_(m.lastCol + 1)}${spec.headerRow}:${Audit.col_(m.lastCol + missing.length)}${spec.headerRow}`, `Colunas da 4.0 acrescentadas à direita: ${missing.map((c) => c.header).join(', ')}.`, 'Nenhuma coluna existente foi movida.', null);
      }
    }
    // A 3.0 input cell on the header row (Progressão's exercise picker in B5) has a strict validation
    // that rejects the header text; headers never carry one, and Setup.apply re-creates the 4.0 rules.
    Object.keys(cells).map((k) => k.split(',').map(Number)).filter(([r]) => r === spec.headerRow)
      .forEach(([r, c]) => { if (c <= sheet.getMaxColumns()) sheet.getRange(r, c).clearDataValidations(); });
    Migrate.write_(sheet, cells);
    Tabs.invalidate();
    if (!rebuild || hasData) Migrate.fixDateCells_(id, rep);
  },

  /** Text dates and dates with a time of day in the tab's date columns → pure local dates. */
  fixDateCells_(id, rep) {
    const spec = Tabs.get(id);
    const sheet = Tabs.findSheet(id);
    const lastRow = sheet.getLastRow();
    if (lastRow < spec.firstDataRow) return;
    const m = Audit.headerMatch(sheet, id);
    const cells = {};
    spec.columns.filter((c) => c.type === 'date' && m.map[c.key]).forEach((c) => {
      const col = m.map[c.key];
      const range = sheet.getRange(spec.firstDataRow, col, lastRow - spec.firstDataRow + 1, 1);
      const values = range.getValues();
      const formulas = range.getFormulas();
      values.forEach((line, i) => {
        const v = line[0];
        if (formulas[i][0] || v === '' || v === null) return;
        const row = spec.firstDataRow + i;
        if (typeof v === 'string' && Dates.parse(v)) {
          cells[Migrate.key_(row, col)] = Dates.parse(v);
          rep('Info', 'text_date', sheet.getName(), Audit.a1_(row, col), `Data em texto em "${c.header}" gravada como data.`, Dates.format(v), v);
        } else if (v instanceof Date && !Dates.isTechnical(v) && Utilities.formatDate(v, Dates.tz(), 'HH:mm:ss') !== '00:00:00') {
          cells[Migrate.key_(row, col)] = Dates.parse(v);
          rep('Info', 'date_with_time', sheet.getName(), Audit.a1_(row, col), `Horário retirado da data em "${c.header}" (datas são dias puros).`, Dates.format(v), Utilities.formatDate(v, Dates.tz(), 'dd/MM/yyyy HH:mm'));
        }
      });
    });
    Migrate.write_(sheet, cells);
  },

  /* Config -------------------------------------------------------------------------------------- */

  /**
   * Writes Config. From the 3.0 profile: the tab (already renamed) is rewritten as Chave |
   * Parâmetro | Valor | Unidade | Descrição and every 3.0 row is quoted in Auditoria. On a 4.0 Config
   * only differing values are set. schemaVersion is left for the end of the migration.
   */
  writeConfig_(config, legacy, rep) {
    const spec = Tabs.get('config');
    const sheet = Tabs.findSheet('config');
    const name = sheet.getName();
    const values = {};
    Config.keys().forEach((k) => { if (k !== 'system.schemaVersion') values[k] = config[k].value; });

    if (Audit.isConfigLayout_(sheet)) {
      Config.invalidate();
      Object.keys(values).forEach((k) => {
        if (config[k].source !== 'json') return;
        const before = Config.raw(k);
        const cell = Config.toCell_(Config.DEFAULTS[k], values[k]);
        if (Tabs.sameCell(before === null ? '' : before, cell)) return;
        Config.set(k, values[k]);
        rep('Info', 'config_set', name, k, `${Config.DEFAULTS[k].label} = ${Migrate.show_(cell)} (da configuração do cliente).`, 'Valor gravado.', before);
      });
      return;
    }

    // 3.0 profile → archive every row, then rewrite the tab.
    const lastRow = Math.max(sheet.getLastRow(), spec.headerRow);
    const lastCol = Math.max(sheet.getLastColumn(), spec.columns.length);
    const cells = {};
    Migrate.titleCells_(spec, sheet, cells, rep);
    (legacy ? legacy.rows : []).forEach((r) => {
      const key = Migrate.LEGACY_PROFILE[r.label];
      const shown = [r.label, r.formula || Audit.quote(r.value), r.unit, r.origin].map((x) => Audit.quote(x)).filter((x) => x !== '').join(' | ');
      let action;
      if (key) action = `Virou ${key} = ${Migrate.show_(Config.toCell_(Config.DEFAULTS[key], values[key]))} (${config[key].source === 'json' ? 'da configuração do cliente' : 'da 3.0'}${legacy.config[key] && legacy.config[key].converted ? '; convertido para cm' : ''}).`;
      else if (Migrate.LEGACY_GOAL[r.label]) action = 'Meta: agora na aba Metas (versão em vigor).';
      else if (Migrate.LEGACY_OBJECTIVE[r.label]) action = 'Objetivo: agora na aba Objetivos.';
      else if (Tabs.normalize_(r.label) === Tabs.normalize_(Audit.PLAN_STATUS_LABEL)) action = 'Status digitado retirado: o status da ficha é derivado da aba Fichas.';
      else if (Audit.STALE_TEXT.test(String(r.value))) action = 'Texto de versão da 3.0 retirado (a versão fica em system.schemaVersion).';
      else action = 'Arquivado aqui; fatos do perfil ficam em client.notes.';
      rep('Info', 'profile_archived', name, `linha ${r.row}`, `Linha do perfil 3.0: ${r.label || '(sem rótulo)'}.`, action, shown);
    });
    const rows = [Tabs.headers('config')];
    Config.sections().forEach((section) => {
      rows.push(['', section.section, '', '', '']);
      section.items.forEach((item) => {
        const v = item.key === 'system.schemaVersion' ? '' : Config.toCell_(Config.DEFAULTS[item.key], values[item.key]);
        rows.push([item.key, item.label, v, item.unit, item.description]);
      });
    });
    const end = Math.max(lastRow, spec.headerRow + rows.length - 1);
    for (let r = spec.headerRow; r <= end; r++) {
      const line = rows[r - spec.headerRow] || [];
      for (let c = 1; c <= lastCol; c++) cells[Migrate.key_(r, c)] = c <= line.length ? line[c - 1] : '';
    }
    Migrate.write_(sheet, cells);
    Config.invalidate();
    Tabs.invalidate();
    const fromJson = Object.keys(values).filter((k) => config[k].source === 'json').length;
    const from30 = Object.keys(values).filter((k) => config[k].source === '3.0').length;
    rep('Info', 'config_rebuilt', name, `linha ${spec.headerRow}+`, `Config 4.0 escrita: ${fromJson} valores da configuração do cliente, ${from30} do perfil 3.0, demais padrão.`, 'Perfil 3.0 arquivado nas linhas acima desta auditoria.', null);
    Object.keys(values).forEach((k) => {
      const c = config[k];
      if (c.source === 'json' && c.legacy !== null && !Tabs.sameCell(c.legacy, c.value) && !(legacy.config[k] && legacy.config[k].converted && c.legacy === c.value)) {
        rep('Aviso', 'config_override', name, k, `${Config.DEFAULTS[k].label}: a configuração do cliente (${Migrate.show_(Config.toCell_(Config.DEFAULTS[k], c.value))}) substitui o valor da 3.0 (${Migrate.show_(c.legacy)}).`, 'Valor do cliente gravado.', c.legacy, 'Revisar');
      }
    });
  },

  /** Short display of a value for the report. */
  show_(v) {
    if (v === null || v === undefined || v === '') return '—';
    if (v instanceof Date) return Dates.isTechnical(v) ? Utilities.formatDate(v, Dates.tz(), 'dd/MM/yyyy') : Dates.format(v);
    if (typeof v === 'number') return String(v).replace('.', ',');
    if (Array.isArray(v)) return v.join(', ');
    return String(v);
  },

  /* Versions ------------------------------------------------------------------------------------ */

  /**
   * Real dates and statuses for objectives, goals and plans. Starts come from the client JSON
   * history, else the valid date already there, else (plans) the 3.0 "Vigência", else the first
   * version starts on client.startDate (flagged for review). Ends close each version the day before
   * the next one. Goals get carbs, tolerances and BMR/expenditure; the objective is created from the
   * JSON with the targets of the goal in force on its start.
   */
  fixVersions_(cc, legacy, rep) {
    Migrate.fixEntity_(Plans, cc.history.plans, rep);
    const goals = cc.history.goals.length ? cc.history.goals
      : (legacy && Object.keys(legacy.goal).length && Goals.list().length ? [{ id: Goals.list()[0].id, start: null, end: undefined, fields: Object.assign({}, legacy.goal) }] : []);
    Migrate.fixEntity_(Goals, goals, rep);
    const objectives = cc.history.objectives.length ? cc.history.objectives : [];
    Migrate.fixEntity_(Objectives, objectives, rep);
    Migrate.linkVersions_(rep);
  },

  fixEntity_(repo, items, rep) {
    const tab = Tabs.get(repo.tab);
    const byId = {};
    items.forEach((it) => { byId[it.id] = it; });
    const versions = repo.list();
    const entries = versions.map((v) => ({ id: v.id, v, item: byId[v.id] || null }));
    items.filter((it) => !versions.some((v) => v.id === it.id)).forEach((it) => entries.push({ id: it.id, v: null, item: it }));
    const firstStart = Config.get('client.startDate');
    entries.forEach((e) => {
      e.start = (e.item && e.item.start) || (e.v && e.v.start) || (repo === Plans && e.v ? e.v.rows.map((r) => r.legacyStart).find(Boolean) || null : null);
    });
    const undated = entries.filter((e) => !e.start);
    if (undated.length && firstStart && entries.filter((e) => e.start).every((e) => Dates.compare(firstStart, e.start) < 0)) {
      const e = undated.sort((a, b) => repo.num_(a.id) - repo.num_(b.id))[0];
      e.start = firstStart;
      e.guessed = true;
    }
    entries.filter((e) => !e.start).forEach((e) => rep('Erro', 'version_no_start', tab.name, e.id, `${repo.label} ${e.id} sem data de início conhecida.`, 'Informar a data em history da configuração do cliente e rodar de novo.', null, 'Aberto'));
    const dated = entries.filter((e) => e.start).sort((a, b) => Dates.compare(a.start, b.start) || repo.num_(a.id) - repo.num_(b.id));
    dated.forEach((e, i) => {
      const next = dated[i + 1];
      if (e.item && e.item.end !== undefined) e.end = e.item.end;
      else if (e.v && e.v.end && (!next || Dates.compare(e.v.end, next.start) < 0)) e.end = e.v.end;
      else e.end = next ? Dates.addDays(next.start, -1) : null;
      e.status = repo.statusFor(e.start, e.end);
      const fields = Object.assign({}, e.item ? e.item.fields : {});
      if (e.v) Migrate.updateVersion_(repo, e, fields, rep);
      else Migrate.appendVersion_(repo, e, fields, rep);
      if (e.guessed) rep('Aviso', 'version_start_guessed', tab.name, e.id, `${repo.label} ${e.id} começa em ${Dates.format(e.start)} (início do acompanhamento), pois não havia data real.`, 'Confirmar a data.', null, 'Revisar');
    });
  },

  /** Goal rows: carbs from kcal/P/G, tolerances from Config, BMR/expenditure from Config. */
  goalExtras_(fields, current, start) {
    const val = (k) => (fields[k] !== undefined ? fields[k] : current ? current[k] : null);
    const carbs = Energy.carbs(val('kcal'), val('protein'), val('fat'));
    if (carbs !== null) fields.carbs = carbs;
    if (val('kcalTolerance') === null || val('kcalTolerance') === undefined) fields.kcalTolerance = Config.get('analysis.kcalTolerance');
    if (val('fatTolerance') === null || val('fatTolerance') === undefined) fields.fatTolerance = Config.get('analysis.fatTolerance');
    if (val('reviewer') === null || val('reviewer') === undefined) fields.reviewer = Config.get('client.reviewer');
    const e = Energy.fromConfig({ date: start });
    if (e.bmr !== null) {
      fields.bmr = e.bmr;
      fields.bmrMethod = e.methodLabel;
      fields.activityFactor = e.activityFactor;
      fields.tdee = e.tdee;
    }
  },

  updateVersion_(repo, e, fields, rep) {
    const tab = Tabs.get(repo.tab);
    if (repo === Goals) Migrate.goalExtras_(fields, e.v.fields, e.start);
    const patch = Object.assign({}, fields, { start: e.start, end: e.end, status: e.status });
    const diffs = [];
    e.v.rows.forEach((r, i) => {
      const rowPatch = Object.assign({}, patch);
      if (repo === Plans && !Dates.parse(r.legacyStart)) rowPatch.legacyStart = e.start;
      const raw = Migrate.rawRow_(repo.tab, r._row);
      Object.keys(rowPatch).forEach((k) => {
        const col = Tabs.column(repo.tab, k);
        const cell = Tabs.toCell(col, rowPatch[k]);
        const old = raw[k];
        if (Tabs.sameCell(old === undefined ? '' : old, cell) || (col.type === 'date' && Dates.key(old) && Dates.key(old) === Dates.key(cell) && !Dates.isTechnical(old))) { delete rowPatch[k]; return; }
        if (i === 0 || (repo === Plans && k === 'legacyStart' && !diffs.some((d) => d.key === k))) diffs.push({ key: k, header: col.header, before: old, after: cell });
      });
      if (Object.keys(rowPatch).length) Tabs.update(repo.tab, r._row, rowPatch);
    });
    if (diffs.length) {
      const rows = e.v.rows.length > 1 ? ` (${e.v.rows.length} linhas)` : '';
      const technical = diffs.some((d) => Dates.isTechnical(d.before));
      rep('Info', technical ? 'version_technical_date' : 'version_updated', tab.name, `${e.id}${rows}`,
        `${repo.label} ${e.id}: ${technical ? 'data técnica 01/01/1900 substituída pela data real; ' : ''}vigência ${Dates.format(e.start)}–${e.end ? Dates.format(e.end) : 'em aberto'}, ${e.status}.`,
        diffs.map((d) => `${d.header}: ${Migrate.show_(d.before)} → ${Migrate.show_(d.after)}`).join('; '),
        diffs.map((d) => `${d.header}=${Migrate.show_(d.before)}`).join('; '));
    }
  },

  /** Raw cell values of a row keyed by column key ('' when the column is missing). */
  rawRow_(id, row) {
    const { sheet, map, lastCol } = Tabs.layout(id);
    const line = lastCol ? sheet.getRange(row, 1, 1, lastCol).getValues()[0] : [];
    const out = {};
    Tabs.columns(id).forEach((c) => { out[c.key] = map[c.key] ? line[map[c.key] - 1] : ''; });
    return out;
  },

  appendVersion_(repo, e, fields, rep) {
    const tab = Tabs.get(repo.tab);
    if (repo === Plans) {
      rep('Aviso', 'plan_missing_rows', tab.name, e.id, `Ficha ${e.id} está no histórico do cliente mas não tem linhas de exercício na aba.`, 'Nada criado; salve a ficha pela Ficha de treino.', null, 'Aberto');
      return;
    }
    const row = Object.assign({}, fields, { id: e.id, start: e.start, end: e.end, status: e.status });
    if (repo === Goals) Migrate.goalExtras_(row, null, e.start);
    if (repo === Objectives) {
      const goal = Goals.on(e.start);
      const g = goal ? goal.fields : {};
      ['kcal', 'protein', 'fat', 'carbs', 'strengthPerWeek', 'cardioPerWeek', 'activitiesPerWeek'].forEach((k) => {
        if ((row[k] === undefined || row[k] === null) && g[k] !== undefined && g[k] !== null) row[k] = g[k];
      });
      if (row.carbs === undefined || row.carbs === null) row.carbs = Energy.carbs(row.kcal, row.protein, row.fat);
      if (row.startWeightKg === undefined || row.startWeightKg === null) row.startWeightKg = Config.get('client.startWeightKg');
      if (row.reviewer === undefined || row.reviewer === null) row.reviewer = Config.get('client.reviewer');
    }
    Tabs.append(repo.tab, row);
    const shown = Object.keys(row).filter((k) => row[k] !== null && row[k] !== undefined && row[k] !== '')
      .map((k) => `${Tabs.column(repo.tab, k).header}: ${Migrate.show_(Tabs.toCell(Tabs.column(repo.tab, k), row[k]))}`).join('; ');
    rep('Info', 'version_created', tab.name, e.id, `${repo.label} ${e.id} criado a partir da configuração do cliente (${e.status} desde ${Dates.format(e.start)}).`, shown, null);
  },

  /** Objective ↔ goal ↔ plan links left empty: filled with the version in force on the start. */
  linkVersions_(rep) {
    const fill = (repo, links) => {
      repo.list().forEach((v) => {
        if (!v.start) return;
        const patch = {};
        Object.keys(links).forEach((k) => {
          if (v.fields[k] !== null && v.fields[k] !== undefined && v.fields[k] !== '') return;
          const other = links[k].on(v.start);
          if (other) patch[k] = other.id;
        });
        if (!Object.keys(patch).length) return;
        v.rows.forEach((r) => Tabs.update(repo.tab, r._row, patch));
        rep('Info', 'version_linked', Tabs.get(repo.tab).name, v.id, `${repo.label} ${v.id} ligado a ${Object.keys(patch).map((k) => patch[k]).join(', ')} (em vigor no início).`, 'Ids gravados.', null);
      });
    };
    fill(Goals, { objective: Objectives });
    fill(Objectives, { goal: Goals, plan: Plans });
  },

  /* Texts, ids, dates, named ranges ------------------------------------------------------------- */

  /** Sentences naming another client are quoted in Auditoria and removed from the cell. */
  fixResidues_(names, rep) {
    if (!names || !names.length) return;
    const bySheet = {};
    Audit.residueCells_(names).forEach((r) => { (bySheet[r.tab] = bySheet[r.tab] || []).push(r); });
    Object.keys(bySheet).forEach((tab) => {
      const sheet = SpreadsheetApp.getActive().getSheetByName(tab);
      const cells = {};
      bySheet[tab].forEach((r) => {
        const kept = Audit.withoutNames(r.text, names);
        const removed = Audit.sentences(r.text).filter((s) => Audit.namesIn_(s, names).length).join(' ');
        cells[Migrate.key_(r.row, r.col)] = kept;
        rep('Info', 'cross_client', tab, Audit.a1_(r.row, r.col), `Frase de outro cliente (${r.names.join(', ')}) retirada: "${removed}"`, kept ? `Texto mantido: "${kept}"` : 'Célula ficou vazia.', r.text);
      });
      Migrate.write_(sheet, cells);
    });
  },

  /** Stale 3.0 status lines on layout tabs → the 4.0 status text. Others are reported open. */
  fixStaleTexts_(rep) {
    const bySheet = {};
    Audit.staleCells_(undefined).forEach((s) => {
      if (s.kind !== 'layout') {
        rep('Aviso', s.code, s.tab, Audit.a1_(s.row, s.col), s.finding, 'Revisar o texto.', s.text, 'Aberto');
        return;
      }
      (bySheet[s.tab] = bySheet[s.tab] || []).push(s);
    });
    Object.keys(bySheet).forEach((tab) => {
      const cells = {};
      bySheet[tab].forEach((s) => {
        cells[Migrate.key_(s.row, s.col)] = Migrate.STATUS_TEXT;
        rep('Info', 'stale_text', tab, Audit.a1_(s.row, s.col), 'Texto de status da 3.0 substituído.', Migrate.STATUS_TEXT, s.text);
      });
      Migrate.write_(SpreadsheetApp.getActive().getSheetByName(tab), cells);
    });
  },

  /** Existing day/session/measure/review rows get the ids in force on their date. */
  stampIds_(rep) {
    Tabs.invalidate();
    if (Tabs.findSheet('diary')) {
      const n = Days.restampAll();
      if (n) rep('Info', 'ids_stamped', Tabs.get('diary').name, '', `${n} ${n === 1 ? 'dia recebeu' : 'dias receberam'} objetivo, meta e ficha da data.`, 'Days.restampAll.', null);
    }
    [['workouts', ['objective', 'plan']], ['measures', ['objective']], ['reviews', ['objective', 'goal', 'plan']]].forEach(([id, keys]) => {
      if (!Tabs.findSheet(id)) return;
      let n = 0;
      Tabs.read(id).forEach((row) => {
        if (!row.date) return;
        const ids = Days.idsOn(row.date);
        const patch = {};
        keys.forEach((k) => { if ((row[k] === null || row[k] === '') && ids[k]) patch[k] = ids[k]; });
        if (Object.keys(patch).length) { Tabs.update(id, row._row, patch); n++; }
      });
      if (n) rep('Info', 'ids_stamped', Tabs.get(id).name, '', `${n} ${n === 1 ? 'linha recebeu' : 'linhas receberam'} os ids em vigor na data (${keys.join(', ')}).`, 'Só células vazias foram preenchidas.', null);
    });
  },

  /** Any date before 2000 still left (outside the version tabs) is cleared, quoted in Auditoria. */
  fixTechnicalDates_(rep) {
    const bySheet = {};
    Audit.technicalDates_().forEach((t) => { (bySheet[t.tab] = bySheet[t.tab] || []).push(t); });
    Object.keys(bySheet).forEach((tab) => {
      const cells = {};
      bySheet[tab].forEach((t) => {
        cells[Migrate.key_(t.row, t.col)] = '';
        rep('Aviso', 'technical_date_cleared', tab, Audit.a1_(t.row, t.col), 'Data técnica anterior a 2000 apagada (era lida como ausente).', 'Informar a data real se ela existir.', t.value, 'Revisar');
      });
      Migrate.write_(SpreadsheetApp.getActive().getSheetByName(tab), cells);
    });
  },

  /** Validations pointing at a missing 3.0 named range get the range back (the 4.0 column). */
  fixNamedRanges_(rep) {
    const ss = SpreadsheetApp.getActive();
    const done = {};
    Audit.brokenValidations_().forEach((b) => {
      const target = Migrate.LEGACY_LISTS[b.ref];
      if (!target) {
        rep('Erro', 'validation_named_range', b.tab, Audit.box_(b.cells), `Validação usa o intervalo "${b.ref}", que não existe.`, 'Refazer a validação (Reaplicar layout).', b.ref, 'Aberto');
        return;
      }
      if (!done[b.ref]) {
        const spec = Tabs.get(target.tab);
        const sheet = Tabs.sheet(target.tab);
        const col = Tabs.headerMap(target.tab)[target.key];
        const rows = sheet.getMaxRows() - spec.firstDataRow + 1;
        ChangeLog.structure(sheet.getName(), { op: 'namedRange', name: b.ref });
        ss.setNamedRange(b.ref, sheet.getRange(spec.firstDataRow, col, rows, 1));
        done[b.ref] = `${sheet.getName()}!${Audit.col_(col)}${spec.firstDataRow}:${Audit.col_(col)}${sheet.getMaxRows()}`;
      }
      rep('Info', 'validation_named_range', b.tab, Audit.box_(b.cells), `Intervalo nomeado "${b.ref}" recriado para a lista da validação.`, `${b.ref} = ${done[b.ref]}.`, b.ref);
    });
  },

  /** A script-rendered layout tab (Painel) loses its formulas; typed text stays. */
  clearLayoutFormulas_(id, rep) {
    const sheet = Tabs.findSheet(id);
    if (!sheet || !sheet.getLastRow() || !sheet.getLastColumn()) return;
    const formulas = sheet.getRange(1, 1, sheet.getLastRow(), sheet.getLastColumn()).getFormulas();
    const cells = {};
    let first = null;
    formulas.forEach((line, i) => line.forEach((f, j) => { if (f) { cells[Migrate.key_(i + 1, j + 1)] = ''; if (!first) first = f; } }));
    const n = Migrate.write_(sheet, cells);
    if (n) rep('Info', 'layout_formulas_removed', sheet.getName(), '', `${n} fórmulas da 3.0 removidas (liam Semanas por posição e com intervalos fixos). Texto digitado mantido.`, 'O Painel passa a ser desenhado pelo script (Atualizar painel / Reaplicar layout).', first);
  },
};

// Undoing the staged migration must not run the derived refreshes between its parts (see status()).
Undo.QUIET_PREFIXES.push(Migrate.LABEL);
// While a staged migration has steps left, other writes are refused (see guard_).
ChangeLog.GUARDS.push((label, opts) => Migrate.guard_(label, opts));
