/**
 * Painel (spec §10): the objective in force, its goals, the state of the running and last closed
 * week, the recommendation, the timeline of phases and the long-term charts. Everything is written
 * as VALUES on each render (no live formulas that would re-evaluate history), except the
 * navigation links (HYPERLINK to other tabs).
 *
 *   Dashboard.model()   pure read: what the Painel shows (tests assert on it)
 *   Dashboard.render()  clears and rewrites the Painel + the hidden chart data block + charts
 *   Dashboard.renderSafely_()  render when the Painel exists; errors logged, never thrown
 *
 * Only the objective in force (Objectives.current()) appears in the header, the phase card, the
 * goals and the state/recommendation cards: a week that belongs to another objective is shown as
 * "semana da fase anterior". History appears only in the timeline and in the charts.
 *
 * Cell map (columns A–E visible; phone shows A–B first):
 *   1  navigation links (A1:E1)          2  title (A2:E2)          3  help + "Atualizado em" (A3:E3)
 *   5  header band "OBJETIVO ATUAL — O001 · …" (A5:E5)   6  since · week · reviewer · ids (A6:E6)
 *   8  Fase atual       9 Início · 10 Peso médio 7d · 11 Cintura · 12 Faixa alvo
 *                       (A label · B main value · C:E detail)
 *   14 Metas atuais — Mxxx  15 kcal · 16 Proteína · 17 Gordura · 18 Carboidrato · 19 Fibra ·
 *                       20 Treinos · 21 Passos · 22 TMB (estimado) · 23 Gasto estimado ·
 *                       24 Dieta base (planejado)
 *   26 Estado atual     27 column heads (B:C esta semana · D:E semana anterior)
 *                       28 Tendência de peso · 29 Cintura · 30 Alimentação · 31 Desempenho ·
 *                       32 Recuperação · 33 Aderência ao treino · 34 Situação geral
 *                       (A indicator · B chip · C text · D chip · E text)
 *   36 Recomendação     37 Código (B chip, C:E motivo) · 38 Dados usados (B:E) · 39 Próxima revisão
 *   41 Linha do tempo das fases  42 heads (Fase · Período · Duração · Peso · Cintura), then two
 *                       rows per objective (values; status chip + outcome)
 *   then  Evolução: the weight chart and, below it, the waist chart (anchored in column A)
 * Rows of an empty card collapse to 4 px and its first row holds the empty-state text.
 *
 * Hidden chart data (columns H onwards, hidden): H1 caption, I1 chart signature; weight block
 * from H2 (Semana | one column per objective | Mudança de fase), then one empty column and the
 * waist block with the same shape. Each objective column holds the weeks whose Sunday belongs
 * to it plus the week before its first one (so the line is continuous and changes colour at the
 * transition); "Mudança de fase" holds the value of each first week of a new objective (markers).
 * Charts read it with "plot hidden data" on and are rebuilt only when its shape changes.
 */
const Dashboard = {
  TAB: 'dashboard',
  COLS: 5,
  WIDTHS: [160, 130, 190, 130, 190],
  HELPER_COL: 8,
  CHART: { width: 800, height: 320, rows: 16 },
  CHART_TITLES: { weight: 'Peso — média de 7 dias (kg)', waist: 'Cintura (cm)' },
  TEXT: {
    empty: 'Sem dados ainda — registre o primeiro dia em Hoje.',
    noObjective: 'Nenhum objetivo em vigor — crie o primeiro em Projeto → Fase e metas → Mudar objetivo/fase.',
    noGoal: 'Nenhuma meta em vigor — crie em Projeto → Fase e metas → Nova meta.',
    noRecommendation: 'Sem dados ainda — a primeira recomendação aparece quando houver uma semana registrada.',
    noPhases: 'Nenhuma fase registrada ainda.',
    noCharts: 'Sem dados ainda — os gráficos aparecem quando houver semanas registradas.',
    previousPhase: 'Semana da fase anterior — veja a linha do tempo.',
    helperCaption: 'Dados dos gráficos (gerado pelo script; não editar)',
    marker: 'Mudança de fase',
  },

  /* Formatting ------------------------------------------------------------------------------ */

  isNum_(v) {
    return typeof v === 'number' && isFinite(v);
  },

  /** Portuguese number: 2400 → "2.400", 79.35 → "79,4" (digits), −0.5 → "−0,5"; '—' when missing. */
  n_(v, digits, signed) {
    if (!Dashboard.isNum_(v)) return '—';
    const d = digits === undefined ? 1 : digits;
    const f = Math.pow(10, d);
    const r = Math.round(Math.abs(v) * f) / f;
    const [i, frac] = r.toFixed(d).split('.');
    const body = i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (frac ? `,${frac}` : '');
    const neg = v < 0 && r !== 0;
    return `${neg ? '−' : signed && r !== 0 ? '+' : ''}${body}`;
  },

  pct_(v) {
    return Dashboard.isNum_(v) ? `${Math.round(v * 100)}%` : '—';
  },

  d_(v) {
    return Dates.format(v) || '—';
  },

  /** "05/10" of a date. */
  dm_(v) {
    const s = Dates.format(v);
    return s ? s.slice(0, 5) : '—';
  },

  /* Model ----------------------------------------------------------------------------------- */

  has_(id) {
    return Boolean(Tabs.findSheet(id));
  },

  /**
   * Everything the Painel shows, as plain data.
   * @returns {{today, updatedAt, clientName, objective, goal, plan, phase, goals, state,
   *   recommendation, timeline, series}}
   */
  model() {
    const today = Dates.today();
    const has = Dashboard.has_;
    const cfg = (k) => { try { return Config.get(k); } catch (err) { return null; } };
    const o = has('objectives') ? Objectives.current() : null;
    const g = has('goals') ? Goals.current() : null;
    const p = has('plans') ? Plans.current() : null;
    const weeks = Weeks.list();
    const timeline = has('objectives') ? Weeks.phaseSummary() : [];
    const m = {
      today,
      updatedAt: new Date(),
      clientName: cfg('client.name'),
      objective: o, goal: g, plan: p,
      hasData: weeks.length > 0,
      phase: null, goals: null, state: null, recommendation: null,
      timeline,
      series: Dashboard.series_(),
    };
    if (o) m.phase = Dashboard.phaseCard_(o, g, p, timeline, weeks, today, cfg);
    if (g) m.goals = Dashboard.goalsCard_(g, cfg);
    m.state = Dashboard.stateCard_(o, weeks, today);
    m.recommendation = Dashboard.recommendationCard_(o, weeks, today);
    return m;
  },

  phaseCard_(o, g, p, timeline, weeks, today, cfg) {
    const f = o.fields;
    const summary = timeline.find((t) => t.id === o.id) || {};
    const days = Dates.diffDays(o.start, today) + 1;
    const week = Dates.diffDays(Dates.weekStart(o.start), Dates.weekStart(today)) / 7 + 1;
    const own = weeks.filter((w) => w.objective === o.id);
    const lastVal = (k) => { const r = own.slice().reverse().find((x) => Dashboard.isNum_(x[k])); return r ? r[k] : null; };
    const startW = Dashboard.isNum_(f.startWeightKg) ? f.startWeightKg : summary.startWeightKg;
    const startWaist = Dashboard.isNum_(f.startWaistCm) ? f.startWaistCm : summary.startWaistCm;
    const nowW = lastVal('weightAvg');
    const nowWaist = lastVal('waistCm');
    const rule = Rules.resolve(f.analysisType).rule;
    const range = Analysis.range({ rateMinPct: f.weightRateMinPct, rateMaxPct: f.weightRateMaxPct }, rule);
    return {
      id: o.id, name: f.name || '', type: rule.label, start: o.start, days, week,
      reviewer: f.reviewer || cfg('client.reviewer') || null,
      goalId: g ? g.id : null, planId: p ? p.id : null,
      startWeightKg: Dashboard.isNum_(startW) ? startW : null, weightKg: nowW,
      startWaistCm: Dashboard.isNum_(startWaist) ? startWaist : null, waistCm: nowWaist,
      rangeText: Analysis.rangeText(range) || 'sem faixa definida',
      expectation: f.expectation || null,
    };
  },

  goalsCard_(g, cfg) {
    const f = g.fields;
    const num = (v) => (Dashboard.isNum_(v) ? v : null);
    let bmr = num(f.bmr);
    let tdee = num(f.tdee);
    let method = f.bmrMethod || null;
    let factor = num(f.activityFactor);
    let energySource = 'meta';
    if (bmr === null) {
      try {
        const e = Energy.fromConfig({ date: g.start });
        if (e.bmr !== null) { bmr = e.bmr; tdee = e.tdee; method = e.methodLabel; factor = e.activityFactor; energySource = 'config'; }
      } catch (err) { /* incomplete profile: shown as — */ }
    }
    let baseDiet = null;
    try {
      if (Dashboard.has_('baseDiet') && typeof BaseDiet !== 'undefined') {
        const t = BaseDiet.totals();
        baseDiet = t && Dashboard.isNum_(t.kcal) ? t.kcal : null;
      }
    } catch (err) { baseDiet = null; }
    return {
      id: g.id, kcal: num(f.kcal), kcalTolerance: num(f.kcalTolerance), protein: num(f.protein),
      proteinMin: num(f.proteinMin), proteinMax: num(f.proteinMax), fat: num(f.fat), fatTolerance: num(f.fatTolerance),
      carbs: num(f.carbs), fiber: num(f.fiber), strengthPerWeek: num(f.strengthPerWeek), cardioPerWeek: num(f.cardioPerWeek),
      activitiesPerWeek: num(f.activitiesPerWeek), activities: cfg('routine.activities'), stepsPerDay: num(f.stepsPerDay),
      bmr, tdee, bmrMethod: method, activityFactor: factor, energySource, baseDietKcal: baseDiet,
    };
  },

  /** Stored rows of the running week and of the week before, each null or a row. */
  weekRows_(weeks, today) {
    const cur = Dates.key(Dates.weekStart(today));
    const prev = Dates.key(Dates.addDays(Dates.weekStart(today), -7));
    return {
      current: weeks.find((w) => Dates.key(w.start) === cur) || null,
      previous: weeks.find((w) => Dates.key(w.start) === prev) || null,
    };
  },

  signals_(row) {
    return String((row && row.signals) || '').split(',').map((s) => s.trim()).filter(Boolean);
  },

  /**
   * Six indicators + overall for one stored week row: [{key, label, chip, kind, text}].
   * `open` = the week has not ended (training adherence is "Em andamento").
   */
  indicators_(row, type, open) {
    const s = Dashboard.signals_(row);
    const has = (x) => s.indexOf(x) >= 0;
    const n = Dashboard.n_;
    const gain = /^ganho/.test(type || '');
    const out = [];
    // Weight
    let w;
    if (has('pesagens_insuficientes') || !Dashboard.isNum_(row.weightAvg)) w = ['Sem dados', 'insufficient'];
    else if (has('peso_na_faixa')) w = ['Na faixa', 'ok'];
    else if (has('peso_abaixo_faixa')) w = ['Abaixo da faixa', 'attention'];
    else if (has('peso_acima_faixa')) w = ['Acima da faixa', 'attention'];
    else w = ['Sem faixa', 'info'];
    const wt = Dashboard.isNum_(row.weightAvg)
      ? `${n(row.weightAvg, 1)} kg · ${n(row.weightDeltaPct, 2, true)}%/sem · ${row.weighIns || 0} pesagens`
      : `${row.weighIns || 0} pesagens`;
    out.push({ key: 'weight', label: 'Tendência de peso', chip: w[0], kind: w[1], text: wt });
    // Waist
    let c;
    if (!Dashboard.isNum_(row.waistCm)) c = ['Não medida', 'insufficient'];
    else if (has('cintura_caindo')) c = ['Caindo', gain ? 'info' : 'ok'];
    else if (has('cintura_subindo')) c = ['Subindo', gain ? 'info' : 'attention'];
    else if (has('cintura_estavel')) c = ['Estável', 'ok'];
    else c = ['Sem comparação', 'insufficient'];
    const ct = Dashboard.isNum_(row.waistCm)
      ? `${n(row.waistCm, 1)} cm${Dashboard.isNum_(row.waistDelta) ? ` (${n(row.waistDelta, 1, true)} cm)` : ''}`
      : 'Sem medida na semana';
    out.push({ key: 'waist', label: 'Cintura', chip: c[0], kind: c[1], text: ct });
    // Food
    let f;
    if (has('alimentacao_insuficiente')) f = ['Poucos dias', 'insufficient'];
    else if (['kcal_fora', 'proteina_baixa', 'gordura_fora', 'aderencia_baixa'].some(has)) f = ['Fora da meta', 'attention'];
    else f = ['Na meta', 'ok'];
    const ft = [`${row.foodCoverage || '0 dias'} completos`];
    if (Dashboard.isNum_(row.kcalAvg)) ft.push(`${n(row.kcalAvg, 0)} kcal`);
    if (Dashboard.isNum_(row.proteinAvg)) ft.push(`P ${n(row.proteinAvg, 0)} g`);
    if (Dashboard.isNum_(row.kcalAdherence)) ft.push(`aderência kcal ${Dashboard.pct_(row.kcalAdherence)}`);
    out.push({ key: 'food', label: 'Alimentação', chip: f[0], kind: f[1], text: ft.join(' · ') });
    // Performance
    let d;
    if (has('desempenho_subindo')) d = ['Subindo', 'ok'];
    else if (has('desempenho_caindo')) d = ['Caindo', 'attention'];
    else if (has('desempenho_mantido')) d = ['Mantido', 'ok'];
    else d = ['Sem comparação', 'insufficient'];
    const dt = Dashboard.isNum_(row.progressions) || Dashboard.isNum_(row.regressions)
      ? `${row.progressions || 0} com progressão · ${row.regressions || 0} com regressão`
      : 'Sem treinos comparáveis';
    out.push({ key: 'performance', label: 'Desempenho', chip: d[0], kind: d[1], text: dt });
    // Recovery
    const recVals = [row.sleepAvg, row.hungerAvg, row.fatigueAvg, row.painMax];
    let r;
    if (['sono_baixo', 'fadiga_alta', 'dor_alta', 'fome_alta'].some(has)) r = ['Atenção', 'attention'];
    else if (!recVals.some(Dashboard.isNum_)) r = ['Sem dados', 'insufficient'];
    else r = ['Boa', 'ok'];
    const rt = `Sono ${n(row.sleepAvg, 1)} h · Fome ${n(row.hungerAvg, 1)} · Cansaço ${n(row.fatigueAvg, 1)} · Dor máx ${n(row.painMax, 0)}`;
    out.push({ key: 'recovery', label: 'Recuperação', chip: r[0], kind: r[1], text: rt });
    // Training adherence
    let t;
    const goal = row.sessionsGoal;
    const done = Dashboard.isNum_(row.sessions) ? row.sessions : 0;
    if (!Dashboard.isNum_(goal)) t = ['Sem meta', 'info'];
    else if (done >= goal) t = ['Na meta', 'ok'];
    else if (open) t = ['Em andamento', 'info'];
    else t = ['Abaixo', 'attention'];
    const tt = [`${done} de ${Dashboard.isNum_(goal) ? goal : '—'} treinos`];
    if (Dashboard.isNum_(row.cardioMin) && row.cardioMin > 0) tt.push(`cardio ${n(row.cardioMin, 0)} min`);
    if (Dashboard.isNum_(row.activities)) tt.push(`${row.activities} ${row.activities === 1 ? 'atividade' : 'atividades'}`);
    out.push({ key: 'training', label: 'Aderência ao treino', chip: t[0], kind: t[1], text: tt.join(' · ') });
    // Overall
    out.push({
      key: 'overall', label: 'Situação geral', chip: row.status || '—', kind: Style.kindOf(row.status) || 'insufficient',
      text: row.reasons || '',
    });
    return out;
  },

  /** State card: {rows: [{label, current: {chip, kind, text}|null, previous: …}], currentLabel, previousLabel} or null. */
  stateCard_(o, weeks, today) {
    if (!weeks.length) return null;
    const { current, previous } = Dashboard.weekRows_(weeks, today);
    const type = o ? o.fields.analysisType : null;
    const mine = (row) => Boolean(row && o && row.objective === o.id);
    const labels = ['Tendência de peso', 'Cintura', 'Alimentação', 'Desempenho', 'Recuperação', 'Aderência ao treino', 'Situação geral'];
    const cur = mine(current) ? Dashboard.indicators_(current, type, true) : null;
    const prev = mine(previous) ? Dashboard.indicators_(previous, type, false) : null;
    const note = (row) => (!row ? { chip: '—', kind: 'insufficient', text: 'Sem registro nesta semana' }
      : { chip: '—', kind: 'insufficient', text: Dashboard.TEXT.previousPhase });
    const ws = Dates.weekStart(today);
    return {
      currentLabel: `Esta semana · ${Dashboard.dm_(ws)}–${Dashboard.dm_(today)}`,
      previousLabel: `Semana anterior · ${Dashboard.dm_(Dates.addDays(ws, -7))}–${Dashboard.dm_(Dates.addDays(ws, -1))}`,
      rows: labels.map((label, i) => ({
        label,
        current: cur ? cur[i] : (i === 0 ? note(current) : null),
        previous: prev ? prev[i] : (i === 0 ? note(previous) : null),
      })),
    };
  },

  /** Last closed week of the objective in force, else its running week; null without one. */
  recommendationCard_(o, weeks, today) {
    if (!o) return null;
    const own = weeks.filter((w) => w.objective === o.id && w.recommendation);
    if (!own.length) return null;
    const closed = own.filter((w) => w.end && Dates.compare(w.end, today) < 0);
    const row = closed.length ? closed[closed.length - 1] : own[own.length - 1];
    const parts = [`Semana ${Dashboard.dm_(row.start)}–${Dashboard.d_(row.end)}${closed.length && row === closed[closed.length - 1] ? ' (fechada)' : ' (em andamento)'}`];
    if (row.sufficiency) parts.push(row.sufficiency);
    if (row.targetRange) parts.push(`faixa alvo ${row.targetRange}`);
    if (row.signals) parts.push(`sinais: ${String(row.signals).replace(/_/g, ' ')}`);
    return {
      code: row.recommendation, kind: Style.kindOf(row.recommendation) || 'insufficient',
      reason: row.recommendationReason || '', data: parts.join(' · '),
      nextReview: row.nextReview || null, weekStart: row.start,
    };
  },

  /**
   * Chart data from Evolução: {phases: [{id, label}], rows: [{start, objective, weight, waist}]}.
   */
  series_() {
    if (!Dashboard.has_('evolution')) return { phases: [], rows: [] };
    const rows = Tabs.read('evolution').filter((r) => Dates.key(r.start))
      .sort((a, b) => Dates.compare(a.start, b.start))
      .map((r) => ({ start: r.start, objective: r.objective ? String(r.objective) : '', weight: r.weightAvg, waist: r.waistCm }));
    const names = {};
    if (Dashboard.has_('objectives')) Objectives.list().forEach((o) => { names[o.id] = o.fields.name || ''; });
    const phases = [];
    rows.forEach((r) => {
      if (!phases.some((p) => p.id === r.objective)) {
        phases.push({ id: r.objective, label: r.objective ? `${r.objective}${names[r.objective] ? ` · ${names[r.objective]}` : ''}` : 'Sem objetivo' });
      }
    });
    return { phases, rows };
  },

  /**
   * Helper block columns for one measure: header + one line per week:
   * [Semana, phase 1..P, Mudança de fase]. See the file header for the continuity rule.
   */
  block_(series, key) {
    const P = series.phases.length;
    const head = ['Semana'].concat(series.phases.map((p) => p.label), [Dashboard.TEXT.marker]);
    const lines = series.rows.map((r, i) => {
      const line = [r.start];
      const v = Dashboard.isNum_(r[key]) ? r[key] : '';
      const next = series.rows[i + 1];
      series.phases.forEach((p) => {
        const own = r.objective === p.id;
        const bridge = next && next.objective === p.id && r.objective !== p.id;
        line.push(own || bridge ? v : '');
      });
      const prev = series.rows[i - 1];
      line.push(prev && prev.objective !== r.objective ? v : '');
      return line;
    });
    return { head, lines, width: P + 2 };
  },

  /* Render ---------------------------------------------------------------------------------- */

  sheet_() {
    return Tabs.findSheet(Dashboard.TAB) || Tabs.ensure(Dashboard.TAB);
  },

  /** Navigation formulas to the layer-1 tabs other than `selfId`: [{label, formula}] (text when missing). */
  navLinks(selfId) {
    return Tabs.layer(Tabs.LAYERS.PERSON).filter((id) => id !== selfId).map((id) => {
      const spec = Tabs.get(id);
      const sheet = Tabs.findSheet(id);
      return sheet ? `=HYPERLINK("#gid=${sheet.getSheetId()}","${spec.name}")` : spec.name;
    });
  },

  /** Renders the Painel. @returns {{rows, charts, phases}} */
  render() {
    const m = Dashboard.model();
    const sheet = Dashboard.sheet_();
    const cv = Style.canvas(Dashboard.COLS);
    const C = Style.C;
    const n = Dashboard.n_;
    const last = Dashboard.COLS;
    const detail = (r, text, fmt) => { cv.put(r, 3, text, Object.assign({ fg: C.textMuted, wrap: true }, fmt || {})); cv.merge(r, 3, last); };
    const kv = (label, value, text, opts) => {
      const o = opts || {};
      const r = cv.row(Style.ROW.field, C.surface);
      cv.put(r, 1, label, { fg: C.textMuted, size: o.small ? Style.SIZE.small : Style.SIZE.body });
      cv.put(r, 2, value, { bold: !o.small, fg: o.small ? C.textMuted : C.text, size: o.small ? Style.SIZE.small : Style.SIZE.body, align: 'right' });
      detail(r, text || '', o.small ? { size: Style.SIZE.small } : null);
      return r;
    };
    const spacer = () => cv.row(Style.ROW.spacer);
    const section = (title) => {
      const r = cv.row(Style.ROW.section, C.primarySoft);
      cv.put(r, 1, title, { bold: true, fg: C.primaryText, size: Style.SIZE.section });
      cv.merge(r, 1, last);
      cv.line(r, 1, last, C.primaryBorder);
      return r;
    };
    /** Empty card: first row holds the text, the other `extra` rows collapse. */
    const empty = (text, extra) => {
      const r = cv.row(Style.ROW.field + 4, C.surface);
      cv.put(r, 1, text, { fg: C.textMuted, wrap: true });
      cv.merge(r, 1, last);
      for (let i = 0; i < extra; i++) cv.row(Style.ROW.collapsed, C.surface);
      return r;
    };
    const card = (r1, r2) => cv.box(r1, r2, 1, last);

    // 1–3 navigation, title, help
    let r = cv.row(Style.ROW.nav);
    Dashboard.navLinks(Dashboard.TAB).forEach((link, i) => cv.put(r, i + 1, link, { fg: C.primary, bold: true }));
    r = cv.row(Style.ROW.title);
    cv.put(r, 1, m.clientName ? `Painel · ${m.clientName}` : 'Painel', { bold: true, size: Style.SIZE.title });
    cv.merge(r, 1, last);
    r = cv.row(Style.ROW.help + 6);
    const stamp = Utilities.formatDate(m.updatedAt, Dates.tz(), 'dd/MM/yyyy HH:mm');
    cv.put(r, 1, `Só o objetivo em vigor; o histórico fica na linha do tempo e nos gráficos. Valores gravados pelo script (Projeto → Análise → Atualizar painel). Atualizado em ${stamp}.`, { fg: C.textMuted, wrap: true, size: Style.SIZE.small });
    cv.merge(r, 1, last);
    spacer();

    // 5–6 header band
    const ph = m.phase;
    r = cv.row(Style.ROW.title + 4, C.band);
    cv.put(r, 1, ph ? `OBJETIVO ATUAL — ${ph.id} · ${ph.name}` : 'OBJETIVO ATUAL — nenhum objetivo em vigor', { bold: true, fg: C.bandText, size: Style.SIZE.band, bg: C.band });
    cv.merge(r, 1, last);
    r = cv.row(Style.ROW.field, C.band);
    const sub = ph
      ? [`Desde ${Dashboard.d_(ph.start)}`, `semana ${ph.week} da fase (${ph.days} ${ph.days === 1 ? 'dia' : 'dias'})`,
        `Revisor: ${ph.reviewer || '—'}`, `Meta ${ph.goalId || '—'}`, `Ficha ${ph.planId || '—'}`].join(' · ')
      : 'Crie o primeiro objetivo em Projeto → Fase e metas → Mudar objetivo/fase.';
    cv.put(r, 1, sub, { fg: C.bandSub, bg: C.band });
    cv.merge(r, 1, last);
    spacer();

    // 8–12 Fase atual
    const s1 = section('Fase atual');
    if (ph) {
      kv('Início', Dashboard.d_(ph.start), `Tipo de análise: ${ph.type}`);
      const wText = ph.startWeightKg !== null
        ? `Inicial ${n(ph.startWeightKg)} kg → atual ${n(ph.weightKg)} kg${Dashboard.isNum_(ph.weightKg) ? ` · Δ ${n(ph.weightKg - ph.startWeightKg, 1, true)} kg` : ''}`
        : 'Peso inicial não registrado';
      kv('Peso médio 7d', Dashboard.isNum_(ph.weightKg) ? `${n(ph.weightKg)} kg` : '—', wText);
      const cText = ph.startWaistCm !== null
        ? `Inicial ${n(ph.startWaistCm)} cm → atual ${n(ph.waistCm)} cm${Dashboard.isNum_(ph.waistCm) ? ` · Δ ${n(ph.waistCm - ph.startWaistCm, 1, true)} cm` : ''}`
        : 'Cintura inicial não registrada';
      kv('Cintura', Dashboard.isNum_(ph.waistCm) ? `${n(ph.waistCm)} cm` : '—', cText);
      kv('Faixa alvo', ph.rangeText.replace(/ \((objetivo|padrão)\)$/, ''), ph.expectation ? `Expectativa: ${ph.expectation}` : (/padrão/.test(ph.rangeText) ? 'Faixa padrão do tipo de análise' : ''));
    } else {
      empty(Dashboard.TEXT.noObjective, 3);
    }
    card(s1, s1 + 4);
    spacer();

    // 14–24 Metas atuais
    const gm = m.goals;
    const s2 = section(gm ? `Metas atuais · ${gm.id}` : 'Metas atuais');
    if (gm) {
      const tol = (t) => (Dashboard.isNum_(t) ? `tolerância ±${Math.round(t * 100)}%` : '');
      kv('kcal', n(gm.kcal, 0), Dashboard.isNum_(gm.kcal) && Dashboard.isNum_(gm.kcalTolerance)
        ? `${tol(gm.kcalTolerance)} (${n(gm.kcal * (1 - gm.kcalTolerance), 0)}–${n(gm.kcal * (1 + gm.kcalTolerance), 0)})` : '');
      kv('Proteína', Dashboard.isNum_(gm.protein) ? `${n(gm.protein, 0)} g` : '—',
        gm.proteinMin !== null && gm.proteinMax !== null ? `faixa ${n(gm.proteinMin, 0)}–${n(gm.proteinMax, 0)} g` : '');
      kv('Gordura', Dashboard.isNum_(gm.fat) ? `${n(gm.fat, 0)} g` : '—', tol(gm.fatTolerance));
      kv('Carboidrato', Dashboard.isNum_(gm.carbs) ? `${n(gm.carbs, 0)} g` : '—', 'calculado da meta: (kcal − 4·P − 9·G) ÷ 4');
      kv('Fibra', Dashboard.isNum_(gm.fiber) ? `${n(gm.fiber, 0)} g` : '—', '');
      const extra = [`Cardio ${Dashboard.isNum_(gm.cardioPerWeek) ? gm.cardioPerWeek : '—'}/sem`];
      if (Dashboard.isNum_(gm.activitiesPerWeek) || gm.activities) extra.push(`${gm.activities || 'Atividades'} ${Dashboard.isNum_(gm.activitiesPerWeek) ? gm.activitiesPerWeek : '—'}/sem`);
      kv('Treinos', Dashboard.isNum_(gm.strengthPerWeek) ? `${gm.strengthPerWeek}/sem` : '—', extra.join(' · '));
      kv('Passos', Dashboard.isNum_(gm.stepsPerDay) ? `${n(gm.stepsPerDay, 0)}/dia` : '—', '');
      const src = gm.energySource === 'config' ? ' (perfil da Config)' : '';
      kv('TMB', Dashboard.isNum_(gm.bmr) ? `${n(gm.bmr, 0)} kcal` : '—', `estimado · ${gm.bmrMethod || 'Mifflin-St Jeor'}${src}`, { small: true });
      kv('Gasto estimado', Dashboard.isNum_(gm.tdee) ? `${n(gm.tdee, 0)} kcal` : '—',
        `estimado · TMB × ${Dashboard.isNum_(gm.activityFactor) ? n(gm.activityFactor, 2) : '—'}${src}`, { small: true });
      kv('Dieta base', Dashboard.isNum_(gm.baseDietKcal) ? `${n(gm.baseDietKcal, 0)} kcal` : '—',
        'planejado · total da aba Dieta base (não é a ingestão)', { small: true });
    } else {
      empty(Dashboard.TEXT.noGoal, 9);
    }
    card(s2, s2 + 10);
    spacer();

    // 26–34 Estado atual
    const s3 = section('Estado atual');
    const st = m.state;
    if (st) {
      r = cv.row(Style.ROW.field, C.headerBg);
      cv.put(r, 1, 'Indicador', { bold: true, fg: C.headerText, bg: C.headerBg });
      cv.put(r, 2, st.currentLabel, { bold: true, fg: C.headerText, bg: C.headerBg });
      cv.merge(r, 2, 3);
      cv.put(r, 4, st.previousLabel, { bold: true, fg: C.headerText, bg: C.headerBg });
      cv.merge(r, 4, 5);
      st.rows.forEach((row) => {
        const rr = cv.row(row.label === 'Situação geral' ? Style.ROW.field + 14 : Style.ROW.field, C.surface);
        cv.put(rr, 1, row.label, { fg: row.label === 'Situação geral' ? C.text : C.textMuted, bold: row.label === 'Situação geral' });
        [[row.current, 2], [row.previous, 4]].forEach(([cell, col]) => {
          if (!cell) return;
          const k = Style.STATUS[cell.kind] || Style.STATUS.insufficient;
          cv.put(rr, col, cell.chip, { bg: k.bg, fg: k.fg, bold: true, align: 'center' });
          cv.put(rr, col + 1, cell.text, { fg: C.textMuted, wrap: true, size: Style.SIZE.small });
        });
        cv.line(rr, 1, last, C.border);
      });
    } else {
      empty(Dashboard.TEXT.empty, 7);
    }
    card(s3, s3 + 8);
    spacer();

    // 36–39 Recomendação
    const s4 = section('Recomendação');
    const rec = m.recommendation;
    if (rec) {
      r = cv.row(Style.ROW.field + 18, C.surface);
      cv.put(r, 1, 'Código', { fg: C.textMuted });
      const k = Style.STATUS[rec.kind];
      cv.put(r, 2, rec.code, { bg: k.bg, fg: k.fg, bold: true, align: 'center', wrap: true });
      detail(r, rec.reason, { fg: C.text });
      r = cv.row(Style.ROW.field + 26, C.surface);
      cv.put(r, 1, 'Dados usados', { fg: C.textMuted });
      cv.put(r, 2, rec.data, { fg: C.textMuted, wrap: true, size: Style.SIZE.small });
      cv.merge(r, 2, last);
      kv('Próxima revisão', Dashboard.d_(rec.nextReview), '');
    } else {
      empty(ph ? Dashboard.TEXT.noRecommendation : Dashboard.TEXT.empty, 2);
    }
    card(s4, s4 + 3);
    spacer();

    // Linha do tempo
    const s5 = section('Linha do tempo das fases');
    if (m.timeline.length) {
      r = cv.row(Style.ROW.field, C.headerBg);
      ['Fase', 'Período', 'Duração', 'Peso (kg)', 'Cintura (cm)'].forEach((h, i) => cv.put(r, i + 1, h, { bold: true, fg: C.headerText, bg: C.headerBg }));
      m.timeline.forEach((t) => {
        const current = ph && t.id === ph.id;
        const bg = current ? C.primarySoft : C.surface;
        const r1 = cv.row(Style.ROW.field, bg);
        cv.put(r1, 1, `${t.id} · ${t.name || t.label || ''}${current ? ' (atual)' : ''}`, { bold: true, bg, wrap: true });
        cv.put(r1, 2, `${Dashboard.d_(t.start)} → ${t.end ? Dashboard.d_(t.end) : 'hoje'}`, { bg, size: Style.SIZE.small, wrap: true });
        cv.put(r1, 3, `${t.weeks} ${t.weeks === 1 ? 'semana' : 'semanas'} · ${t.durationDays} dias`, { bg });
        const delta = (a, b, d) => (Dashboard.isNum_(a) && Dashboard.isNum_(b) ? `${n(a)} → ${n(b)} (${n(d, 1, true)})` : Dashboard.isNum_(a) ? `${n(a)} → —` : '—');
        cv.put(r1, 4, delta(t.startWeightKg, t.endWeightKg, t.weightChangeKg), { bg, size: Style.SIZE.small });
        cv.put(r1, 5, delta(t.startWaistCm, t.endWaistCm, t.waistChangeCm), { bg, size: Style.SIZE.small });
        const r2 = cv.row(Style.ROW.field, bg);
        const kind = Style.STATUS[Style.kindOf(t.status) || 'insufficient'];
        cv.put(r2, 1, t.status || '—', { bg: kind.bg, fg: kind.fg, bold: true, align: 'center' });
        cv.put(r2, 2, t.outcome || '', { bg, fg: C.textMuted, size: Style.SIZE.small, wrap: true });
        cv.merge(r2, 2, last);
        cv.line(r2, 1, last, C.border);
      });
    } else {
      empty(Dashboard.TEXT.noPhases, 0);
    }
    card(s5, cv.rows.length);
    spacer();

    // Charts
    const s6 = section('Evolução por fase');
    const hasSeries = m.series.rows.length > 0;
    let chartRows = null;
    if (hasSeries) {
      r = cv.row(Style.ROW.field, C.surface);
      cv.put(r, 1, 'Uma cor por fase; os pontos escuros marcam as mudanças de objetivo. Dados: aba Evolução.', { fg: C.textMuted, size: Style.SIZE.small });
      cv.merge(r, 1, last);
      const start = cv.rows.length + 1;
      for (let i = 0; i < Dashboard.CHART.rows * 2 + 1; i++) cv.row(21, C.surface);
      chartRows = { weight: start, waist: start + Dashboard.CHART.rows + 1 };
    } else {
      empty(Dashboard.TEXT.noCharts, 0);
    }
    card(s6, cv.rows.length);

    // Write
    const oldSignature = sheet.getMaxColumns() > Dashboard.HELPER_COL ? String(sheet.getRange(1, Dashboard.HELPER_COL + 1).getValue()) : '';
    Dashboard.clear_(sheet, cv.rows.length);
    cv.flush(sheet);
    Dashboard.frame_(sheet);
    const charts = Dashboard.charts_(sheet, m.series, chartRows, oldSignature);
    return { rows: cv.rows.length, charts, phases: m.series.phases.length, model: m };
  },

  /** Clears the whole Painel (it is fully script-rendered): values, formats, merges, validations, rules. */
  clear_(sheet, rows) {
    if (sheet.getMaxRows() < rows + 10) sheet.insertRowsAfter(sheet.getMaxRows(), rows + 10 - sheet.getMaxRows());
    const all = sheet.getRange(1, 1, sheet.getMaxRows(), sheet.getMaxColumns());
    all.breakApart();
    all.clear();
    all.clearDataValidations();
    sheet.clearConditionalFormatRules();
    all.setBackground(Style.C.canvas);
  },

  /** Widths, gridlines, frozen rows and the warning-only protection of the Painel. */
  frame_(sheet) {
    Dashboard.WIDTHS.forEach((w, i) => sheet.setColumnWidth(i + 1, w));
    sheet.setColumnWidth(Dashboard.COLS + 1, 16);
    sheet.setHiddenGridlines(true);
    sheet.setFrozenRows(0);
    sheet.setTabColor(Style.LAYER[1].tab);
    const p = sheet.protect();
    p.setDescription('Painel gerado pelo script (Atualizar painel). Edições serão sobrescritas.');
    p.setWarningOnly(true);
  },

  /**
   * Writes the hidden chart data and creates/updates the two charts (removes foreign charts and,
   * without data, its own). @returns {number} charts on the Painel
   */
  charts_(sheet, series, chartRows, oldSignature) {
    const H = Dashboard.HELPER_COL;
    const mine = {};
    const titles = Dashboard.CHART_TITLES;
    sheet.getCharts().forEach((c) => {
      const t = c.getOptions().get('title');
      const key = Object.keys(titles).find((k) => titles[k] === t);
      if (key && !mine[key]) mine[key] = c;
      else sheet.removeChart(c);
    });
    if (!chartRows) {
      Object.keys(mine).forEach((k) => sheet.removeChart(mine[k]));
      return 0;
    }
    const w = Dashboard.block_(series, 'weight');
    const c = Dashboard.block_(series, 'waist');
    const waistCol = H + w.width + 2;
    const needCols = waistCol + c.width;
    if (sheet.getMaxColumns() < needCols) sheet.insertColumnsAfter(sheet.getMaxColumns(), needCols - sheet.getMaxColumns());
    const rows = series.rows.length;
    sheet.getRange(1, H).setValue(Dashboard.TEXT.helperCaption);
    const put = (col, block) => {
      sheet.getRange(2, col, 1, block.head.length).setValues([block.head]);
      sheet.getRange(3, col, rows, block.head.length).setValues(block.lines);
      sheet.getRange(3, col, rows, 1).setNumberFormat('dd/mm/yyyy');
      sheet.getRange(3, col + 1, rows, block.head.length - 1).setNumberFormat('0.0');
    };
    put(H, w);
    put(waistCol, c);
    sheet.hideColumns(H, sheet.getMaxColumns() - H + 1);

    const weightRange = sheet.getRange(2, H, rows + 1, w.head.length);
    const waistRange = sheet.getRange(2, waistCol, rows + 1, c.head.length);
    const signature = JSON.stringify({
      weight: weightRange.getA1Notation(), waist: waistRange.getA1Notation(), heads: [w.head, c.head],
      at: [chartRows.weight, chartRows.waist], v: 1,
    });
    sheet.getRange(1, H + 1).setValue(signature);
    // Same ranges, headers and anchors: the charts already read the new values.
    if (signature === oldSignature && mine.weight && mine.waist) return sheet.getCharts().length;
    const build = (key, range, row, block, unit) => {
      const P = block.head.length - 2;
      const opts = {};
      for (let i = 0; i < P; i++) opts[i] = { color: Style.SERIES[i % Style.SERIES.length], lineWidth: 3, pointSize: 4 };
      opts[P] = { color: Style.MARKER, lineWidth: 0, pointSize: 9, pointShape: 'diamond', visibleInLegend: true };
      const existing = mine[key];
      const b = (existing ? existing.modify() : sheet.newChart()).asLineChart()
        .clearRanges()
        .addRange(range)
        .setNumHeaders(1)
        .setMergeStrategy(Charts.ChartMergeStrategy.MERGE_COLUMNS)
        .setHiddenDimensionStrategy(Charts.ChartHiddenDimensionStrategy.SHOW_BOTH)
        .setPosition(row, 1, 0, 0)
        .setOption('title', Dashboard.CHART_TITLES[key])
        .setOption('width', Dashboard.CHART.width)
        .setOption('height', Dashboard.CHART.height)
        .setOption('series', opts)
        .setOption('interpolateNulls', true)
        .setOption('legend.position', 'bottom')
        .setOption('hAxis.format', 'dd/MM/yy')
        .setOption('vAxis.title', unit)
        .setOption('fontName', Style.FONT)
        .setOption('backgroundColor', Style.C.surface)
        .setOption('colors', block.head.slice(1).map((h, i) => (i < P ? Style.SERIES[i % Style.SERIES.length] : Style.MARKER)));
      if (existing) sheet.updateChart(b.build());
      else sheet.insertChart(b.build());
    };
    build('weight', weightRange, chartRows.weight, w, 'kg');
    build('waist', waistRange, chartRows.waist, c, 'cm');
    return sheet.getCharts().length;
  },

  /** Renders when the Painel exists; an error is logged and returned, never thrown. */
  renderSafely_() {
    if (!Tabs.findSheet(Dashboard.TAB)) return null;
    try {
      return Dashboard.render();
    } catch (err) {
      console.error(err);
      return { error: err && err.message ? err.message : String(err) };
    }
  },
};

/*
 * Refresh wiring. The weekly engine re-analyses the running week after every committed action
 * that touched a source tab (weeks.js) and emits 'weeks.refreshed'; the Painel follows it (also
 * from dailyRefresh, Atualizar semana and Recalcular histórico). Actions that touched only
 * tabs the weekly engine ignores but the Painel shows (Config, Dieta base, Alimentos…) re-render
 * directly. A phase transition writes Objetivos, so it always re-renders the header band.
 */
Core.on('weeks.refreshed', () => Dashboard.renderSafely_());
Core.on('action.committed', (e) => {
  const tabs = (e && e.tabs) || [];
  const sources = (typeof Weeks !== 'undefined' && Weeks.SOURCE_TABS ? Weeks.SOURCE_TABS : []).map((id) => Tabs.get(id).name);
  if (tabs.some((t) => sources.indexOf(t) >= 0)) return; // weeks.refreshed follows
  const shown = ['config', 'baseDiet', 'foods'].map((id) => Tabs.get(id).name);
  if (tabs.some((t) => shown.indexOf(t) >= 0)) Dashboard.renderSafely_();
});

Actions.register({
  id: 'dashboardRefresh', label: 'Atualizar painel', group: 'analysis', quick: true, order: 30, logged: false,
  run: () => {
    const r = Dashboard.render();
    return { message: `Painel atualizado${r.charts ? ` (${r.charts} gráficos, ${r.phases} ${r.phases === 1 ? 'fase' : 'fases'})` : ''}.` };
  },
});
