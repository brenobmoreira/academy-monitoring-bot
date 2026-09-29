/**
 * Food log: the Alimentação tab (spec §3.3, §4.5) and the day totals it feeds into Diário.
 *
 * One row per food eaten. Quantities are stored in the food's base unit (g/ml); what was typed
 * in another unit is kept in Observação ("Informado: 2 un (medida caseira, estimada)").
 * Every row carries:
 *   Cálculo   Calculado | Estimado | Sem cálculo
 *             Estimado = household measure, Medição "Estimada", or a food whose Fonte is
 *             Estimativa/Pendente (also an ingredient that was estimated when its favourite was
 *             created). Sem cálculo = unknown macros: the macro cells stay empty, never 0.
 *   Fonte     from the catalogue (Foods.source); Pendente for Sem cálculo rows
 *   Conferência  why a row is not plainly Calculado ("Medida caseira; Fonte: estimativa"), or OK
 *   ID lançamento  A<yyyyMMdd>-<nnn>, sequential per date
 *   Favorita / versão  "<name> · v<n>" for rows launched from a favourite
 *
 * After every change the day's totals are recomputed from its rows and written with
 * Days.patch(date, {kcal, protein, carbs, fat, fiber, noCalcItems, estimatedItems}): sums over
 * the calculable rows (Calculado + Estimado); macros null when the day has no calculable row;
 * everything null when the day has no food row at all (não informado, not zero); then
 * Diary.refreshState(date) re-derives Estado do dia.
 *
 * Copies ("Copiar refeição/dia") keep the stored values of the source rows and put the marker
 * "Cópia de dd/mm/yyyy" at the start of Observação. Copying the same meal of the same date to
 * the same day twice is refused (the marker on the target rows is the record of the copy).
 *
 * Every write goes through Tabs, so an action (Actions.run → ChangeLog.run) is undone as a whole,
 * totals included.
 */
const FoodLog = {
  CALC: { CALCULATED: 'Calculado', ESTIMATED: 'Estimado', NO_CALC: 'Sem cálculo' },
  /** Medição values (3.0 list). */
  MEASUREMENTS: ['Pesada', 'Rótulo', 'Estimada'],
  MEASURE_ESTIMATED: 'Estimada',
  /** Generic meal names offered by Setup's validation lists; meals stay free text. */
  MEALS: ['Café da manhã', 'Lanche da manhã', 'Almoço', 'Lanche', 'Pré-treino', 'Pós-treino', 'Jantar', 'Ceia', 'Outro'],
  ALL_MEALS: 'Todas',
  COPY_PREFIX: 'Cópia de',
  NOTE_SEP: ' · ',
  INPUT_NOTE: 'Informado:',
  ID_PREFIX: 'A',
  CHECK_OK: 'OK',
  CHECK_NO_CALC: 'Macros desconhecidos',

  /* ------------------------------------------------------------------ reading ----------- */

  /** Alimentação rows of a date, in sheet order. */
  rows(date) {
    return Tabs.findByDate('food', Dates.require(date, 'Data'));
  },

  /** Cálculo of a row; 3.0 rows without it: Calculado when kcal is a number, else Sem cálculo. */
  kind(row) {
    if (row.calc) return row.calc;
    return typeof row.kcal === 'number' ? FoodLog.CALC.CALCULATED : FoodLog.CALC.NO_CALC;
  },

  /**
   * Totals of a date from its rows (no write).
   * @returns {{kcal, protein, carbs, fat, fiber, noCalcItems, estimatedItems, items, calculableItems}|null}
   *   null when the date has no food row
   */
  dayTotals(date) {
    const rows = FoodLog.rows(date);
    if (!rows.length) return null;
    const calc = rows.filter((r) => FoodLog.kind(r) !== FoodLog.CALC.NO_CALC);
    const out = {};
    Foods.MACROS.forEach((k) => {
      const nums = calc.map((r) => r[k]).filter((v) => typeof v === 'number' && isFinite(v));
      out[k] = nums.length ? Units.round(nums.reduce((a, b) => a + b, 0), 1) : null;
    });
    out.noCalcItems = rows.filter((r) => FoodLog.kind(r) === FoodLog.CALC.NO_CALC).length;
    out.estimatedItems = rows.filter((r) => FoodLog.kind(r) === FoodLog.CALC.ESTIMATED).length;
    out.items = rows.length;
    out.calculableItems = calc.length;
    return out;
  },

  /**
   * Writes the day's totals to Diário. A date without food rows clears them (only when the day
   * row exists: no Diário row is created just to hold empties).
   * @returns {Object|null} the totals written
   */
  recomputeDay(date) {
    const d = Dates.require(date, 'Data');
    const t = FoodLog.dayTotals(d);
    const keys = Foods.MACROS.concat(['noCalcItems', 'estimatedItems']);
    const fields = {};
    keys.forEach((k) => { fields[k] = t ? t[k] : null; });
    if (!t && !Days.get(d)) return null;
    Days.patch(d, fields);
    if (typeof Diary !== 'undefined') Diary.refreshState(d); // Estado do dia depends on the food totals
    return t;
  },

  /* ------------------------------------------------------------------ writing ----------- */

  /**
   * Logs a catalogued food.
   * @param {{date, meal: string, food: string, qty: number|string, unit?: string,
   *   measure?: string, note?: string}} args
   * @returns {{rows: number[], ids: string[], totals: Object, message: string}}
   */
  add(args) {
    const a = args || {};
    const date = FoodLog.date_(a.date);
    const meal = FoodLog.meal_(a.meal);
    const measure = FoodLog.measure_(a.measure);
    const food = Foods.get(a.food);
    const entry = FoodLog.entryFor_(food, a.qty, a.unit, { measure, note: a.note });
    const res = FoodLog.append_(date, [Object.assign({ meal }, entry)]);
    res.message = `Lançado: ${entry.food} ${Units.fmt(entry.qty)} ${entry.unit} em ${meal} de ${Dates.format(date)}. ${FoodLog.totalsText_(res.totals)}`;
    return res;
  },

  /**
   * Logs an item without known macros (eaten out, no label…). Macros stay empty.
   * @param {{date, meal: string, description: string, qty?: number, unit?: string, note?: string}} args
   */
  addNoCalc(args) {
    const a = args || {};
    const date = FoodLog.date_(a.date);
    const meal = FoodLog.meal_(a.meal);
    const description = a.description === null || a.description === undefined ? '' : String(a.description).trim();
    if (!description) throw new Error('Descreva o que foi consumido (Refeição sem cálculo).');
    const qty = Units.parseQty(a.qty);
    const entry = FoodLog.noCalcEntry_(description, qty !== null && qty > 0 ? qty : null, qty !== null && qty > 0 ? Units.normalize(a.unit) || null : null);
    if (a.note) entry.note = String(a.note);
    const res = FoodLog.append_(date, [Object.assign({ meal }, entry)]);
    res.message = `Registrado sem cálculo: ${description} em ${meal} de ${Dates.format(date)}. ${FoodLog.totalsText_(res.totals)}`;
    return res;
  },

  /**
   * Logs the latest version of a favourite × portions: one row per ingredient, each with
   * `Favorita / versão`. Macros are recomputed from the current catalogue.
   * @param {{date, meal: string, name: string, portions?: number}} args
   */
  addFavorite(args) {
    const a = args || {};
    const date = FoodLog.date_(a.date);
    const meal = FoodLog.meal_(a.meal);
    const portions = a.portions === null || a.portions === undefined || a.portions === '' ? 1 : Units.parseQty(a.portions);
    if (!(portions > 0)) throw new Error('Porções deve ser um número maior que zero.');
    const fav = Favorites.latest(a.name);
    if (!fav) throw new Error(`Favorita "${String(a.name || '').trim()}" não encontrada. Crie com Criar favorita da refeição.`);
    const ings = Favorites.ingredients(fav.name, fav.version);
    if (!ings.length) throw new Error(`A favorita "${Favorites.label(fav)}" não tem ingredientes.`);
    const label = Favorites.label(fav);
    const errors = [];
    const entries = [];
    ings.forEach((ing) => {
      const qty = typeof ing.qty === 'number' ? Units.round(ing.qty * portions, 4) : null;
      if (ing.check === FoodLog.CALC.NO_CALC || qty === null) {
        entries.push(FoodLog.noCalcEntry_(ing.food, qty, qty === null ? null : ing.unit));
        return;
      }
      try {
        entries.push(FoodLog.entryFor_(Foods.get(ing.food), qty, ing.unit, { estimated: ing.check === FoodLog.CALC.ESTIMATED }));
      } catch (err) {
        errors.push(err.message);
      }
    });
    if (errors.length) throw new Error(`Não foi possível lançar "${label}": ${errors.join(' ')}`);
    const portionNote = portions === 1 ? null : `${Units.fmt(portions)} porções`;
    const res = FoodLog.append_(date, entries.map((e) => Object.assign({ meal, favorite: label }, e, {
      note: FoodLog.joinNote_([portionNote, e.note]),
    })));
    res.message = `Lançada: ${label} × ${Units.fmt(portions)} (${entries.length} itens) em ${meal} de ${Dates.format(date)}. ${FoodLog.totalsText_(res.totals)}`;
    return res;
  },

  /**
   * Copies a meal (or every meal: 'Todas') of `from` to `to`, keeping each row's meal and values.
   * @param {{from, to, meal?: string}} args
   */
  copy(args) {
    const a = args || {};
    const from = Dates.parse(a.from);
    if (!from) throw new Error('Informe a data de origem (Copiar da data).');
    const to = FoodLog.date_(a.to);
    if (Dates.sameDay(from, to)) throw new Error('A data de origem é a mesma do dia: escolha outra data em Copiar da data.');
    const which = a.meal === null || a.meal === undefined || String(a.meal).trim() === '' ? FoodLog.ALL_MEALS : String(a.meal).trim();
    const all = which === FoodLog.ALL_MEALS;
    const source = FoodLog.rows(from).filter((r) => all || Tabs.same_(r.meal, which));
    if (!source.length) {
      throw new Error(all ? `Nada para copiar: ${Dates.format(from)} não tem alimentos registrados.`
        : `Nada para copiar: ${which} de ${Dates.format(from)} não tem alimentos registrados.`);
    }
    const marker = `${FoodLog.COPY_PREFIX} ${Dates.format(from)}`;
    const meals = [];
    source.forEach((r) => { if (meals.indexOf(r.meal) < 0) meals.push(r.meal); });
    const target = FoodLog.rows(to);
    const done = meals.filter((m) => target.some((r) => Tabs.same_(r.meal, m) && FoodLog.copyMarker_(r.note) === marker));
    if (done.length) {
      throw new Error(`Cópia já feita: ${done.map((m) => m || '(sem refeição)').join(', ')} de ${Dates.format(from)} já foi copiado para ${Dates.format(to)}. Para repetir, lance os itens ou corrija a quantidade.`);
    }
    const copyKeys = ['meal', 'food', 'qty', 'unit', 'measure', 'favorite', 'source', 'calc', 'check'].concat(Foods.MACROS);
    const entries = source.map((r) => {
      const e = {};
      copyKeys.forEach((k) => { e[k] = r[k]; });
      e.calc = FoodLog.kind(r);
      if (e.calc === FoodLog.CALC.NO_CALC) Foods.MACROS.forEach((k) => { e[k] = null; });
      e.note = FoodLog.joinNote_([marker, FoodLog.stripCopyMarker_(r.note)]);
      return e;
    });
    const res = FoodLog.append_(to, entries);
    res.message = `Copiado: ${all ? 'dia inteiro' : which} de ${Dates.format(from)} para ${Dates.format(to)} (${entries.length} itens). ${FoodLog.totalsText_(res.totals)}`;
    return res;
  },

  /**
   * Corrects the quantity of one Alimentação row (sheet row number) and recomputes it.
   * @param {number} row
   * @param {{qty: number|string, unit?: string}} amount unit defaults to the row's unit
   */
  correct(row, amount) {
    const r = FoodLog.readRow_(row);
    if (FoodLog.kind(r) === FoodLog.CALC.NO_CALC) {
      throw new Error(`A linha ${row} é sem cálculo: exclua e lance de novo com um alimento cadastrado.`);
    }
    const a = amount || {};
    const food = Foods.get(r.food);
    const favEstimated = !!r.favorite && String(r.check || '').indexOf(FoodLog.CHECK_FAVORITE_ESTIMATED) >= 0;
    const entry = FoodLog.entryFor_(food, a.qty, a.unit || r.unit, { measure: r.measure, estimated: favEstimated });
    const keep = FoodLog.splitNote_(r.note).filter((s) => s.indexOf(FoodLog.INPUT_NOTE) !== 0);
    const copy = keep.filter((s) => FoodLog.copyMarker_(s));
    const rest = keep.filter((s) => !FoodLog.copyMarker_(s));
    const patch = {
      qty: entry.qty, unit: entry.unit, source: entry.source, calc: entry.calc, check: entry.check,
      note: FoodLog.joinNote_(copy.concat(entry.note ? [entry.note] : []).concat(rest)),
    };
    Foods.MACROS.forEach((k) => { patch[k] = entry[k]; });
    Tabs.update('food', row, patch);
    const totals = FoodLog.recomputeDay(r.date);
    return {
      row, totals, dates: [r.date],
      message: `Corrigido: ${r.food} ${Units.fmt(r.qty)} → ${Units.fmt(entry.qty)} ${entry.unit} (${Dates.format(r.date)}). ${FoodLog.totalsText_(totals)}`,
    };
  },

  /**
   * Deletes Alimentação rows (sheet row numbers) and recomputes the totals of their dates.
   * @param {number[]} rows
   */
  remove(rows) {
    const list = (Array.isArray(rows) ? rows : [rows]).map(Number);
    if (!list.length) throw new Error('Nenhuma linha selecionada.');
    const read = list.map((row) => FoodLog.readRow_(row));
    const dates = [];
    read.forEach((r) => { if (!dates.some((d) => Dates.sameDay(d, r.date))) dates.push(r.date); });
    list.slice().sort((x, y) => y - x).forEach((row) => Tabs.remove('food', row));
    const totals = dates.map((d) => FoodLog.recomputeDay(d));
    const names = read.map((r) => r.food).join(', ');
    return {
      rows: list, totals, dates,
      message: `Excluído: ${names}. ${dates.length === 1 ? FoodLog.totalsText_(totals[0]) : ''}`.trim(),
    };
  },

  /**
   * Alimentação rows selected in the sheet (the active range must be on Alimentação).
   * @returns {number[]} sheet rows with content
   */
  selection() {
    const range = SpreadsheetApp.getActiveRange();
    const spec = Tabs.get('food');
    if (!range || range.getSheet().getName() !== spec.name) {
      throw new Error(`Selecione a linha na aba ${spec.name} antes de usar esta ação.`);
    }
    const first = range.getRow();
    const last = first + range.getNumRows() - 1;
    const out = Tabs.read('food').map((x) => x._row).filter((r) => r >= first && r <= last);
    if (!out.length) throw new Error(`Selecione uma linha com lançamento na aba ${spec.name}.`);
    return out;
  },

  /* ------------------------------------------------------------------ internals --------- */

  CHECK_FAVORITE_ESTIMATED: 'Item estimado na favorita',

  /** A calculable row (no date/meal/id) for a catalogue food. */
  entryFor_(food, qty, unit, opts) {
    const o = opts || {};
    const p = Foods.portion(food, qty, unit);
    const reasons = [];
    if (p.household) reasons.push('Medida caseira');
    if (o.measure === FoodLog.MEASURE_ESTIMATED) reasons.push('Quantidade estimada');
    if (p.source === Foods.SOURCE.ESTIMATE) reasons.push('Fonte: estimativa');
    if (p.source === Foods.SOURCE.PENDING) reasons.push('Fonte pendente');
    if (o.estimated) reasons.push(FoodLog.CHECK_FAVORITE_ESTIMATED);
    const entry = {
      food: String(food.name).trim(),
      qty: p.qty,
      unit: p.unit,
      measure: o.measure || (p.household ? FoodLog.MEASURE_ESTIMATED : null),
      source: p.source,
      calc: reasons.length ? FoodLog.CALC.ESTIMATED : FoodLog.CALC.CALCULATED,
      check: reasons.length ? reasons.join('; ') : FoodLog.CHECK_OK,
      note: FoodLog.joinNote_([Units.describe(p), o.note]),
    };
    Foods.MACROS.forEach((k) => { entry[k] = p.macros[k]; });
    return entry;
  },

  noCalcEntry_(description, qty, unit) {
    const e = {
      food: description, qty, unit, measure: null, source: Foods.SOURCE.PENDING,
      calc: FoodLog.CALC.NO_CALC, check: FoodLog.CHECK_NO_CALC, note: null,
    };
    Foods.MACROS.forEach((k) => { e[k] = null; });
    return e;
  },

  /** Appends entries on `date` with new ids, then recomputes the day. */
  append_(date, entries) {
    const ids = FoodLog.nextIds_(date, entries.length);
    const rows = Tabs.appendMany('food', entries.map((e, i) => Object.assign({}, e, { date, entryId: ids[i] })));
    const totals = FoodLog.recomputeDay(date);
    return { rows, ids, totals, dates: [date] };
  },

  /** n new ids for a date: A<yyyyMMdd>-<nnn>, after the highest one already used that day. */
  nextIds_(date, n) {
    const stamp = Dates.key(date).replace(/-/g, '');
    const re = new RegExp(`^${FoodLog.ID_PREFIX}${stamp}-(\\d+)$`);
    let max = 0;
    Tabs.read('food').forEach((r) => {
      const m = re.exec(String(r.entryId || ''));
      if (m) max = Math.max(max, Number(m[1]));
    });
    const out = [];
    for (let i = 1; i <= n; i++) out.push(`${FoodLog.ID_PREFIX}${stamp}-${String(max + i).padStart(3, '0')}`);
    return out;
  },

  readRow_(row) {
    const spec = Tabs.get('food');
    const n = Number(row);
    if (!(n >= spec.firstDataRow)) throw new Error(`Linha ${row} não é um lançamento de ${spec.name}.`);
    const r = Tabs.readRow('food', n);
    if (!r.date || !r.food) throw new Error(`A linha ${row} de ${spec.name} não tem data e alimento.`);
    return r;
  },

  date_(v) {
    const d = v === null || v === undefined || v === '' ? Dates.today() : Dates.require(v, 'Data');
    if (Dates.compare(d, Dates.today()) > 0) throw new Error(`Data futura (${Dates.format(d)}): registre o consumo no dia em que aconteceu.`);
    return d;
  },

  meal_(v) {
    const m = v === null || v === undefined ? '' : String(v).trim();
    if (!m || m === FoodLog.ALL_MEALS) throw new Error('Informe a refeição.');
    return m;
  },

  measure_(v) {
    const m = v === null || v === undefined ? '' : String(v).trim();
    if (!m) return null;
    if (FoodLog.MEASUREMENTS.indexOf(m) < 0) throw new Error(`Medição inválida: "${m}". Use: ${FoodLog.MEASUREMENTS.join(', ')}.`);
    return m;
  },

  splitNote_(note) {
    return String(note === null || note === undefined ? '' : note).split(FoodLog.NOTE_SEP).map((s) => s.trim()).filter(Boolean);
  },

  joinNote_(parts) {
    const text = parts.filter((p) => p !== null && p !== undefined && String(p).trim() !== '').join(FoodLog.NOTE_SEP);
    return text || null;
  },

  /** "Cópia de dd/mm/yyyy" at the start of a note, or ''. */
  copyMarker_(note) {
    const m = new RegExp(`^${FoodLog.COPY_PREFIX} \\d{2}/\\d{2}/\\d{4}`).exec(String(note === null || note === undefined ? '' : note));
    return m ? m[0] : '';
  },

  stripCopyMarker_(note) {
    return FoodLog.joinNote_(FoodLog.splitNote_(note).filter((s) => !FoodLog.copyMarker_(s)));
  },

  totalsText_(t) {
    if (!t) return 'Dia sem registros alimentares.';
    const parts = [];
    parts.push(t.kcal === null ? 'Dia: sem itens calculáveis' : `Dia: ${Math.round(t.kcal)} kcal, P ${Math.round(t.protein)} g`);
    if (t.noCalcItems) parts.push(`${t.noCalcItems} sem cálculo`);
    if (t.estimatedItems) parts.push(`${t.estimatedItems} estimado${t.estimatedItems === 1 ? '' : 's'}`);
    return `${parts.join(' · ')}.`;
  },
};


/**
 * Adapter between the food actions and the food card of Hoje (ui_hoje.js). The actions read their
 * inputs only through FoodScreen.read(), which returns
 *   {date, favorite, portions, meal, food, quantity, unit, measurement, copyFromDate, copyMeal,
 *    noCalcDescription, note}
 * (date: Date; portions/quantity: number|null — an unparseable text is kept as is so the action
 * can name it; the rest trimmed text or null), clear the fields they consumed with
 * FoodScreen.clear(keys) and refresh "Meta × realizado" with FoodScreen.refresh(date).
 *
 * Wiring to Hoje (keys of Hoje.read().food → FoodScreen keys in HOJE_KEYS): the date is
 * Hoje.date() (today when the cell is empty); clear writes nulls with Hoje.write('food', …) so the
 * meal stays selected; refresh calls Hoje.renderDayStatus(date) when Hoje shows that date.
 * FoodScreen.use({read, clear?, refresh?}) replaces the wiring (tests, another screen).
 */
const FoodScreen = {
  FIELDS: ['date', 'favorite', 'portions', 'meal', 'food', 'quantity', 'unit', 'measurement', 'copyFromDate', 'copyMeal', 'noCalcDescription', 'note'],
  /** FoodScreen key → Hoje food key. */
  HOJE_KEYS: {
    favorite: 'favorite', portions: 'portions', meal: 'meal', food: 'food', quantity: 'qty', unit: 'unit',
    measurement: 'measure', copyFromDate: 'copyFrom', copyMeal: 'copyMeal', noCalcDescription: 'noCalcText', note: 'note',
  },
  impl_: null,

  /** Replaces the Hoje wiring: impl = {read(): Object, clear?(keys), refresh?(date)}; null restores it. */
  use(impl) {
    FoodScreen.impl_ = impl || null;
  },

  hoje_() {
    if (typeof Hoje === 'undefined' || !Tabs.findSheet(Hoje.TAB)) {
      throw new Error('A tela Hoje não está disponível. Rode Projeto → Sistema → Configuração inicial.');
    }
    return Hoje;
  },

  read() {
    if (FoodScreen.impl_) return FoodScreen.normalize_(FoodScreen.impl_.read() || {});
    const hoje = FoodScreen.hoje_();
    const food = hoje.read().food || {};
    const raw = { date: hoje.date() };
    Object.keys(FoodScreen.HOJE_KEYS).forEach((k) => { raw[k] = food[FoodScreen.HOJE_KEYS[k]]; });
    return FoodScreen.normalize_(raw);
  },

  clear(keys) {
    if (FoodScreen.impl_) {
      if (typeof FoodScreen.impl_.clear === 'function') FoodScreen.impl_.clear(keys);
      return;
    }
    const values = {};
    keys.forEach((k) => { if (FoodScreen.HOJE_KEYS[k]) values[FoodScreen.HOJE_KEYS[k]] = null; });
    FoodScreen.hoje_().write('food', values);
  },

  /** Re-renders Meta × realizado when the screen shows `date` (no-op without Hoje). */
  refresh(date) {
    if (FoodScreen.impl_) {
      if (typeof FoodScreen.impl_.refresh === 'function') FoodScreen.impl_.refresh(date);
      return;
    }
    if (typeof Hoje === 'undefined' || !Tabs.findSheet(Hoje.TAB)) return;
    if (Dates.sameDay(Hoje.date(), date)) Hoje.renderDayStatus(date);
  },

  normalize_(raw) {
    const text = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
    const num = (v) => {
      if (v === null || v === undefined || v === '') return null;
      const n = Units.parseQty(v);
      return n === null ? v : n;
    };
    const date = (v) => (v === null || v === undefined || v === '' ? null : (Dates.parse(v) || v));
    return {
      date: date(raw.date),
      favorite: text(raw.favorite),
      portions: num(raw.portions),
      meal: text(raw.meal),
      food: text(raw.food),
      quantity: num(raw.quantity),
      unit: text(raw.unit),
      measurement: text(raw.measurement),
      copyFromDate: date(raw.copyFromDate),
      copyMeal: text(raw.copyMeal),
      noCalcDescription: text(raw.noCalcDescription),
      note: text(raw.note),
    };
  },
};

/* ------------------------------------------------------------------------ actions ----------- */

/** Runs a food action body, then clears the consumed screen fields and refreshes Hoje. */
function foodScreenAction_(keys, body) {
  const r = body();
  FoodScreen.clear(keys);
  const dates = [];
  (r && r.dates ? r.dates : []).forEach((d) => { if (!dates.some((x) => Dates.sameDay(x, d))) dates.push(d); });
  dates.forEach((d) => FoodScreen.refresh(d));
  return r;
}

/** Asks for a text in a dialog (menu only: prompts do not work on mobile); null when cancelled. */
function foodPrompt_(title, message) {
  const ui = SpreadsheetApp.getUi();
  const res = ui.prompt(title, message, ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return null;
  return String(res.getResponseText() || '').trim();
}

Actions.register({
  id: 'foodAdd', label: 'Lançar alimento', group: 'food', order: 10, quick: true,
  run: () => foodScreenAction_(['food', 'quantity', 'note'], () => {
    const s = FoodScreen.read();
    if (!s.food) throw new Error('Escolha o alimento em Hoje.');
    if (s.quantity === null) throw new Error('Informe a quantidade em Hoje.');
    return FoodLog.add({ date: s.date, meal: s.meal, food: s.food, qty: s.quantity, unit: s.unit, measure: s.measurement, note: s.note });
  }),
});

Actions.register({
  id: 'foodAddFavorite', label: 'Lançar favorita', group: 'food', order: 20, quick: true,
  run: () => foodScreenAction_(['favorite', 'portions'], () => {
    const s = FoodScreen.read();
    if (!s.favorite) throw new Error('Escolha a favorita em Hoje.');
    return FoodLog.addFavorite({ date: s.date, meal: s.meal, name: s.favorite, portions: s.portions });
  }),
});

Actions.register({
  id: 'foodAddNoCalc', label: 'Lançar sem cálculo', group: 'food', order: 30, quick: true,
  run: () => foodScreenAction_(['noCalcDescription', 'note'], () => {
    const s = FoodScreen.read();
    return FoodLog.addNoCalc({ date: s.date, meal: s.meal, description: s.noCalcDescription, note: s.note });
  }),
});

Actions.register({
  id: 'foodCopy', label: 'Copiar refeição/dia', group: 'food', order: 40, quick: true,
  run: () => foodScreenAction_(['copyFromDate'], () => {
    const s = FoodScreen.read();
    return FoodLog.copy({ from: s.copyFromDate, to: s.date, meal: s.copyMeal });
  }),
});

Actions.register({
  id: 'foodCorrect', label: 'Corrigir linha selecionada', group: 'food', order: 50,
  run: () => foodScreenAction_([], () => {
    const rows = FoodLog.selection();
    if (rows.length !== 1) throw new Error('Selecione uma única linha para corrigir.');
    const r = Tabs.readRow('food', rows[0]);
    const text = foodPrompt_('Corrigir quantidade', `${r.food}: ${Units.fmt(r.qty)} ${r.unit || ''}. Nova quantidade (ex.: 150 ou 2 un):`);
    if (text === null) return { message: 'Correção cancelada.' };
    const amount = Units.parseAmount(text);
    if (!amount) throw new Error(`Quantidade inválida: "${text}".`);
    return FoodLog.correct(rows[0], { qty: amount.qty, unit: amount.unit || r.unit });
  }),
});

Actions.register({
  id: 'foodDelete', label: 'Excluir linha selecionada', group: 'food', order: 60,
  run: () => foodScreenAction_([], () => FoodLog.remove(FoodLog.selection())),
});
