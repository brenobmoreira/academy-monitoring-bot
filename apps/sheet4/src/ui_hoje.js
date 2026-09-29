/**
 * Hoje (spec §11): the phone-first input screen. One column of cards, label in A and value in B
 * (only the training and "Meta × realizado" tables are wider). This file owns the cell map
 * (Hoje.layout(), pure data that Setup/Style draw) and the reads/writes of those cells.
 *
 * Cell map (rows are fixed; row 1 is kept for Setup's navigation links, 2 title, 3 help):
 *
 *   Header        B4 Ação rápida (Hoje.QUICK_CELL, list = Actions.quickList())
 *                 B5 Data (Hoje.DATE_CELL)
 *                 B6 Fase — "O001 Recomposição corporal · M001 · F002" (script)
 *                 B7 Estado do dia (script)
 *   diary  (A9)   B10 Peso kg · B11 Cintura cm · B12 Sono h · B13 Passos · B14 Cardio min ·
 *                 B15 Atividade min · B16 Atividade · B17 Fome 1–5 · B18 Cansaço 1–5 ·
 *                 B19 Dor 0–10 · B20 Registro alimentar · B21 Observações
 *   food   (A23)  B24 Refeição · B25 Alimento · B26 Quantidade · B27 Unidade · B28 Medição ·
 *                 B29 Favorita · B30 Porções · B31 Copiar da data · B32 Refeição a copiar ·
 *                 B33 Sem cálculo (descrição) · B34 Observação         (hint on A35)
 *   training (A37) B38 Sessão · B39 Fase da ficha · B40 Estado da sessão (script) ·
 *                 B41 Ficha (script)                                      (hint on A42)
 *                 table header row 43, rows 44–55 (12), columns A–M:
 *                 A Exercício | B Aquec. kg | C Aquec. reps | D Feeder kg | E Feeder reps |
 *                 F Work 1 kg | G Work 1 reps | H RIR work 1 | I Work 2 kg | J Work 2 reps |
 *                 K RIR work 2 | L Dor 0–10 | M Observação                (hint on A56)
 *   status (A58)  Meta × realizado do dia: header row 59 (A Indicador | B Realizado | C Meta |
 *                 D Comparação | E Status), rows 60–65 kcal, Proteína g, Carboidrato g,
 *                 Gordura g, Fibra g, Passos; B66 Cobertura (script)
 *
 * Keys: diary fields are Diário column keys (Diary.FIELDS); food keys are meal, food, qty, unit,
 * measure, favorite, portions, copyFrom, copyMeal, noCalcText, note; training row keys are the
 * Registro de treino keys (exercise, warmupKg, warmupReps, feederKg, feederReps, work1Kg,
 * work1Reps, rir1, work2Kg, work2Reps, rir2, pain, note); training header keys are session,
 * phase, state, plan.
 *
 * API for the Food and Workout modules:
 *   Hoje.read()            → {date, quick, diary: {...}, food: {...}, training: {session, phase,
 *                             state, plan, rows: [{_index, exercise, …}]}} (empty rows left out;
 *                             _index is the 0-based table row)
 *   Hoje.write(section, v) → section 'diary' | 'food' | 'training' | 'header'; v is {key: value}
 *                             (only given keys change; null empties the cell). For 'training', v
 *                             may be an array of rows (replaces the whole table) or
 *                             {session?, phase?, state?, plan?, rows?}.
 *   Hoje.clear(section)    → empties the section's input cells (training: header inputs + table)
 *
 * Values read: empty → null; numbers typed as text with a comma ("67,5") become numbers; the
 * clear convention "-" or "limpar" in a diary input cell reads as Hoje.CLEAR (Salvar dia then
 * erases the stored value; an empty cell never erases). Screen writes are not recorded in the Log:
 * Hoje is a view, undo restores the data tabs.
 */
const Hoje = {
  TAB: 'today',
  QUICK_CELL: 'B4',
  DATE_CELL: 'B5',
  PHASE_CELL: 'B6',
  STATE_CELL: 'B7',
  /** Value read from an input cell holding one of CLEAR_TOKENS. */
  CLEAR: '__limpar__',
  CLEAR_TOKENS: ['-', '—', 'limpar'],
  TRAINING_ROWS: 12,
  LAST_COL: 13, // M
  LAST_ROW: 66,

  /** Meals offered on the food card (generic list, not client data). */
  MEALS: ['Café da manhã', 'Lanche', 'Almoço', 'Jantar', 'Pré-treino', 'Pós-treino', 'Ceia'],
  UNITS: ['g', 'mg', 'kg', 'ml', 'l', 'un', 'fatia', 'porção'],
  MEASURE_KINDS: ['Pesada', 'Rótulo', 'Estimada'],
  PLAN_PHASES: ['Adaptação', 'Regular'],

  layout_: null,

  /**
   * The screen as data. Validation shapes:
   *   {type: 'number', min?, max?, integer?} · {type: 'list', values: [...]} ·
   *   {type: 'list', source: 'quickActions' | 'config:<key>' | 'tab:<tabId>.<columnKey>'} ·
   *   {type: 'date'}. Number/date validations are warnings (allowInvalid) so the clear tokens fit.
   * @returns {{tab, quickCell, dateCell, columns: Object<string, number>, texts: Object<string,string>,
   *   sections: Object[]}}
   */
  layout() {
    if (Hoje.layout_) return Hoje.layout_;
    const num = (min, max, integer) => ({ type: 'number', min, max, integer: !!integer, allowInvalid: true });
    const field = (key, label, row, type, extra) => Object.assign({
      key, label, labelCell: `A${row}`, cell: `B${row}`, type, input: true,
    }, extra || {});
    const calc = (key, label, row) => field(key, label, row, 'text', { input: false });
    const fromDiary = (key, row) => {
      const f = Diary.FIELDS[key];
      const validation = f.type === 'enum' ? { type: 'list', values: f.enum }
        : f.type === 'text' ? null : num(f.min, f.max, f.type === 'integer');
      return field(key, f.label, row, f.type === 'integer' ? 'number' : f.type, { validation });
    };
    const diaryKeys = Object.keys(Diary.FIELDS);
    const trainingColumns = [
      ['exercise', 'Exercício', 'text', { type: 'list', source: 'tab:exercises.name' }],
      ['warmupKg', 'Aquec. kg', 'number', num(0, 1000)],
      ['warmupReps', 'Aquec. reps', 'number', num(0, 100, true)],
      ['feederKg', 'Feeder kg', 'number', num(0, 1000)],
      ['feederReps', 'Feeder reps', 'number', num(0, 100, true)],
      ['work1Kg', 'Work 1 kg', 'number', num(0, 1000)],
      ['work1Reps', 'Work 1 reps', 'number', num(0, 100, true)],
      ['rir1', 'RIR work 1', 'number', num(0, 10)],
      ['work2Kg', 'Work 2 kg', 'number', num(0, 1000)],
      ['work2Reps', 'Work 2 reps', 'number', num(0, 100, true)],
      ['rir2', 'RIR work 2', 'number', num(0, 10)],
      ['pain', 'Dor 0–10', 'number', num(0, 10, true)],
      ['note', 'Observação', 'text', null],
    ].map(([key, header, type, validation], i) => ({ key, header, type, validation, col: String.fromCharCode(65 + i) }));
    const statusRows = [
      ['kcal', 'kcal'], ['protein', 'Proteína g'], ['carbs', 'Carboidrato g'],
      ['fat', 'Gordura g'], ['fiber', 'Fibra g'], ['steps', 'Passos'],
    ];
    const l = {
      tab: Hoje.TAB,
      quickCell: Hoje.QUICK_CELL,
      dateCell: Hoje.DATE_CELL,
      lastRow: Hoje.LAST_ROW,
      lastCol: Hoje.LAST_COL,
      /** Suggested widths in pixels: A labels, B inputs, the rest for the tables. */
      columns: { A: 150, B: 190, C: 80, D: 150, E: 150, F: 80, G: 80, H: 80, I: 80, J: 80, K: 80, L: 80, M: 200 },
      navRow: 1,
      sections: [
        {
          id: 'header', title: null,
          fields: [
            field('quick', 'Ação rápida', 4, 'text', { validation: { type: 'list', source: 'quickActions' }, default: Actions.QUICK_EMPTY }),
            field('date', 'Data', 5, 'date', { validation: { type: 'date', allowInvalid: false } }),
            calc('phase', 'Fase', 6),
            calc('dayState', 'Estado do dia', 7),
          ],
        },
        {
          id: 'diary', title: 'Medidas do dia', titleCell: 'A9',
          fields: diaryKeys.map((k, i) => fromDiary(k, 10 + i)),
        },
        {
          id: 'food', title: 'Alimentação', titleCell: 'A23',
          fields: [
            field('meal', 'Refeição', 24, 'text', { validation: { type: 'list', values: Hoje.MEALS } }),
            field('food', 'Alimento', 25, 'text', { validation: { type: 'list', source: 'tab:foods.name' } }),
            field('qty', 'Quantidade', 26, 'number', { validation: num(0, 100000) }),
            field('unit', 'Unidade', 27, 'text', { validation: { type: 'list', values: Hoje.UNITS } }),
            field('measure', 'Medição', 28, 'text', { validation: { type: 'list', values: Hoje.MEASURE_KINDS } }),
            field('favorite', 'Favorita', 29, 'text', { validation: { type: 'list', source: 'tab:favorites.name' } }),
            field('portions', 'Porções', 30, 'number', { validation: num(0.01, 100) }),
            field('copyFrom', 'Copiar da data', 31, 'date', { validation: { type: 'date', allowInvalid: true } }),
            field('copyMeal', 'Refeição a copiar', 32, 'text', { validation: { type: 'list', values: ['Todas'].concat(Hoje.MEALS) } }),
            field('noCalcText', 'Sem cálculo (descrição)', 33, 'text', { validation: null }),
            field('note', 'Observação', 34, 'text', { validation: null }),
          ],
          hints: { A35: 'Escolha a unidade: 2 un de ovo ≠ 2 g. Conversões caseiras são estimadas.' },
        },
        {
          id: 'training', title: 'Treino', titleCell: 'A37',
          fields: [
            field('session', 'Sessão', 38, 'text', { validation: { type: 'list', source: 'config:routine.sessionRotation' } }),
            field('phase', 'Fase da ficha', 39, 'text', { validation: { type: 'list', values: Hoje.PLAN_PHASES } }),
            calc('state', 'Estado da sessão', 40),
            calc('plan', 'Ficha', 41),
          ],
          hints: {
            A42: 'Carga: siga o critério do cadastro de Exercícios. Aquecimento e feeder são preparação; só work sets contam.',
            A56: 'RIR = repetições em reserva. Informe para cada work set; 0 é um registro válido.',
          },
          table: { headerRow: 43, firstRow: 44, rows: Hoje.TRAINING_ROWS, columns: trainingColumns },
        },
        {
          id: 'status', title: 'Meta × realizado do dia', titleCell: 'A58', script: true,
          fields: [calc('coverage', 'Cobertura', 66)],
          table: {
            headerRow: 59, firstRow: 60, rows: statusRows.length,
            columns: [
              { key: 'label', header: 'Indicador', col: 'A' },
              { key: 'done', header: 'Realizado', col: 'B' },
              { key: 'goal', header: 'Meta', col: 'C' },
              { key: 'comparison', header: 'Comparação', col: 'D' },
              { key: 'status', header: 'Status', col: 'E' },
            ],
            indicators: statusRows.map(([key, label], i) => ({ key, label, row: 60 + i })),
          },
        },
      ],
    };
    Hoje.layout_ = l;
    return l;
  },

  section(id) {
    const s = Hoje.layout().sections.find((x) => x.id === id);
    if (!s) throw new Error(`Seção de Hoje desconhecida: ${id}`);
    return s;
  },

  /** Static texts {A1: text}: titles, labels, table headers, hints, indicator names. */
  texts() {
    const out = {};
    const spec = Tabs.get(Hoje.TAB);
    out[`A${Tabs.TITLE_ROW}`] = spec.title;
    out[`A${Tabs.HELP_ROW}`] = `${spec.help} Para apagar um valor salvo, digite "-" ou "limpar" e salve.`;
    Hoje.layout().sections.forEach((s) => {
      if (s.titleCell) out[s.titleCell] = s.title;
      s.fields.forEach((f) => { out[f.labelCell] = f.label; });
      Object.assign(out, s.hints || {});
      if (s.table) {
        s.table.columns.forEach((c) => { out[`${c.col}${s.table.headerRow}`] = c.header; });
        (s.table.indicators || []).forEach((i) => { out[`A${i.row}`] = i.label; });
      }
    });
    return out;
  },

  /** The Hoje sheet, created bare (texts only, no styling) when missing. */
  ensure() {
    const existing = Tabs.findSheet(Hoje.TAB);
    if (existing) return existing;
    const sheet = Tabs.ensure(Hoje.TAB);
    const texts = Hoje.texts();
    Object.keys(texts).forEach((a1) => sheet.getRange(a1).setValue(texts[a1]));
    sheet.getRange(Hoje.QUICK_CELL).setValue(Actions.QUICK_EMPTY);
    return sheet;
  },

  sheet_() {
    return Tabs.sheet(Hoje.TAB);
  },

  /** Writes {A1: value} directly (not logged; see the file header). */
  setCells_(cells) {
    const sheet = Hoje.sheet_();
    Object.keys(cells).forEach((a1) => {
      const v = cells[a1];
      sheet.getRange(a1).setValue(v === null || v === undefined ? '' : v);
    });
  },

  /** A1 → [row, col] (1-based). */
  rc_(a1) {
    const m = /^([A-Z]+)(\d+)$/.exec(a1);
    let col = 0;
    for (let i = 0; i < m[1].length; i++) col = col * 26 + (m[1].charCodeAt(i) - 64);
    return [Number(m[2]), col];
  },

  /** Cell value → code value for a field/column type. */
  value_(type, v, allowClear) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) return null;
      if (allowClear && Hoje.CLEAR_TOKENS.indexOf(s.toLowerCase()) >= 0) return Hoje.CLEAR;
      if (type === 'number') {
        const n = Number(s.replace(',', '.'));
        return isFinite(n) ? n : s;
      }
      if (type === 'date') return Dates.parse(s) || s;
      return s;
    }
    if (type === 'date') return Dates.parse(v) || v;
    return v;
  },

  /** Reads the whole screen (see the file header). */
  read() {
    const grid = Hoje.sheet_().getRange(1, 1, Hoje.LAST_ROW, Hoje.LAST_COL).getValues();
    const at = (a1) => { const [r, c] = Hoje.rc_(a1); return grid[r - 1][c - 1]; };
    const fields = (id, allowClear) => {
      const out = {};
      Hoje.section(id).fields.forEach((f) => { out[f.key] = Hoje.value_(f.type, at(f.cell), allowClear && f.input); });
      return out;
    };
    const header = fields('header', false);
    const training = fields('training', false);
    const t = Hoje.section('training').table;
    training.rows = [];
    for (let i = 0; i < t.rows; i++) {
      const line = grid[t.firstRow + i - 1];
      const row = { _index: i };
      let any = false;
      t.columns.forEach((c) => {
        const v = Hoje.value_(c.type, line[Hoje.rc_(`${c.col}1`)[1] - 1], false);
        row[c.key] = v;
        if (v !== null) any = true;
      });
      if (any) training.rows.push(row);
    }
    return {
      date: header.date,
      quick: header.quick,
      diary: fields('diary', true),
      food: fields('food', false),
      training,
    };
  },

  /** The screen date: the date cell, or today when empty. Throws when the cell holds garbage. */
  date() {
    const raw = Hoje.sheet_().getRange(Hoje.DATE_CELL).getValue();
    if (raw === '' || raw === null || raw === undefined) return Dates.today();
    const d = Dates.parse(raw);
    if (!d) throw new Error(`Data inválida em Hoje (${Hoje.DATE_CELL}): ${JSON.stringify(raw instanceof Date ? String(raw) : raw)}. Use dd/mm/aaaa.`);
    return d;
  },

  /** Cells of the section's fields: {key: field}. */
  fieldMap_(id) {
    const out = {};
    Hoje.section(id).fields.forEach((f) => { out[f.key] = f; });
    return out;
  },

  /** Writes values to a section (see the file header). */
  write(section, values) {
    if (section === 'status') throw new Error('Use Hoje.renderDayStatus para a seção Meta × realizado.');
    const map = Hoje.fieldMap_(section);
    const cells = {};
    let rows = null;
    let obj = values || {};
    if (section === 'training' && Array.isArray(values)) { rows = values; obj = {}; }
    else if (section === 'training' && Array.isArray(obj.rows)) rows = obj.rows;
    Object.keys(obj).forEach((k) => {
      if (k === 'rows' && section === 'training') return;
      if (!map[k]) throw new Error(`Campo desconhecido em Hoje/${section}: ${k}`);
      cells[map[k].cell] = Hoje.cell_(obj[k]);
    });
    if (rows) Object.assign(cells, Hoje.trainingCells_(rows));
    Hoje.setCells_(cells);
  },

  cell_(v) {
    if (v === null || v === undefined || v === Hoje.CLEAR) return '';
    return v;
  },

  /** Cells for the whole training table: given rows from the top, the rest emptied. */
  trainingCells_(rows) {
    const t = Hoje.section('training').table;
    if (rows.length > t.rows) throw new Error(`O treino de Hoje comporta ${t.rows} exercícios; recebidos ${rows.length}.`);
    const keys = t.columns.map((c) => c.key);
    const cells = {};
    rows.forEach((r) => Object.keys(r).forEach((k) => {
      if (k !== '_index' && keys.indexOf(k) < 0) throw new Error(`Coluna desconhecida no treino de Hoje: ${k}`);
    }));
    for (let i = 0; i < t.rows; i++) {
      const r = rows[i] || {};
      t.columns.forEach((c) => { cells[`${c.col}${t.firstRow + i}`] = Hoje.cell_(r[c.key]); });
    }
    return cells;
  },

  /** Empties a section's input cells (training: session/phase and the whole table). */
  clear(section) {
    if (section === 'header' || section === 'status') throw new Error(`A seção ${section} não é limpa por Hoje.clear.`);
    const cells = {};
    Hoje.section(section).fields.forEach((f) => { if (f.input) cells[f.cell] = ''; });
    if (section === 'training') Object.assign(cells, Hoje.trainingCells_([]));
    Hoje.setCells_(cells);
  },

  /** "O001 Recomposição corporal · M001 · F002" for the date. */
  phaseLine(date) {
    const o = Objectives.on(date);
    const g = Goals.on(date);
    const p = Plans.on(date);
    if (!o && !g && !p) return 'Sem objetivo, meta ou ficha para esta data';
    const obj = o ? `${o.id}${o.fields.name ? ` ${o.fields.name}` : ''}` : 'Sem objetivo';
    return `${obj} · ${g ? g.id : 'sem meta'} · ${p ? p.id : 'sem ficha'}`;
  },

  /** Writes the date, the phase line and the day state. */
  renderHeader(date) {
    const d = Dates.require(date, 'Data');
    Hoje.setCells_({ [Hoje.DATE_CELL]: d, [Hoje.PHASE_CELL]: Hoje.phaseLine(d), [Hoje.STATE_CELL]: Diary.dayState(d) });
  },

  round_(v) {
    return Math.round(v * 10) / 10;
  },

  fmt_(v) {
    return String(Math.round(v)).replace('-', '−');
  },

  /**
   * Compares one indicator. kind: 'range' (inside [lo, hi]) or 'min' (≥ lo is inside).
   * @returns {string} Dentro da meta | Abaixo da meta | Acima da meta
   */
  compare_(done, lo, hi) {
    if (done < lo) return 'Abaixo da meta';
    if (hi !== null && done > hi) return 'Acima da meta';
    return 'Dentro da meta';
  },

  /**
   * Values of the Meta × realizado block for a date (pure, no write):
   * {state, coverage, rows: [{key, label, done, goal, comparison, status}]}.
   * Food rows: Sem registro → "Sem registro"; realizado empty → "Não informado"; no goal → "Sem meta";
   * Parcial → "Parcial" (never compared); Completo — cálculo parcial → that text; Completo → the
   * comparison against the goal in force on the date (kcal ± Tolerância kcal, protein within
   * [mín, máx] or ± kcal tolerance, fat ± Tolerância gordura, carbs ± kcal tolerance, fiber ≥ goal
   * − kcal tolerance). Steps: ≥ Passos/dia is inside.
   */
  dayStatus(date) {
    const d = Dates.require(date, 'Data');
    const row = Days.get(d);
    const state = Diary.dayState(row);
    const g = Goals.on(d);
    const gf = g ? g.fields : {};
    const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    const kcalTol = num(gf.kcalTolerance) !== null ? gf.kcalTolerance : Config.get('analysis.kcalTolerance');
    const fatTol = num(gf.fatTolerance) !== null ? gf.fatTolerance : Config.get('analysis.fatTolerance');
    const band = (goal, tol) => [goal * (1 - tol), goal * (1 + tol)];
    const specs = {
      kcal: { goal: num(gf.kcal), range: (x) => band(x, kcalTol) },
      protein: {
        goal: num(gf.protein),
        range: (x) => (num(gf.proteinMin) !== null && num(gf.proteinMax) !== null ? [gf.proteinMin, gf.proteinMax] : band(x, kcalTol)),
      },
      carbs: { goal: num(gf.carbs), range: (x) => band(x, kcalTol) },
      fat: { goal: num(gf.fat), range: (x) => band(x, fatTol) },
      fiber: { goal: num(gf.fiber), range: (x) => [x * (1 - kcalTol), null] },
      steps: { goal: num(gf.stepsPerDay), range: (x) => [x, null], notFood: true },
    };
    const rows = Hoje.section('status').table.indicators.map((ind) => {
      const s = specs[ind.key];
      const done = row ? num(row[ind.key]) : null;
      const goal = s.goal;
      let status;
      if (!s.notFood && state === Diary.STATES.NONE) status = 'Sem registro';
      else if (done === null) status = 'Não informado';
      else if (goal === null) status = 'Sem meta';
      else if (!s.notFood && state === Diary.STATES.PARTIAL) status = 'Parcial';
      else if (!s.notFood && state === Diary.STATES.COMPLETE_PARTIAL_CALC) status = Diary.STATES.COMPLETE_PARTIAL_CALC;
      else { const [lo, hi] = s.range(goal); status = Hoje.compare_(done, lo, hi); }
      let comparison = '';
      if (done !== null) {
        comparison = goal === null ? Hoje.fmt_(done) : `${Hoje.fmt_(done)} / ${Hoje.fmt_(goal)}`;
        if (goal) {
          const pct = Math.round((done - goal) / goal * 100);
          comparison += ` (${pct > 0 ? '+' : pct < 0 ? '−' : ''}${Math.abs(pct)}%)`;
        }
        if (ind.key === 'protein' && num(gf.proteinMin) !== null && num(gf.proteinMax) !== null) {
          comparison += ` · faixa ${Hoje.fmt_(gf.proteinMin)}–${Hoje.fmt_(gf.proteinMax)}`;
        }
      }
      return { key: ind.key, label: ind.label, row: ind.row, done: done === null ? null : Hoje.round_(done), goal: goal === null ? null : Hoje.round_(goal), comparison, status };
    });
    const parts = [`Registro alimentar: ${(row && row.foodLog) || Diary.FOOD_LOG.NONE}`];
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    if (row && num(row.noCalcItems)) parts.push(plural(row.noCalcItems, 'item sem cálculo', 'itens sem cálculo'));
    if (row && num(row.estimatedItems)) parts.push(plural(row.estimatedItems, 'item estimado', 'itens estimados'));
    if (!g) parts.push('sem meta vigente nesta data');
    else parts.push(`meta ${g.id}`);
    return { state, coverage: parts.join(' · '), rows };
  },

  /** Fills the Meta × realizado block (values, not formulas) and the day state. */
  renderDayStatus(date) {
    const s = Hoje.dayStatus(date);
    const cells = { [Hoje.STATE_CELL]: s.state };
    const cols = Hoje.section('status').table.columns;
    s.rows.forEach((r) => cols.forEach((c) => { cells[`${c.col}${r.row}`] = r[c.key]; }));
    cells[Hoje.fieldMap_('status').coverage.cell] = s.coverage;
    Hoje.setCells_(cells);
    return s;
  },
};
