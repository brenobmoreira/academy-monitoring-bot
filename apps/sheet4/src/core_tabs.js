/**
 * Tab registry (spec §3, §5.2) and generic header-addressed repositories.
 *
 * Tabs.SPEC describes every tab: name, layer (1 person, 2 history, 3 technical), the fixed rows
 * (title 2, help 3, header 5, data from 6) and its columns. Setup, Migrate, Audit, the repos and
 * the API all read it. A column is {key, header, type, role, enum?, width?, aliases?}:
 *   type   'date' | 'datetime' | 'number' | 'integer' | 'text' | 'enum' | 'bool' | 'id'
 *   role   'input' (typed by a person or the Hoje screen) | 'calc' (written by the script) | 'id'
 *   aliases  older header texts accepted when reading (3.0 names before migration renames them)
 *
 * Code addresses columns by header text, never by position or fixed range: the header row is
 * read once per execution (cached; Tabs.invalidate() after changing headers) and rows come back as
 * objects keyed by `key`, with `_row` holding the 1-based sheet row. Empty cells read as null
 * (unknown is not zero); date cells read as local-midnight Dates, technical dates (< 2000) as null.
 * Writes go through ChangeLog.track when an action is running, so Undo can restore them.
 */
const Tabs = {
  TITLE_ROW: 2,
  HELP_ROW: 3,
  HEADER_ROW: 5,
  FIRST_DATA_ROW: 6,

  LAYERS: { PERSON: 1, HISTORY: 2, TECHNICAL: 3 },

  /** Lists validated in the sheet and in code. User-facing values, Portuguese. */
  ENUMS: {
    OBJECTIVE_STATUS: ['Vigente', 'Encerrado', 'Planejado'],
    // Goals (metas) and plans (fichas) are feminine nouns: "meta encerrada", "ficha encerrada".
    VERSION_STATUS_F: ['Vigente', 'Encerrada', 'Planejada'],
    ANALYSIS_TYPES: ['adaptacao', 'recomposicao', 'manutencao', 'deficit', 'ganho_controlado',
      'ganho_agressivo', 'manutencao_pos_cut', 'performance', 'personalizado'],
    FOOD_LOG: ['Não informado', 'Parcial', 'Completo'],
    DAY_STATE: ['Sem registro', 'Parcial', 'Completo', 'Completo — cálculo parcial'],
    FOOD_SOURCE: ['Rótulo confirmado', 'TACO/fonte confiável', 'Estimativa', 'Pendente'],
    FOOD_CALC: ['Calculado', 'Estimado', 'Sem cálculo'],
    SESSION_STATE: ['Parcial', 'Concluído'],
    REVIEW_AREAS: ['Objetivo/fase', 'Metas', 'Ficha', 'Dieta', 'Treino', 'Recuperação', 'Medidas', 'Sistema', 'Outro'],
    REVIEW_STATUS: ['A revisar', 'Planejado', 'Aplicado', 'Descartado'],
    WEEK_STATUS: ['No caminho', 'Atenção', 'Fora do esperado', 'Dados insuficientes'],
    RECOMMENDATIONS: ['MANTER', 'REVISAR ENERGIA', 'REVISAR MACROS', 'REVISAR TREINO', 'REVISAR RECUPERAÇÃO',
      'REVISAR OBJETIVO/FASE', 'DADOS INSUFICIENTES'],
    AUDIT_SEVERITY: ['Erro', 'Aviso', 'Info'],
    LOG_KIND: ['Alteração', 'Inclusão', 'Exclusão', 'Células'],
    SEX: ['M', 'F'],
    YES_NO: ['Sim', 'Não'],
  },

  SPEC: {},

  /** Spec lookup by id; throws for an unknown id (a programming error). */
  get(id) {
    const spec = Tabs.SPEC[id];
    if (!spec) throw new Error(`Unknown tab id: ${id}`);
    return spec;
  },

  ids() {
    return Object.keys(Tabs.SPEC);
  },

  /** Spec whose current or legacy name is `name`, or null. */
  byName(name) {
    const ids = Tabs.ids();
    for (let i = 0; i < ids.length; i++) {
      const s = Tabs.SPEC[ids[i]];
      if (s.name === name || (s.legacyNames || []).indexOf(name) >= 0) return s;
    }
    return null;
  },

  /** Tab ids of one layer, in registry order. */
  layer(n) {
    return Tabs.ids().filter((id) => Tabs.SPEC[id].layer === n);
  },

  columns(id) {
    return Tabs.get(id).columns;
  },

  column(id, key) {
    const col = Tabs.get(id).columns.find((c) => c.key === key);
    if (!col) throw new Error(`Unknown column ${id}.${key}`);
    return col;
  },

  headers(id) {
    return Tabs.columns(id).map((c) => c.header);
  },

  /** The tab's sheet under its 4.0 name, or null. */
  findSheet(id) {
    return SpreadsheetApp.getActive().getSheetByName(Tabs.get(id).name);
  },

  /** The tab's sheet; throws a Portuguese message when it does not exist. */
  sheet(id) {
    const sheet = Tabs.findSheet(id);
    if (!sheet) throw new Error(`Aba "${Tabs.get(id).name}" não encontrada. Rode Projeto → Sistema → Configuração inicial.`);
    return sheet;
  },

  /**
   * Returns the tab's sheet, creating a bare one (title, help and header rows, no styling) when
   * missing. Setup styles it later; used for technical tabs such as Log and Auditoria.
   */
  ensure(id) {
    const spec = Tabs.get(id);
    let sheet = Tabs.findSheet(id);
    if (sheet) return sheet;
    sheet = SpreadsheetApp.getActive().insertSheet(spec.name);
    sheet.getRange(Tabs.TITLE_ROW, 1).setValue(spec.title || spec.name);
    if (spec.help) sheet.getRange(Tabs.HELP_ROW, 1).setValue(spec.help);
    // A new sheet has 26 columns; wider tabs (Semanas, Registro de treino…) need more first.
    if (spec.columns.length > sheet.getMaxColumns()) sheet.insertColumnsAfter(sheet.getMaxColumns(), spec.columns.length - sheet.getMaxColumns());
    if (spec.columns.length) sheet.getRange(spec.headerRow, 1, 1, spec.columns.length).setValues([Tabs.headers(id)]);
    Tabs.invalidate(spec.name);
    return sheet;
  },

  cache_: {},

  /** Forgets cached header positions (all tabs, or one sheet name). */
  invalidate(name) {
    if (name) delete Tabs.cache_[name];
    else Tabs.cache_ = {};
  },

  normalize_(text) {
    return String(text === null || text === undefined ? '' : text).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  },

  /**
   * {key: column} for the columns found on the header row, matched by header text or alias
   * (case- and spacing-insensitive). Also returns `byCol` ({column: header text}) and `lastCol`.
   */
  layout(id) {
    const spec = Tabs.get(id);
    const sheet = Tabs.sheet(id);
    const cached = Tabs.cache_[spec.name];
    if (cached) return cached;
    const lastCol = sheet.getLastColumn();
    const texts = lastCol ? sheet.getRange(spec.headerRow, 1, 1, lastCol).getValues()[0] : [];
    const index = {};
    texts.forEach((h, i) => {
      const n = Tabs.normalize_(h);
      if (n && !(n in index)) index[n] = i + 1;
    });
    const map = {};
    spec.columns.forEach((c) => {
      const names = [c.header].concat(c.aliases || []);
      for (let i = 0; i < names.length; i++) {
        const col = index[Tabs.normalize_(names[i])];
        if (col) { map[c.key] = col; break; }
      }
    });
    const byCol = {};
    texts.forEach((h, i) => { byCol[i + 1] = String(h === null || h === undefined ? '' : h).trim(); });
    const out = { sheet, map, byCol, lastCol: Math.max(lastCol, 0) };
    Tabs.cache_[spec.name] = out;
    return out;
  },

  /** {key: column} only. */
  headerMap(id) {
    return Tabs.layout(id).map;
  },

  /** Keys of the spec with no matching header in the sheet. */
  missingColumns(id) {
    const map = Tabs.headerMap(id);
    return Tabs.columns(id).filter((c) => !map[c.key]).map((c) => c.key);
  },

  /** Cell value → code value for a column spec. */
  fromCell(col, v) {
    if (v === '' || v === null || v === undefined) return null;
    switch (col.type) {
      case 'date': return Dates.parse(v);
      case 'datetime': return v instanceof Date ? v : (Dates.parse(v) || v);
      case 'bool':
        if (v === true || v === 'Sim' || v === 'TRUE') return true;
        if (v === false || v === 'Não' || v === 'FALSE') return false;
        return v;
      default: return v;
    }
  },

  /**
   * Code value → cell value. null/undefined write an empty cell. Dates are written as local
   * midnight and a technical date is refused (spec §4.4). Enum values must be in the list.
   */
  toCell(col, v) {
    if (v === null || v === undefined || v === '') return '';
    switch (col.type) {
      case 'date': {
        const d = Dates.parse(v);
        if (!d) throw new Error(`Data inválida para "${col.header}": ${JSON.stringify(v instanceof Date ? String(v) : v)}`);
        return d;
      }
      case 'bool': return v === true || v === 'Sim' ? 'Sim' : 'Não';
      case 'enum':
        if (col.enum && col.enum.indexOf(v) < 0) throw new Error(`Valor inválido para "${col.header}": "${v}". Use: ${col.enum.join(', ')}`);
        return v;
      default: return v;
    }
  },

  /** Row values (full width) → object keyed by column key, with _row. */
  toObject_(id, line, row) {
    const { map } = Tabs.layout(id);
    const obj = { _row: row };
    Tabs.columns(id).forEach((c) => {
      obj[c.key] = map[c.key] ? Tabs.fromCell(c, line[map[c.key] - 1]) : null;
    });
    return obj;
  },

  /** True when every mapped cell of the line is empty. */
  isEmpty_(id, line) {
    const { map } = Tabs.layout(id);
    return Object.keys(map).every((k) => {
      const v = line[map[k] - 1];
      return v === '' || v === null || v === undefined;
    });
  },

  /**
   * Data rows as objects keyed by column key, in sheet order, skipping empty rows.
   * @param {string} id tab id
   * @returns {Object[]} each with `_row`
   */
  read(id) {
    const spec = Tabs.get(id);
    const { sheet, lastCol } = Tabs.layout(id);
    const first = spec.firstDataRow;
    const last = sheet.getLastRow();
    if (last < first || !lastCol) return [];
    const values = sheet.getRange(first, 1, last - first + 1, lastCol).getValues();
    const out = [];
    values.forEach((line, i) => {
      if (!Tabs.isEmpty_(id, line)) out.push(Tabs.toObject_(id, line, first + i));
    });
    return out;
  },

  /** One row as an object (empty cells → null). */
  readRow(id, row) {
    const { sheet, lastCol } = Tabs.layout(id);
    if (!lastCol) return Tabs.toObject_(id, [], row);
    return Tabs.toObject_(id, sheet.getRange(row, 1, 1, lastCol).getValues()[0], row);
  },

  filter(id, pred) {
    return Tabs.read(id).filter(pred);
  },

  find(id, pred) {
    return Tabs.read(id).find(pred) || null;
  },

  /** Equality used by findBy: dates by day, text trimmed, numbers strictly. */
  same_(a, b) {
    if (a instanceof Date || b instanceof Date) return Dates.sameDay(a, b);
    if (a === null || a === undefined || b === null || b === undefined) return a === b || (a == null && b == null);
    if (typeof a === 'string' || typeof b === 'string') return String(a).trim() === String(b).trim();
    return a === b;
  },

  /** Rows whose `key` equals value. */
  findAllBy(id, key, value) {
    Tabs.column(id, key);
    return Tabs.read(id).filter((r) => Tabs.same_(r[key], value));
  },

  /** First row whose `key` equals value, or null. */
  findBy(id, key, value) {
    return Tabs.findAllBy(id, key, value)[0] || null;
  },

  /** Rows on a given day (by the `date` column unless another key is given). */
  findByDate(id, date, key) {
    const k = key || 'date';
    const target = Dates.key(date);
    if (!target) return [];
    return Tabs.read(id).filter((r) => Dates.key(r[k]) === target);
  },

  /** Row where the next append lands: after the last row with content (never above data start). */
  nextRow(id) {
    const spec = Tabs.get(id);
    const { sheet } = Tabs.layout(id);
    return Math.max(sheet.getLastRow() + 1, spec.firstDataRow);
  },

  /** Validates keys and converts an object to {column: cellValue}. */
  cells_(id, obj) {
    const { map } = Tabs.layout(id);
    const spec = Tabs.get(id);
    const out = {};
    Object.keys(obj).forEach((key) => {
      if (key === '_row') return;
      const col = spec.columns.find((c) => c.key === key);
      if (!col) throw new Error(`Unknown column ${id}.${key}`);
      if (!map[key]) {
        if (obj[key] === null || obj[key] === undefined || obj[key] === '') return;
        throw new Error(`Coluna "${col.header}" não encontrada na aba "${spec.name}". Rode Projeto → Sistema → Reaplicar layout.`);
      }
      out[map[key]] = Tabs.toCell(col, obj[key]);
    });
    return out;
  },

  /** Writes whole rows of cell values keyed by column; tracks the change before writing. */
  track_(id, change) {
    if (id !== 'log' && typeof ChangeLog !== 'undefined') ChangeLog.track(change);
  },

  /**
   * Appends one row. Unknown keys throw; keys without a column in the sheet throw unless empty.
   * @returns {number} the sheet row written
   */
  append(id, obj) {
    return Tabs.appendMany(id, [obj])[0];
  },

  /** Appends several rows in one write. @returns {number[]} rows */
  appendMany(id, objs) {
    if (!objs.length) return [];
    const { sheet, byCol } = Tabs.layout(id);
    const spec = Tabs.get(id);
    const lines = objs.map((o) => Tabs.cells_(id, o));
    const width = Math.max(Tabs.layout(id).lastCol, ...lines.map((l) => Math.max(0, ...Object.keys(l).map(Number))));
    if (!width) throw new Error(`A aba "${spec.name}" não tem cabeçalho na linha ${spec.headerRow}.`);
    const first = Tabs.nextRow(id);
    const rows = [];
    const values = lines.map((cells, i) => {
      const line = [];
      for (let c = 1; c <= width; c++) line.push(c in cells ? cells[c] : '');
      const after = {};
      Object.keys(cells).forEach((c) => { after[Tabs.cellName_(byCol, Number(c))] = cells[c]; });
      Tabs.track_(id, { kind: 'append', tab: spec.name, row: first + i, before: null, after });
      rows.push(first + i);
      return line;
    });
    sheet.getRange(first, 1, values.length, width).setValues(values);
    return rows;
  },

  /**
   * Writes only the given keys of an existing row; cells whose value does not change are skipped.
   * @returns {number} row
   */
  update(id, row, patch) {
    const { sheet, byCol } = Tabs.layout(id);
    const spec = Tabs.get(id);
    if (row < spec.firstDataRow) throw new Error(`Row ${row} is above the data of ${spec.name}`);
    const cells = Tabs.cells_(id, patch);
    const cols = Object.keys(cells).map(Number).sort((a, b) => a - b);
    const before = {};
    const after = {};
    if (!cols.length) return row;
    const range = sheet.getRange(row, 1, 1, cols[cols.length - 1]);
    const values = range.getValues()[0];
    const formulas = range.getFormulas()[0];
    const changed = cols.filter((c) => {
      const formula = formulas[c - 1];
      const old = formula || values[c - 1];
      if (!formula && Tabs.sameCell(old, cells[c])) return false;
      before[Tabs.cellName_(byCol, c)] = old;
      after[Tabs.cellName_(byCol, c)] = cells[c];
      return true;
    });
    if (!changed.length) return row;
    Tabs.track_(id, { kind: 'update', tab: spec.name, row, before, after });
    changed.forEach((c) => sheet.getRange(row, c).setValue(cells[c]));
    return row;
  },

  /** Deletes a data row (shifts the rows below up). */
  remove(id, row) {
    const { sheet, lastCol, byCol } = Tabs.layout(id);
    const spec = Tabs.get(id);
    if (row < spec.firstDataRow) throw new Error(`Row ${row} is above the data of ${spec.name}`);
    const range = sheet.getRange(row, 1, 1, Math.max(lastCol, 1));
    const values = range.getValues()[0];
    const formulas = range.getFormulas()[0];
    const before = {};
    values.forEach((v, i) => {
      const value = formulas[i] || v;
      if (value !== '' && value !== null && value !== undefined) before[Tabs.cellName_(byCol, i + 1)] = value;
    });
    Tabs.track_(id, { kind: 'delete', tab: spec.name, row, before, after: null });
    sheet.deleteRow(row);
  },

  /**
   * Writes cells of a layout tab (Hoje, Painel) by A1 address, tracked as one change.
   * @param {Object<string, *>} cells {A1: value}
   */
  setCells(id, cells) {
    const spec = Tabs.get(id);
    const sheet = Tabs.sheet(id);
    const before = {};
    const after = {};
    Object.keys(cells).forEach((a1) => {
      const range = sheet.getRange(a1);
      const formula = range.getFormulas()[0][0];
      before[a1] = formula || range.getValue();
      after[a1] = cells[a1] === null || cells[a1] === undefined ? '' : cells[a1];
    });
    Tabs.track_(id, { kind: 'cells', tab: spec.name, row: null, before, after });
    Object.keys(after).forEach((a1) => {
      const v = after[a1];
      if (typeof v === 'string' && v.charAt(0) === '=') sheet.getRange(a1).setFormula(v);
      else sheet.getRange(a1).setValue(v);
    });
  },

  /** Cell equality (dates by instant, empty/null alike). */
  sameCell(a, b) {
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof Date || b instanceof Date) return false;
    const ea = a === null || a === undefined ? '' : a;
    const eb = b === null || b === undefined ? '' : b;
    return ea === eb;
  },

  /** Header text of a column for the log; '#n' when the column has no header. */
  cellName_(byCol, c) {
    return byCol[c] ? byCol[c] : `#${c}`;
  },
};

/* ---------------------------------------------------------------------------------------------
 * Registry. Column helper: col(key, header, type, role, extra).
 * ------------------------------------------------------------------------------------------- */
(function defineTabs() {
  const E = Tabs.ENUMS;
  const col = (key, header, type, role, extra) => Object.assign({ key, header, type, role: role || 'input' }, extra || {});
  const table = (id, def) => {
    Tabs.SPEC[id] = Object.assign({
      id, kind: 'table', headerRow: Tabs.HEADER_ROW, firstDataRow: Tabs.FIRST_DATA_ROW, legacyNames: [],
    }, def);
  };
  const layout = (id, def) => {
    Tabs.SPEC[id] = Object.assign({ id, kind: 'layout', headerRow: null, firstDataRow: null, columns: [], legacyNames: [] }, def);
  };
  const macros = (role, prefix) => [
    col('kcal', `${prefix || ''}kcal`, 'number', role),
    col('protein', 'Proteína g', 'number', role),
    col('carbs', 'Carboidrato g', 'number', role),
    col('fat', 'Gordura g', 'number', role),
    col('fiber', 'Fibra g', 'number', role),
  ];

  /* Layer 1 — person ---------------------------------------------------------------------- */
  layout('today', { name: 'Hoje', layer: 1, title: 'Registro rápido', help: 'Preencha o que souber e use Ação rápida ou o menu Projeto. Campos vazios não viram zero.' });
  layout('dashboard', { name: 'Painel', layer: 1, title: 'Painel', help: 'Objetivo atual, metas, estado da semana e recomendação. Gerado pelo script.' });

  table('progression', {
    name: 'Progressão', layer: 1, title: 'Progressão por exercício',
    help: 'Gerado pelo script a partir do Registro de treino. Só work sets contam.',
    columns: [
      col('exercise', 'Exercício', 'text', 'calc'),
      col('group', 'Grupo', 'text', 'calc'),
      col('session', 'Sessão', 'text', 'calc'),
      col('lastDate', 'Última sessão', 'date', 'calc'),
      col('lastWork', 'Último work', 'text', 'calc'),
      col('rir', 'RIR', 'number', 'calc'),
      col('trend', 'Tendência', 'text', 'calc'),
      col('suggestion', 'Sugestão', 'text', 'calc'),
      col('plan', 'Ficha', 'id', 'calc'),
    ],
  });

  table('baseDiet', {
    name: 'Dieta base', layer: 1, title: 'Dieta base com porções revisáveis',
    help: 'Plano alimentar de referência. Os totais são a dieta planejada, não a ingestão realizada.',
    columns: [
      col('meal', 'Refeição', 'text'),
      col('food', 'Alimento', 'text'),
      col('qty', 'Quantidade', 'number'),
      col('unit', 'Unidade', 'text'),
      ...macros('calc'),
      col('note', 'Adaptação / observação', 'text'),
    ],
  });

  table('planDraft', {
    name: 'Ficha de treino', layer: 1, title: 'Ficha vigente',
    help: 'Mostra a ficha em vigor. Edite como rascunho e use Salvar nova ficha para criar a próxima versão.',
    columns: [
      col('session', 'Sessão', 'text'),
      col('exercise', 'Exercício', 'text'),
      col('group', 'Grupo principal', 'text'),
      col('workSetsAdapt', 'Work sets adaptação', 'integer'),
      col('workSetsRegular', 'Work sets regular', 'integer'),
      col('repsMin', 'Reps work mín.', 'integer'),
      col('repsMax', 'Reps work máx.', 'integer'),
      col('rirAdapt', 'RIR work adaptação máx.', 'number'),
      col('rirRegular', 'RIR work regular máx.', 'number'),
      col('restS', 'Descanso s', 'integer'),
      col('alternative', 'Alternativa', 'text'),
      col('planStatus', 'Status do plano', 'text'),
      col('setTypes', 'Tipos de série', 'text'),
    ],
  });

  table('measures', {
    name: 'Medidas e fotos', layer: 1, title: 'Medidas e fotos padronizadas',
    help: 'Cintura semanal; outras medidas e fotos a cada 4 semanas, mesma luz, distância e postura.',
    columns: [
      col('date', 'Data', 'date', 'id'),
      col('waistCm', 'Cintura umbigo cm', 'number'),
      col('hipCm', 'Quadril cm', 'number'),
      col('chestCm', 'Peito cm', 'number'),
      col('armCm', 'Braço direito cm', 'number'),
      col('thighCm', 'Coxa direita cm', 'number'),
      col('photoFront', 'Frente: link', 'text'),
      col('photoSide', 'Lado: link', 'text'),
      col('photoBack', 'Costas: link', 'text'),
      col('notes', 'Condições / observações', 'text'),
      col('objective', 'Objetivo', 'id', 'calc'),
    ],
  });

  /* Layer 2 — history --------------------------------------------------------------------- */
  table('weeks', {
    name: 'Semanas', layer: 2, title: 'Evolução semanal',
    help: 'Uma linha por semana (segunda a domingo), gravada como valores com o objetivo, a meta e a ficha daquela semana.',
    columns: [
      col('start', 'Início', 'date', 'id'),
      col('end', 'Fim', 'date', 'calc'),
      col('objective', 'Objetivo', 'id', 'calc'),
      col('goal', 'Meta', 'id', 'calc'),
      col('plan', 'Ficha', 'id', 'calc'),
      col('transition', 'Transição na semana', 'text', 'calc'),
      col('weighIns', 'Pesagens', 'integer', 'calc'),
      col('weightAvg', 'Peso médio 7d', 'number', 'calc'),
      col('weightDelta', 'Variação kg', 'number', 'calc'),
      col('weightDeltaPct', 'Variação %/sem', 'number', 'calc'),
      col('waistCm', 'Cintura', 'number', 'calc'),
      col('waistDelta', 'Variação cintura', 'number', 'calc'),
      col('daysLogged', 'Dias com registro', 'integer', 'calc'),
      col('completeDays', 'Dias completos', 'integer', 'calc'),
      col('kcalAvg', 'kcal média', 'number', 'calc'),
      col('proteinAvg', 'Proteína média', 'number', 'calc'),
      col('carbsAvg', 'Carboidrato médio', 'number', 'calc'),
      col('fatAvg', 'Gordura média', 'number', 'calc'),
      col('fiberAvg', 'Fibra média', 'number', 'calc'),
      col('kcalAdherence', 'Aderência kcal', 'number', 'calc'),
      col('proteinAdherence', 'Aderência proteína', 'number', 'calc'),
      col('fatAdherence', 'Aderência gordura', 'number', 'calc'),
      col('foodCoverage', 'Cobertura alimentar', 'text', 'calc'),
      col('noCalcItems', 'Itens sem cálculo', 'integer', 'calc'),
      col('sessions', 'Treinos', 'integer', 'calc'),
      col('sessionsGoal', 'Meta treinos', 'integer', 'calc'),
      col('workVolume', 'Volume work', 'number', 'calc'),
      col('progressions', 'Exercícios com progressão', 'integer', 'calc'),
      col('regressions', 'Exercícios com regressão', 'integer', 'calc'),
      col('sleepAvg', 'Sono médio', 'number', 'calc'),
      col('hungerAvg', 'Fome média', 'number', 'calc'),
      col('fatigueAvg', 'Cansaço médio', 'number', 'calc'),
      col('painMax', 'Dor máx', 'number', 'calc'),
      col('stepsAvg', 'Passos médios', 'number', 'calc'),
      col('cardioMin', 'Cardio min', 'number', 'calc'),
      col('activities', 'Atividades', 'integer', 'calc'),
      col('sufficiency', 'Suficiência de dados', 'text', 'calc'),
      col('targetRange', 'Faixa alvo %/sem', 'text', 'calc'),
      col('status', 'Situação', 'enum', 'calc', { enum: E.WEEK_STATUS }),
      col('signals', 'Sinais', 'text', 'calc'),
      col('reasons', 'Motivos', 'text', 'calc'),
      col('recommendation', 'Recomendação', 'enum', 'calc', { enum: E.RECOMMENDATIONS }),
      col('recommendationReason', 'Motivo da recomendação', 'text', 'calc'),
      col('nextReview', 'Próxima revisão', 'date', 'calc'),
      col('computedAt', 'Calculado em', 'datetime', 'calc'),
    ],
  });

  table('evolution', {
    name: 'Evolução', layer: 2, title: 'Evolução de longo prazo',
    help: 'Uma linha por semana, todas as fases. Base dos gráficos do Painel.',
    columns: [
      col('start', 'Semana', 'date', 'id'),
      col('objective', 'Objetivo', 'id', 'calc'),
      col('goal', 'Meta', 'id', 'calc'),
      col('plan', 'Ficha', 'id', 'calc'),
      col('weightAvg', 'Peso médio 7d', 'number', 'calc'),
      col('waistCm', 'Cintura', 'number', 'calc'),
      col('kcalAvg', 'kcal média', 'number', 'calc'),
      col('proteinAvg', 'Proteína média', 'number', 'calc'),
      col('sessions', 'Treinos', 'integer', 'calc'),
      col('workVolume', 'Volume work', 'number', 'calc'),
      col('status', 'Situação', 'enum', 'calc', { enum: E.WEEK_STATUS }),
      col('recommendation', 'Recomendação', 'enum', 'calc', { enum: E.RECOMMENDATIONS }),
    ],
  });

  table('food', {
    name: 'Alimentação', layer: 2, title: 'Registro diário de alimentação',
    help: 'Consumo confirmado. Quantidades na unidade-base. Sem cálculo = macros desconhecidos, nunca zero.',
    columns: [
      col('date', 'Data', 'date', 'id'),
      col('meal', 'Refeição', 'text'),
      col('food', 'Alimento', 'text'),
      col('qty', 'Quantidade', 'number'),
      col('unit', 'Unidade', 'text'),
      ...macros('calc'),
      col('measure', 'Medição', 'text'),
      col('note', 'Observação', 'text'),
      col('check', 'Conferência', 'text', 'calc'),
      col('entryId', 'ID lançamento', 'id', 'id'),
      col('favorite', 'Favorita / versão', 'text', 'calc'),
      col('source', 'Fonte', 'enum', 'input', { enum: E.FOOD_SOURCE }),
      col('calc', 'Cálculo', 'enum', 'calc', { enum: E.FOOD_CALC }),
    ],
  });

  table('workouts', {
    name: 'Registro de treino', layer: 2, title: 'Registro por exercício e sessão',
    help: 'Aquecimento e feeder preservados; volume e progressão só com Work 1 + Work 2. Salvar parcial permite retomar.',
    columns: [
      col('date', 'Data', 'date', 'id'),
      col('session', 'Sessão', 'text'),
      col('exercise', 'Exercício', 'text'),
      col('equipment', 'Equipamento / carga', 'text'),
      col('warmupKg', 'Aquecimento kg', 'number'),
      col('warmupReps', 'Aquecimento reps', 'integer'),
      col('feederKg', 'Feeder kg', 'number'),
      col('feederReps', 'Feeder reps', 'integer'),
      col('work1Kg', 'Work 1 kg', 'number'),
      col('work1Reps', 'Work 1 reps', 'integer'),
      col('work2Kg', 'Work 2 kg', 'number'),
      col('work2Reps', 'Work 2 reps', 'integer'),
      col('workSetsDone', 'Work sets realizadas', 'integer', 'calc'),
      col('workVolume', 'Volume work kg×reps', 'number', 'calc'),
      col('rir2', 'RIR work 2', 'number'),
      col('pain', 'Dor 0–10', 'integer'),
      col('note', 'Observação', 'text'),
      col('plan', 'Ficha', 'id', 'calc'),
      col('workSetsPrescribed', 'Work sets prescritas', 'integer', 'calc'),
      col('repsMin', 'Reps work mín', 'integer', 'calc'),
      col('repsMax', 'Reps work máx', 'integer', 'calc'),
      col('phase', 'Fase', 'text', 'calc'),
      col('sessionId', 'ID sessão', 'id', 'id'),
      col('rir1', 'RIR work 1', 'number'),
      col('sessionState', 'Estado sessão', 'enum', 'input', { enum: E.SESSION_STATE }),
      col('setModel', 'Modelo de séries', 'text', 'calc'),
      col('objective', 'Objetivo', 'id', 'calc'),
    ],
  });

  table('diary', {
    name: 'Diário', layer: 2, title: 'Resumo diário',
    help: 'Uma linha por dia. Vazio = não informado; zero só quando digitado. Totais escritos pelo script.',
    columns: [
      col('date', 'Data', 'date', 'id'),
      col('weightKg', 'Peso kg', 'number'),
      col('waistCm', 'Cintura cm', 'number'),
      col('sleepH', 'Sono h', 'number'),
      col('steps', 'Passos', 'integer'),
      col('cardioMin', 'Cardio min', 'number'),
      col('activityMin', 'Atividade min', 'number'),
      col('activity', 'Atividade', 'text'),
      col('hunger', 'Fome 1–5', 'integer'),
      col('fatigue', 'Cansaço 1–5', 'integer'),
      col('pain', 'Dor 0–10', 'integer'),
      col('foodLog', 'Registro alimentar', 'enum', 'input', { enum: E.FOOD_LOG }),
      col('notes', 'Observações', 'text'),
      col('objective', 'Objetivo', 'id', 'calc'),
      col('goal', 'Meta', 'id', 'calc'),
      col('plan', 'Ficha', 'id', 'calc'),
      ...macros('calc'),
      col('noCalcItems', 'Itens sem cálculo', 'integer', 'calc'),
      col('estimatedItems', 'Itens estimados', 'integer', 'calc'),
      col('sessions', 'Treinos', 'integer', 'calc'),
      col('dayState', 'Estado do dia', 'enum', 'calc', { enum: E.DAY_STATE }),
    ],
  });

  table('reviews', {
    name: 'Revisões', layer: 2, title: 'Decisões e adaptação',
    help: 'Toda mudança de objetivo, meta ou ficha fica registrada aqui. A planilha não muda metas sozinha.',
    columns: [
      col('date', 'Data', 'date', 'id'),
      col('area', 'Área', 'text'),
      col('reason', 'Observação / motivo', 'text'),
      col('change', 'Alteração', 'text', 'input', { aliases: ['Alteração proposta'] }),
      col('reviewer', 'Revisor', 'text'),
      col('status', 'Status', 'text'),
      col('nextReview', 'Próxima revisão', 'date'),
      col('result', 'Resultado', 'text', 'input', { aliases: ['Resultado após mudança'] }),
      col('objective', 'Objetivo', 'id', 'calc'),
      col('goal', 'Meta', 'id', 'calc'),
      col('plan', 'Ficha', 'id', 'calc'),
      col('recommendation', 'Recomendação', 'text', 'calc'),
    ],
  });

  table('objectives', {
    name: 'Objetivos', layer: 2, title: 'Objetivos por fase',
    help: 'Uma linha por versão do objetivo. Mudanças encerram a versão vigente e criam a próxima; nada é sobrescrito.',
    columns: [
      col('id', 'ID', 'id', 'id'),
      col('name', 'Objetivo', 'text'),
      col('analysisType', 'Tipo de análise', 'enum', 'input', { enum: E.ANALYSIS_TYPES }),
      col('start', 'Início', 'date'),
      col('end', 'Fim', 'date', 'calc'),
      col('status', 'Status', 'enum', 'calc', { enum: E.OBJECTIVE_STATUS }),
      col('startWeightKg', 'Peso inicial kg', 'number', 'calc'),
      col('startWaistCm', 'Cintura inicial cm', 'number', 'calc'),
      col('reason', 'Motivo da mudança', 'text'),
      col('expectation', 'Expectativa principal', 'text'),
      col('weightRateMinPct', 'Variação de peso alvo %/sem mín', 'number'),
      col('weightRateMaxPct', 'Variação de peso alvo %/sem máx', 'number'),
      col('kcal', 'kcal iniciais', 'number'),
      col('protein', 'Proteína g', 'number'),
      col('fat', 'Gordura g', 'number'),
      col('carbs', 'Carboidrato g', 'number', 'calc'),
      col('strengthPerWeek', 'Treinos/sem', 'integer'),
      col('cardioPerWeek', 'Cardio/sem', 'integer'),
      col('activitiesPerWeek', 'Atividades/sem', 'integer'),
      col('goal', 'Meta ligada', 'id', 'calc'),
      col('plan', 'Ficha ligada', 'id', 'calc'),
      col('reviewer', 'Revisor', 'text'),
      col('notes', 'Observações', 'text'),
    ],
  });

  table('goals', {
    name: 'Metas', layer: 2, legacyNames: ['Histórico de metas'], title: 'Metas por vigência',
    help: 'Uma linha por versão da meta. Carboidrato, TMB e gasto estimado ficam gravados com a meta.',
    columns: [
      col('id', 'ID', 'id', 'id', { aliases: ['Versão'] }),
      col('objective', 'Objetivo', 'id', 'calc'),
      col('start', 'Início', 'date', 'input', { aliases: ['Vigência'] }),
      col('end', 'Fim', 'date', 'calc'),
      col('status', 'Status', 'enum', 'calc', { enum: E.VERSION_STATUS_F }),
      col('kcal', 'kcal', 'number'),
      col('protein', 'Proteína g', 'number'),
      col('proteinMin', 'Proteína mín', 'number'),
      col('proteinMax', 'Proteína máx', 'number'),
      col('fat', 'Gordura g', 'number'),
      col('carbs', 'Carboidrato g', 'number', 'calc'),
      col('fiber', 'Fibra g', 'number'),
      col('kcalTolerance', 'Tolerância kcal', 'number'),
      col('fatTolerance', 'Tolerância gordura', 'number'),
      col('strengthPerWeek', 'Treinos/sem', 'integer', 'input', { aliases: ['Treinos semana'] }),
      col('cardioPerWeek', 'Cardio/sem', 'integer'),
      col('activitiesPerWeek', 'Atividades/sem', 'integer'),
      col('stepsPerDay', 'Passos/dia', 'integer'),
      col('bmr', 'TMB kcal', 'number', 'calc'),
      col('bmrMethod', 'Método TMB', 'text', 'calc'),
      col('activityFactor', 'Fator de atividade', 'number', 'calc'),
      col('tdee', 'Gasto estimado kcal', 'number', 'calc'),
      col('reason', 'Motivo', 'text'),
      col('reviewer', 'Revisor', 'text'),
    ],
  });

  table('plans', {
    name: 'Fichas', layer: 2, legacyNames: ['Histórico de fichas'], title: 'Fichas preservadas por versão',
    help: 'Uma linha por exercício de cada versão. A versão vigente aparece em Ficha de treino.',
    columns: [
      col('id', 'Versão', 'id', 'id'),
      col('legacyStart', 'Vigência', 'date', 'calc'),
      col('session', 'Sessão', 'text'),
      col('exercise', 'Exercício', 'text'),
      col('group', 'Grupo', 'text'),
      col('workSetsAdapt', 'Work sets adaptação', 'integer'),
      col('workSetsRegular', 'Work sets regular', 'integer'),
      col('repsMin', 'Reps work mín', 'integer'),
      col('repsMax', 'Reps work máx', 'integer'),
      col('rirAdapt', 'RIR work adaptação', 'number'),
      col('rirRegular', 'RIR work regular', 'number'),
      col('restS', 'Descanso s', 'integer'),
      col('alternative', 'Alternativa', 'text'),
      col('review', 'Revisão', 'text'),
      col('notes', 'Observações', 'text'),
      col('start', 'Início', 'date'),
      col('end', 'Fim', 'date', 'calc'),
      col('status', 'Status', 'enum', 'calc', { enum: E.VERSION_STATUS_F }),
    ],
  });

  /* Layer 3 — technical ------------------------------------------------------------------- */
  table('config', {
    name: 'Config', layer: 3, legacyNames: ['Macros e perfil'], title: 'Configuração',
    help: 'Perfil, rotina e limites da análise. Edite só a coluna Valor. Objetivo, meta e ficha atuais vêm das abas de histórico.',
    columns: [
      col('key', 'Chave', 'id', 'id'),
      col('label', 'Parâmetro', 'text', 'calc'),
      col('value', 'Valor', 'text', 'input'),
      col('unit', 'Unidade', 'text', 'calc'),
      col('description', 'Descrição', 'text', 'calc'),
    ],
  });

  table('foods', {
    name: 'Alimentos', layer: 3, title: 'Base de alimentos e macros',
    help: 'Unidade-base e porção-base definem os nutrientes. Medida caseira é opcional. Não converter ml em g sem densidade.',
    columns: [
      col('name', 'Alimento único', 'text', 'id'),
      col('baseUnit', 'Unidade-base', 'text'),
      col('baseQty', 'Base', 'number'),
      ...macros('input'),
      col('reference', 'Referência', 'text'),
      col('howToMeasure', 'Como medir', 'text'),
      col('sourceLink', 'Link da fonte', 'text'),
      col('valid', 'Cadastro válido', 'text', 'calc'),
      col('householdUnit', 'Medida caseira', 'text'),
      col('perHousehold', 'Base por medida', 'number'),
      col('quality', 'Qualidade da referência', 'text'),
    ],
  });

  table('favorites', {
    name: 'Favoritas', layer: 3, title: 'Refeições prontas para lançar',
    help: 'Use Criar favorita da refeição depois de registrar uma refeição.',
    columns: [
      col('name', 'Favorita', 'text', 'id'),
      col('version', 'Versão', 'text'),
      ...macros('calc'),
      col('note', 'Observação', 'text'),
    ],
  });

  table('ingredients', {
    name: 'Ingredientes', layer: 3, title: 'Ingredientes das favoritas',
    help: 'Quantidade sempre na unidade-base do alimento.',
    columns: [
      col('favorite', 'Favorita', 'text', 'id'),
      col('food', 'Alimento', 'text'),
      col('qty', 'Quantidade', 'number'),
      col('unit', 'Unidade', 'text'),
      ...macros('calc'),
      col('check', 'Conferência', 'text', 'calc'),
    ],
  });

  table('equivalences', {
    name: 'Equivalências', layer: 3, title: 'Trocas por nutriente principal',
    help: 'Trocas igualam um nutriente, não todos os macros. Confira o total da dieta.',
    columns: [
      col('base', 'Base', 'text'),
      col('baseQty', 'Qtd. base', 'number'),
      col('criterion', 'Critério', 'text'),
      col('alternative', 'Alternativa', 'text'),
      col('equivQty', 'Qtd. equivalente', 'number', 'calc'),
      col('unit', 'Unidade', 'text'),
      col('kcalBase', 'kcal base', 'number', 'calc'),
      col('kcalAlt', 'kcal alternativa', 'number', 'calc'),
      col('kcalDiff', 'Diferença kcal', 'number', 'calc'),
      col('proteinAlt', 'Proteína alt.', 'number', 'calc'),
      col('carbsAlt', 'Carboidrato alt.', 'number', 'calc'),
      col('fatAlt', 'Gordura alt.', 'number', 'calc'),
      col('note', 'Observação', 'text'),
    ],
  });

  table('exercises', {
    name: 'Exercícios', layer: 3, title: 'Cadastro de exercícios',
    help: 'Um exercício por linha. Mantenha sempre o mesmo critério de carga.',
    columns: [
      col('name', 'Exercício', 'text', 'id'),
      col('group', 'Grupo', 'text'),
      col('loadConvention', 'Convenção de carga', 'text'),
    ],
  });

  table('guide', {
    name: 'Guia', layer: 3, legacyNames: ['Guia e fontes'], title: 'Como usar e referências',
    help: 'Orientações gerais. Nomes, rotinas e metas vêm da Config e das abas de histórico.',
    columns: [
      col('topic', 'Tema', 'text'),
      col('guidance', 'Orientação prática', 'text'),
      col('source', 'Fonte / localização', 'text'),
    ],
  });

  table('audit', {
    name: 'Auditoria', layer: 3, title: 'Auditoria',
    help: 'Relatório da última auditoria e da migração. Não altera dados.',
    columns: [
      col('at', 'Quando', 'datetime', 'calc'),
      col('area', 'Área', 'text', 'calc'),
      col('tab', 'Aba', 'text', 'calc'),
      col('cell', 'Célula', 'text', 'calc'),
      col('severity', 'Gravidade', 'enum', 'calc', { enum: E.AUDIT_SEVERITY }),
      col('finding', 'Achado', 'text', 'calc'),
      col('before', 'Valor anterior', 'text', 'calc'),
      col('action', 'Ação tomada', 'text', 'calc'),
    ],
  });

  table('log', {
    name: 'Log', layer: 3, hidden: true, title: 'Registro de alterações',
    help: 'Usado por Desfazer. Uma linha por linha/célula alterada; linhas com o mesmo ID ação formam uma ação.',
    columns: [
      col('at', 'Quando', 'datetime', 'calc'),
      col('actionId', 'ID ação', 'id', 'calc'),
      col('action', 'Ação', 'text', 'calc'),
      col('tab', 'Aba', 'text', 'calc'),
      col('row', 'Linha', 'integer', 'calc'),
      col('kind', 'Tipo', 'enum', 'calc', { enum: E.LOG_KIND }),
      col('before', 'Antes (JSON)', 'text', 'calc'),
      col('after', 'Depois (JSON)', 'text', 'calc'),
      col('undone', 'Desfeito', 'datetime', 'calc'),
    ],
  });
})();
