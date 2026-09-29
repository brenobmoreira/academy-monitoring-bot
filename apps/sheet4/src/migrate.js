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
 * and applying the layout (Weeks.recomputeAll, Setup.apply) run afterwards as separate actions,
 * only when those modules exist.
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
   * @param {{postSteps?: boolean}=} opts postSteps=false skips Weeks.recomputeAll / Setup.apply
   */
  run(client, opts) {
    const o = opts || {};
    if (Migrate.isMigrated()) {
      return { ok: true, alreadyMigrated: true, changes: 0, report: [], postSteps: [], message: 'A planilha já está na versão 4.0; nada foi alterado.' };
    }
    const parsed = Migrate.parseClient(client);
    if (parsed.errors.length) throw new Error(`Configuração do cliente inválida: ${parsed.errors.join(' ')}`);
    const cc = parsed.client;
    const findingsBefore = Audit.findings({ otherNames: cc.otherClientNames });

    const result = Core.withLock(() => ChangeLog.run(Migrate.LABEL, () => Migrate.steps_(cc)));
    result.findingsBefore = findingsBefore;
    result.postSteps = o.postSteps === false ? [] : Migrate.postSteps_();
    result.ok = true;
    result.alreadyMigrated = false;
    const open = result.findingsAfter.filter((f) => f.severity === 'Erro').length;
    result.message = `Migração concluída: ${result.changes} ${result.changes === 1 ? 'alteração' : 'alterações'} registradas na Auditoria`
      + `${open ? `; ${open} ${open === 1 ? 'erro continua aberto' : 'erros continuam abertos'}` : ''}. Desfazer última alteração reverte a migração.`;
    return result;
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

  steps_(cc) {
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
      if (spec.kind === 'table' && ['config', 'audit', 'log'].indexOf(id) < 0 && created.indexOf(id) < 0) Migrate.migrateTable_(id, rep);
    });
    Migrate.fixVersions_(cc, legacy, rep);
    Migrate.fixResidues_(cc.otherClientNames.length ? cc.otherClientNames : config['system.otherClientNames'].value || [], rep);
    Migrate.fixStaleTexts_(rep);
    Migrate.stampIds_(rep);
    Migrate.fixTechnicalDates_(rep);
    Migrate.fixNamedRanges_(rep);
    Migrate.clearLayoutFormulas_('dashboard', rep);

    Config.set('system.schemaVersion', Config.SCHEMA_VERSION);
    rep('Info', 'schema_version', Tabs.get('config').name, 'system.schemaVersion', `Versão do esquema gravada: ${Config.SCHEMA_VERSION}.`, 'Rodar a migração de novo não altera nada.', null);

    Tabs.invalidate();
    Config.invalidate();
    const findingsAfter = Audit.findings({ otherNames: cc.otherClientNames });
    const at = new Date();
    const rows = report.map((f) => Audit.row(f, at, f.state))
      .concat(cc.review.map((r) => Audit.row({ severity: 'Aviso', code: 'review', tab: '', cell: r.area, finding: r.message, action: 'Confirmar com o revisor e ajustar em Config/Metas se preciso.' }, at, 'Revisar')))
      .concat(findingsAfter.map((f) => Audit.row(f, at, 'Aberto')));
    Tabs.appendMany('audit', rows);
    return { changes: report.length, report, findingsAfter, review: cc.review };
  },

  /** Weeks.recomputeAll and Setup.apply, each as its own action, only when defined. */
  postSteps_() {
    const steps = [
      { step: 'Recalcular semanas', label: 'Migração: recalcular semanas', fn: () => (typeof Weeks !== 'undefined' && Weeks && typeof Weeks.recomputeAll === 'function' ? () => Weeks.recomputeAll() : null) },
      { step: 'Aplicar layout', label: 'Migração: aplicar layout', fn: () => (typeof Setup !== 'undefined' && Setup && typeof Setup.apply === 'function' ? () => Setup.apply() : null) },
    ];
    return steps.map((s) => {
      const fn = s.fn();
      if (!fn) return { step: s.step, status: 'ausente', message: 'Módulo ainda não instalado; rode depois pelo menu.' };
      try {
        Core.withLock(() => ChangeLog.run(s.label, fn));
        return { step: s.step, status: 'ok', message: '' };
      } catch (err) {
        return { step: s.step, status: 'erro', message: err.message };
      }
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
    changed.forEach((x) => {
      const cell = sheet.getRange(x.r, x.c);
      if (typeof x.v === 'string' && x.v.charAt(0) === '=') cell.setFormula(x.v);
      else cell.setValue(x.v);
    });
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
