/**
 * JSON API over the spreadsheet for the Telegram bot (spec §12). The agent calls it over HTTP
 * (doPost, the Web App); tests and other scripts call SheetApi.run in-process.
 *
 * Request:  {"key": "<SHEET_API_KEY>", "op": "<operation>", "args": {...}}
 * Response: {"ok": true, "result": {...}} | {"ok": false, "errors": [{path, code, message, suggestions?}]}
 *
 * Apps Script cannot set HTTP status codes, so the outcome is always in the body. The key is
 * checked against the Script Property SHEET_API_KEY (Config.sheetApiKey()). Arguments are
 * validated strictly (api_validator.js) and every error is reported at once; nothing is written
 * unless the whole request is valid.
 *
 * Writes never touch a tab directly: they call the domain modules (Diary.save, FoodLog.add /
 * addFavorite / addNoCalc, Sessions.savePartial / complete) inside the script lock and one
 * ChangeLog action, so the write is undoable as a whole (its action id is the `writeId`) and the
 * action's commit refreshes the running week (Weeks). A domain refusal rolls the action back.
 *
 * Reads resolve everything by date: phase.get / day.get / week.get return the objective, goal and
 * plan in force on the date asked, never the current ones.
 *
 * Error codes: unauthorized, invalid_json, wrong_type, unknown_field, unknown_op, required, empty,
 * too_long, out_of_range, invalid_date, date_in_future, invalid_range, not_in_catalog, duplicate,
 * conflict, incomplete_food, invalid_unit, rejected (the domain refused a valid-looking request;
 * the message says why), nothing_to_undo, not_found, already_undone, not_latest, unavailable
 * (lock busy), internal (unexpected exception).
 */
function doPost(e) {
  const text = e && e.postData ? e.postData.contents : '';
  return ContentService.createTextOutput(JSON.stringify(SheetApi.handle(text)))
    .setMimeType(ContentService.MimeType.JSON);
}

const SheetApi = {
  ENVELOPE: ['key', 'op', 'args'],
  /** How far back catalog.recent looks. */
  RECENT_MINUTES: 30,
  LABEL_PREFIX: 'Bot:',

  /**
   * op → {write, validate(args) -> {value, errors}, run(value), meta?(value) (writes: what the
   * ChangeLog label records, read back by catalog.recent and write.undo), logged? (default true
   * for writes)}
   */
  OPS: {
    catalog: {
      write: false,
      validate: (a) => ApiValidator.empty(a),
      run: () => SheetApi.catalog_(),
    },
    'diary.upsert': {
      write: true,
      validate: (a) => ApiValidator.diaryUpsert(a),
      meta: (v) => ({ op: 'diary.upsert', date: v.date, fields: Object.keys(v.fields) }),
      run: (v) => SheetApi.diaryUpsert_(v),
    },
    'workout.upsert': {
      write: true,
      validate: (a) => ApiValidator.workoutUpsert(a),
      meta: (v) => ({ op: 'workout.upsert', date: v.date, session: v.session, exercises: v.exercises.map((e) => e.name), complete: v.complete }),
      run: (v) => SheetApi.workoutUpsert_(v),
    },
    'food.add': {
      write: true,
      validate: (a) => ApiValidator.foodAdd(a),
      meta: (v) => ({ op: 'food.add', date: v.date, meal: v.meal, items: v.items.map((i) => i.food || i.favorite || i.description) }),
      run: (v) => SheetApi.foodAdd_(v),
    },
    'write.undo': {
      write: true,
      logged: false, // undo writes are never an action of their own
      validate: (a) => ApiValidator.writeUndo(a),
      run: (v) => SheetApi.undo_(v),
    },
    'day.get': {
      write: false,
      validate: (a) => ApiValidator.date(a, false),
      run: (v) => SheetApi.day_(v.date),
    },
    'diary.range': {
      write: false,
      validate: (a) => ApiValidator.dateRange(a),
      run: (v) => ({ from: v.from, to: v.to, days: SheetApi.diaryRange_(v.from, v.to) }),
    },
    'workout.range': {
      write: false,
      validate: (a) => ApiValidator.dateRange(a),
      run: (v) => ({ from: v.from, to: v.to, rows: SheetApi.workoutRange_(v.from, v.to) }),
    },
    'exercise.history': {
      write: false,
      validate: (a) => ApiValidator.exerciseHistory(a),
      run: (v) => SheetApi.exerciseHistory_(v.name, v.limit),
    },
    'phase.get': {
      write: false,
      validate: (a) => ApiValidator.date(a, true),
      run: (v) => SheetApi.phase_(Dates.fromKey(v.date)),
    },
    'week.get': {
      write: false,
      validate: (a) => ApiValidator.date(a, false),
      run: (v) => SheetApi.week_(Dates.fromKey(v.date)),
    },
  },

  /* Entry points ------------------------------------------------------------------------------ */

  /** HTTP entry: parse, authenticate, check the envelope, then run. */
  handle(text) {
    let request;
    try {
      request = JSON.parse(text);
    } catch (err) {
      return SheetApi.fail_('body', 'invalid_json', 'corpo não é JSON válido');
    }
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return SheetApi.fail_('body', 'wrong_type', 'esperado objeto JSON {key, op, args}');
    }
    let expected;
    try {
      expected = Config.sheetApiKey();
    } catch (err) {
      return SheetApi.fail_('key', 'internal', err.message);
    }
    if (typeof request.key !== 'string' || request.key !== expected) return SheetApi.fail_('key', 'unauthorized', 'chave inválida');
    const unknown = Object.keys(request).filter((k) => !SheetApi.ENVELOPE.includes(k));
    if (unknown.length) {
      return { ok: false, errors: unknown.map((k) => ({ path: k, code: 'unknown_field', message: `campo desconhecido; aceitos: ${SheetApi.ENVELOPE.join(', ')}` })) };
    }
    return SheetApi.run(request.op, request.args === undefined ? {} : request.args);
  },

  /**
   * In-process entry: validate, then run; writes hold the script lock and run as one ChangeLog
   * action (writeId = its id, added only when something was written).
   */
  run(op, args) {
    const spec = typeof op === 'string' && Object.prototype.hasOwnProperty.call(SheetApi.OPS, op) ? SheetApi.OPS[op] : null;
    if (!spec) return SheetApi.fail_('op', 'unknown_op', `operação desconhecida ${JSON.stringify(op)}; aceitas: ${Object.keys(SheetApi.OPS).join(', ')}`);
    const exec = () => {
      const checked = spec.validate(args);
      if (checked.errors.length) return { ok: false, errors: checked.errors };
      const value = checked.value;
      if (!spec.write || spec.logged === false) return { ok: true, result: spec.run(value) };
      let writeId = null;
      const result = ChangeLog.run(SheetApi.label_(spec.meta(value)), () => {
        const r = spec.run(value);
        if (ChangeLog.changeCount() > 0) writeId = ChangeLog.active().id;
        return r;
      });
      if (writeId) result.writeId = writeId;
      return { ok: true, result };
    };
    try {
      return spec.write ? Core.withLock(exec) : exec();
    } catch (err) {
      return SheetApi.error_(err, args);
    } finally {
      Tabs.invalidate();
      Config.invalidate();
    }
  },

  /** An exception as {ok: false, errors}. */
  error_(err, args) {
    if (err && err.apiErrors) {
      const hasId = args && typeof args === 'object' && args.writeId !== undefined;
      return {
        ok: false,
        errors: err.apiErrors.map((e) => Object.assign({}, e, {
          path: e.path === 'rows' ? 'args.exercises' : e.path === 'args' && hasId ? 'args.writeId' : e.path,
        })),
      };
    }
    const message = err && err.message ? err.message : String(err);
    if (/^Outra alteração está em andamento/.test(message)) return SheetApi.fail_('', 'unavailable', message);
    if (err && err.name === 'Error') return SheetApi.fail_('args', 'rejected', message);
    console.error(err);
    return SheetApi.fail_('', 'internal', message);
  },

  fail_(path, code, message) {
    return { ok: false, errors: [{ path, code, message }] };
  },

  /* Action labels (Log "Ação"): readable text + the op summary as JSON ------------------------- */

  label_(meta) {
    const day = Dates.format(meta.date);
    const text = meta.op === 'diary.upsert' ? `Diário ${day}`
      : meta.op === 'workout.upsert' ? `treino ${meta.session} ${day}`
        : `alimentação ${meta.meal} ${day}`;
    return `${SheetApi.LABEL_PREFIX} ${text} ${JSON.stringify(meta)}`;
  },

  /** {text, meta} of a Log label; meta null for actions not made by this API (menu, Hoje). */
  parseLabel_(label) {
    const s = String(label === null || label === undefined ? '' : label);
    const i = s.indexOf(' {"op":');
    if (s.indexOf(SheetApi.LABEL_PREFIX) === 0 && i > 0) {
      try {
        return { text: s.slice(0, i), meta: JSON.parse(s.slice(i + 1)) };
      } catch (err) {
        // a hand-edited label: fall through
      }
    }
    return { text: s, meta: null };
  },

  /* Serialisation ------------------------------------------------------------------------------ */

  has_(id) {
    return !!Tabs.findSheet(id);
  },

  isNum_(v) {
    return typeof v === 'number' && isFinite(v);
  },

  /** Picks keys of a row object; dates as yyyy-MM-dd, empty as null. */
  pick_(row, keys) {
    const out = {};
    keys.forEach((k) => {
      const v = row ? row[k] : null;
      out[k] = v instanceof Date ? Dates.key(v) : (v === undefined ? null : v);
    });
    return out;
  },

  /** Only the keys whose value is present. */
  compact_(obj) {
    const out = {};
    Object.keys(obj).forEach((k) => { if (obj[k] !== null && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
  },

  pair_(kg, reps) {
    return SheetApi.isNum_(kg) && SheetApi.isNum_(reps) ? { kg, reps } : null;
  },

  work_(sets) {
    return sets.map((s) => ({ kg: s.kg, reps: s.reps, rir: s.rir }));
  },

  /**
   * Context for exercise_: the exercise catalogue, a plan cache and, when `withPrevious`, the
   * work-set history index (Progression.index) used for `previous` / `comparison`.
   */
  exCtx_(all, withPrevious) {
    return { catalogue: Exercises.list(), plans: {}, index: withPrevious ? Progression.index(all) : null };
  },

  /**
   * A Registro de treino row as the API exercise shape: warm-up and feeder apart, `work` = the
   * work sets done (the only ones in volume and comparison). With ctx.index, also the previous
   * session of the exercise before the row's date and Progression.compare's verdict.
   */
  exercise_(row, ctx) {
    const entry = Progression.entry(row);
    const planId = row.plan ? String(row.plan) : '';
    if (planId && !(planId in ctx.plans)) {
      const v = SheetApi.has_('plans') ? Plans.get(planId) : null;
      ctx.plans[planId] = v ? v.rows : [];
    }
    const out = SheetApi.compact_({
      name: String(row.exercise).trim(),
      group: Exercises.groupOf(row.exercise, planId ? ctx.plans[planId] : [], ctx.catalogue),
      equipment: row.equipment,
      warmup: SheetApi.pair_(row.warmupKg, row.warmupReps),
      feeder: SheetApi.pair_(row.feederKg, row.feederReps),
    });
    out.work = SheetApi.work_(entry.sets);
    out.workSets = SheetApi.isNum_(row.workSetsDone) ? row.workSetsDone : entry.sets.length;
    out.volume = SheetApi.isNum_(row.workVolume) ? row.workVolume : null;
    out.prescription = SheetApi.isNum_(row.workSetsPrescribed) || SheetApi.isNum_(row.repsMin)
      ? { sets: row.workSetsPrescribed, repsMin: row.repsMin, repsMax: row.repsMax } : null;
    Object.assign(out, SheetApi.compact_({ pain: row.pain, note: row.note }));
    if (ctx.index) {
      const prev = Progression.previous(ctx.index[Exercises.normalize(row.exercise)] || [], row.date);
      out.previous = prev ? {
        date: Dates.key(prev.date), session: prev.session, work: SheetApi.work_(prev.sets),
        volume: Math.round(prev.volume * 100) / 100, equipment: prev.equipment,
      } : null;
      out.comparison = prev ? Progression.compare(prev, entry) : null;
    }
    return out;
  },

  FOOD_KEYS: ['entryId', 'meal', 'food', 'qty', 'unit', 'kcal', 'protein', 'carbs', 'fat', 'fiber', 'calc', 'source', 'check', 'favorite', 'note'],
  TOTAL_KEYS: ['kcal', 'protein', 'carbs', 'fat', 'fiber', 'noCalcItems', 'estimatedItems'],

  foodItem_(row) {
    const out = SheetApi.pick_(row, SheetApi.FOOD_KEYS);
    out.calc = FoodLog.kind(row);
    return out;
  },

  /* catalog ------------------------------------------------------------------------------------ */

  catalog_() {
    const today = Dates.today();
    const plan = SheetApi.has_('plans') ? Plans.on(today) : null;
    const trainingPhase = Sessions.phaseOn(today, plan);
    const all = Workouts.rows();
    let next = null;
    try { next = Sessions.nextSession(today, all); } catch (err) { next = null; }
    let lastWorkout = null;
    if (all.length) {
      const last = all.slice().sort((a, b) => Dates.compare(a.date, b.date) || a._row - b._row)[all.length - 1];
      const s = Workouts.sessionsOn(all, last.date).find((x) => Exercises.normalize(x.session) === Exercises.normalize(last.session));
      lastWorkout = { date: Dates.key(last.date), session: s.session, state: s.state };
    }
    return {
      today: Dates.key(today),
      timezone: Config.timezone(),
      client: { name: Config.get('client.name') },
      phase: SheetApi.phase_(today),
      trainingPhase,
      sessions: Sessions.names(today),
      rotation: Sessions.rotation(today),
      rotationMode: Sessions.mode(),
      nextSession: next,
      lastWorkout,
      exercises: Exercises.known(today).map((e) => ({ name: e.name, group: e.group })),
      plan: (plan ? plan.rows : []).filter((r) => r.exercise !== null).map((r) => {
        const p = Sessions.prescription(r, trainingPhase);
        return Object.assign({ session: r.session, exercise: r.exercise, group: r.group }, p, { prescription: Sessions.prescriptionText(p) });
      }),
      foods: SheetApi.has_('foods') ? Foods.names() : [],
      favorites: SheetApi.has_('favorites') && SheetApi.has_('ingredients') ? Favorites.names() : [],
      meals: FoodLog.MEALS.slice(),
      units: Units.LIST.slice(),
      foodLog: Tabs.ENUMS.FOOD_LOG.slice(),
      recent: SheetApi.recent_(),
    };
  },

  /** Actions of the last RECENT_MINUTES not undone, newest first (bot writes carry their summary). */
  recent_() {
    if (!SheetApi.has_('log')) return [];
    const since = Date.now() - SheetApi.RECENT_MINUTES * 60 * 1000;
    return ChangeLog.actions()
      .filter((a) => !a.undone && a.at instanceof Date && a.at.getTime() >= since)
      .reverse()
      .map((a) => {
        const p = SheetApi.parseLabel_(a.label);
        return Object.assign({ writeId: a.id, at: a.at.toISOString(), action: p.text }, p.meta || {});
      });
  },

  /* phase.get ---------------------------------------------------------------------------------- */

  OBJECTIVE_KEYS: ['id', 'name', 'analysisType', 'start', 'end', 'status', 'startWeightKg', 'startWaistCm', 'expectation',
    'weightRateMinPct', 'weightRateMaxPct', 'reason', 'reviewer'],
  GOAL_KEYS: ['id', 'start', 'end', 'status', 'kcal', 'protein', 'proteinMin', 'proteinMax', 'fat', 'carbs', 'fiber',
    'kcalTolerance', 'fatTolerance', 'strengthPerWeek', 'cardioPerWeek', 'activitiesPerWeek', 'stepsPerDay', 'bmr', 'tdee'],

  /** Ids and targets in force on `date` (never the current ones), plus the latest stored recommendation. */
  phase_(date) {
    const on = (repo) => (SheetApi.has_(repo.tab) ? repo.on(date) : null);
    const o = on(Objectives);
    const g = on(Goals);
    const p = on(Plans);
    const objective = o ? SheetApi.pick_(Object.assign({}, o.fields, { id: o.id, start: o.start, end: o.end, status: o.status }), SheetApi.OBJECTIVE_KEYS) : null;
    if (objective) {
      const rule = Rules.resolve(o.fields.analysisType);
      objective.label = rule && rule.rule ? rule.rule.label : null;
      objective.days = Dates.diffDays(o.start, date) + 1;
      objective.weeks = Math.floor((objective.days - 1) / 7) + 1;
    }
    const goal = g ? SheetApi.pick_(Object.assign({}, g.fields, { id: g.id, start: g.start, end: g.end, status: g.status }), SheetApi.GOAL_KEYS) : null;
    const plan = p ? {
      id: p.id, start: Dates.key(p.start), end: p.end ? Dates.key(p.end) : null, status: p.status,
      sessions: Sessions.planSessions(date), trainingPhase: Sessions.phaseOn(date, p),
    } : null;
    return { date: Dates.key(date), objective, goal, plan, recommendation: SheetApi.lastRecommendation_(date, o ? o.id : null) };
  },

  /** Latest stored Semanas analysis of the objective up to the week of `date`, or null. */
  lastRecommendation_(date, objectiveId) {
    if (!objectiveId || !SheetApi.has_('weeks')) return null;
    const until = Dates.key(Dates.weekStart(date));
    const rows = Weeks.list().filter((r) => r.objective === objectiveId && Dates.key(r.start) <= until);
    const r = rows[rows.length - 1];
    if (!r) return null;
    return {
      week: Dates.key(r.start), status: r.status, code: r.recommendation, reason: r.recommendationReason,
      nextReview: r.nextReview ? Dates.key(r.nextReview) : null,
    };
  },

  /* week.get ----------------------------------------------------------------------------------- */

  /**
   * The Semanas row of the week containing `date`: the stored row of a closed week (frozen
   * values), or the running week (or a closed week never stored) analysed now without writing.
   */
  week_(date) {
    const start = Dates.weekStart(date);
    const closed = Dates.compare(Dates.weekEnd(start), Dates.today()) < 0;
    const stored = SheetApi.has_('weeks') ? Weeks.stored(start) : null;
    let row;
    let source;
    if (stored && closed) {
      row = stored;
      source = 'stored';
    } else {
      row = Weeks.toRow_(Weeks.analyze(start));
      source = 'computed';
    }
    const out = SheetApi.pick_(row, Tabs.columns('weeks').map((c) => c.key));
    out.computedAt = row.computedAt instanceof Date ? row.computedAt.toISOString() : null;
    return Object.assign({ source, closed }, out);
  },

  /* diary ---------------------------------------------------------------------------------------- */

  diaryUpsert_(v) {
    const r = Diary.save(v.date, v.fields);
    const day = Days.get(v.date);
    const fields = SheetApi.pick_(day, Object.keys(v.fields));
    const ids = day ? SheetApi.pick_(day, ['objective', 'goal', 'plan']) : Days.idsOn(Dates.fromKey(v.date));
    return { date: v.date, row: r.row, fields, changed: r.changed, dayState: r.dayState, ids };
  },

  /** A Diário row: date, ids, the typed fields present, food totals and state. */
  dayRow_(row) {
    const out = { date: Dates.key(row.date) };
    Object.assign(out, SheetApi.compact_(SheetApi.pick_(row, Object.keys(Diary.FIELDS))));
    Object.assign(out, SheetApi.compact_(SheetApi.pick_(row, SheetApi.TOTAL_KEYS.concat(['sessions']))));
    out.dayState = Diary.dayState(row);
    out.ids = SheetApi.pick_(row, ['objective', 'goal', 'plan']);
    return out;
  },

  diaryRange_(from, to) {
    return Diary.rows()
      .filter((r) => r.date && Dates.within(r.date, from, to))
      .sort((a, b) => Dates.compare(a.date, b.date))
      .map((r) => SheetApi.dayRow_(r));
  },

  /* workouts ------------------------------------------------------------------------------------- */

  /** Request exercise → Hoje-style row for Sessions.save_; absent warm-up/feeder/pain/note keep what was saved. */
  sessionRow_(ex, saved) {
    const keep = (k) => (saved ? saved[k] : null);
    const w = ex.work || [];
    const row = {
      exercise: ex.name,
      warmupKg: ex.warmup ? ex.warmup.kg : keep('warmupKg'),
      warmupReps: ex.warmup ? ex.warmup.reps : keep('warmupReps'),
      feederKg: ex.feeder ? ex.feeder.kg : keep('feederKg'),
      feederReps: ex.feeder ? ex.feeder.reps : keep('feederReps'),
      work1Kg: w[0] ? w[0].kg : null,
      work1Reps: w[0] ? w[0].reps : null,
      rir1: w[0] && w[0].rir !== undefined ? w[0].rir : null,
      work2Kg: w[1] ? w[1].kg : null,
      work2Reps: w[1] ? w[1].reps : null,
      rir2: w[1] && w[1].rir !== undefined ? w[1].rir : null,
      pain: ex.pain !== undefined ? ex.pain : keep('pain'),
      note: ex.note !== undefined ? ex.note : keep('note'),
    };
    if (ex.equipment !== undefined) row.equipment = ex.equipment;
    return row;
  },

  workoutUpsert_(v) {
    const d = Dates.fromKey(v.date);
    const before = Workouts.rows();
    const rows = v.exercises.map((ex) => {
      const saved = Workouts.ofSession(before, d, v.session).find((r) => Exercises.normalize(r.exercise) === Exercises.normalize(ex.name));
      return SheetApi.sessionRow_(ex, saved || null);
    });
    const res = v.complete ? Sessions.complete(d, v.session, rows) : Sessions.savePartial(d, v.session, rows);
    const all = Workouts.rows();
    const ctx = SheetApi.exCtx_(all, true);
    const saved = Workouts.ofSession(all, d, res.session);
    const exercises = v.exercises.map((ex) => {
      const row = saved.find((r) => Exercises.normalize(r.exercise) === Exercises.normalize(ex.name));
      return SheetApi.exercise_(row, ctx);
    });
    return {
      date: v.date, session: res.session, state: res.state, plan: res.plan, objective: res.objective, phase: res.phase,
      exercises, workSets: res.workSets, workVolume: res.workVolume, sessionsConcluded: res.sessionsConcluded, next: res.next,
    };
  },

  /** Sessions of a date: [{session, state, plan, phase, exercises}]. */
  sessions_(all, date) {
    const ctx = SheetApi.exCtx_(all, true);
    return Workouts.sessionsOn(all, date).map((s) => ({
      session: s.session, state: s.state, plan: s.rows[0].plan, phase: s.rows[0].phase,
      exercises: s.rows.map((r) => SheetApi.exercise_(r, ctx)),
    }));
  },

  workoutRange_(from, to) {
    const all = Workouts.rows();
    const ctx = SheetApi.exCtx_(all, false);
    return all
      .filter((r) => Dates.within(r.date, from, to))
      .sort((a, b) => Dates.compare(a.date, b.date) || a._row - b._row)
      .map((r) => Object.assign({ date: Dates.key(r.date), session: String(r.session).trim(), state: r.sessionState, plan: r.plan },
        SheetApi.exercise_(r, ctx)));
  },

  exerciseHistory_(name, limit) {
    const entries = Progression.history(name).slice().reverse().slice(0, limit);
    return {
      name,
      group: Exercises.groupOf(name, [], Exercises.list()),
      sessions: entries.map((e) => ({
        date: Dates.key(e.date), session: e.session, plan: e.plan, state: e.state, equipment: e.equipment,
        work: SheetApi.work_(e.sets), volume: Math.round(e.volume * 100) / 100,
      })),
    };
  },

  /* food ------------------------------------------------------------------------------------------ */

  foodAdd_(v) {
    const rows = [];
    v.items.forEach((it) => {
      let r;
      if (it.kind === 'food') {
        r = FoodLog.add({ date: v.date, meal: v.meal, food: it.food, qty: it.qty, unit: it.unit, measure: it.measure, note: it.note });
      } else if (it.kind === 'favorite') {
        r = FoodLog.addFavorite({ date: v.date, meal: v.meal, name: it.favorite, portions: it.portions });
      } else {
        r = FoodLog.addNoCalc({ date: v.date, meal: v.meal, description: it.description, qty: it.qty, unit: it.unit, note: it.note });
      }
      rows.push(...r.rows);
    });
    const totals = FoodLog.dayTotals(v.date);
    return {
      date: v.date, meal: v.meal,
      items: rows.map((row) => SheetApi.foodItem_(Tabs.readRow('food', row))),
      totals: totals ? SheetApi.pick_(totals, SheetApi.TOTAL_KEYS) : null,
      dayState: Diary.dayState(v.date),
    };
  },

  /* day.get --------------------------------------------------------------------------------------- */

  day_(key) {
    const d = Dates.fromKey(key);
    const row = SheetApi.has_('diary') ? Days.get(d) : null;
    let diary = null;
    if (row) {
      diary = SheetApi.compact_(SheetApi.pick_(row, Object.keys(Diary.FIELDS)));
      if (!Object.keys(diary).length) diary = null;
    }
    const all = Workouts.rows();
    return {
      date: key,
      ids: row ? SheetApi.pick_(row, ['objective', 'goal', 'plan']) : Days.idsOn(d),
      diary,
      totals: row ? SheetApi.pick_(row, SheetApi.TOTAL_KEYS) : null,
      dayState: Diary.dayState(row),
      food: SheetApi.has_('food') ? FoodLog.rows(d).map((r) => SheetApi.foodItem_(r)) : [],
      workout: SheetApi.sessions_(all, d),
    };
  },

  /* write.undo ------------------------------------------------------------------------------------ */

  undo_(v) {
    const r = v.writeId === undefined ? Undo.last() : Undo.action(v.writeId);
    const p = SheetApi.parseLabel_(r.action);
    return { writeId: r.actionId, undone: Object.assign({ action: p.text, changes: r.changes }, p.meta || {}) };
  },
};
