/**
 * Progression (spec §6.1 training, §8): work-set history per exercise, session comparison,
 * weekly training summary for the weekly engine, and progression suggestions for approval.
 *
 * Only Work 1 and Work 2 count; warm-up and feeder never enter a comparison or a volume. Two
 * sessions of an exercise are compared set by set (Work 1 with Work 1, Work 2 with Work 2), and
 * only when they used the same "Equipamento / carga" text (the same load convention; empty on
 * both counts as the same). A set progressed when its load went up at the same or more reps, or
 * its reps went up at the same load, and its RIR is the same or higher (not harder); it regressed
 * in the mirror case. A session progressed when at least one set progressed and none regressed.
 *
 * Nothing here changes a plan, a load or a target: suggestions are text for a person to approve
 * (Progressão tab and a Revisões row "A revisar"); approving means saving a new plan.
 */
const Progression = {
  RESULT: { UP: 'progressed', HELD: 'held', DOWN: 'regressed' },
  LABELS: { progressed: 'Progrediu', held: 'Manteve', regressed: 'Regrediu' },
  NO_COMPARISON: 'Sem comparação',
  /** History block on the Progressão tab, to the right of the summary table. */
  HISTORY: {
    MIN_COL: 11, GAP: 1, PICKER_ROW: 4, ROWS: 20,
    PICKER_LABEL: 'Exercício',
    HEADERS: ['Data', 'Treino', 'Versão da ficha', 'W1 kg', 'W1 reps', 'W1 RIR', 'W2 kg', 'W2 reps', 'W2 RIR', 'Volume work', 'Estado', 'Leitura'],
  },
  REVIEW_AREA: 'Treino',
  REVIEW_STATUS: 'A revisar',

  /** Work sets done in a Registro row: [{n, kg, reps, rir}] (reps > 0 and kg given). */
  workSets(row) {
    const out = [];
    Workouts.WORK_SETS.forEach((w) => {
      const reps = row[w.reps];
      const kg = row[w.kg];
      if (typeof reps === 'number' && reps > 0 && typeof kg === 'number') {
        out.push({ n: w.n, kg, reps, rir: typeof row[w.rir] === 'number' ? row[w.rir] : null });
      }
    });
    return out;
  },

  /** A Registro row as a history entry. */
  entry(row) {
    const sets = Progression.workSets(row);
    return {
      date: row.date, session: String(row.session).trim(), exercise: String(row.exercise).trim(),
      plan: row.plan, state: row.sessionState, equipment: row.equipment === null || row.equipment === undefined ? null : String(row.equipment).trim(),
      sets, volume: sets.reduce((s, x) => s + x.kg * x.reps, 0), row: row._row,
    };
  },

  /**
   * {normalized exercise: entries with at least one work set, chronological} from Registro rows.
   */
  index(rows) {
    const out = {};
    (rows || Workouts.rows()).forEach((r) => {
      const e = Progression.entry(r);
      if (!e.sets.length) return;
      const key = Exercises.normalize(e.exercise);
      (out[key] = out[key] || []).push(e);
    });
    Object.keys(out).forEach((k) => out[k].sort((a, b) => Dates.compare(a.date, b.date) || a.row - b.row));
    return out;
  },

  /**
   * Work-set history of one exercise, oldest first.
   * @param {{from?, to?}} opts inclusive date bounds
   */
  history(exercise, opts) {
    const o = opts || {};
    const list = Progression.index()[Exercises.normalize(exercise)] || [];
    return list.filter((e) => (!o.from || Dates.compare(e.date, o.from) >= 0) && (!o.to || Dates.compare(e.date, o.to) <= 0));
  },

  /** Latest entry strictly before `date` (sessions of the same date are not a reference), or null. */
  previous(entries, date) {
    for (let i = entries.length - 1; i >= 0; i--) {
      if (Dates.compare(entries[i].date, date) < 0) return entries[i];
    }
    return null;
  },

  /** Last work sets of `exercise` before `date`, or null. */
  lastWork(exercise, date) {
    return Progression.previous(Progression.history(exercise), Dates.require(date, 'Data'));
  },

  /** "22/09 · Upper: 40 kg × 10 (RIR 1) · 40 kg × 9 (RIR 0)" */
  referenceText(e) {
    if (!e) return '';
    return `${Dates.format(e.date).slice(0, 5)} · ${e.session}: ${Progression.setsText(e.sets)}`;
  },

  setsText(sets) {
    return sets.map((s) => `${Fmt.num(s.kg)} kg × ${s.reps}${s.rir === null ? '' : ` (RIR ${Fmt.num(s.rir)})`}`).join(' · ');
  },

  /** 1 progressed, -1 regressed, 0 neither, for one pair of sets. */
  compareSet_(a, b) {
    const harder = a.rir !== null && b.rir !== null && b.rir < a.rir;
    const easier = a.rir !== null && b.rir !== null && b.rir > a.rir;
    const up = (b.kg > a.kg && b.reps >= a.reps) || (b.kg === a.kg && b.reps > a.reps);
    const down = (b.kg < a.kg && b.reps <= a.reps) || (b.kg === a.kg && b.reps < a.reps);
    if (up && !harder) return 1;
    if (down && !easier) return -1;
    return 0;
  },

  /**
   * prev → cur: 'progressed' | 'held' | 'regressed', or null when they cannot be compared
   * (no common work set, or a different equipment/load convention).
   */
  compare(prev, cur) {
    if (!prev || !cur || !prev.sets.length || !cur.sets.length) return null;
    if (prev.equipment && cur.equipment && Exercises.normalize(prev.equipment) !== Exercises.normalize(cur.equipment)) return null;
    let ups = 0;
    let downs = 0;
    let pairs = 0;
    cur.sets.forEach((b) => {
      const a = prev.sets.find((s) => s.n === b.n);
      if (!a) return;
      pairs += 1;
      const r = Progression.compareSet_(a, b);
      if (r > 0) ups += 1;
      if (r < 0) downs += 1;
    });
    if (!pairs) return null;
    if (ups && !downs) return Progression.RESULT.UP;
    if (downs && !ups) return Progression.RESULT.DOWN;
    return Progression.RESULT.HELD;
  },

  /**
   * Training aggregate of [start, end] for the weekly engine (spec §6.1):
   * {start, end, sessions (concluded), partialSessions, sessionList: [{date, session, state}],
   *  workSets, workVolume (Σ work kg×reps; null when no work set), workVolumeByGroup (alias
   *  volumeByGroup): {group: volume}, comparedExercises, progressedExercises: [names],
   *  heldExercises, regressedExercises (the three lists are null when nothing could be compared:
   *  unknown is not zero)}
   * Volume counts every saved work set in the range (a partial session's sets were done too);
   * `sessions` counts only concluded ones. Each exercise trained in the range is compared once:
   * its last entry in the range against the last entry before the range (or, when there is none,
   * its first entry in the range). Group: Exercícios, else the plan row, else "Sem grupo".
   */
  weekSummary(start, end) {
    const s = Dates.require(start, 'Início');
    const e = Dates.require(end || Dates.addDays(s, 6), 'Fim');
    const rows = Workouts.rows();
    const inRange = (d) => Dates.within(d, s, e);
    const catalogue = Exercises.list();
    const planRowsCache = {};
    const planRowsOf = (id) => {
      if (!id) return [];
      if (!(id in planRowsCache)) { const v = Plans.get(String(id)); planRowsCache[id] = v ? v.rows : []; }
      return planRowsCache[id];
    };
    const sessionList = [];
    const byGroup = {};
    let volume = 0;
    let workSets = 0;
    const days = {};
    rows.filter((r) => inRange(r.date)).forEach((r) => {
      const k = Dates.key(r.date);
      if (!days[k]) days[k] = true;
      const sets = Progression.workSets(r);
      if (!sets.length) return;
      const v = sets.reduce((sum, x) => sum + x.kg * x.reps, 0);
      const group = Exercises.groupOf(r.exercise, planRowsOf(r.plan), catalogue) || 'Sem grupo';
      byGroup[group] = Math.round(((byGroup[group] || 0) + v) * 100) / 100;
      volume += v;
      workSets += sets.length;
    });
    Object.keys(days).sort().forEach((k) => {
      Workouts.sessionsOn(rows, Dates.fromKey(k)).forEach((x) => sessionList.push({ date: k, session: x.session, state: x.state }));
    });

    const idx = Progression.index(rows);
    const progressed = [];
    const held = [];
    const regressed = [];
    let compared = 0;
    Object.keys(idx).forEach((key) => {
      const list = idx[key];
      const inside = list.filter((x) => inRange(x.date));
      if (!inside.length) return;
      const before = list.filter((x) => Dates.compare(x.date, s) < 0);
      const cur = inside[inside.length - 1];
      const prev = before.length ? before[before.length - 1] : (inside.length > 1 ? inside[0] : null);
      const r = Progression.compare(prev, cur);
      if (!r) return;
      compared += 1;
      if (r === Progression.RESULT.UP) progressed.push(cur.exercise);
      else if (r === Progression.RESULT.DOWN) regressed.push(cur.exercise);
      else held.push(cur.exercise);
    });
    const measured = compared > 0;
    return {
      start: Dates.key(s), end: Dates.key(e),
      sessions: sessionList.filter((x) => x.state === Sessions.STATE.DONE).length,
      partialSessions: sessionList.filter((x) => x.state !== Sessions.STATE.DONE).length,
      sessionList, workSets, workVolume: workSets ? Math.round(volume * 100) / 100 : null,
      workVolumeByGroup: byGroup, volumeByGroup: byGroup,
      comparedExercises: compared,
      progressedExercises: measured ? progressed : null,
      heldExercises: measured ? held : null,
      regressedExercises: measured ? regressed : null,
    };
  },

  /**
   * Proposals for the plan in force on `date` (default today); never writes.
   * - kind 'load': the last `analysis.progressionSessions` sessions of an exercise all reached
   *   the top of the rep range in every prescribed work set, at the same load and equipment →
   *   propose load + `routine.loadIncrementKg`;
   * - kind 'review': the last `analysis.progressionSessions` comparisons all regressed → review
   *   load/recovery with the reviewer.
   * @returns {{exercise, session, kind, currentKg?, suggestedKg?, incrementKg?, dates: string[], text}[]}
   */
  suggestions(date) {
    const d = date ? Dates.require(date, 'Data') : Dates.today();
    const plan = Plans.on(d);
    if (!plan) return [];
    const phase = Sessions.phaseOn(d, plan);
    const k = Math.max(1, Config.get('analysis.progressionSessions') || 1);
    const inc = Config.get('routine.loadIncrementKg');
    const idx = Progression.index();
    const out = [];
    const seen = {};
    plan.rows.forEach((pr) => {
      if (pr.exercise === null) return;
      const key = Exercises.normalize(pr.exercise);
      if (seen[key]) return;
      seen[key] = true;
      const list = (idx[key] || []).filter((e) => Dates.compare(e.date, d) <= 0);
      const p = Sessions.prescription(pr, phase);
      const name = String(pr.exercise).trim();
      const last = list.slice(-k);
      if (last.length === k && p && p.repsMax !== null && inc) {
        const need = p.sets || 1;
        const kg = last[k - 1].sets[0].kg;
        const eq = Exercises.normalize(last[k - 1].equipment);
        const ok = last.every((e) => e.sets.length >= need && Exercises.normalize(e.equipment) === eq
          && e.sets.slice(0, need).every((s) => s.reps >= p.repsMax && s.kg === kg));
        if (ok) {
          const rirs = [];
          last.forEach((e) => e.sets.forEach((s) => { if (s.rir !== null) rirs.push(s.rir); }));
          const rirText = rirs.length ? ` a ${Math.min(...rirs) === Math.max(...rirs) ? `${Fmt.num(rirs[0])}` : `${Fmt.num(Math.min(...rirs))}–${Fmt.num(Math.max(...rirs))}`} RIR` : '';
          const reps = Math.min(...last.map((e) => Math.min(...e.sets.slice(0, need).map((s) => s.reps))));
          const next = Math.round((kg + inc) * 100) / 100;
          out.push({
            exercise: name, session: String(pr.session).trim(), kind: 'load', currentKg: kg, suggestedKg: next, incrementKg: inc,
            dates: last.map((e) => Dates.key(e.date)),
            text: `${name}: ${need}×${reps}${rirText} em ${k} ${k === 1 ? 'sessão' : 'sessões'} com ${Fmt.num(kg)} kg → sugerir ${Fmt.num(next)} kg (+${Fmt.num(inc)} kg). Aprovar com o revisor antes de mudar.`,
          });
          return;
        }
      }
      if (list.length > k) {
        const tail = list.slice(-(k + 1));
        let all = true;
        for (let i = 1; i < tail.length; i++) if (Progression.compare(tail[i - 1], tail[i]) !== Progression.RESULT.DOWN) all = false;
        if (all) {
          out.push({
            exercise: name, session: String(pr.session).trim(), kind: 'review', dates: tail.slice(1).map((e) => Dates.key(e.date)),
            text: `${name}: queda em ${k} ${k === 1 ? 'sessão' : 'sessões'} seguidas → revisar carga e recuperação com o revisor.`,
          });
        }
      }
    });
    return out;
  },

  /** Column of the history block (right of the summary table). */
  historyCol_() {
    const map = Tabs.headerMap('progression');
    const width = Math.max(0, ...Object.keys(map).map((k) => map[k]));
    return Math.max(Progression.HISTORY.MIN_COL, width + 1 + Progression.HISTORY.GAP);
  },

  /** A1 of the exercise picker cell of the Progressão tab (Setup puts the validation list there). */
  pickerCell() {
    return `${Progression.colLetter_(Progression.historyCol_() + 1)}${Progression.HISTORY.PICKER_ROW}`;
  },

  colLetter_(n) {
    let s = '';
    let x = n;
    while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); }
    return s;
  },

  /**
   * Renders the Progressão tab as values: the summary table (one row per exercise of the plan in
   * force: last work sets, RIR, trend, suggestion) and, to the right, the picker and the last
   * sessions of the chosen exercise. `exercise` defaults to the picker value, then to the first
   * exercise of the plan. A derived view: written directly (not logged for undo).
   * @returns {{exercise: ?string, rows: number, history: number, suggestions: Object[]}}
   */
  refreshProgressionTab(exercise, date) {
    const d = date ? Dates.require(date) : Dates.today();
    const sheet = Tabs.sheet('progression');
    const spec = Tabs.get('progression');
    const map = Tabs.headerMap('progression');
    const width = Math.max(0, ...Object.keys(map).map((k) => map[k]));
    if (!width) throw new Error('A aba Progressão não tem cabeçalho. Rode Projeto → Sistema → Reaplicar layout.');
    const plan = Plans.on(d);
    const idx = Progression.index();
    const sugg = Progression.suggestions(d);
    const catalogue = Exercises.list();
    const lines = [];
    const order = [];
    (plan ? plan.rows : []).forEach((pr) => {
      if (pr.exercise === null) return;
      const key = Exercises.normalize(pr.exercise);
      let item = order.find((x) => x.key === key);
      if (!item) { item = { key, name: String(pr.exercise).trim(), sessions: [], planRows: [] }; order.push(item); }
      if (pr.session && item.sessions.indexOf(String(pr.session).trim()) < 0) item.sessions.push(String(pr.session).trim());
      item.planRows.push(pr);
    });
    order.forEach((item) => {
      const list = (idx[item.key] || []).filter((e) => Dates.compare(e.date, d) <= 0);
      const last = list.length ? list[list.length - 1] : null;
      const prev = list.length > 1 ? list[list.length - 2] : null;
      const r = Progression.compare(prev, last);
      const s = sugg.filter((x) => Exercises.normalize(x.exercise) === item.key).map((x) => x.text).join(' ');
      const values = {
        exercise: item.name, group: Exercises.groupOf(item.name, item.planRows, catalogue), session: item.sessions.join(', '),
        lastDate: last ? last.date : null, lastWork: last ? Progression.setsText(last.sets) : 'Sem registro',
        rir: last && last.sets[last.sets.length - 1].rir !== null ? last.sets[last.sets.length - 1].rir : null,
        trend: r ? Progression.LABELS[r] : Progression.NO_COMPARISON, suggestion: s || null, plan: plan.id,
      };
      const line = [];
      for (let c = 1; c <= width; c++) line.push('');
      Object.keys(values).forEach((k) => { if (map[k]) line[map[k] - 1] = values[k] === null ? '' : values[k]; });
      lines.push(line);
    });
    const first = spec.firstDataRow;
    const lastRow = sheet.getLastRow();
    if (lastRow >= first) sheet.getRange(first, 1, lastRow - first + 1, width).clearContent();
    if (lines.length) sheet.getRange(first, 1, lines.length, width).setValues(lines);

    // History block.
    const H = Progression.HISTORY;
    const col = Progression.historyCol_();
    const pickerA1 = Progression.pickerCell();
    const picked = exercise || sheet.getRange(pickerA1).getValue() || (order.length ? order[0].name : '');
    const name = picked ? String(picked).trim() : '';
    sheet.getRange(H.PICKER_ROW, col).setValue(H.PICKER_LABEL);
    sheet.getRange(pickerA1).setValue(name);
    sheet.getRange(spec.headerRow, col, 1, H.HEADERS.length).setValues([H.HEADERS]);
    sheet.getRange(first, col, H.ROWS, H.HEADERS.length).clearContent();
    const hist = name ? (idx[Exercises.normalize(name)] || []).filter((e) => Dates.compare(e.date, d) <= 0) : [];
    const recent = hist.slice(-H.ROWS).reverse();
    const hLines = recent.map((e, i) => {
      const prev = recent[i + 1] || null;
      const set = (n) => e.sets.find((s) => s.n === n) || { kg: '', reps: '', rir: null };
      const w1 = set(1);
      const w2 = set(2);
      const r = Progression.compare(prev, e);
      return [e.date, e.session, e.plan || '', w1.kg, w1.reps, w1.rir === null ? '' : w1.rir, w2.kg, w2.reps, w2.rir === null ? '' : w2.rir,
        Math.round(e.volume * 100) / 100, e.state || '', r ? Progression.LABELS[r] : (prev ? Progression.NO_COMPARISON : 'Primeiro registro')];
    });
    if (hLines.length) sheet.getRange(first, col, hLines.length, H.HEADERS.length).setValues(hLines);
    return { exercise: name || null, rows: lines.length, history: hLines.length, suggestions: sugg };
  },

  /**
   * Action "Sugestões de progressão": renders Progressão and records each new suggestion as a
   * Revisões row (Área Treino, Status A revisar) for approval, once per text. Never touches the
   * plan, the draft or the training log.
   */
  runSuggestions(date) {
    const d = Dates.require(date || Dates.today(), 'Data');
    const view = Progression.refreshProgressionTab(null, d);
    const canRecord = !!Tabs.findSheet('reviews');
    const pending = canRecord ? Tabs.read('reviews').filter((r) => r.area === Progression.REVIEW_AREA && r.status === Progression.REVIEW_STATUS).map((r) => String(r.change || '')) : [];
    const fresh = canRecord ? view.suggestions.filter((s) => pending.indexOf(s.text) < 0) : [];
    if (fresh.length) {
      const ids = Days.idsOn(d);
      Tabs.appendMany('reviews', fresh.map((s) => ({
        date: d, area: Progression.REVIEW_AREA, reason: s.kind === 'load' ? 'Sugestão de progressão (topo da faixa de reps)' : 'Queda de desempenho',
        change: s.text, reviewer: Config.get('client.reviewer'), status: Progression.REVIEW_STATUS,
        objective: ids.objective, goal: ids.goal, plan: ids.plan, recommendation: 'REVISAR TREINO',
      })));
    }
    const n = view.suggestions.length;
    return {
      message: n ? `${n} ${n === 1 ? 'sugestão' : 'sugestões'} de progressão (${fresh.length} nova(s) em Revisões para aprovação). Nada foi alterado na ficha.` : 'Nenhuma sugestão de progressão agora.',
      suggestions: view.suggestions, recorded: fresh.length,
    };
  },
};
