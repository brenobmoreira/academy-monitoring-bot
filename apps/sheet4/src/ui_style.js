/**
 * Design system (spec §11): tokens and small helpers shared by Setup, Hoje and the Painel.
 *
 * Tokens
 *   Style.FONT          one family everywhere (also set as the spreadsheet theme font when the
 *                       theme API is available)
 *   Style.SIZE          title 18 · band 14 · section 12 · body 10 · small 9
 *   Style.C             neutral surfaces (canvas, card, borders, text), the primary accent, the
 *                       header band, input fill (light yellow, dark border) vs calculated fill
 *                       (light grey, grey text, never italic)
 *   Style.STATUS        chip colours per status kind: ok · attention · off · insufficient · info
 *   Style.LAYER         tab colour and table-header colours per layer (1 person, 2 history,
 *                       3 technical/grey)
 *   Style.SERIES        chart colours, one per phase (cycled), Style.MARKER for transition marks
 *   Style.ROW / WIDTH   row heights and column widths (px)
 *
 * Helpers (each takes a Range or a RangeList and returns it):
 *   title, help, section, card, label, input, calc, chip(range, kind), header(range, layer),
 *   link, small, band, bandSub.
 *   Style.kindOf(text)          status kind of a displayed value ('No caminho' → 'ok', …)
 *   Style.numberFormat(col)     number format of a Tabs.SPEC column (dates dd/mm/yyyy, …)
 *   Style.width(col)            default width of a Tabs.SPEC column
 *   Style.statusRules(range, values)       conditional-format builders colouring status values
 *   Style.technicalDateRule(range, bg)     conditional format hiding dates before 2000 (§4.4)
 *   Style.table(sheet, spec)    title/help/header rows, widths, number formats, input/calc fills,
 *                               frozen header and conditional formats of a data tab
 *   Style.canvas(cols)          an in-memory grid of values + formats written in one batch
 *                               (used by the Painel, which is rewritten as values on each render)
 *
 * Only presentation lives here: no data reads, no client values.
 */
const Style = {
  FONT: 'Inter',

  SIZE: { title: 18, band: 14, section: 12, body: 10, small: 9 },

  C: {
    canvas: '#f8fafc',
    surface: '#ffffff',
    border: '#e2e8f0',
    borderStrong: '#cbd5e1',
    text: '#0f172a',
    textMuted: '#64748b',
    textSubtle: '#94a3b8',
    primary: '#4f46e5',
    primarySoft: '#eef2ff',
    primaryText: '#312e81',
    primaryBorder: '#c7d2fe',
    band: '#1e1b4b',
    bandText: '#ffffff',
    bandSub: '#c7d2fe',
    input: '#fffbeb',
    inputBorder: '#b45309',
    calc: '#f1f5f9',
    calcText: '#475569',
    headerBg: '#f1f5f9',
    headerText: '#334155',
  },

  STATUS: {
    ok: { bg: '#dcfce7', fg: '#166534' },
    attention: { bg: '#fef3c7', fg: '#92400e' },
    off: { bg: '#fee2e2', fg: '#991b1b' },
    insufficient: { bg: '#e2e8f0', fg: '#475569' },
    info: { bg: '#e0e7ff', fg: '#3730a3' },
  },

  LAYER: {
    1: { tab: '#4f46e5', headerBg: '#e0e7ff', headerText: '#312e81', headerLine: '#4f46e5' },
    2: { tab: '#0d9488', headerBg: '#ccfbf1', headerText: '#134e4a', headerLine: '#0d9488' },
    3: { tab: '#94a3b8', headerBg: '#e2e8f0', headerText: '#334155', headerLine: '#64748b' },
  },

  SERIES: ['#4f46e5', '#0d9488', '#d97706', '#db2777', '#0284c7', '#65a30d', '#7c3aed', '#dc2626'],
  MARKER: '#0f172a',

  ROW: { nav: 24, title: 36, help: 22, header: 38, field: 28, section: 30, spacer: 10, hint: 34, collapsed: 4 },

  WIDTH: { date: 96, datetime: 132, number: 90, integer: 80, id: 76, enum: 150, bool: 70, text: 170, long: 300 },

  /** Displayed value → status kind. Values are the Portuguese enums of Tabs.ENUMS and Hoje. */
  STATUS_VALUES: {
    // weeks
    'No caminho': 'ok', 'Atenção': 'attention', 'Fora do esperado': 'off', 'Dados insuficientes': 'insufficient',
    // recommendations
    MANTER: 'ok', 'DADOS INSUFICIENTES': 'insufficient', 'REVISAR OBJETIVO/FASE': 'info',
    'REVISAR ENERGIA': 'attention', 'REVISAR MACROS': 'attention', 'REVISAR TREINO': 'attention', 'REVISAR RECUPERAÇÃO': 'attention',
    // day and session states
    Completo: 'ok', 'Completo — cálculo parcial': 'attention', Parcial: 'attention', 'Sem registro': 'insufficient',
    'Não informado': 'insufficient', 'Concluído': 'ok',
    // versions
    Vigente: 'ok', Encerrado: 'insufficient', Encerrada: 'insufficient', Planejado: 'info', Planejada: 'info',
    // food
    Calculado: 'ok', Estimado: 'attention', 'Sem cálculo': 'off', 'Rótulo confirmado': 'ok', 'TACO/fonte confiável': 'ok',
    Estimativa: 'attention', Pendente: 'attention',
    // Hoje · Meta × realizado
    'Dentro da meta': 'ok', 'Abaixo da meta': 'attention', 'Acima da meta': 'attention', 'Sem meta': 'insufficient',
    // audit
    Erro: 'off', Aviso: 'attention', Info: 'info',
  },

  /** Status kind of a displayed value, or null. */
  kindOf(text) {
    if (text === null || text === undefined) return null;
    return Style.STATUS_VALUES[String(text).trim()] || null;
  },

  /* Range helpers --------------------------------------------------------------------------- */

  base_(range, size) {
    return range.setFontFamily(Style.FONT).setFontSize(size || Style.SIZE.body).setVerticalAlignment('middle');
  },

  title(range) {
    return Style.base_(range, Style.SIZE.title).setFontWeight('bold').setFontColor(Style.C.text);
  },

  help(range) {
    return Style.base_(range, Style.SIZE.body).setFontWeight('normal').setFontColor(Style.C.textMuted);
  },

  small(range) {
    return Style.base_(range, Style.SIZE.small).setFontColor(Style.C.textMuted);
  },

  section(range) {
    Style.base_(range, Style.SIZE.section).setFontWeight('bold').setFontColor(Style.C.primaryText).setBackground(Style.C.primarySoft);
    return range.setBorder(null, null, true, null, null, null, Style.C.primaryBorder, 'SOLID');
  },

  /** White card with a light outer border. */
  card(range) {
    range.setBackground(Style.C.surface);
    return range.setBorder(true, true, true, true, null, null, Style.C.border, 'SOLID');
  },

  label(range) {
    return Style.base_(range, Style.SIZE.body).setFontColor(Style.C.textMuted).setFontWeight('normal');
  },

  /** Editable cell: light yellow fill, dark border on every side. */
  input(range) {
    Style.base_(range, Style.SIZE.body).setBackground(Style.C.input).setFontColor(Style.C.text).setFontStyle('normal');
    return range.setBorder(true, true, true, true, true, true, Style.C.inputBorder, 'SOLID');
  },

  /** Calculated cell: grey fill and grey text (not italic). */
  calc(range) {
    return Style.base_(range, Style.SIZE.body).setBackground(Style.C.calc).setFontColor(Style.C.calcText).setFontStyle('normal');
  },

  chip(range, kind) {
    const s = Style.STATUS[kind] || Style.STATUS.insufficient;
    return Style.base_(range, Style.SIZE.body).setBackground(s.bg).setFontColor(s.fg).setFontWeight('bold').setHorizontalAlignment('center');
  },

  header(range, layer) {
    const l = Style.LAYER[layer] || Style.LAYER[3];
    Style.base_(range, Style.SIZE.body).setBackground(l.headerBg).setFontColor(l.headerText).setFontWeight('bold')
      .setHorizontalAlignment('center').setWrap(true);
    return range.setBorder(null, null, true, null, null, null, l.headerLine, 'SOLID_MEDIUM');
  },

  link(range) {
    return Style.base_(range, Style.SIZE.body).setFontColor(Style.C.primary).setFontWeight('bold');
  },

  band(range) {
    return Style.base_(range, Style.SIZE.band).setBackground(Style.C.band).setFontColor(Style.C.bandText).setFontWeight('bold');
  },

  bandSub(range) {
    return Style.base_(range, Style.SIZE.body).setBackground(Style.C.band).setFontColor(Style.C.bandSub).setFontWeight('normal');
  },

  /* Column rules ---------------------------------------------------------------------------- */

  LONG_TEXT: /(notes|note|reason|reasons|description|guidance|signals|finding|before|after|change|result|expectation|suggestion|recommendationReason|sufficiency|howToMeasure|reference|sourceLink|alternative|lastWork|photo)/i,

  /**
   * Number format of a column spec: dates dd/mm/yyyy, datetimes with time, integers '0',
   * kcal-like and counts '#,##0', grams '0', %/week '0.00', fractions (adherence, tolerance) '0%',
   * the rest one decimal. Text and ids: null (untouched).
   */
  numberFormat(col) {
    const k = col.key;
    if (col.type === 'date') return 'dd/mm/yyyy';
    if (col.type === 'datetime') return 'dd/mm/yyyy hh:mm';
    if (col.type === 'integer') return /steps/i.test(k) ? '#,##0' : '0';
    if (col.type !== 'number') return null;
    if (/Adherence$|Tolerance$/.test(k)) return '0%';
    if (/Pct$|Pct|activityFactor/.test(k)) return '0.00';
    if (/kcal|Kcal|tdee|bmr|steps|Volume|volume|equivQty/.test(k)) return '#,##0';
    if (/^(protein|carbs|fat|fiber)(Avg|Alt|Min|Max)?$|^rir/.test(k)) return '0';
    return '0.0';
  },

  /** Default width in px (col.width wins). */
  width(col) {
    if (col.width) return col.width;
    if (col.type === 'text' && Style.LONG_TEXT.test(col.key)) return Style.WIDTH.long;
    return Style.WIDTH[col.type] || Style.WIDTH.text;
  },

  /** Horizontal alignment of a column's data cells. */
  align(col) {
    if (col.type === 'date' || col.type === 'datetime' || col.type === 'id' || col.type === 'enum' || col.type === 'bool') return 'center';
    if (col.type === 'number' || col.type === 'integer') return 'right';
    return 'left';
  },

  /* Conditional formats --------------------------------------------------------------------- */

  /** Rules colouring each of `values` that has a status kind (text equal to the value). */
  statusRules(ranges, values) {
    const list = Array.isArray(ranges) ? ranges : [ranges];
    const out = [];
    (values || []).forEach((v) => {
      const kind = Style.kindOf(v);
      if (!kind) return;
      const s = Style.STATUS[kind];
      out.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(v).setBackground(s.bg).setFontColor(s.fg).setBold(true).setRanges(list).build());
    });
    return out;
  },

  /** Hides (font = background) numeric dates before 01/01/2000 in a one-column range (§4.4). */
  technicalDateRule(range, background) {
    const a1 = range.getA1Notation().split(':')[0];
    return SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(`=AND(ISNUMBER(${a1}),${a1}<DATE(2000,1,1))`)
      .setFontColor(background || Style.C.surface)
      .setRanges([range])
      .build();
  },

  /* Tables ---------------------------------------------------------------------------------- */

  /** A1 of column n (1-based). */
  col(n) {
    let s = '';
    let x = n;
    while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); }
    return s;
  },

  /**
   * Styles a data tab from its spec: title (row 2), help (row 3), header (row 5) band of the
   * layer, frozen header, widths, number formats, alignment, input/calc fills of the data rows
   * and conditional formats (status chips on enum columns, hidden technical dates). Columns are
   * found by header text (Tabs.headerMap); unknown columns keep their data and get only the
   * header band. Values are never written here.
   * @param {Sheet} sheet
   * @param {Object} spec Tabs.SPEC entry (kind 'table')
   * @param {{inputFill?: boolean, extraRules?: Object[]}} opts inputFill paints input columns
   *   yellow (layer 1 and Config); extraRules are appended to the sheet's conditional formats.
   * @returns {{rules: number}}
   */
  table(sheet, spec, opts) {
    const o = opts || {};
    const map = Tabs.headerMap(spec.id);
    const lastCol = Math.max(sheet.getLastColumn(), 1);
    const maxRows = sheet.getMaxRows();
    const first = spec.firstDataRow;
    const n = maxRows - first + 1;
    Style.title(sheet.getRange(Tabs.TITLE_ROW, 1));
    Style.help(sheet.getRange(Tabs.HELP_ROW, 1));
    sheet.setRowHeight(Tabs.TITLE_ROW, Style.ROW.title);
    sheet.setRowHeight(Tabs.HELP_ROW, Style.ROW.help);
    Style.header(sheet.getRange(spec.headerRow, 1, 1, lastCol), spec.layer);
    sheet.setRowHeight(spec.headerRow, Style.ROW.header);
    sheet.setFrozenRows(spec.headerRow);

    const groups = {};
    const add = (key, a1) => { (groups[key] = groups[key] || []).push(a1); };
    const rules = [];
    spec.columns.forEach((c) => {
      const j = map[c.key];
      if (!j) return;
      sheet.setColumnWidth(j, Style.width(c));
      const letter = Style.col(j);
      const a1 = `${letter}${first}:${letter}${maxRows}`;
      add(`font|${Style.FONT}`, a1);
      const nf = Style.numberFormat(c);
      if (nf) add(`nf|${nf}`, a1);
      add(`align|${Style.align(c)}`, a1);
      const fill = c.role === 'calc' ? 'calc' : (o.inputFill && c.role === 'input' ? 'input' : 'plain');
      add(`fill|${fill}`, a1);
      if (c.type === 'date') {
        const bg = fill === 'calc' ? Style.C.calc : fill === 'input' ? Style.C.input : Style.C.surface;
        rules.push(Style.technicalDateRule(sheet.getRange(first, j, n, 1), bg));
      }
      if (c.type === 'enum' && c.enum) Style.statusRules(sheet.getRange(first, j, n, 1), c.enum).forEach((r) => rules.push(r));
    });
    Object.keys(groups).sort().forEach((key) => {
      const [what, value] = key.split('|');
      const list = sheet.getRangeList(groups[key]);
      if (what === 'font') list.setFontFamily(value).setFontSize(Style.SIZE.body).setVerticalAlignment('middle');
      else if (what === 'nf') list.setNumberFormat(value);
      else if (what === 'align') list.setHorizontalAlignment(value);
      else if (value === 'calc') list.setBackground(Style.C.calc).setFontColor(Style.C.calcText).setFontStyle('normal');
      else if (value === 'input') list.setBackground(Style.C.input).setFontColor(Style.C.text).setFontStyle('normal');
      else list.setBackground(null).setFontColor(Style.C.text).setFontStyle('normal');
    });
    (o.extraRules || []).forEach((r) => rules.push(r));
    sheet.setConditionalFormatRules(rules);
    return { rules: rules.length };
  },

  /* Canvas ---------------------------------------------------------------------------------- */

  /**
   * A grid written in one batch (values and per-cell formats), for script-rendered views.
   *   const cv = Style.canvas(5);
   *   const r = cv.row(Style.ROW.field);            // new row, returns its 1-based index
   *   cv.put(r, 1, 'Peso', {fg: Style.C.textMuted}); // format keys: bg fg bold size italic align nf wrap
   *   cv.merge(r, 3, 5); cv.box(r1, r2, 1, 5);
   *   cv.flush(sheet)                                 // values, formats, merges, borders, heights
   */
  canvas(cols) {
    const rows = [];
    const merges = [];
    const boxes = [];
    const lines = [];
    const cv = {
      cols,
      rows,
      row(height, fill) {
        const cells = [];
        for (let c = 0; c < cols; c++) cells.push({ v: '', f: { bg: fill || Style.C.canvas } });
        rows.push({ h: height || Style.ROW.field, cells });
        return rows.length;
      },
      put(r, c, value, fmt) {
        const cell = rows[r - 1].cells[c - 1];
        cell.v = value === null || value === undefined ? '' : value;
        if (fmt) Object.assign(cell.f, fmt);
        return cv;
      },
      fmt(r, c1, c2, fmt) {
        for (let c = c1; c <= c2; c++) Object.assign(rows[r - 1].cells[c - 1].f, fmt);
        return cv;
      },
      merge(r, c1, c2) {
        if (c2 > c1) merges.push([r, c1, c2]);
        return cv;
      },
      /** Outer border around rows r1..r2, columns c1..c2. */
      box(r1, r2, c1, c2, color) {
        boxes.push([r1, r2, c1, c2, color || Style.C.border]);
        return cv;
      },
      /** Bottom border under one row. */
      line(r, c1, c2, color, style) {
        lines.push([r, c1, c2, color || Style.C.border, style || 'SOLID']);
        return cv;
      },
      value(r, c) {
        return rows[r - 1] ? rows[r - 1].cells[c - 1].v : '';
      },
      flush(sheet) {
        if (!rows.length) return;
        const range = sheet.getRange(1, 1, rows.length, cols);
        const grid = (fn) => rows.map((row) => row.cells.map(fn));
        range.setValues(grid((c) => c.v));
        range.setBackgrounds(grid((c) => c.f.bg || null));
        range.setFontColors(grid((c) => c.f.fg || Style.C.text));
        range.setFontWeights(grid((c) => (c.f.bold ? 'bold' : 'normal')));
        range.setFontSizes(grid((c) => c.f.size || Style.SIZE.body));
        range.setFontFamilies(grid(() => Style.FONT));
        range.setFontStyles(grid((c) => (c.f.italic ? 'italic' : 'normal')));
        range.setHorizontalAlignments(grid((c) => c.f.align || 'left'));
        range.setVerticalAlignments(grid(() => 'middle'));
        range.setNumberFormats(grid((c) => c.f.nf || 'General'));
        range.setWraps(grid((c) => Boolean(c.f.wrap)));
        merges.forEach(([r, c1, c2]) => sheet.getRange(r, c1, 1, c2 - c1 + 1).merge());
        boxes.forEach(([r1, r2, c1, c2, color]) => sheet.getRange(r1, c1, r2 - r1 + 1, c2 - c1 + 1).setBorder(true, true, true, true, null, null, color, 'SOLID'));
        lines.forEach(([r, c1, c2, color, style]) => sheet.getRange(r, c1, 1, c2 - c1 + 1).setBorder(null, null, true, null, null, null, color, style));
        let i = 0;
        while (i < rows.length) {
          let j = i;
          while (j + 1 < rows.length && rows[j + 1].h === rows[i].h) j++;
          sheet.setRowHeights(i + 1, j - i + 1, rows[i].h);
          i = j + 1;
        }
      },
    };
    return cv;
  },
};
