/**
 * Structural audit (spec §1, §4.4, §9): finds what makes a spreadsheet unsafe to read by date and
 * by header, and reports it in the Auditoria tab. It never changes data; the only write is
 * appending its findings to Auditoria (Audit.run). Audit.findings() writes nothing at all.
 *
 * Checks: tabs missing / still under their 3.0 name, header columns missing vs Tabs.SPEC (and 3.0
 * header texts still in use), technical dates (< 2000), formula errors, fixed-range formulas in
 * data tabs, data validations pointing at a named range that does not exist, dates typed as text
 * or with a time part in date columns, text naming another client (names from Config
 * `system.otherClientNames` or the caller), stale 3.0 status texts, version-history problems
 * (Versions.validate of objectives, goals and plans, none in force today) and required Config
 * values left empty.
 *
 * A finding is {severity: 'Erro'|'Aviso'|'Info', code, tab, cell, finding, action, before}.
 * The cell scan helpers (residueCells_, staleCells_, technicalDates_) are shared with Migrate so the
 * migration fixes exactly what the audit reports.
 */
const Audit = {
  /** Tabs never scanned: the audit's own report and the change log quote old values on purpose. */
  SKIP_TABS: ['audit', 'log'],

  /** Error values a formula can show. */
  ERROR_VALUE: /^#(REF!|N\/A|VALUE!|DIV\/0!|NAME\?|ERROR!|NUM!|NULL!)/,

  /** Texts of the 3.0 product that describe a state which 4.0 derives (status lines, version tags). */
  STALE_TEXT: /(^|[^0-9.])3\.0([^0-9]|$)/,

  /** 3.0 profile label whose typed value contradicts the plan in force (spec §1 finding 4). */
  PLAN_STATUS_LABEL: 'Status da ficha',

  /** A range spanning at least this many rows with a literal end row counts as "fixed" (A6:A1000). */
  FIXED_RANGE_MIN_ROWS: 100,

  /** Config keys that must hold a value (age or birth date: one of them). */
  REQUIRED_CONFIG: ['client.name', 'client.sex', 'client.heightCm', 'client.startWeightKg', 'client.startDate',
    'client.reviewer', 'routine.strengthPerWeek', 'routine.sessionRotation', 'energy.activityFactor'],

  /**
   * Runs every check and appends the findings to Auditoria (state "Aberto").
   * @param {{otherNames?: string[], write?: boolean}} opts write=false only computes
   * @returns {{findings: Object[], written: number, message: string}}
   */
  run(opts) {
    const o = opts || {};
    const findings = Audit.findings(o);
    let written = 0;
    if (o.write !== false && findings.length) {
      Migrate.ensureTab('audit'); // logged, so Undo also removes a tab it created
      Tabs.invalidate();
      const at = new Date();
      Tabs.appendMany('audit', findings.map((f) => Audit.row(f, at, 'Aberto')));
      written = findings.length;
    }
    const errors = findings.filter((f) => f.severity === 'Erro').length;
    const message = findings.length
      ? `Auditoria: ${findings.length} ${findings.length === 1 ? 'problema' : 'problemas'} (${errors} ${errors === 1 ? 'erro' : 'erros'}). Veja a aba Auditoria.`
      : 'Auditoria: nenhum problema encontrado.';
    return { findings, written, message };
  },

  /** Auditoria row object for a finding. */
  row(f, at, state) {
    return {
      at: at || new Date(), severity: f.severity, tab: f.tab || '', cell: f.cell || '', finding: f.finding,
      action: f.action || '', state: state || f.state || 'Aberto', code: f.code || '', before: Audit.quote(f.before),
    };
  },

  /** Text for the "Valor anterior" column (dates as dd/mm/yyyy, formulas as text). */
  quote(v) {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date) return Dates.isTechnical(v) ? Utilities.formatDate(v, Dates.tz(), 'dd/MM/yyyy') : Dates.format(v);
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    // A leading "=" would be written as a formula.
    return s.charAt(0) === '=' ? `'${s}` : s;
  },

  /**
   * Every finding, without writing.
   * @param {{otherNames?: string[]}} opts
   */
  findings(opts) {
    const o = opts || {};
    Tabs.invalidate();
    Config.invalidate();
    const out = [];
    const ctx = Audit.context_(o);
    Audit.checkTabs_(out);
    Audit.checkCells_(out, ctx);
    Audit.checkValidations_(out);
    Audit.checkVersions_(out);
    Audit.checkConfig_(out);
    return out;
  },

  /* Context ----------------------------------------------------------------------------------- */

  /** {otherNames, ownName, currentPlan} for the cell checks. */
  context_(o) {
    const configOk = !!Tabs.findSheet('config') && Audit.isConfigLayout_(Tabs.findSheet('config'));
    let names = o.otherNames;
    let own = o.ownName || null;
    if (configOk) {
      try { if (!names) names = Config.getList('system.otherClientNames'); } catch (err) { names = names || []; }
      try { if (!own) own = Config.getString('client.name'); } catch (err) { /* reported by checkConfig_ */ }
    }
    const ownFold = own ? Audit.fold_(own) : null;
    const otherNames = (names || []).map((n) => String(n).trim()).filter((n) => n && Audit.fold_(n) !== ownFold);
    let currentPlan;
    try { currentPlan = Tabs.findSheet('plans') ? Plans.current() : undefined; } catch (err) { currentPlan = undefined; }
    return { otherNames, currentPlan };
  },

  /** True when the sheet has the 4.0 Config header (Chave …) rather than the 3.0 profile. */
  isConfigLayout_(sheet) {
    const spec = Tabs.get('config');
    const lastCol = sheet.getLastColumn();
    if (!lastCol) return false;
    const texts = sheet.getRange(spec.headerRow, 1, 1, lastCol).getValues()[0].map(Tabs.normalize_);
    return texts.indexOf(Tabs.normalize_(Tabs.column('config', 'key').header)) >= 0
      && texts.indexOf(Tabs.normalize_(Tabs.column('config', 'value').header)) >= 0;
  },

  /* Tabs and headers ------------------------------------------------------------------------ */

  /** Sheet of a spec (4.0 name, else a legacy name) and which name matched. */
  locate_(id) {
    const spec = Tabs.get(id);
    const ss = SpreadsheetApp.getActive();
    const sheet = ss.getSheetByName(spec.name);
    if (sheet) return { sheet, legacy: null };
    for (let i = 0; i < (spec.legacyNames || []).length; i++) {
      const s = ss.getSheetByName(spec.legacyNames[i]);
      if (s) return { sheet: s, legacy: spec.legacyNames[i] };
    }
    return { sheet: null, legacy: null };
  },

  /**
   * Header matching on any sheet (also under a legacy name): {map: {key: col}, aliasUsed:
   * [{key, col, text}], texts, lastCol}.
   */
  headerMatch(sheet, id) {
    const spec = Tabs.get(id);
    const lastCol = sheet.getLastColumn();
    const texts = lastCol ? sheet.getRange(spec.headerRow, 1, 1, lastCol).getValues()[0] : [];
    const index = {};
    texts.forEach((h, i) => { const n = Tabs.normalize_(h); if (n && !(n in index)) index[n] = i + 1; });
    const map = {};
    const aliasUsed = [];
    spec.columns.forEach((c) => {
      const direct = index[Tabs.normalize_(c.header)];
      if (direct) { map[c.key] = direct; return; }
      const alias = (c.aliases || []).find((a) => index[Tabs.normalize_(a)]);
      if (alias) {
        map[c.key] = index[Tabs.normalize_(alias)];
        aliasUsed.push({ key: c.key, col: map[c.key], text: alias });
      }
    });
    return { map, aliasUsed, texts, lastCol };
  },

  checkTabs_(out) {
    Tabs.ids().forEach((id) => {
      if (Audit.SKIP_TABS.indexOf(id) >= 0) return;
      const spec = Tabs.get(id);
      const { sheet, legacy } = Audit.locate_(id);
      if (!sheet) {
        out.push({ severity: 'Erro', code: 'tab_missing', tab: spec.name, cell: '', finding: `A aba "${spec.name}" não existe.`, action: 'Projeto → Sistema → Migrar 3.0 → 4.0 (ou Configuração inicial) cria a aba.' });
        return;
      }
      if (legacy) {
        out.push({ severity: 'Aviso', code: 'tab_legacy_name', tab: legacy, cell: '', finding: `Aba com o nome da versão 3.0 ("${legacy}"); na 4.0 ela se chama "${spec.name}".`, action: 'A migração renomeia a aba no lugar (links e gráficos continuam valendo).' });
      }
      if (spec.kind !== 'table') return;
      if (id === 'config' && !Audit.isConfigLayout_(sheet)) {
        out.push({ severity: 'Aviso', code: 'config_legacy_layout', tab: sheet.getName(), cell: `linha ${spec.headerRow}`, finding: 'Perfil no formato 3.0 (Parâmetro | Valor editável …), sem as chaves da Config 4.0.', action: 'A migração reescreve a aba como Config (Chave | Parâmetro | Valor | Unidade | Descrição) e arquiva o perfil 3.0 na Auditoria.' });
        return;
      }
      const m = Audit.headerMatch(sheet, id);
      const missing = spec.columns.filter((c) => !m.map[c.key]).map((c) => c.header);
      if (missing.length) {
        out.push({ severity: 'Aviso', code: 'columns_missing', tab: sheet.getName(), cell: `linha ${spec.headerRow}`, finding: `Colunas da 4.0 ausentes: ${missing.join(', ')}.`, action: 'A migração acrescenta as colunas à direita do cabeçalho (sem mover dados).' });
      }
      m.aliasUsed.forEach((a) => {
        out.push({ severity: 'Info', code: 'header_legacy', tab: sheet.getName(), cell: Audit.a1_(spec.headerRow, a.col), finding: `Cabeçalho da 3.0 "${a.text}" (4.0: "${Tabs.column(id, a.key).header}").`, action: 'A migração renomeia o cabeçalho; a coluna e os dados ficam no lugar.', before: a.text });
      });
    });
  },

  /* Cells ----------------------------------------------------------------------------------- */

  /** Sheets to scan with their spec (or null for tabs outside the registry). */
  sheets_() {
    return SpreadsheetApp.getActive().getSheets().map((sheet) => ({ sheet, spec: Tabs.byName(sheet.getName()) }))
      .filter((x) => !x.spec || Audit.SKIP_TABS.indexOf(x.spec.id) < 0);
  },

  /** {values, formulas, lastRow, lastCol} of a sheet's used range. */
  grid_(sheet) {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (!lastRow || !lastCol) return { values: [], formulas: [], lastRow: 0, lastCol: 0 };
    const range = sheet.getRange(1, 1, lastRow, lastCol);
    return { values: range.getValues(), formulas: range.getFormulas(), lastRow, lastCol };
  },

  checkCells_(out, ctx) {
    Audit.sheets_().forEach(({ sheet, spec }) => {
      const g = Audit.grid_(sheet);
      const name = sheet.getName();
      const fixed = [];
      g.values.forEach((line, i) => line.forEach((v, j) => {
        const row = i + 1;
        const col = j + 1;
        const f = g.formulas[i][j];
        if (typeof v === 'string' && Audit.ERROR_VALUE.test(v)) {
          out.push({ severity: 'Erro', code: 'formula_error', tab: name, cell: Audit.a1_(row, col), finding: `Erro de fórmula ${v}.`, action: 'Corrigir a fórmula ou trocar por valor calculado pelo script.', before: f || v });
        } else if (f && /#REF!/.test(f)) {
          out.push({ severity: 'Erro', code: 'formula_error', tab: name, cell: Audit.a1_(row, col), finding: 'Fórmula com referência quebrada (#REF!).', action: 'Corrigir a fórmula.', before: f });
        }
        if (f && spec && spec.kind === 'table' && row >= spec.firstDataRow && Audit.fixedRange_(f)) fixed.push({ row, col, f });
      }));
      if (fixed.length) {
        out.push({ severity: 'Aviso', code: 'fixed_range', tab: name, cell: Audit.box_(fixed), finding: `${fixed.length} ${fixed.length === 1 ? 'fórmula' : 'fórmulas'} com intervalo fixo (ex.: ${Audit.fixedRange_(fixed[0].f)}); dados além do limite seriam ignorados.`, action: 'Na 4.0 o script calcula e grava valores; a migração remove essas fórmulas.', before: fixed[0].f });
      }
      Audit.checkDateColumns_(out, sheet, spec, g);
    });
    Audit.technicalDates_().forEach((t) => {
      out.push({ severity: 'Erro', code: 'technical_date', tab: t.tab, cell: Audit.a1_(t.row, t.col), finding: 'Data técnica anterior a 2000 (tratada como ausente).', action: 'Informar a data real (a migração usa as datas do histórico do cliente).', before: t.value });
    });
    Audit.residueCells_(ctx.otherNames).forEach((r) => {
      out.push({ severity: 'Aviso', code: 'cross_client', tab: r.tab, cell: Audit.a1_(r.row, r.col), finding: `Texto menciona outro cliente (${r.names.join(', ')}).`, action: 'A migração move as frases para a Auditoria e as retira do texto.', before: r.text });
    });
    Audit.staleCells_(ctx.currentPlan).forEach((s) => {
      out.push({ severity: s.severity, code: s.code, tab: s.tab, cell: Audit.a1_(s.row, s.col), finding: s.finding, action: s.action, before: s.text });
    });
  },

  /** The first fixed range of a formula ("$A$6:$A1000"), or null. */
  fixedRange_(formula) {
    const re = /\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)/g;
    let m;
    while ((m = re.exec(formula))) {
      if (Number(m[4]) - Number(m[2]) >= Audit.FIXED_RANGE_MIN_ROWS) return m[0];
    }
    return null;
  },

  /** Date columns (by header) holding text dates or a time of day. */
  checkDateColumns_(out, sheet, spec, g) {
    if (!spec || spec.kind !== 'table' || !g.lastRow) return;
    const m = Audit.headerMatch(sheet, spec.id);
    spec.columns.filter((c) => c.type === 'date' && m.map[c.key]).forEach((c) => {
      const col = m.map[c.key];
      for (let row = spec.firstDataRow; row <= g.lastRow; row++) {
        const v = g.values[row - 1][col - 1];
        if (g.formulas[row - 1][col - 1]) continue;
        if (typeof v === 'string' && v.trim() && Dates.parse(v)) {
          out.push({ severity: 'Aviso', code: 'text_date', tab: sheet.getName(), cell: Audit.a1_(row, col), finding: `Data digitada como texto em "${c.header}".`, action: 'A migração grava a data como data (meia-noite local).', before: v });
        } else if (v instanceof Date && !Dates.isTechnical(v) && Utilities.formatDate(v, Dates.tz(), 'HH:mm:ss') !== '00:00:00') {
          out.push({ severity: 'Info', code: 'date_with_time', tab: sheet.getName(), cell: Audit.a1_(row, col), finding: `Data com horário em "${c.header}" (datas são dias puros).`, action: 'A migração grava só o dia.', before: Utilities.formatDate(v, Dates.tz(), 'dd/MM/yyyy HH:mm') });
        }
      }
    });
  },

  /**
   * Cells holding a date before 2000 (time-of-day values, stored by Sheets on 30/12/1899, are not
   * dates and are skipped): [{tab, row, col, value, spec}].
   */
  technicalDates_() {
    const out = [];
    Audit.sheets_().forEach(({ sheet, spec }) => {
      const g = Audit.grid_(sheet);
      g.values.forEach((line, i) => line.forEach((v, j) => {
        if (g.formulas[i][j] || !Dates.isTechnical(v)) return;
        if (Utilities.formatDate(v, Dates.tz(), 'yyyy-MM-dd') === '1899-12-30') return;
        out.push({ tab: sheet.getName(), row: i + 1, col: j + 1, value: v, spec });
      }));
    });
    return out;
  },

  /** Lower case without accents, for name matching. */
  fold_(s) {
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  },

  /** Names of `names` mentioned in `text` as whole words. */
  namesIn_(text, names) {
    const t = Audit.fold_(text);
    return names.filter((n) => {
      const f = Audit.fold_(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9])${f}(?=$|[^a-z0-9])`).test(t);
    });
  },

  /** Splits a text in sentences (keeps the punctuation with each). */
  sentences(text) {
    return String(text).split(/(?<=[.!?])\s+/).filter((s) => s !== '');
  },

  /** The text without the sentences that mention one of `names`. */
  withoutNames(text, names) {
    return Audit.sentences(text).filter((s) => !Audit.namesIn_(s, names).length).join(' ');
  },

  /**
   * Text cells mentioning another client: [{tab, row, col, text, names}]. Skips formulas and the
   * Config row that lists the other names.
   */
  residueCells_(names) {
    const out = [];
    if (!names || !names.length) return out;
    Audit.sheets_().forEach(({ sheet, spec }) => {
      const g = Audit.grid_(sheet);
      const skipRow = spec && spec.id === 'config' ? Audit.configKeyRow_(g, 'system.otherClientNames') : -1;
      g.values.forEach((line, i) => line.forEach((v, j) => {
        if (typeof v !== 'string' || g.formulas[i][j] || i + 1 === skipRow) return;
        const hit = Audit.namesIn_(v, names);
        if (hit.length) out.push({ tab: sheet.getName(), row: i + 1, col: j + 1, text: v, names: hit });
      }));
    });
    return out;
  },

  /** Sheet row of a Config key in a grid (−1 when absent). */
  configKeyRow_(g, key) {
    for (let i = Tabs.get('config').firstDataRow - 1; i < g.values.length; i++) {
      if (String(g.values[i][0]).trim() === key) return i + 1;
    }
    return -1;
  },

  /**
   * Stale 3.0 texts: [{tab, row, col, text, code, severity, finding, action, kind}]. Looks at
   * title/help rows of every tab, all of layout tabs (Hoje, Painel) and the profile/Config tab.
   * Also a typed "Status da ficha" that is not the plan in force.
   */
  staleCells_(currentPlan) {
    const out = [];
    Audit.sheets_().forEach(({ sheet, spec }) => {
      const g = Audit.grid_(sheet);
      const isProfile = spec && spec.id === 'config';
      g.values.forEach((line, i) => line.forEach((v, j) => {
        if (typeof v !== 'string' || g.formulas[i][j]) return;
        const row = i + 1;
        const inScope = !spec || spec.kind === 'layout' || isProfile || row < spec.headerRow;
        if (inScope && Audit.STALE_TEXT.test(v)) {
          const kind = !spec || spec.kind === 'layout' ? 'layout' : row < spec.headerRow ? 'title' : 'profile';
          out.push({ tab: sheet.getName(), row, col: j + 1, text: v, kind,
            code: 'stale_text', severity: 'Aviso', finding: 'Texto de status/versão da 3.0 que não vale mais.', action: 'A migração troca por texto da 4.0 (valores derivados das abas de histórico).' });
        }
        if (Tabs.normalize_(v) === Tabs.normalize_(Audit.PLAN_STATUS_LABEL)) {
          const k = line.slice(j + 1).findIndex((x) => x !== '' && x !== null);
          if (k < 0) return;
          const typed = String(line[j + 1 + k]);
          const plan = currentPlan === undefined ? null : currentPlan;
          const ok = plan && typed.indexOf(plan.id) >= 0 && !/F\d{3}/.test(typed.replace(plan.id, ''));
          if (ok) return;
          out.push({ tab: sheet.getName(), row, col: j + 2 + k, text: typed, kind: 'planStatus', code: 'stale_plan_status',
            severity: currentPlan === undefined ? 'Aviso' : 'Erro',
            finding: currentPlan === undefined ? `"${Audit.PLAN_STATUS_LABEL}" digitado; na 4.0 o status vem da aba Fichas.`
              : `"${Audit.PLAN_STATUS_LABEL}" = "${typed}" contradiz a ficha vigente (${plan ? plan.id : 'nenhuma'}).`,
            action: 'A migração retira o status digitado; o status passa a ser derivado de Fichas.' });
        }
      }));
    });
    return out;
  },

  /* Validations ----------------------------------------------------------------------------- */

  /** Data validations whose list range is a named range that does not exist. */
  checkValidations_(out) {
    Audit.brokenValidations_().forEach((b) => {
      out.push({ severity: 'Erro', code: 'validation_named_range', tab: b.tab, cell: Audit.box_(b.cells), finding: `Validação usa o intervalo nomeado "${b.ref}", que não existe (lista suspensa vazia).`, action: 'A migração recria o intervalo nomeado quando ele é conhecido da 3.0; senão refaça a validação.', before: b.ref });
    });
  },

  /** [{tab, ref, cells: [{row, col}]}] grouped by sheet and reference. */
  brokenValidations_() {
    const ss = SpreadsheetApp.getActive();
    const groups = {};
    const order = [];
    Audit.sheets_().forEach(({ sheet }) => {
      const rows = sheet.getMaxRows();
      const cols = sheet.getMaxColumns();
      if (!rows || !cols) return;
      const rules = sheet.getRange(1, 1, rows, cols).getDataValidations();
      rules.forEach((line, i) => line.forEach((rule, j) => {
        if (!rule || String(rule.getCriteriaType()) !== 'VALUE_IN_RANGE') return;
        const target = rule.getCriteriaValues()[0];
        if (target && typeof target !== 'string') return;
        const ref = target ? String(target) : '(vazio)';
        if (target && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(ref) && ss.getRangeByName(ref)) return;
        const k = `${sheet.getName()}\u0000${ref}`;
        if (!groups[k]) { groups[k] = { tab: sheet.getName(), ref, cells: [] }; order.push(k); }
        groups[k].cells.push({ row: i + 1, col: j + 1 });
      }));
    });
    return order.map((k) => groups[k]);
  },

  /* Entities and Config --------------------------------------------------------------------- */

  checkVersions_(out) {
    [['objectives', Objectives], ['goals', Goals], ['plans', Plans]].forEach(([id, repo]) => {
      if (!Tabs.findSheet(id)) return; // reported as missing / legacy name
      let problems;
      let current;
      try {
        problems = repo.validate();
        current = repo.current();
      } catch (err) {
        out.push({ severity: 'Erro', code: 'version_unreadable', tab: Tabs.get(id).name, cell: '', finding: err.message, action: 'Reaplicar layout ou migrar.' });
        return;
      }
      problems.forEach((p) => out.push({ severity: 'Erro', code: `version_${p.code}`, tab: Tabs.get(id).name, cell: p.id || '', finding: p.message, action: 'Corrigir as datas/status da versão (o histórico só cresce para frente).' }));
      if (!current) out.push({ severity: 'Erro', code: 'version_none_current', tab: Tabs.get(id).name, cell: '', finding: `Nenhuma versão de ${repo.label.toLowerCase()} em vigor hoje.`, action: 'Criar a versão inicial (Configuração inicial) ou corrigir as datas.' });
    });
  },

  checkConfig_(out) {
    const sheet = Tabs.findSheet('config');
    if (!sheet || !Audit.isConfigLayout_(sheet)) return;
    Config.invalidate();
    const name = Tabs.get('config').name;
    Config.keys().forEach((k) => {
      try { Config.get(k); } catch (err) {
        out.push({ severity: 'Erro', code: 'config_invalid', tab: name, cell: k, finding: err.message, action: 'Corrigir o valor na coluna Valor.' });
      }
    });
    const missing = Audit.REQUIRED_CONFIG.filter((k) => {
      try { return !Config.has(k); } catch (err) { return false; }
    });
    if (!Config.has('client.age') && !Config.has('client.birthDate')) missing.push('client.age');
    missing.forEach((k) => out.push({ severity: 'Erro', code: 'config_missing', tab: name, cell: k, finding: `"${Config.DEFAULTS[k].label}" está vazio.`, action: 'Preencher em Config ou pela Configuração inicial.' }));
    if (Config.raw('system.schemaVersion') !== Config.SCHEMA_VERSION) {
      out.push({ severity: 'Aviso', code: 'schema_version', tab: name, cell: 'system.schemaVersion', finding: `Versão do esquema "${Config.raw('system.schemaVersion') || ''}" (esperado ${Config.SCHEMA_VERSION}).`, action: 'Rodar Projeto → Sistema → Migrar 3.0 → 4.0.' });
    }
  },

  /* A1 helpers ------------------------------------------------------------------------------ */

  col_(n) {
    let s = '';
    let x = n;
    while (x > 0) { const r = (x - 1) % 26; s = String.fromCharCode(65 + r) + s; x = Math.floor((x - 1) / 26); }
    return s;
  },

  a1_(row, col) {
    return `${Audit.col_(col)}${row}`;
  },

  /** Bounding box of cells as A1 ("A27:A38"), or the single cell. */
  box_(cells) {
    const r1 = Math.min(...cells.map((c) => c.row));
    const r2 = Math.max(...cells.map((c) => c.row));
    const c1 = Math.min(...cells.map((c) => c.col));
    const c2 = Math.max(...cells.map((c) => c.col));
    return r1 === r2 && c1 === c2 ? Audit.a1_(r1, c1) : `${Audit.a1_(r1, c1)}:${Audit.a1_(r2, c2)}`;
  },
};
