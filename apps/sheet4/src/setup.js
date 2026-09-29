/**
 * Setup (spec §5.1, §11): builds or updates every tab from Tabs.SPEC + Style. Idempotent: a second
 * run changes nothing. It never deletes a data row or reorders data columns.
 *
 *   Setup.apply()        everything below, then Dashboard.render(); returns a report
 *   Setup.ensureTriggers()  the two installable triggers, exactly once each
 *
 * Steps of apply():
 *   1. every tab exists (Tabs.ensure / Hoje.ensure). Tabs are NOT renamed here (the migration
 *      renames 3.0 tabs in place); an untouched default "Sheet1/Página1" is removed from a new file;
 *   2. missing spec columns are appended after the last used column (header text only);
 *   3. Config gets every key of Config.DEFAULTS (sections, labels, units, descriptions);
 *      existing values are kept;
 *   4. tab order by layer (1 person, 2 history, 3 technical; unknown tabs last), tab colours,
 *      Log hidden (other hidden tabs stay as they are), gridlines hidden on layer 1;
 *   5. per data tab: title/help rows, header band, frozen header, widths, number formats,
 *      input/calc fills, validations (Tabs.SPEC enums + per-tab lists), conditional formats
 *      (status chips, hidden technical dates < 2000), warning-only protections of the header row
 *      and of calculated columns ("[Setup] …" protections are replaced on each run);
 *   6. named range ListaExercicios (the 3.0 validations referenced it; it was missing) → the
 *      Exercícios name column;
 *   7. Hoje drawn from Hoje.layout() (phone-first cards, inputs vs calculated, validations, chips,
 *      navigation row); a Hoje with a foreign layout (3.0) is cleared first — it is a screen;
 *   8. installable triggers: onEdit → onEditInstalled, daily → dailyRefresh (no duplicates);
 *   9. Dashboard.render().
 */
const Setup = {
  PROTECT_PREFIX: '[Setup] ',
  NAMED_EXERCISES: 'ListaExercicios',
  DEFAULT_SHEET: /^(Sheet|Página|Pagina|Planilha|Folha|Hoja|Feuille|Tabelle)\s?\d*$/i,
  TRIGGERS: {
    edit: 'onEditInstalled',
    daily: 'dailyRefresh',
    DAILY_HOUR: 3,
  },

  /**
   * Per-tab validations beyond the enums of Tabs.SPEC: tab id → column key → rule.
   * Rules: {type: 'list', values | source, allowInvalid?} · {type: 'number', min?, max?} · {type: 'date'}.
   * Sources: 'tab:<id>.<key>' (a live range), 'sessions' (Sessions.names or the Config rotation),
   * 'config:<key>'.
   */
  VALIDATIONS: (() => {
    const kg = { type: 'number', min: 0, max: 1000 };
    const reps = { type: 'number', min: 0, max: 100 };
    const scale = { type: 'number', min: 0, max: 10 };
    const cm = { type: 'number', min: 0, max: 300 };
    return {
      workouts: {
        exercise: { type: 'list', source: 'tab:exercises.name' },
        session: { type: 'list', source: 'sessions' },
        warmupKg: kg, feederKg: kg, work1Kg: kg, work2Kg: kg,
        warmupReps: reps, feederReps: reps, work1Reps: reps, work2Reps: reps,
        rir1: scale, rir2: scale, pain: scale,
      },
      planDraft: { exercise: { type: 'list', source: 'tab:exercises.name' } },
      food: { food: { type: 'list', source: 'tab:foods.name' }, measure: { type: 'list', values: ['Pesada', 'Rótulo', 'Estimada'] } },
      baseDiet: { food: { type: 'list', source: 'tab:foods.name' } },
      ingredients: { food: { type: 'list', source: 'tab:foods.name' } },
      measures: { waistCm: cm, hipCm: cm, chestCm: cm, armCm: cm, thighCm: cm },
      reviews: { area: { type: 'list', values: Tabs.ENUMS.REVIEW_AREAS }, status: { type: 'list', values: Tabs.ENUMS.REVIEW_STATUS } },
    };
  })(),

  /* Entry point ------------------------------------------------------------------------------ */

  /**
   * @returns {{created: string[], removed: string[], columnsAdded: Object<string, string[]>,
   *   configKeysAdded: string[], hojeReset: boolean, triggers: Object, dashboard: Object|null,
   *   warnings: string[]}}
   */
  apply() {
    const ss = SpreadsheetApp.getActive();
    const report = { created: [], removed: [], columnsAdded: {}, configKeysAdded: [], hojeReset: false, triggers: null, dashboard: null, warnings: [] };
    Setup.theme_(ss, report);
    Tabs.ids().forEach((id) => {
      if (Tabs.findSheet(id)) return;
      if (id === Hoje.TAB) Hoje.ensure(); else Tabs.ensure(id);
      report.created.push(Tabs.get(id).name);
    });
    Setup.dropDefaultSheets_(ss, report);
    Tabs.ids().forEach((id) => { if (Tabs.get(id).kind === 'table') Setup.addMissingColumns_(id, report); });
    Tabs.invalidate();
    Setup.config_(report);
    Setup.order_(ss);
    Setup.namedRanges_(ss);
    Tabs.ids().forEach((id) => {
      const spec = Tabs.get(id);
      if (spec.kind === 'table') Setup.styleTable_(id);
      Setup.frame_(id);
    });
    report.hojeReset = Setup.hoje_();
    report.triggers = Setup.ensureTriggers(report);
    try {
      report.dashboard = Dashboard.render();
    } catch (err) {
      console.error(err);
      report.warnings.push(`Painel: ${err.message}`);
    }
    const hoje = Tabs.findSheet(Hoje.TAB);
    if (hoje) ss.setActiveSheet(hoje);
    return report;
  },

  /** Spreadsheet theme font (when the API exists; the fakes have none). */
  theme_(ss, report) {
    try {
      if (typeof ss.getSpreadsheetTheme === 'function') {
        const theme = ss.getSpreadsheetTheme();
        if (theme && typeof theme.setFontFamily === 'function') theme.setFontFamily(Style.FONT);
      }
    } catch (err) {
      report.warnings.push(`Tema: ${err.message}`);
    }
  },

  /** Removes an untouched default sheet ("Sheet1", "Página1"…) that is not a product tab. */
  dropDefaultSheets_(ss, report) {
    ss.getSheets().forEach((sheet) => {
      const name = sheet.getName();
      if (!Setup.DEFAULT_SHEET.test(name) || Tabs.byName(name)) return;
      if (sheet.getLastRow() || sheet.getLastColumn() || sheet.getCharts().length || ss.getNumSheets() < 2) return;
      ss.deleteSheet(sheet);
      report.removed.push(name);
    });
  },

  /** Appends the header of every spec column missing from a data tab (after the last used column). */
  addMissingColumns_(id, report) {
    const spec = Tabs.get(id);
    Tabs.invalidate(spec.name);
    const missing = Tabs.missingColumns(id).map((k) => Tabs.column(id, k).header);
    if (!missing.length) return;
    const sheet = Tabs.sheet(id);
    const start = sheet.getLastColumn() + 1;
    const need = start + missing.length - 1;
    if (need > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), need - sheet.getMaxColumns());
    sheet.getRange(spec.headerRow, start, 1, missing.length).setValues([missing]);
    Tabs.invalidate(spec.name);
    report.columnsAdded[spec.name] = missing;
  },

  /* Config ----------------------------------------------------------------------------------- */

  /** Every Config key present (with section rows on a new tab); labels/units/descriptions refreshed. */
  config_(report) {
    const rows = Tabs.read('config');
    const byKey = {};
    rows.forEach((r) => { if (r.key !== null && String(r.key).trim()) byKey[String(r.key).trim()] = r; });
    const out = [];
    const sectionsPresent = {};
    rows.forEach((r) => { if ((r.key === null || !String(r.key).trim()) && r.label) sectionsPresent[String(r.label).trim()] = true; });
    Config.sections().forEach((s) => {
      const missing = s.items.filter((i) => !byKey[i.key]);
      if (!missing.length) return;
      if (!sectionsPresent[s.section]) out.push({ key: null, label: s.section });
      missing.forEach((i) => {
        out.push({ key: i.key, label: i.label, value: Config.toCell_(i, i.default), unit: i.unit, description: i.description });
        report.configKeysAdded.push(i.key);
      });
    });
    Object.keys(byKey).forEach((k) => {
      const def = Config.DEFAULTS[k];
      if (!def) return;
      const r = byKey[k];
      const patch = {};
      if (r.label !== def.label) patch.label = def.label;
      if ((r.unit || '') !== (def.unit || '')) patch.unit = def.unit;
      if ((r.description || '') !== (def.description || '')) patch.description = def.description;
      if (Object.keys(patch).length) Tabs.update('config', r._row, patch);
    });
    if (out.length) Tabs.appendMany('config', out);
    Config.invalidate();
  },

  /* Order, visibility, colours --------------------------------------------------------------- */

  /** Product tabs by layer and registry order, then unknown tabs in their current order. */
  order_(ss) {
    const hidden = {};
    ss.getSheets().forEach((s) => { hidden[s.getSheetId()] = s.isSheetHidden(); });
    const wanted = [1, 2, 3].reduce((acc, layer) => acc.concat(Tabs.layer(layer).map((id) => Tabs.findSheet(id)).filter(Boolean)), []);
    const others = ss.getSheets().filter((s) => wanted.indexOf(s) < 0 && !wanted.some((w) => w.getSheetId() === s.getSheetId()));
    wanted.concat(others).forEach((sheet, i) => {
      if (sheet.getIndex() === i + 1) return;
      ss.setActiveSheet(sheet);
      ss.moveActiveSheet(i + 1);
    });
    // Activating a hidden sheet shows it: put visibility back, then apply the spec.
    ss.getSheets().forEach((s) => {
      const spec = Tabs.byName(s.getName());
      const hide = spec && spec.hidden ? true : hidden[s.getSheetId()];
      if (hide && !s.isSheetHidden()) s.hideSheet();
      else if (!hide && s.isSheetHidden()) s.showSheet();
    });
  },

  /** Tab colour, gridlines, navigation row (layer-1 tables), frozen first column (wide history tabs). */
  frame_(id) {
    const spec = Tabs.get(id);
    const sheet = Tabs.sheet(id);
    sheet.setTabColor(Style.LAYER[spec.layer].tab);
    sheet.setHiddenGridlines(spec.layer === Tabs.LAYERS.PERSON);
    if (spec.kind !== 'table') return;
    sheet.setFrozenColumns(spec.layer === Tabs.LAYERS.HISTORY && spec.columns.length > 10 ? 1 : 0);
    if (spec.layer === Tabs.LAYERS.PERSON) {
      const links = ['today', 'dashboard'].map((target) => {
        const s = Tabs.findSheet(target);
        return s ? `=HYPERLINK("#gid=${s.getSheetId()}","${target === 'today' ? '‹ ' : ''}${Tabs.get(target).name}")` : Tabs.get(target).name;
      });
      sheet.getRange(1, 1, 1, 2).setValues([links]);
      Style.link(sheet.getRange(1, 1, 1, 2));
      sheet.setRowHeight(1, Style.ROW.nav);
    }
  },

  /** ListaExercicios → Exercícios name column (data rows). */
  namedRanges_(ss) {
    const spec = Tabs.get('exercises');
    const sheet = Tabs.sheet('exercises');
    const col = Tabs.headerMap('exercises').name;
    if (!col) return;
    const range = sheet.getRange(spec.firstDataRow, col, sheet.getMaxRows() - spec.firstDataRow + 1, 1);
    const existing = ss.getRangeByName(Setup.NAMED_EXERCISES);
    if (existing && existing.getA1Notation() === range.getA1Notation() && existing.getSheet().getSheetId() === sheet.getSheetId()) return;
    if (existing) ss.removeNamedRange(Setup.NAMED_EXERCISES);
    ss.setNamedRange(Setup.NAMED_EXERCISES, range);
  },

  /* Data tabs -------------------------------------------------------------------------------- */

  /** Title shown on row 2 (Ficha de treino shows the status derived from the plan entity). */
  titleOf_(id) {
    const spec = Tabs.get(id);
    if (id === 'planDraft' && typeof PlanDraft !== 'undefined' && Tabs.findSheet('plans')) {
      try { return PlanDraft.statusText(); } catch (err) { return spec.title; }
    }
    return spec.title;
  },

  styleTable_(id) {
    const spec = Tabs.get(id);
    const sheet = Tabs.sheet(id);
    sheet.getRange(Tabs.TITLE_ROW, 1).setValue(Setup.titleOf_(id));
    sheet.getRange(Tabs.HELP_ROW, 1).setValue(Setup.helpOf_(spec));
    const extraRules = [];
    if (id === 'progression') Setup.progressionBlock_(sheet, extraRules);
    Style.table(sheet, spec, { inputFill: spec.layer === Tabs.LAYERS.PERSON || id === 'config', extraRules });
    Setup.validations_(id);
    Setup.protections_(id);
    if (id === 'config') Setup.configRows_(sheet);
    if (id === 'planDraft') Setup.planDraftForm_(sheet);
  },

  /** Help row: the spec text, plus the colour legend on tabs that mix inputs and calculations. */
  helpOf_(spec) {
    const roles = spec.columns.map((c) => c.role);
    const mixed = roles.indexOf('calc') >= 0 && roles.indexOf('calc') !== roles.lastIndexOf('calc') && roles.some((r) => r === 'input');
    return mixed ? `${spec.help} Colunas cinza são calculadas pelo script.` : spec.help;
  },

  /** DataValidation for a rule, or null (clears). */
  rule_(v, help) {
    if (!v) return null;
    const b = SpreadsheetApp.newDataValidation();
    const allowInvalid = v.allowInvalid !== undefined ? v.allowInvalid : true;
    if (v.type === 'date') {
      b.requireDate().setHelpText(help || 'Data no formato dd/mm/aaaa.');
    } else if (v.type === 'number') {
      const has = (x) => typeof x === 'number' && isFinite(x);
      if (has(v.min) && has(v.max)) b.requireNumberBetween(v.min, v.max).setHelpText(help || `Número entre ${v.min} e ${v.max}.`);
      else if (has(v.min)) b.requireNumberGreaterThanOrEqualTo(v.min).setHelpText(help || `Número a partir de ${v.min}.`);
      else if (has(v.max)) b.requireNumberLessThanOrEqualTo(v.max).setHelpText(help || `Número até ${v.max}.`);
      else return null;
    } else if (v.type === 'list') {
      if (v.source && v.source.indexOf('tab:') === 0) {
        const [tab, key] = v.source.slice(4).split('.');
        const sheet = Tabs.findSheet(tab);
        const col = sheet ? Tabs.headerMap(tab)[key] : null;
        if (!col) return null;
        const first = Tabs.get(tab).firstDataRow;
        b.requireValueInRange(sheet.getRange(first, col, sheet.getMaxRows() - first + 1, 1), true)
          .setHelpText(help || `Escolha da aba ${Tabs.get(tab).name}.`);
      } else {
        const values = Setup.listValues_(v);
        if (!values.length) return null;
        b.requireValueInList(values, true).setHelpText(help || 'Escolha da lista.');
      }
    } else {
      return null;
    }
    return b.setAllowInvalid(allowInvalid).build();
  },

  /** Values of a list rule (fixed values or a dynamic source). */
  listValues_(v) {
    if (v.values) return v.values.slice();
    if (v.source === 'quickActions') return Actions.quickList();
    if (v.source === 'sessions' || v.source === 'config:routine.sessionRotation') {
      if (typeof Sessions !== 'undefined' && typeof Sessions.names === 'function') {
        try { return Sessions.names(Dates.today()); } catch (err) { /* fall back to Config */ }
      }
      return Config.getList('routine.sessionRotation');
    }
    if (v.source && v.source.indexOf('config:') === 0) return Config.getList(v.source.slice(7));
    return [];
  },

  /** Validations of every spec column of a data tab (data rows); columns with no rule are cleared. */
  validations_(id) {
    const spec = Tabs.get(id);
    const sheet = Tabs.sheet(id);
    const map = Tabs.headerMap(id);
    const extra = Setup.VALIDATIONS[id] || {};
    const n = sheet.getMaxRows() - spec.firstDataRow + 1;
    spec.columns.forEach((c) => {
      const j = map[c.key];
      if (!j) return;
      let rule = extra[c.key] || null;
      if (!rule && c.type === 'enum' && c.enum) rule = { type: 'list', values: c.enum, allowInvalid: c.role !== 'input' };
      if (!rule && c.type === 'date' && c.role !== 'calc') rule = { type: 'date', allowInvalid: false };
      if (!rule && id === 'diary' && Diary.FIELDS[c.key] && (c.type === 'number' || c.type === 'integer')) {
        const f = Diary.FIELDS[c.key];
        rule = { type: 'number', min: f.min, max: f.max };
      }
      const range = sheet.getRange(spec.firstDataRow, j, n, 1);
      const dv = c.role === 'calc' && !(c.type === 'enum') ? null : Setup.rule_(rule);
      if (dv) range.setDataValidation(dv);
      else range.clearDataValidations();
    });
  },

  /** Removes the protections Setup created before (by description prefix). */
  dropProtections_(sheet) {
    sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach((p) => {
      if (String(p.getDescription()).indexOf(Setup.PROTECT_PREFIX) === 0) p.remove();
    });
  },

  protect_(range, text) {
    const p = range.protect();
    p.setDescription(Setup.PROTECT_PREFIX + text);
    p.setWarningOnly(true);
    return p;
  },

  /** Warning-only protections: the header row, and each run of adjacent calculated columns. */
  protections_(id) {
    const spec = Tabs.get(id);
    const sheet = Tabs.sheet(id);
    Setup.dropProtections_(sheet);
    const map = Tabs.headerMap(id);
    Setup.protect_(sheet.getRange(spec.headerRow, 1, 1, Math.max(sheet.getLastColumn(), 1)), 'Cabeçalho: o script encontra as colunas por este texto.');
    const calc = spec.columns.filter((c) => c.role === 'calc' && map[c.key]).map((c) => ({ col: map[c.key], header: c.header }))
      .sort((a, b) => a.col - b.col);
    const runs = [];
    calc.forEach((c) => {
      const last = runs[runs.length - 1];
      if (last && last.to === c.col - 1) { last.to = c.col; last.headers.push(c.header); } else runs.push({ from: c.col, to: c.col, headers: [c.header] });
    });
    const n = sheet.getMaxRows() - spec.firstDataRow + 1;
    runs.forEach((r) => Setup.protect_(sheet.getRange(spec.firstDataRow, r.from, n, r.to - r.from + 1), `Calculado pelo script: ${r.headers.join(', ')}.`));
  },

  /** Config: section rows, technical key column, per-key validations and date formats. */
  configRows_(sheet) {
    const map = Tabs.headerMap('config');
    if (!map.value || !map.label) return;
    const lastCol = Math.max(sheet.getLastColumn(), 1);
    Tabs.read('config').forEach((r) => {
      const key = r.key === null ? '' : String(r.key).trim();
      if (!key) {
        if (r.label) Style.section(sheet.getRange(r._row, 1, 1, lastCol));
        return;
      }
      if (map.key) Style.small(sheet.getRange(r._row, map.key));
      const def = Config.DEFAULTS[key];
      const cell = sheet.getRange(r._row, map.value);
      if (!def) { cell.clearDataValidations(); return; }
      let rule = null;
      if (def.type === 'enum') rule = { type: 'list', values: def.options, allowInvalid: false };
      else if (def.type === 'date') rule = { type: 'date', allowInvalid: false };
      else if (def.type === 'number' || def.type === 'integer') rule = { type: 'number', min: -1000000, max: 1000000000 };
      const dv = Setup.rule_(rule, def.description);
      if (dv) cell.setDataValidation(dv); else cell.clearDataValidations();
      cell.setNumberFormat(def.type === 'date' ? 'dd/mm/yyyy' : 'General').setHorizontalAlignment('left');
    });
  },

  /** Ficha de treino row 4: the start date and reason inputs of "Salvar nova ficha". */
  planDraftForm_(sheet) {
    if (typeof PlanDraft === 'undefined') return;
    const c = PlanDraft.CELLS;
    [[c.startLabel, PlanDraft.LABELS.start], [c.reasonLabel, PlanDraft.LABELS.reason]].forEach(([a1, text]) => {
      const r = sheet.getRange(a1);
      if (r.getValue() === '') r.setValue(text);
      Style.label(r).setFontWeight('bold').setHorizontalAlignment('right');
    });
    Style.input(sheet.getRange(c.start)).setNumberFormat('dd/mm/yyyy').setDataValidation(Setup.rule_({ type: 'date', allowInvalid: false }, 'Início da nova ficha (dd/mm/aaaa).'));
    Style.input(sheet.getRange(c.reason));
    sheet.setRowHeight(4, Style.ROW.field);
  },

  /** Progressão: picker + history block (right of the summary table), as Progression renders it. */
  progressionBlock_(sheet, rules) {
    if (typeof Progression === 'undefined' || typeof Progression.pickerCell !== 'function') return;
    const H = Progression.HISTORY;
    const col = Progression.historyCol_();
    const need = col + H.HEADERS.length - 1;
    if (need > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), need - sheet.getMaxColumns());
    sheet.getRange(H.PICKER_ROW, col).setValue(H.PICKER_LABEL);
    Style.label(sheet.getRange(H.PICKER_ROW, col)).setFontWeight('bold').setHorizontalAlignment('right');
    const picker = sheet.getRange(Progression.pickerCell());
    Style.input(picker);
    const dv = Setup.rule_({ type: 'list', source: 'tab:exercises.name' }, 'Escolha o exercício para ver o histórico.');
    if (dv) picker.setDataValidation(dv);
    sheet.setRowHeight(H.PICKER_ROW, Style.ROW.field);
    const header = Tabs.get('progression').headerRow;
    sheet.getRange(header, col, 1, H.HEADERS.length).setValues([H.HEADERS]);
    const first = Tabs.get('progression').firstDataRow;
    const body = sheet.getRange(first, col, H.ROWS, H.HEADERS.length);
    Style.calc(body);
    sheet.getRange(first, col, H.ROWS, 1).setNumberFormat('dd/mm/yyyy').setHorizontalAlignment('center');
    sheet.getRange(first, col + 3, H.ROWS, 7).setNumberFormat('0.0');
    H.HEADERS.forEach((h, i) => sheet.setColumnWidth(col + i, i === 0 ? Style.WIDTH.date : i === H.HEADERS.length - 1 ? 220 : i < 3 ? 110 : 76));
    const trends = ['Progrediu', 'Manteve', 'Regrediu', 'Sem comparação', 'Primeiro registro', 'Sem registro'];
    const trendCol = Tabs.headerMap('progression').trend;
    if (trendCol) Style.statusRules(sheet.getRange(first, trendCol, sheet.getMaxRows() - first + 1, 1), trends).forEach((r) => rules.push(r));
    Style.statusRules(sheet.getRange(first, col + H.HEADERS.length - 2, H.ROWS, 2), trends.concat(Tabs.ENUMS.SESSION_STATE)).forEach((r) => rules.push(r));
  },

  /* Hoje ------------------------------------------------------------------------------------- */

  /** True when Hoje holds another layout (e.g. 3.0): more than a quarter of the label cells differ. */
  foreignHoje_(sheet) {
    const texts = Hoje.texts();
    const cells = Object.keys(texts).filter((a1) => a1 !== `A${Tabs.TITLE_ROW}` && a1 !== `A${Tabs.HELP_ROW}`);
    const wrong = cells.filter((a1) => {
      const v = sheet.getRange(a1).getValue();
      return v !== '' && v !== texts[a1];
    });
    return wrong.length * 4 > cells.length;
  },

  /** Resets a sheet completely (screen tabs only). */
  resetSheet_(sheet) {
    const all = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns());
    all.breakApart();
    all.clear();
    all.clearDataValidations();
    all.clearNote();
    sheet.clearConditionalFormatRules();
    sheet.getCharts().forEach((c) => sheet.removeChart(c));
    sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).forEach((p) => p.remove());
    sheet.setFrozenRows(0);
    sheet.setFrozenColumns(0);
  },

  /** Draws Hoje from Hoje.layout(). Input values are kept. @returns {boolean} the tab was reset */
  hoje_() {
    const sheet = Hoje.ensure();
    const layout = Hoje.layout();
    let reset = false;
    if (Setup.foreignHoje_(sheet)) {
      Setup.resetSheet_(sheet);
      reset = true;
    }
    const texts = Hoje.texts();
    Object.keys(texts).forEach((a1) => sheet.getRange(a1).setValue(texts[a1]));
    const quick = sheet.getRange(layout.quickCell);
    if (quick.getValue() === '') quick.setValue(Actions.QUICK_EMPTY);
    const lastRow = layout.lastRow + 1;
    const lastCol = layout.lastCol;
    if (sheet.getMaxColumns() < lastCol) sheet.insertColumnsAfter(sheet.getMaxColumns(), lastCol - sheet.getMaxColumns());
    const R = (a1) => sheet.getRange(a1);
    const colA = (c) => Style.col(c);

    // Canvas, widths, rows
    const area = sheet.getRange(1, 1, lastRow, lastCol);
    Style.base_(area, Style.SIZE.body).setBackground(Style.C.canvas).setFontColor(Style.C.text).setFontWeight('normal')
      .setFontStyle('normal').setWrap(false).setHorizontalAlignment('left').setBorder(false, false, false, false, false, false);
    Object.keys(layout.columns).forEach((letter) => sheet.setColumnWidth(Hoje.rc_(`${letter}1`)[1], layout.columns[letter]));
    sheet.setRowHeights(1, lastRow, Style.ROW.field);
    sheet.setHiddenGridlines(true);
    sheet.setFrozenRows(Hoje.rc_(layout.dateCell)[0]);

    // Navigation, title, help
    const links = Dashboard.navLinks(Hoje.TAB);
    sheet.getRange(1, 1, 1, links.length).setValues([links]);
    Style.link(sheet.getRange(1, 1, 1, links.length));
    sheet.setRowHeight(1, Style.ROW.nav);
    Style.title(R(`A${Tabs.TITLE_ROW}`));
    sheet.setRowHeight(Tabs.TITLE_ROW, Style.ROW.title);
    R(`A${Tabs.HELP_ROW}:B${Tabs.HELP_ROW}`).merge();
    Style.small(R(`A${Tabs.HELP_ROW}`)).setWrap(true);
    sheet.setRowHeight(Tabs.HELP_ROW, 44);

    const validations = [];
    const calcCells = [];
    const rules = [];
    const drawField = (f) => {
      Style.label(R(f.labelCell)).setBackground(Style.C.surface);
      if (f.input) {
        Style.input(R(f.cell));
        if (f.validation) validations.push([f.cell, f.validation, f.label]);
        else R(f.cell).clearDataValidations();
      } else {
        Style.calc(R(f.cell)).setWrap(true);
        R(f.cell).clearDataValidations();
        calcCells.push(f.cell);
      }
      const nf = f.type === 'date' ? 'dd/mm/yyyy' : Setup.hojeFormat_(f.key);
      R(f.cell).setNumberFormat(nf || 'General');
    };

    layout.sections.forEach((s) => {
      const width = s.table ? s.table.columns.length : 2;
      const rows = s.fields.map((f) => Hoje.rc_(f.cell)[0]);
      if (s.table) rows.push(s.table.firstRow + s.table.rows - 1);
      Object.keys(s.hints || {}).forEach((a1) => rows.push(Hoje.rc_(a1)[0]));
      const top = s.titleCell ? Hoje.rc_(s.titleCell)[0] : Math.min.apply(null, rows);
      const bottom = Math.max.apply(null, rows);
      if (s.titleCell) {
        Style.section(sheet.getRange(top, 1, 1, width));
        sheet.setRowHeight(top, Style.ROW.section);
        if (top > 1) sheet.setRowHeight(top - 1, Style.ROW.spacer);
      }
      s.fields.forEach(drawField);
      Object.keys(s.hints || {}).forEach((a1) => {
        const r = Hoje.rc_(a1)[0];
        R(`A${r}:B${r}`).merge();
        Style.small(R(a1)).setWrap(true).setBackground(Style.C.surface);
        sheet.setRowHeight(r, Style.ROW.hint);
      });
      if (s.table) {
        const t = s.table;
        Style.header(sheet.getRange(t.headerRow, 1, 1, t.columns.length), Tabs.LAYERS.PERSON);
        sheet.setRowHeight(t.headerRow, Style.ROW.header);
        const body = sheet.getRange(t.firstRow, 1, t.rows, t.columns.length);
        if (s.script) {
          Style.calc(body);
          (t.indicators || []).forEach((ind) => Style.label(R(`A${ind.row}`)).setBackground(Style.C.surface));
          sheet.getRange(t.firstRow, 2, t.rows, 2).setNumberFormat('#,##0').setHorizontalAlignment('right');
          const statusCol = t.columns.find((c) => c.key === 'status');
          const st = sheet.getRange(t.firstRow, Hoje.rc_(`${statusCol.col}1`)[1], t.rows, 1);
          st.setHorizontalAlignment('center');
          Style.statusRules(st, ['Dentro da meta', 'Abaixo da meta', 'Acima da meta', 'Parcial', 'Completo — cálculo parcial', 'Sem registro', 'Não informado', 'Sem meta'])
            .forEach((x) => rules.push(x));
          calcCells.push(`B${t.firstRow}:${colA(t.columns.length)}${t.firstRow + t.rows - 1}`);
        } else {
          Style.input(body);
          t.columns.forEach((c) => {
            const col = sheet.getRange(t.firstRow, Hoje.rc_(`${c.col}1`)[1], t.rows, 1);
            col.setNumberFormat(c.type === 'number' ? (/Kg$/.test(c.key) ? '0.0' : '0') : 'General');
            if (c.validation) validations.push([`${c.col}${t.firstRow}:${c.col}${t.firstRow + t.rows - 1}`, c.validation, c.header]);
            else col.clearDataValidations();
          });
        }
      }
      if (s.id === 'status') {
        const cov = s.fields[0];
        const r = Hoje.rc_(cov.cell)[0];
        R(`B${r}:${colA(s.table.columns.length)}${r}`).merge();
        Style.calc(R(`B${r}:${colA(s.table.columns.length)}${r}`)).setWrap(true);
        sheet.setRowHeight(r, Style.ROW.hint);
      }
      Style.card(sheet.getRange(top, 1, bottom - top + 1, width));
    });

    // Header card accents: Ação rápida stands out; the day state and session state are chips.
    const q = R(layout.quickCell);
    q.setBackground(Style.C.primarySoft).setFontColor(Style.C.primaryText).setFontWeight('bold')
      .setBorder(true, true, true, true, null, null, Style.C.primary, 'SOLID_MEDIUM');
    Style.label(R(`A${Hoje.rc_(layout.quickCell)[0]}`)).setFontColor(Style.C.primaryText).setFontWeight('bold');
    sheet.setRowHeight(Hoje.rc_(layout.quickCell)[0], 32);
    Style.statusRules(R(Hoje.STATE_CELL), Tabs.ENUMS.DAY_STATE).forEach((x) => rules.push(x));
    const sessionState = Hoje.section('training').fields.find((f) => f.key === 'state');
    if (sessionState) Style.statusRules(R(sessionState.cell), Tabs.ENUMS.SESSION_STATE).forEach((x) => rules.push(x));
    sheet.setConditionalFormatRules(rules);

    validations.forEach(([a1, v, label]) => {
      const help = v.type === 'list' && v.source === 'quickActions' ? 'Escolha uma ação: ela roda na hora (funciona no celular).' : null;
      const dv = Setup.rule_(v, help || (v.type === 'number' ? null : `${label}: escolha da lista.`));
      if (dv) R(a1).setDataValidation(dv); else R(a1).clearDataValidations();
    });

    // Warning-only protections: calculated cells and the screen texts.
    Setup.dropProtections_(sheet);
    calcCells.forEach((a1) => Setup.protect_(R(a1), 'Calculado pelo script (tela Hoje).'));
    const training = Hoje.section('training').table;
    Setup.protect_(sheet.getRange(Tabs.TITLE_ROW, 1, training.headerRow - Tabs.TITLE_ROW + 1, 1), 'Textos da tela Hoje.');
    Setup.protect_(sheet.getRange(training.firstRow + training.rows, 1, layout.lastRow - training.firstRow - training.rows + 1, 1), 'Textos da tela Hoje.');
    Setup.protect_(sheet.getRange(training.headerRow, 2, 1, training.columns.length - 1), 'Textos da tela Hoje.');
    return reset;
  },

  /** Number format of a Hoje field by key. */
  hojeFormat_(key) {
    if (['weightKg', 'waistCm', 'sleepH', 'qty', 'portions'].indexOf(key) >= 0) return '0.0';
    if (['steps'].indexOf(key) >= 0) return '#,##0';
    if (['cardioMin', 'activityMin', 'hunger', 'fatigue', 'pain'].indexOf(key) >= 0) return '0';
    return null;
  },

  /* Triggers --------------------------------------------------------------------------------- */

  /**
   * Installable triggers, exactly one of each: onEdit → onEditInstalled (Ação rápida, date change,
   * Medidas stamps) and a daily time trigger → dailyRefresh. Extra copies are deleted.
   * @returns {{created: string[], removed: number, warning?: string}}
   */
  ensureTriggers(report) {
    const out = { created: [], removed: 0 };
    try {
      const ss = SpreadsheetApp.getActive();
      const all = ScriptApp.getProjectTriggers();
      const keep = {};
      all.forEach((t) => {
        const h = t.getHandlerFunction();
        if (h !== Setup.TRIGGERS.edit && h !== Setup.TRIGGERS.daily) return;
        if (keep[h]) { ScriptApp.deleteTrigger(t); out.removed++; } else keep[h] = t;
      });
      if (!keep[Setup.TRIGGERS.edit]) {
        ScriptApp.newTrigger(Setup.TRIGGERS.edit).forSpreadsheet(ss).onEdit().create();
        out.created.push(Setup.TRIGGERS.edit);
      }
      if (!keep[Setup.TRIGGERS.daily]) {
        ScriptApp.newTrigger(Setup.TRIGGERS.daily).timeBased().everyDays(1).atHour(Setup.TRIGGERS.DAILY_HOUR).create();
        out.created.push(Setup.TRIGGERS.daily);
      }
    } catch (err) {
      out.warning = `Gatilhos não criados (${err.message}). Rode Projeto → Sistema → Reaplicar layout pelo menu para autorizar.`;
      if (report) report.warnings.push(out.warning);
    }
    return out;
  },
};

Actions.register({
  id: 'setupApply', label: 'Reaplicar layout', group: 'system', order: 40, logged: false,
  run: () => {
    const r = Setup.apply();
    const parts = ['Layout reaplicado.'];
    if (r.created.length) parts.push(`${r.created.length} aba(s) criada(s).`);
    const cols = Object.keys(r.columnsAdded).reduce((n, k) => n + r.columnsAdded[k].length, 0);
    if (cols) parts.push(`${cols} coluna(s) adicionada(s).`);
    if (r.triggers && r.triggers.created.length) parts.push(`Gatilhos criados: ${r.triggers.created.join(', ')}.`);
    if (r.warnings.length) parts.push(r.warnings.join(' '));
    return { message: parts.join(' '), report: r };
  },
});
