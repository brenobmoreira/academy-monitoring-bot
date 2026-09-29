/**
 * Versioned entities (spec §4.1–4.2): objectives (O001…), goals (M001…) and plans (F001…).
 *
 * One generic implementation, Versions.create(options), backs all three. A version is
 * {id, start, end, status, fields, rows}: `rows` are its sheet rows (a plan has one row per
 * exercise, all sharing the id), `fields` the first of them. History is append-only: open()
 * closes the latest version on start−1 and appends the next one; a start on or before the
 * latest start is rejected. Status is derived from the dates (Vigente / Encerrado / Planejado)
 * and written with the rows; refreshStatuses() updates it as days pass.
 *
 * Transition.apply is the only phase change: new objective, optionally new goal and plan, and a
 * Revisões row, as one undoable action. Transition.preview computes the same without writing.
 */
const Versions = {
  /**
   * @param {{tab: string, prefix: string, label: string, statuses: {current, closed, planned},
   *   multiRow?: boolean, prepare?: function(Object, {start: Date, opts: Object}): void}} options
   *   prepare fills calculated fields of each new row (e.g. carbs of a goal).
   */
  create(options) {
    const o = Object.assign({ multiRow: false, prepare: null }, options);
    const repo = {
      options: o,
      tab: o.tab,
      prefix: o.prefix,
      label: o.label,
      statuses: o.statuses,

      /** All versions ordered by start (versions with no valid start first), then id. */
      list() {
        const byId = {};
        const order = [];
        Tabs.read(o.tab).forEach((r) => {
          if (r.id === null) return;
          const id = String(r.id).trim();
          if (!byId[id]) {
            byId[id] = { id, start: r.start, end: r.end, status: r.status, fields: r, rows: [] };
            order.push(id);
          }
          byId[id].rows.push(r);
        });
        return order.map((id) => byId[id]).sort((a, b) => Dates.compare(a.start, b.start) || repo.num_(a.id) - repo.num_(b.id));
      },

      /** Version by id, or null. */
      get(id) {
        return repo.list().find((v) => v.id === id) || null;
      },

      /** Version in force on date: start ≤ date ≤ (end or ∞); null before the first. */
      on(date) {
        const d = Dates.parse(date);
        if (!d) return null;
        const hits = repo.list().filter((v) => v.start && Dates.within(d, v.start, v.end));
        return hits.length ? hits[hits.length - 1] : null;
      },

      current() {
        return repo.on(Dates.today());
      },

      /** Version with the latest start (ignores versions with no valid start). */
      latest() {
        const dated = repo.list().filter((v) => v.start);
        return dated.length ? dated[dated.length - 1] : null;
      },

      /** Prefix + 3 digits, max existing + 1. */
      nextId() {
        const max = repo.list().reduce((m, v) => Math.max(m, repo.num_(v.id)), 0);
        return o.prefix + String(max + 1).padStart(3, '0');
      },

      num_(id) {
        const m = new RegExp(`^${o.prefix}(\\d+)$`).exec(String(id));
        return m ? Number(m[1]) : 0;
      },

      /** Status implied by dates, relative to today. */
      statusFor(start, end) {
        const today = Dates.today();
        if (Dates.compare(start, today) > 0) return o.statuses.planned;
        if (end && Dates.compare(end, today) < 0) return o.statuses.closed;
        return o.statuses.current;
      },

      /**
       * Computes what open() would write, without writing. Throws a Portuguese message when the
       * new version cannot be opened.
       * @returns {{id, start: Date, status, close: {version, end: Date, status}|null, rows: Object[]}}
       */
      plan_(fields, start, opts) {
        const s = Dates.require(start, `Início (${o.label})`);
        const versions = repo.list();
        const undated = versions.filter((v) => !v.start);
        if (undated.length) {
          throw new Error(`${o.label}: a versão ${undated.map((v) => v.id).join(', ')} não tem data de início válida. Rode a migração ou corrija a aba "${Tabs.get(o.tab).name}".`);
        }
        const latest = versions.length ? versions[versions.length - 1] : null;
        if (latest && Dates.compare(s, latest.start) <= 0) {
          throw new Error(`${o.label}: o início ${Dates.format(s)} não é posterior ao início de ${latest.id} (${Dates.format(latest.start)}). O histórico só cresce para frente.`);
        }
        let close = null;
        if (latest) {
          const end = Dates.addDays(s, -1);
          if (latest.end && Dates.compare(latest.end, end) < 0) {
            throw new Error(`${o.label}: ${latest.id} terminou em ${Dates.format(latest.end)}; começar em ${Dates.format(s)} deixaria um intervalo sem versão.`);
          }
          close = { version: latest, end, status: repo.statusFor(latest.start, end) };
        }
        const id = repo.nextId();
        const status = repo.statusFor(s, null);
        const list = o.multiRow ? fields : [fields];
        if (!Array.isArray(list) || !list.length) throw new Error(`${o.label}: nenhuma linha para a nova versão.`);
        const rows = list.map((f) => {
          const row = Object.assign({}, f, { id, start: s, end: null, status });
          delete row._row;
          if (o.prepare) o.prepare(row, { start: s, opts: opts || {} });
          return row;
        });
        return { id, start: s, status, close, rows };
      },

      /** Writes a plan from plan_(): closes the previous version and appends the new rows. */
      commit_(p) {
        if (p.close) p.close.version.rows.forEach((r) => Tabs.update(o.tab, r._row, { end: p.close.end, status: p.close.status }));
        return Tabs.appendMany(o.tab, p.rows);
      },

      /**
       * Opens a new version starting on `start` (see plan_ for the rules).
       * @param {Object|Object[]} fields row fields (an array of rows for a multi-row entity)
       * @returns {{id, start: Date, status, closed: {id, end: Date, status}|null, rows: number[]}}
       */
      open(fields, start, opts) {
        return ChangeLog.run(`${o.label}: nova versão`, () => {
          const p = repo.plan_(fields, start, opts);
          const rows = repo.commit_(p);
          return {
            id: p.id, start: p.start, status: p.status, rows,
            closed: p.close ? { id: p.close.version.id, end: p.close.end, status: p.close.status } : null,
          };
        });
      },

      /** Rewrites stored statuses that no longer match the dates. @returns {number} versions changed */
      refreshStatuses() {
        let n = 0;
        repo.list().forEach((v) => {
          if (!v.start) return;
          const status = repo.statusFor(v.start, v.end);
          const stale = v.rows.filter((r) => r.status !== status);
          if (stale.length) { n++; stale.forEach((r) => Tabs.update(o.tab, r._row, { status })); }
        });
        return n;
      },

      /**
       * Structural problems: [{code, id, message}] with codes missing_start, end_before_start,
       * inconsistent_rows, id_format, status_invalid, status_mismatch, overlap, gap, id_order,
       * multiple_current. Empty when the history is consistent.
       */
      validate() {
        const out = [];
        const add = (code, id, message) => out.push({ code, id, message });
        const versions = repo.list();
        const allowed = [o.statuses.current, o.statuses.closed, o.statuses.planned];
        versions.forEach((v) => {
          if (!repo.num_(v.id)) add('id_format', v.id, `${o.label} ${v.id}: ID fora do padrão ${o.prefix}001.`);
          if (!v.start) add('missing_start', v.id, `${o.label} ${v.id}: sem data de início válida (datas antes de 2000 contam como ausentes).`);
          if (v.start && v.end && Dates.compare(v.end, v.start) < 0) add('end_before_start', v.id, `${o.label} ${v.id}: fim ${Dates.format(v.end)} antes do início ${Dates.format(v.start)}.`);
          if (v.rows.some((r) => Dates.key(r.start) !== Dates.key(v.start) || Dates.key(r.end) !== Dates.key(v.end) || r.status !== v.status)) {
            add('inconsistent_rows', v.id, `${o.label} ${v.id}: linhas da mesma versão com início, fim ou status diferentes.`);
          }
          if (v.status !== null && allowed.indexOf(v.status) < 0) add('status_invalid', v.id, `${o.label} ${v.id}: status "${v.status}" inválido.`);
          else if (v.start && v.status !== repo.statusFor(v.start, v.end)) {
            add('status_mismatch', v.id, `${o.label} ${v.id}: status "${v.status || ''}" não confere com as datas (esperado "${repo.statusFor(v.start, v.end)}").`);
          }
        });
        const dated = versions.filter((v) => v.start);
        for (let i = 1; i < dated.length; i++) {
          const a = dated[i - 1];
          const b = dated[i];
          if (!a.end || Dates.compare(a.end, b.start) >= 0) {
            add('overlap', b.id, `${o.label}: ${a.id} e ${b.id} se sobrepõem (${b.id} começa em ${Dates.format(b.start)}).`);
          } else if (Dates.diffDays(a.end, b.start) > 1) {
            add('gap', b.id, `${o.label}: intervalo sem versão entre ${Dates.format(a.end)} e ${Dates.format(b.start)}.`);
          }
          if (repo.num_(b.id) <= repo.num_(a.id)) add('id_order', b.id, `${o.label}: ${b.id} começa depois de ${a.id} mas tem número menor.`);
        }
        const current = versions.filter((v) => v.status === o.statuses.current);
        if (current.length > 1) add('multiple_current', current[1].id, `${o.label}: mais de uma versão vigente (${current.map((v) => v.id).join(', ')}).`);
        return out;
      },
    };
    return repo;
  },
};

const Objectives = Versions.create({
  tab: 'objectives', prefix: 'O', label: 'Objetivo',
  statuses: { current: 'Vigente', closed: 'Encerrado', planned: 'Planejado' },
  prepare(row) {
    if (row.carbs === null || row.carbs === undefined) row.carbs = Energy.carbs(row.kcal, row.protein, row.fat);
  },
});

const Goals = Versions.create({
  tab: 'goals', prefix: 'M', label: 'Meta',
  statuses: { current: 'Vigente', closed: 'Encerrada', planned: 'Planejada' },
  /**
   * Carbs are always derived from kcal, protein and fat and stored with the goal. Tolerances
   * default to Config. BMR / expenditure are computed from Config (opts.weightKg overrides the
   * start weight) unless given; left empty when the profile is incomplete. opts.energy=false skips.
   */
  prepare(row, ctx) {
    const carbs = Energy.carbs(row.kcal, row.protein, row.fat);
    if (carbs !== null) row.carbs = carbs;
    if (row.kcalTolerance === null || row.kcalTolerance === undefined) row.kcalTolerance = Config.get('analysis.kcalTolerance');
    if (row.fatTolerance === null || row.fatTolerance === undefined) row.fatTolerance = Config.get('analysis.fatTolerance');
    if ((row.bmr === null || row.bmr === undefined) && ctx.opts.energy !== false) {
      const e = Energy.fromConfig({ date: ctx.start, weightKg: ctx.opts.weightKg });
      if (e.bmr !== null) {
        row.bmr = e.bmr;
        row.bmrMethod = e.methodLabel;
        row.activityFactor = e.activityFactor;
        row.tdee = e.tdee;
      }
    }
  },
});

const Plans = Object.assign(Versions.create({
  tab: 'plans', prefix: 'F', label: 'Ficha', multiRow: true,
  statuses: { current: 'Vigente', closed: 'Encerrada', planned: 'Planejada' },
  prepare(row, ctx) {
    row.legacyStart = ctx.start;
  },
}), {
  /** Draft keys (Ficha de treino) that differ from the Fichas keys. */
  DRAFT_MAP: { planStatus: 'review', setTypes: 'notes' },

  /** Exercise rows of the Ficha de treino draft, keyed as Fichas rows (ready for open()). */
  draftRows() {
    const keys = Tabs.columns('plans').map((c) => c.key);
    return Tabs.read('planDraft').filter((r) => r.exercise !== null).map((r) => {
      const out = {};
      Object.keys(r).forEach((k) => {
        if (k === '_row') return;
        const key = Plans.DRAFT_MAP[k] || k;
        if (keys.indexOf(key) >= 0 && r[k] !== null) out[key] = r[k];
      });
      return out;
    });
  },

  /** Exercise rows of the plan in force on date ([] when none). */
  exercisesOn(date) {
    const v = Plans.on(date);
    return v ? v.rows : [];
  },
});

const Transition = {
  AREAS: { objective: 'Objetivo/fase', goal: 'Metas', plan: 'Ficha' },

  /**
   * Phase change: new objective from `date`, optionally a new goal and plan; otherwise the goal
   * and plan in force continue. Writes Objetivos/Metas/Fichas and a Revisões row as one undoable
   * action, then emits 'phase.changed' ({date, before, after}) inside the same action so the
   * current week can be re-analysed.
   * @param {{date, objective: Object, goal?: Object, plan?: Object[], reason: string,
   *   reviewer?: string, weightKg?: number}} args
   * @returns {Object} the preview shape with ok: true
   */
  apply(args) {
    return Transition.run_(args, { objective: true });
  },

  /** "Nova meta": the same operation limited to the goal. */
  newGoal(args) {
    return Transition.run_(Object.assign({}, args, { objective: undefined, plan: undefined }), { goal: true });
  },

  /** "Salvar nova ficha": the same operation limited to the plan. */
  newPlan(args) {
    return Transition.run_(Object.assign({}, args, { objective: undefined, goal: undefined }), { plan: true });
  },

  /**
   * What apply/newGoal/newPlan would do, without any write:
   * {ok, errors[], date, area, before: {objective, goal, plan}, after: {…}, closes: [{entity, id,
   * end, status}], opens: [{entity, id, start, status}], review: {Revisões row}}. Dates as keys.
   */
  preview(args) {
    const need = args && args.objective ? { objective: true } : args && args.goal ? { goal: true } : { plan: true };
    return Transition.view_(Transition.compute_(args || {}, need));
  },

  run_(args, need) {
    return Core.withLock(() => {
      const c = Transition.compute_(args, need);
      if (c.errors.length) {
        const err = new Error(c.errors.join(' '));
        err.apiErrors = c.errors.map((m) => ({ path: 'args', code: 'invalid', message: m }));
        throw err;
      }
      return ChangeLog.run(c.area === Transition.AREAS.objective ? 'Mudar objetivo/fase' : c.area === Transition.AREAS.goal ? 'Nova meta' : 'Salvar nova ficha', () => {
        ['objective', 'goal', 'plan'].forEach((k) => { if (c.planned[k]) Transition.repo_(k).commit_(c.planned[k]); });
        const reviewRow = Tabs.append('reviews', c.review);
        Core.emit('phase.changed', { date: c.date, before: c.before, after: c.after });
        return Object.assign(Transition.view_(c), { reviewRow });
      });
    });
  },

  repo_(key) {
    return { objective: Objectives, goal: Goals, plan: Plans }[key];
  },

  isNum_(v) {
    return typeof v === 'number' && isFinite(v);
  },

  /** Validates, resolves ids and plans every write. Never writes. */
  compute_(args, need) {
    const errors = [];
    const date = Dates.parse(args.date);
    if (!date) errors.push('Data da mudança inválida ou ausente.');
    const reason = args.reason === null || args.reason === undefined ? '' : String(args.reason).trim();
    if (!reason) errors.push('Informe o motivo da mudança.');
    const reviewer = args.reviewer || Config.get('client.reviewer') || null;

    const objective = args.objective ? Object.assign({}, args.objective) : null;
    const goal = args.goal ? Object.assign({}, args.goal) : null;
    const plan = args.plan ? args.plan.map((r) => Object.assign({}, r)) : null;
    if (need.objective && !objective) errors.push('Informe o novo objetivo.');
    if (need.goal && !goal) errors.push('Informe a nova meta.');
    if (need.plan && !plan) errors.push('Informe a nova ficha.');
    if (objective) {
      if (!objective.name || !String(objective.name).trim()) errors.push('Objetivo: informe o nome.');
      if (Tabs.ENUMS.ANALYSIS_TYPES.indexOf(objective.analysisType) < 0) errors.push(`Objetivo: tipo de análise inválido (${objective.analysisType}). Use: ${Tabs.ENUMS.ANALYSIS_TYPES.join(', ')}.`);
    }
    if (goal) {
      if (!Transition.isNum_(goal.kcal) || goal.kcal <= 0) errors.push('Meta: kcal deve ser um número positivo.');
      if (!Transition.isNum_(goal.protein) || goal.protein <= 0) errors.push('Meta: proteína deve ser um número positivo.');
      if (goal.fat !== undefined && goal.fat !== null && !Transition.isNum_(goal.fat)) errors.push('Meta: gordura deve ser um número.');
    }
    if (plan) {
      if (!plan.length) errors.push('Ficha: nenhuma linha.');
      plan.forEach((r, i) => { if (!r.exercise || !r.session) errors.push(`Ficha: linha ${i + 1} sem sessão ou exercício.`); });
    }
    const area = objective ? Transition.AREAS.objective : goal ? Transition.AREAS.goal : Transition.AREAS.plan;
    const out = { errors, date, area, before: {}, after: {}, planned: {}, review: null };
    if (!date || errors.length) return out;

    const cur = { objective: Objectives.on(date), goal: Goals.on(date), plan: Plans.on(date) };
    out.before = { objective: cur.objective ? cur.objective.id : null, goal: cur.goal ? cur.goal.id : null, plan: cur.plan ? cur.plan.id : null };
    out.after = {
      objective: objective ? Objectives.nextId() : out.before.objective,
      goal: goal ? Goals.nextId() : out.before.goal,
      plan: plan ? Plans.nextId() : out.before.plan,
    };

    if (goal) {
      if (goal.objective === undefined) goal.objective = out.after.objective;
      if (goal.reason === undefined) goal.reason = reason;
      if (goal.reviewer === undefined) goal.reviewer = reviewer;
    }
    if (objective) {
      const g = goal || (cur.goal ? cur.goal.fields : {});
      ['kcal', 'protein', 'fat', 'strengthPerWeek', 'cardioPerWeek', 'activitiesPerWeek'].forEach((k) => {
        if ((objective[k] === undefined || objective[k] === null) && g[k] !== undefined && g[k] !== null) objective[k] = g[k];
      });
      if (objective.goal === undefined) objective.goal = out.after.goal;
      if (objective.plan === undefined) objective.plan = out.after.plan;
      if (objective.reason === undefined) objective.reason = reason;
      if (objective.reviewer === undefined) objective.reviewer = reviewer;
    }
    // Listeners may fill baseline values (initial weight/waist) before the rows are planned.
    Core.emit('transition.prepare', { date, objective, goal, plan });

    const specs = { objective, goal, plan };
    Object.keys(specs).forEach((k) => {
      if (!specs[k]) return;
      try {
        out.planned[k] = Transition.repo_(k).plan_(specs[k], date, { weightKg: args.weightKg });
      } catch (err) {
        errors.push(err.message);
      }
    });
    if (errors.length) return out;

    const parts = [];
    const describe = (k, label) => {
      const b = out.before[k];
      const a = out.after[k];
      if (specs[k]) parts.push(`${label} ${b || '—'} → ${a}${k === 'objective' ? ` (${objective.name})` : ''}`);
      else parts.push(`${label} ${a || '—'} ${k === 'objective' ? 'mantido' : 'mantida'}`);
    };
    describe('objective', 'Objetivo');
    describe('goal', 'Meta');
    describe('plan', 'Ficha');
    const future = Dates.compare(date, Dates.today()) > 0;
    out.review = {
      date,
      area,
      reason,
      change: `${parts.join('; ')}; a partir de ${Dates.format(date)}.`,
      reviewer,
      status: future ? 'Planejado' : 'Aplicado',
      nextReview: Dates.addDays(date, Config.get('analysis.reviewEveryDays')),
      objective: out.after.objective,
      goal: out.after.goal,
      plan: out.after.plan,
    };
    return out;
  },

  /** Public shape of a computed transition (dates as yyyy-MM-dd keys). */
  view_(c) {
    const closes = [];
    const opens = [];
    ['objective', 'goal', 'plan'].forEach((k) => {
      const p = c.planned[k];
      if (!p) return;
      if (p.close) closes.push({ entity: k, id: p.close.version.id, end: Dates.key(p.close.end), status: p.close.status });
      opens.push({ entity: k, id: p.id, start: Dates.key(p.start), status: p.status, rows: p.rows.length });
    });
    const review = c.review ? Object.assign({}, c.review, { date: Dates.key(c.review.date), nextReview: Dates.key(c.review.nextReview) }) : null;
    return {
      ok: c.errors.length === 0, errors: c.errors.slice(), date: Dates.key(c.date), area: c.area,
      before: c.before, after: c.after, closes, opens, review,
    };
  },
};
