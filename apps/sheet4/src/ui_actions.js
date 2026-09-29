/**
 * Hoje/day actions (spec §5.3) and the installable onEdit handler (spec §2.7).
 *
 * Registered actions (group Hoje; quick = also in the Ação rápida dropdown):
 *   loadDay    Carregar dia   quick  Diário values of the screen date → Hoje (not logged: a view)
 *   saveDay    Salvar dia     quick  Hoje diary card → Diário via Diary.save (empty cell = keep,
 *                                    "-"/"limpar" = erase, 0 = zero), then reloads the screen
 *   clearScreen Limpar tela   quick  empties the diary, food and training cards (not logged)
 *   goToday    Ir para hoje   quick  sets the date to today and loads it
 *   goToDate   Ir para data          asks for a date (menu only: prompts do not work on mobile)
 *
 * onEditInstalled(e) — installable trigger created by Setup (handler name 'onEditInstalled'):
 *   Hoje!B4 (Hoje.QUICK_CELL) changed → Actions.runQuick(label), then the cell goes back to '—';
 *   Hoje!B5 (Hoje.DATE_CELL) changed  → Carregar dia for the new date;
 *   Medidas e fotos data row edited   → stamps that row's Objetivo.
 *
 * Events for other modules (Core.on): 'hoje.loaded' ({date}) after the screen shows a date (Food
 * and Workout may fill their cards); 'day.saved' comes from Diary.save.
 */
const HojeActions = {
  /** Carregar dia: header, diary card and Meta × realizado for the date (the date cell if omitted). */
  loadDay(date) {
    Hoje.ensure();
    const d = date ? Dates.require(date, 'Data') : Hoje.date();
    const saved = Diary.load(d) || {};
    const values = {};
    Object.keys(Diary.FIELDS).forEach((k) => { values[k] = saved[k] === undefined ? null : saved[k]; });
    Hoje.write('diary', values);
    Hoje.renderHeader(d);
    Hoje.renderDayStatus(d);
    Core.emit('hoje.loaded', { date: d });
    return { message: Diary.load(d) ? `Dia ${Dates.format(d)} carregado.` : `Dia ${Dates.format(d)} sem registro no Diário.`, date: Dates.key(d) };
  },

  /** Salvar dia. */
  saveDay() {
    const d = Hoje.date();
    const screen = Hoje.read().diary;
    const fields = {};
    Object.keys(Diary.FIELDS).forEach((k) => {
      const v = screen[k];
      if (v === Hoje.CLEAR) fields[k] = null;
      else if (v !== null) fields[k] = v;
    });
    const r = Diary.save(d, fields);
    HojeActions.loadDay(d);
    const n = r.changed.length;
    return {
      message: n ? `Dia ${Dates.format(d)} salvo (${n} ${n === 1 ? 'campo alterado' : 'campos alterados'}). Estado: ${r.dayState}.`
        : `Nada mudou em ${Dates.format(d)}.`,
      changed: r.changed, dayState: r.dayState,
    };
  },

  clearScreen() {
    ['diary', 'food', 'training'].forEach((s) => Hoje.clear(s));
    return { message: 'Tela limpa. Nada foi apagado do Diário.' };
  },

  goToday() {
    return HojeActions.loadDay(Dates.today());
  },

  /** Asks for a date (empty = today) and loads it; args.date skips the prompt. */
  goToDate(args) {
    let raw = args && args.date;
    if (raw === undefined) {
      const ui = SpreadsheetApp.getUi();
      const res = ui.prompt('Ir para data', 'Data (dd/mm/aaaa). Vazio = hoje.', ui.ButtonSet.OK_CANCEL);
      if (res.getSelectedButton() !== ui.Button.OK) return null;
      raw = res.getResponseText();
    }
    const text = raw === null || raw === undefined ? '' : raw;
    if (typeof text === 'string' && !text.trim()) return HojeActions.loadDay(Dates.today());
    const d = Dates.parse(text);
    if (!d) throw new Error(`Data inválida: ${JSON.stringify(String(text))}. Use dd/mm/aaaa.`);
    return HojeActions.loadDay(d);
  },
};

Actions.register({ id: 'loadDay', label: 'Carregar dia', group: 'today', order: 10, quick: true, logged: false, run: () => HojeActions.loadDay() });
Actions.register({ id: 'saveDay', label: 'Salvar dia', group: 'today', order: 20, quick: true, run: () => HojeActions.saveDay() });
Actions.register({ id: 'goToday', label: 'Ir para hoje', group: 'today', order: 80, quick: true, logged: false, run: () => HojeActions.goToday() });
Actions.register({ id: 'goToDate', label: 'Ir para data', group: 'today', order: 81, logged: false, run: (args) => HojeActions.goToDate(args) });
Actions.register({ id: 'clearScreen', label: 'Limpar tela', group: 'today', order: 90, quick: true, logged: false, run: () => HojeActions.clearScreen() });

/**
 * Installable onEdit handler (Setup creates the trigger). Never throws: errors become toasts.
 * @param {{range: Range, value?: *}} e
 */
function onEditInstalled(e) {
  try {
    if (!e || !e.range) return;
    const sheet = e.range.getSheet();
    const name = sheet.getName();
    const row = e.range.getRow();
    const col = e.range.getColumn();
    const single = e.range.getNumRows() === 1 && e.range.getNumColumns() === 1;
    if (name === Tabs.get(Hoje.TAB).name && single) {
      const [qr, qc] = Hoje.rc_(Hoje.QUICK_CELL);
      const [dr, dc] = Hoje.rc_(Hoje.DATE_CELL);
      if (row === qr && col === qc) {
        const label = e.value !== undefined ? e.value : e.range.getValue();
        try {
          Actions.runQuick(label);
        } finally {
          sheet.getRange(Hoje.QUICK_CELL).setValue(Actions.QUICK_EMPTY);
        }
        return;
      }
      if (row === dr && col === dc) {
        Actions.run('loadDay');
        return;
      }
    }
    if (name === Tabs.get('measures').name && row + e.range.getNumRows() - 1 >= Tabs.get('measures').firstDataRow) {
      Core.withLock(() => {
        const first = Math.max(row, Tabs.get('measures').firstDataRow);
        for (let r = first; r < row + e.range.getNumRows(); r++) Measures.stampRow(r);
      });
    }
  } catch (err) {
    Actions.fail_(err);
  }
}
