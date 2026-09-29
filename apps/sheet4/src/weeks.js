/**
 * Weekly engine (spec §6): aggregates one Monday–Sunday week, analyses it with the rules of the
 * objective in force on that week's Sunday (analysis.js) and stores the result as values in
 * `Semanas` and `Evolução`.
 *
 *   Weeks.compute(start)        aggregate of the week containing `start` (no analysis)
 *   Weeks.analyze(start)        aggregate + {status, signals, reasons, expectationMet, recommendation}
 *   Weeks.store(start, {force}) writes the Semanas + Evolução rows; a closed week whose row was
 *                               computed after it ended ("final") is never rewritten unless force
 *   Weeks.refreshCurrent()      rewrites the week containing today
 *   Weeks.closeFinished()       writes every closed week that has no final row yet
 *   Weeks.recomputeAll()        rewrites every week (Recalcular histórico)
 *   Weeks.list()                stored Semanas rows, oldest first
 *   Weeks.phaseSummary()        one entry per objective (Painel "linha do tempo das fases")
 *   dailyRefresh()              time-driven entry point (Setup installs the trigger)
 *
 * Event 'weeks.refreshed' ({scope: 'current'|'all'|'none', written}) follows refreshCurrent and
 * recomputeAll (and a committed action when there is no Semanas tab); the Painel re-renders on it.
 *
 * Everything is resolved by date: ids are the versions in force on the week's Sunday (plus a
 * `Transição na semana` text when an id changes inside the week), the food adherence of each day
 * uses the goal in force on that day, and the history an analysis sees is recomputed from the
 * same data by date, never read from stored rows. So `store` and `recomputeAll` give identical
 * values, and opening a new objective today changes nothing about earlier weeks.
 *
 * Data is read by header through Tabs only (Diário, Medidas e fotos, Registro de treino,
 * Exercícios, Objetivos, Metas, Fichas), once per call (a snapshot), never through the modules
 * that write them. Training uses `Progression.weekSummary(start, end)` when that function exists;
 * otherwise it is computed here from Registro de treino (work sets only; see training_).
 *
 * Unknown is not zero: an average over no values is null, a count of days says "de N dias", and
 * a week with too little data is flagged, never scored as if the missing values were 0.
 *
 * Thresholds (Config, defaults in core_config.js): analysis.weightTrendDays (7) window of the
 * weight moving average; analysis.minWeighInsPerWeek (3) and analysis.minCompleteFoodDays (4)
 * data sufficiency; analysis.kcalTolerance (0.05) / analysis.fatTolerance (0.15) when the goal has
 * no tolerance of its own. The rule thresholds are listed in analysis.js.
 */
const Weeks = {
  /** Previous weeks given to the analysis as history (spec §7: "the previous 4 weeks"). */
  HISTORY_WEEKS: 4,

  /* Snapshot ------------------------------------------------------------------------------- */

  /**
   * Everything the engine reads, read once: {today, diary: {key: row}, waists: [{key, cm, source}],
   * workouts: [row], groups: {exercise: group}, objectives/goals/plans: version lists,
   * memo: {aggregates, analysed}}.
   */
  snapshot_() {
    const read = (id) => (Tabs.findSheet(id) ? Tabs.read(id) : []);
    const list = (repo) => (Tabs.findSheet(repo.tab) ? repo.list() : []);
    const diary = {};
    read('diary').forEach((r) => {
      const k = Dates.key(r.date);
      if (k && !diary[k]) diary[k] = r;
    });
    const byKey = {};
    Object.keys(diary).forEach((k) => {
      if (Weeks.num_(diary[k].waistCm)) byKey[k] = { key: k, cm: diary[k].waistCm, source: 'Diário' };
    });
    // Medidas e fotos is the standardised measurement: it wins over Diário on the same day.
    read('measures').forEach((r) => {
      const k = Dates.key(r.date);
      if (k && Weeks.num_(r.waistCm)) byKey[k] = { key: k, cm: r.waistCm, source: 'Medidas' };
    });
    const waists = Object.keys(byKey).sort().map((k) => byKey[k]);
    const workouts = read('workouts').filter((r) => Dates.key(r.date))
      .sort((a, b) => Dates.compare(a.date, b.date) || a._row - b._row);
    const groups = {};
    read('exercises').forEach((r) => { if (r.name && r.group) groups[Weeks.norm_(r.name)] = String(r.group); });
    const plans = list(Plans);
    plans.forEach((v) => v.rows.forEach((r) => {
      if (r.exercise && r.group && !groups[Weeks.norm_(r.exercise)]) groups[Weeks.norm_(r.exercise)] = String(r.group);
    }));
    return {
      today: Dates.today(), diary, waists, workouts, groups,
      objectives: list(Objectives), goals: list(Goals), plans,
      memo: { aggregates: {}, analysed: {} },
    };
  },

  /** Same semantics as Versions.on, over a list already read. */
  versionOn_(versions, date) {
    const hits = versions.filter((v) => v.start && Dates.within(date, v.start, v.end));
    return hits.length ? hits[hits.length - 1] : null;
  },

  idsOn_(snap, date) {
    const id = (list) => { const v = Weeks.versionOn_(list, date); return v ? v.id : null; };
    return { objective: id(snap.objectives), goal: id(snap.goals), plan: id(snap.plans) };
  },

  /* Small helpers -------------------------------------------------------------------------- */

  num_(v) {
    return typeof v === 'number' && isFinite(v);
  },

  norm_(s) {
    return String(s === null || s === undefined ? '' : s).trim().toLowerCase();
  },

  round_(v, digits) {
    if (!Weeks.num_(v)) return null;
    const f = Math.pow(10, digits);
    return Math.round(v * f) / f;
  },

  mean_(values) {
    const xs = values.filter(Weeks.num_);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  },

  sum_(values) {
    const xs = values.filter(Weeks.num_);
    return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
  },

  max_(values) {
    const xs = values.filter(Weeks.num_);
    return xs.length ? Math.max.apply(null, xs) : null;
  },

  /** Keys of the days from a to b inclusive. */
  days_(a, b) {
    const out = [];
    for (let d = Dates.require(a); Dates.compare(d, b) <= 0; d = Dates.addDays(d, 1)) out.push(Dates.key(d));
    return out;
  },

  /** Mean weight of the `analysis.weightTrendDays` days ending on `date`, with the count. */
  weightAvgAt_(snap, date) {
    const n = Config.get('analysis.weightTrendDays');
    const keys = Weeks.days_(Dates.addDays(date, -(n - 1)), date);
    const xs = keys.map((k) => snap.diary[k] && snap.diary[k].weightKg).filter(Weeks.num_);
    return { avg: Weeks.mean_(xs), count: xs.length };
  },

  /** Latest waist measurement on or before `date` (key compare), or null. */
  waistOnOrBefore_(snap, date) {
    const k = Dates.key(date);
    let hit = null;
    snap.waists.forEach((w) => { if (w.key <= k) hit = w; });
    return hit;
  },

  /* Aggregation ---------------------------------------------------------------------------- */

  /**
   * Aggregate of the week containing `date` (spec §6.1). Keys match the Semanas columns, plus:
   * asOf, closed, future, daysElapsed, transitionChanges, weightPrevAvg, waistDate, waistPrev,
   * estimatedItems, volumeByGroup, comparedExercises, trainingSource, targets, phase and
   * sufficiency ({weight, food, waist, training}) with sufficiencyText.
   */
  compute(date, snap) {
    const s = snap || Weeks.snapshot_();
    const start = Dates.weekStart(date);
    const key = Dates.key(start);
    if (s.memo.aggregates[key]) return s.memo.aggregates[key];
    const end = Dates.weekEnd(start);
    const future = Dates.compare(start, s.today) > 0;
    const closed = Dates.compare(end, s.today) < 0;
    const asOf = closed ? end : future ? start : s.today;
    const w = { start, end, asOf, closed, future, daysElapsed: future ? 0 : Dates.diffDays(start, asOf) + 1 };

    Weeks.ids_(s, w);
    Weeks.weight_(s, w);
    Weeks.waist_(s, w);
    Weeks.food_(s, w);
    Weeks.training_(s, w);
    Weeks.recovery_(s, w);
    Weeks.phase_(s, w);
    Weeks.sufficiency_(w);
    s.memo.aggregates[key] = w;
    return w;
  },

  /** Ids on the Sunday; changes inside the week (day d differs from day d−1). */
  ids_(s, w) {
    Object.assign(w, Weeks.idsOn_(s, w.end));
    const labels = { objective: 'Objetivo', goal: 'Meta', plan: 'Ficha' };
    const changes = [];
    let prev = Weeks.idsOn_(s, w.start);
    for (let i = 1; i < 7; i++) {
      const d = Dates.addDays(w.start, i);
      const ids = Weeks.idsOn_(s, d);
      Object.keys(labels).forEach((k) => {
        if (ids[k] !== prev[k]) changes.push({ entity: k, from: prev[k], to: ids[k], date: d });
      });
      prev = ids;
    }
    w.transitionChanges = changes;
    w.transition = changes.length
      ? changes.map((c) => `${labels[c.entity]} ${c.from || '—'} → ${c.to || '—'} em ${Dates.format(c.date)}`).join('; ')
      : null;
  },

  /**
   * Weigh-ins of the week (up to asOf), the moving average at asOf and at the previous Sunday,
   * delta and %/week. For the running week the % is scaled to 7 days by the days elapsed since
   * the previous Sunday, so it stays a weekly rate.
   */
  weight_(s, w) {
    const keys = Weeks.days_(w.start, w.asOf);
    w.weighIns = w.future ? 0 : keys.filter((k) => s.diary[k] && Weeks.num_(s.diary[k].weightKg)).length;
    const cur = w.future ? { avg: null } : Weeks.weightAvgAt_(s, w.asOf);
    const prevEnd = Dates.addDays(w.start, -1);
    const prev = Weeks.weightAvgAt_(s, prevEnd);
    w.weightAvg = Weeks.round_(cur.avg, 2);
    w.weightPrevAvg = Weeks.round_(prev.avg, 2);
    if (Weeks.num_(cur.avg) && Weeks.num_(prev.avg)) {
      const days = Dates.diffDays(prevEnd, w.asOf);
      w.weightDelta = Weeks.round_(cur.avg - prev.avg, 2);
      w.weightDeltaPct = Weeks.round_(((cur.avg - prev.avg) / prev.avg) * 100 * (7 / days), 2);
    } else {
      w.weightDelta = null;
      w.weightDeltaPct = null;
    }
  },

  /** Last waist of the week (Diário or Medidas) and its change vs the previous measurement. */
  waist_(s, w) {
    const last = w.future ? null : Weeks.waistOnOrBefore_(s, w.asOf);
    const inWeek = last && last.key >= Dates.key(w.start) ? last : null;
    const prev = Weeks.waistOnOrBefore_(s, Dates.addDays(w.start, -1));
    w.waistCm = inWeek ? inWeek.cm : null;
    w.waistDate = inWeek ? Dates.fromKey(inWeek.key) : null;
    w.waistPrev = prev ? prev.cm : null;
    w.waistDelta = inWeek && prev ? Weeks.round_(inWeek.cm - prev.cm, 2) : null;
  },

  /**
   * Targets of a goal version: kcal ± tolerance, protein [mín, máx] (mín defaults to the protein
   * target, no máx when empty), fat ± tolerance. Tolerances default to Config.
   */
  targetsOf_(goal) {
    const g = goal ? goal.fields : {};
    const n = (v) => (Weeks.num_(v) ? v : null);
    return {
      goal: goal ? goal.id : null,
      kcal: n(g.kcal),
      kcalTolerance: Weeks.num_(g.kcalTolerance) ? g.kcalTolerance : Config.get('analysis.kcalTolerance'),
      protein: n(g.protein),
      proteinMin: Weeks.num_(g.proteinMin) ? g.proteinMin : n(g.protein),
      proteinMax: n(g.proteinMax),
      fat: n(g.fat),
      fatTolerance: Weeks.num_(g.fatTolerance) ? g.fatTolerance : Config.get('analysis.fatTolerance'),
      carbs: n(g.carbs),
      fiber: n(g.fiber),
      strengthPerWeek: n(g.strengthPerWeek),
    };
  },

  /** True/false when the value and the target exist; null otherwise (not counted). */
  within_(value, target, tolerance) {
    if (!Weeks.num_(value) || !Weeks.num_(target)) return null;
    return Math.abs(value - target) <= target * tolerance + 1e-9;
  },

  proteinOk_(value, t) {
    if (!Weeks.num_(value) || !Weeks.num_(t.proteinMin)) return null;
    return value >= t.proteinMin - 1e-9 && (!Weeks.num_(t.proteinMax) || value <= t.proteinMax + 1e-9);
  },

  /**
   * Food over complete days with calculation only: Registro alimentar = Completo, kcal present
   * and no item without calculation. Adherence of each day is judged against the goal in force on
   * that day; the week's averages against the goal of the Sunday (signals in analysis.js).
   */
  food_(s, w) {
    const keys = w.future ? [] : Weeks.days_(w.start, w.asOf);
    const rows = keys.map((k) => s.diary[k]).filter(Boolean);
    w.daysLogged = rows.filter((r) => r.foodLog === 'Parcial' || r.foodLog === 'Completo').length;
    const complete = rows.filter((r) => r.foodLog === 'Completo' && Weeks.num_(r.kcal) && !(Weeks.num_(r.noCalcItems) && r.noCalcItems > 0));
    w.completeDays = complete.length;
    const avg = (k, d) => Weeks.round_(Weeks.mean_(complete.map((r) => r[k])), d);
    w.kcalAvg = avg('kcal', 0);
    w.proteinAvg = avg('protein', 1);
    w.carbsAvg = avg('carbs', 1);
    w.fatAvg = avg('fat', 1);
    w.fiberAvg = avg('fiber', 1);
    const rate = (fn) => {
      const judged = complete.map(fn).filter((x) => x !== null);
      return judged.length ? Weeks.round_(judged.filter((x) => x).length / judged.length, 2) : null;
    };
    const dayTargets = (r) => Weeks.targetsOf_(Weeks.versionOn_(s.goals, r.date));
    w.kcalAdherence = rate((r) => { const t = dayTargets(r); return Weeks.within_(r.kcal, t.kcal, t.kcalTolerance); });
    w.proteinAdherence = rate((r) => Weeks.proteinOk_(r.protein, dayTargets(r)));
    w.fatAdherence = rate((r) => { const t = dayTargets(r); return Weeks.within_(r.fat, t.fat, t.fatTolerance); });
    w.foodCoverage = `${w.completeDays} de ${w.daysElapsed} ${w.daysElapsed === 1 ? 'dia' : 'dias'}`;
    w.noCalcItems = Weeks.sum_(rows.map((r) => r.noCalcItems));
    w.estimatedItems = Weeks.sum_(rows.map((r) => r.estimatedItems));
    w.targets = Weeks.targetsOf_(Weeks.versionOn_(s.goals, w.end));
  },

  /**
   * Training. With Progression.weekSummary(start, end) (workout.js) its numbers are used as they
   * come. Otherwise, from Registro de treino rows dated start..asOf:
   *   sessions     distinct sessions (ID sessão, else date + Sessão) with a row "Concluído";
   *   workVolume   Σ kg × reps of Work 1 and Work 2 (warm-up and feeder never count), every
   *                session including partial ones; null when no work set has kg and reps;
   *   progressions exercises whose last work set of the week (heaviest, then most reps) beats
   *                the previous session of the same exercise — more kg, or same kg and more reps —
   *                at the same RIR or more; regressions the opposite (less kg with no more reps, or
   *                same kg and fewer reps); comparedExercises those with a previous session.
   */
  training_(s, w) {
    const objective = Weeks.versionOn_(s.objectives, w.end);
    const goal = Weeks.versionOn_(s.goals, w.end);
    const pick = (k) => {
      if (goal && Weeks.num_(goal.fields[k])) return goal.fields[k];
      if (objective && Weeks.num_(objective.fields[k])) return objective.fields[k];
      return null;
    };
    w.sessionsGoal = pick('strengthPerWeek');
    if (w.sessionsGoal === null) w.sessionsGoal = Config.get('routine.strengthPerWeek');
    if (w.future) {
      Object.assign(w, { sessions: 0, workVolume: null, volumeByGroup: {}, progressions: null, regressions: null, comparedExercises: 0, trainingSource: null });
      return;
    }
    if (typeof Progression !== 'undefined' && Progression && typeof Progression.weekSummary === 'function') {
      const p = Progression.weekSummary(w.start, w.asOf) || {};
      const count = (v) => (Array.isArray(v) ? v.length : Weeks.num_(v) ? v : null);
      w.sessions = Weeks.num_(p.sessions) ? p.sessions : 0;
      w.workVolume = Weeks.round_(p.workVolume, 1);
      w.volumeByGroup = p.volumeByGroup || {};
      w.progressions = count(p.progressedExercises);
      w.regressions = count(p.regressedExercises);
      w.comparedExercises = Weeks.num_(p.comparedExercises) ? p.comparedExercises
        : (w.progressions || 0) + (w.regressions || 0) + (w.sessions > 0 ? 1 : 0);
      w.trainingSource = 'Progression';
      return;
    }
    const kStart = Dates.key(w.start);
    const kEnd = Dates.key(w.asOf);
    const rows = s.workouts.filter((r) => { const k = Dates.key(r.date); return k >= kStart && k <= kEnd; });
    const sessionKey = (r) => (r.sessionId ? String(r.sessionId) : `${Dates.key(r.date)}|${Weeks.norm_(r.session)}`);
    const done = {};
    rows.forEach((r) => { if (r.sessionState === 'Concluído') done[sessionKey(r)] = true; });
    w.sessions = Object.keys(done).length;
    const byGroup = {};
    let volume = null;
    rows.forEach((r) => {
      const v = Weeks.workVolume_(r);
      if (v === null) return;
      volume = (volume || 0) + v;
      const g = s.groups[Weeks.norm_(r.exercise)] || 'Sem grupo';
      byGroup[g] = Weeks.round_((byGroup[g] || 0) + v, 1);
    });
    w.workVolume = Weeks.round_(volume, 1);
    w.volumeByGroup = byGroup;
    let up = 0;
    let down = 0;
    let compared = 0;
    const lastByExercise = {};
    rows.forEach((r) => { if (r.exercise && Weeks.topSet_(r)) lastByExercise[Weeks.norm_(r.exercise)] = r; });
    Object.keys(lastByExercise).forEach((ex) => {
      const cur = lastByExercise[ex];
      const curKey = Dates.key(cur.date);
      let prev = null;
      s.workouts.forEach((r) => {
        if (Weeks.norm_(r.exercise) === ex && Dates.key(r.date) < curKey && Weeks.topSet_(r)) prev = r;
      });
      if (!prev) return;
      compared++;
      const c = Weeks.topSet_(cur);
      const p = Weeks.topSet_(prev);
      const rirOk = !Weeks.num_(c.rir) || !Weeks.num_(p.rir) || c.rir >= p.rir;
      if (rirOk && (c.kg > p.kg || (c.kg === p.kg && c.reps > p.reps))) up++;
      else if ((c.kg < p.kg && c.reps <= p.reps) || (c.kg === p.kg && c.reps < p.reps)) down++;
    });
    w.progressions = compared ? up : null;
    w.regressions = compared ? down : null;
    w.comparedExercises = compared;
    w.trainingSource = 'Registro de treino';
  },

  /** kg × reps of the work sets of a row; null when none has both. */
  workVolume_(r) {
    let v = null;
    [['work1Kg', 'work1Reps'], ['work2Kg', 'work2Reps']].forEach(([k, n]) => {
      if (Weeks.num_(r[k]) && Weeks.num_(r[n])) v = (v || 0) + r[k] * r[n];
    });
    return v;
  },

  /** Heaviest work set of a row (then most reps): {kg, reps, rir}, or null. */
  topSet_(r) {
    const sets = [];
    if (Weeks.num_(r.work1Kg) && Weeks.num_(r.work1Reps)) sets.push({ kg: r.work1Kg, reps: r.work1Reps, rir: r.rir1 });
    if (Weeks.num_(r.work2Kg) && Weeks.num_(r.work2Reps)) sets.push({ kg: r.work2Kg, reps: r.work2Reps, rir: r.rir2 });
    if (!sets.length) return null;
    sets.sort((a, b) => b.kg - a.kg || b.reps - a.reps);
    return sets[0];
  },

  /** Recovery from Diário (start..asOf): averages and max over the days that have a value. */
  recovery_(s, w) {
    const rows = w.future ? [] : Weeks.days_(w.start, w.asOf).map((k) => s.diary[k]).filter(Boolean);
    const col = (k) => rows.map((r) => r[k]);
    w.sleepAvg = Weeks.round_(Weeks.mean_(col('sleepH')), 2);
    w.hungerAvg = Weeks.round_(Weeks.mean_(col('hunger')), 2);
    w.fatigueAvg = Weeks.round_(Weeks.mean_(col('fatigue')), 2);
    w.painMax = Weeks.max_(col('pain'));
    w.stepsAvg = Weeks.round_(Weeks.mean_(col('steps')), 0);
    w.cardioMin = Weeks.round_(Weeks.sum_(col('cardioMin')), 1);
    const informed = rows.filter((r) => Weeks.num_(r.activityMin) || (r.activity !== null && String(r.activity).trim() !== ''));
    w.activities = informed.length ? informed.filter((r) => (Weeks.num_(r.activityMin) ? r.activityMin > 0 : true)).length : null;
  },

  /**
   * The objective of the week (Sunday) with what the analysis needs: type, target range, weeks
   * since its first week, and the change since its start (baseline = the objective's Peso/Cintura
   * inicial, else the moving average / latest waist on the day before it started).
   */
  phase_(s, w) {
    const o = Weeks.versionOn_(s.objectives, w.end);
    if (!o) { w.phase = null; return; }
    const f = o.fields;
    const n = (v) => (Weeks.num_(v) ? v : null);
    const before = Dates.addDays(o.start, -1);
    let baseW = n(f.startWeightKg);
    if (baseW === null) baseW = Weeks.round_(Weeks.weightAvgAt_(s, before).avg, 2);
    let baseWaist = n(f.startWaistCm);
    if (baseWaist === null) { const b = Weeks.waistOnOrBefore_(s, before); baseWaist = b ? b.cm : null; }
    const lastWaist = w.future ? null : Weeks.waistOnOrBefore_(s, w.asOf);
    const waistNow = lastWaist && lastWaist.key >= Dates.key(o.start) ? lastWaist.cm : null;
    w.phase = {
      id: o.id,
      name: f.name,
      analysisType: f.analysisType,
      start: o.start,
      end: o.end,
      rateMinPct: n(f.weightRateMinPct),
      rateMaxPct: n(f.weightRateMaxPct),
      expectation: f.expectation || null,
      weeks: Dates.diffDays(Dates.weekStart(o.start), w.start) / 7 + 1,
      baselineWeightKg: baseW,
      baselineWaistCm: baseWaist,
      weightChangeKg: Weeks.num_(w.weightAvg) && baseW !== null ? Weeks.round_(w.weightAvg - baseW, 2) : null,
      waistChangeCm: waistNow !== null && baseWaist !== null ? Weeks.round_(waistNow - baseWaist, 2) : null,
    };
  },

  /** Sufficiency flags (Config thresholds) and their Portuguese summary. */
  sufficiency_(w) {
    const minW = Config.get('analysis.minWeighInsPerWeek');
    const minF = Config.get('analysis.minCompleteFoodDays');
    w.sufficiency = {
      weight: w.weighIns >= minW && Weeks.num_(w.weightDeltaPct),
      weightPrevious: Weeks.num_(w.weightPrevAvg),
      food: w.completeDays >= minF,
      waist: w.waistDelta !== null,
      training: w.sessions > 0 || w.comparedExercises > 0,
    };
    const parts = [];
    parts.push(`Peso ${w.sufficiency.weight ? 'ok' : 'insuficiente'} (${w.weighIns} de ${minW} pesagens${w.sufficiency.weightPrevious ? '' : ', sem semana anterior'})`);
    parts.push(`Alimentação ${w.sufficiency.food ? 'ok' : 'insuficiente'} (${w.completeDays} de ${minF} dias completos)`);
    parts.push(`Cintura ${w.waistCm === null ? 'não medida' : w.sufficiency.waist ? 'ok' : 'sem medida anterior'}`);
    parts.push(`Treino ${w.sufficiency.training ? 'ok' : 'sem registro'}`);
    w.sufficiencyText = parts.join(' · ');
  },

  /* Analysis chain ------------------------------------------------------------------------- */

  /**
   * Aggregate + analysis + recommendation. The history is the previous HISTORY_WEEKS weeks,
   * analysed the same way (memoised), so the result depends only on the data by date.
   */
  analyze(date, snap) {
    const s = snap || Weeks.snapshot_();
    const start = Dates.weekStart(date);
    const key = Dates.key(start);
    if (s.memo.analysed[key]) return s.memo.analysed[key];
    const history = Weeks.history_(start, s);
    const w = Object.assign({}, Weeks.compute(start, s));
    Object.assign(w, Analysis.evaluate(w, history));
    w.recommendation = Recommend.for(w, history);
    s.memo.analysed[key] = w;
    return w;
  },

  /** Analysed previous weeks, oldest first, never before the first week with data. */
  history_(start, s) {
    const first = Weeks.firstWeek_(s);
    const out = [];
    for (let i = Weeks.HISTORY_WEEKS; i >= 1; i--) {
      const d = Dates.addDays(start, -7 * i);
      if (first && Dates.compare(d, first) >= 0) out.push(Weeks.analyze(d, s));
    }
    return out;
  },

  /** Monday of the first week with any data or version; null when there is none. */
  firstWeek_(s) {
    const keys = [];
    const dk = Object.keys(s.diary).sort();
    if (dk.length) keys.push(dk[0]);
    if (s.waists.length) keys.push(s.waists[0].key);
    if (s.workouts.length) keys.push(Dates.key(s.workouts[0].date));
    [s.objectives, s.goals, s.plans].forEach((l) => { const v = l.find((x) => x.start); if (v) keys.push(Dates.key(v.start)); });
    if (!keys.length) return null;
    keys.sort();
    return Dates.weekStart(keys[0]);
  },

  /** Mondays from the first week to the current one. */
  allStarts_(s) {
    const first = Weeks.firstWeek_(s);
    if (!first) return [];
    const out = [];
    const last = Dates.weekStart(s.today);
    for (let d = first; Dates.compare(d, last) <= 0; d = Dates.addDays(d, 7)) out.push(d);
    return out;
  },

  /* Storage -------------------------------------------------------------------------------- */

  /** Semanas row values of an analysed week. */
  toRow_(w) {
    const row = {};
    Tabs.columns('weeks').forEach((c) => { if (c.key in w) row[c.key] = w[c.key]; });
    const r = w.recommendation || {};
    Object.assign(row, {
      sufficiency: w.sufficiencyText,
      signals: (w.signals || []).join(', ') || null,
      reasons: (w.reasons || []).join(' ') || null,
      targetRange: Analysis.rangeText(w.range),
      recommendation: r.code || null,
      recommendationReason: r.reason || null,
      nextReview: r.nextReview || null,
      computedAt: new Date(),
    });
    return row;
  },

  toEvolution_(w) {
    const row = {};
    Tabs.columns('evolution').forEach((c) => { if (c.key in w) row[c.key] = w[c.key]; });
    row.recommendation = w.recommendation ? w.recommendation.code : null;
    return row;
  },

  /** A stored row is final when it was computed after its week ended. */
  isFinal_(row) {
    return Boolean(row && row.computedAt && row.end && Dates.key(row.computedAt) > Dates.key(row.end));
  },

  index_(id) {
    const out = {};
    if (!Tabs.findSheet(id)) return out;
    Tabs.read(id).forEach((r) => { const k = Dates.key(r.start); if (k && !out[k]) out[k] = r; });
    return out;
  },

  /**
   * Writes the weeks of `starts` (Mondays). Future weeks are skipped; a closed week with a final
   * row is skipped unless opts.force. Semanas and Evolução are created bare when missing.
   * @returns {{written: string[], skipped: string[]}} week keys
   */
  storeMany_(starts, s, opts) {
    const o = opts || {};
    Tabs.ensure('weeks');
    Tabs.ensure('evolution');
    const weeks = Weeks.index_('weeks');
    const evo = Weeks.index_('evolution');
    const written = [];
    const skipped = [];
    const appendW = [];
    const appendE = [];
    starts.forEach((d) => {
      const start = Dates.weekStart(d);
      const key = Dates.key(start);
      const existing = weeks[key];
      if (Dates.compare(start, s.today) > 0 || (!o.force && Weeks.isFinal_(existing) && Dates.compare(existing.end, s.today) < 0)) {
        skipped.push(key);
        return;
      }
      const w = Weeks.analyze(start, s);
      const row = Weeks.toRow_(w);
      const erow = Weeks.toEvolution_(w);
      if (existing) Tabs.update('weeks', existing._row, Weeks.fill_('weeks', row));
      else appendW.push(row);
      if (evo[key]) Tabs.update('evolution', evo[key]._row, Weeks.fill_('evolution', erow));
      else appendE.push(erow);
      written.push(key);
    });
    Tabs.appendMany('weeks', appendW);
    Tabs.appendMany('evolution', appendE);
    return { written, skipped };
  },

  /** Every column of the tab, null where the row has no value (clears stale cells on rewrite). */
  fill_(id, row) {
    const out = {};
    Tabs.columns(id).forEach((c) => { out[c.key] = c.key in row ? row[c.key] : null; });
    return out;
  },

  /** Stores the week containing `date` (see storeMany_). @returns the analysed week or null. */
  store(date, opts) {
    const s = Weeks.snapshot_();
    const r = Weeks.storeMany_([date], s, opts);
    return r.written.length ? Weeks.analyze(date, s) : null;
  },

  /** Rewrites the running week (called on every save, phase change and by the daily trigger). */
  refreshCurrent() {
    const s = Weeks.snapshot_();
    const r = Weeks.storeMany_([s.today], s, { force: true });
    Core.emit('weeks.refreshed', { scope: 'current', written: r.written });
    return r;
  },

  /** Writes every closed week that has no final row yet (the week that just ended, gaps). */
  closeFinished() {
    const s = Weeks.snapshot_();
    const closed = Weeks.allStarts_(s).filter((d) => Dates.compare(Dates.weekEnd(d), s.today) < 0);
    return Weeks.storeMany_(closed, s, {});
  },

  /** Recalcular histórico: rewrites every week with the same by-date lookups. */
  recomputeAll() {
    const s = Weeks.snapshot_();
    const r = Weeks.storeMany_(Weeks.allStarts_(s), s, { force: true });
    Core.emit('weeks.refreshed', { scope: 'all', written: r.written });
    return r;
  },

  /** Stored Semanas rows, oldest first ([] when the tab does not exist). */
  list() {
    if (!Tabs.findSheet('weeks')) return [];
    return Tabs.read('weeks').filter((r) => r.start).sort((a, b) => Dates.compare(a.start, b.start));
  },

  /** Stored row of the week containing `date`, or null. */
  stored(date) {
    const k = Dates.key(Dates.weekStart(date));
    return Weeks.list().find((r) => Dates.key(r.start) === k) || null;
  },

  /**
   * One entry per objective version, oldest first, from the stored weeks (values, never
   * recomputed): {id, name, analysisType, label, status, start, end, durationDays, weeks,
   * weeksOnTrack, weeksAttention, weeksOff, weeksInsufficient, startWeightKg, endWeightKg,
   * weightChangeKg, startWaistCm, endWaistCm, waistChangeCm, lastStatus, lastRecommendation,
   * outcome}. Weeks belong to the objective of their Sunday.
   */
  phaseSummary() {
    if (!Tabs.findSheet('objectives')) return [];
    const today = Dates.today();
    const stored = Weeks.list();
    return Objectives.list().filter((o) => o.start).map((o) => {
      const f = o.fields;
      const rows = stored.filter((r) => r.objective === o.id);
      const count = (st) => rows.filter((r) => r.status === st).length;
      const firstVal = (k) => { const r = rows.find((x) => Weeks.num_(x[k])); return r ? r[k] : null; };
      const lastVal = (k) => { const r = rows.slice().reverse().find((x) => Weeks.num_(x[k])); return r ? r[k] : null; };
      const startWeight = Weeks.num_(f.startWeightKg) ? f.startWeightKg : firstVal('weightAvg');
      const endWeight = lastVal('weightAvg');
      const startWaist = Weeks.num_(f.startWaistCm) ? f.startWaistCm : firstVal('waistCm');
      const endWaist = lastVal('waistCm');
      const last = rows.length ? rows[rows.length - 1] : null;
      const ongoing = !o.end || Dates.compare(o.end, today) >= 0;
      const until = ongoing ? today : o.end;
      const classified = rows.length - count('Dados insuficientes');
      const onTrack = count('No caminho');
      let outcome;
      if (Dates.compare(o.start, today) > 0) outcome = 'Planejado';
      else if (!classified) outcome = ongoing ? 'Em andamento — sem semanas avaliadas' : 'Sem dados suficientes';
      else {
        const share = `${onTrack} de ${classified} ${classified === 1 ? 'semana avaliada' : 'semanas avaliadas'} no caminho`;
        outcome = ongoing ? `Em andamento — ${share}` : `${onTrack * 2 >= classified ? 'Maioria no caminho' : 'Maioria fora do caminho'} — ${share}`;
      }
      const rule = Rules.resolve(f.analysisType).rule;
      return {
        id: o.id, name: f.name, analysisType: f.analysisType, label: rule.label, status: f.status,
        start: o.start, end: o.end, durationDays: Dates.compare(o.start, today) > 0 ? 0 : Dates.diffDays(o.start, until) + 1,
        weeks: rows.length, weeksOnTrack: onTrack, weeksAttention: count('Atenção'), weeksOff: count('Fora do esperado'),
        weeksInsufficient: count('Dados insuficientes'),
        startWeightKg: startWeight, endWeightKg: endWeight,
        weightChangeKg: Weeks.num_(startWeight) && Weeks.num_(endWeight) ? Weeks.round_(endWeight - startWeight, 2) : null,
        startWaistCm: startWaist, endWaistCm: endWaist,
        waistChangeCm: Weeks.num_(startWaist) && Weeks.num_(endWaist) ? Weeks.round_(endWaist - startWaist, 2) : null,
        lastStatus: last ? last.status : null, lastRecommendation: last ? last.recommendation : null,
        outcome,
      };
    });
  },
};

/* Hooks, actions and the daily trigger -------------------------------------------------------- */


// Any action that wrote a source of the weekly analysis re-analyses the running week once, when the
// action commits (spec §6.2: "recomputed on every save"): Hoje, food, training, measures, undo.
// Closed weeks keep their frozen rows; Recalcular histórico rewrites them.
Weeks.SOURCE_TABS = ['diary', 'food', 'workouts', 'measures', 'objectives', 'goals', 'plans'];
Core.on('action.committed', (e) => {
  const names = Weeks.SOURCE_TABS.map((id) => Tabs.get(id).name);
  if (e && (e.tabs || []).some((t) => names.includes(t))) Weeks.refreshSafely_();
});

/** refreshCurrent when Semanas exists; an error is logged, never thrown to the caller's save. */
Weeks.refreshSafely_ = function refreshSafely_() {
  if (!Tabs.findSheet('weeks')) {
    // Nothing to re-analyse, but views of the phase (Painel) still follow the change.
    Core.emit('weeks.refreshed', { scope: 'none', written: [] });
    return null;
  }
  try {
    return Weeks.refreshCurrent();
  } catch (err) {
    console.error(err);
    return null;
  }
};

// Semanas/Evolução are derived values: their writes are not undoable actions (logged: false), so
// "Desfazer" keeps undoing the person's last edit.
Actions.register({
  id: 'weeksRefresh', label: 'Atualizar semana', group: 'analysis', quick: true, order: 10, logged: false,
  run: () => {
    const closed = Weeks.closeFinished();
    Weeks.refreshCurrent();
    const w = Weeks.stored(Dates.today());
    const extra = closed.written.length ? ` ${closed.written.length} semana(s) encerrada(s) gravada(s).` : '';
    return { message: w ? `Semana atualizada: ${w.status} · ${w.recommendation}.${extra}` : `Semana atualizada.${extra}` };
  },
});

Actions.register({
  id: 'weeksRecompute', label: 'Recalcular histórico', group: 'analysis', order: 20, logged: false,
  run: () => {
    const r = Weeks.recomputeAll();
    return { message: `${r.written.length} semana(s) recalculada(s) com o objetivo, a meta e a ficha de cada data.` };
  },
});

/** Time-driven trigger (installed by Setup): closes the weeks that ended and refreshes today's. */
function dailyRefresh() {
  return Core.withLock(() => {
    const closed = Weeks.closeFinished();
    const current = Weeks.refreshCurrent();
    return { closed: closed.written, current: current.written };
  });
}
