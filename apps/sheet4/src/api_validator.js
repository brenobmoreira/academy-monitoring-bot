/**
 * Strict validation of the bot API arguments (api.js). Nothing is coerced: "82,4" is not a number
 * and "sim" is not a boolean. Every error is collected in one pass so the caller (usually an LLM
 * agent) can fix them all before retrying; nothing is written unless everything is valid.
 *
 * Each validator returns {value, errors}; value is null whenever errors is non-empty.
 * Error = {path, code, message, suggestions?}. Messages are Portuguese and aimed at the model.
 * Names (session, exercise, food, favourite) are matched ignoring case and accents and come back
 * in their canonical spelling; an unknown name gets the closest ones as `suggestions`.
 *
 * Domain rules stay in the domain modules: ranges of the day's fields come from Diary.FIELDS,
 * valid sessions from Sessions.names(date), exercises from Exercises.known(date), unit
 * conversions from Units.tryConvert, catalogue completeness from Foods.problems.
 */
const ApiValidator = {
  MAX_RANGE_DAYS: 92,
  MAX_EXERCISES: 15,
  MAX_WORK_SETS: 2,
  MAX_FOOD_ITEMS: 20,
  TEXT_MAX: { notes: 500, activity: 100 },

  /* diary.upsert --------------------------------------------------------------------------- */

  diaryUpsert(args) {
    const c = new ApiChecker_();
    if (!c.object(args, 'args')) return c.result(null);
    c.onlyKeys(args, 'args', ['date', 'fields']);
    c.date(args.date, 'args.date');
    const fields = args.fields;
    const names = Object.keys(Diary.FIELDS);
    if (fields === undefined) c.add('args.fields', 'required', `campo obrigatório; aceitos: ${names.join(', ')}`);
    else if (c.object(fields, 'args.fields')) {
      const keys = Object.keys(fields);
      if (!keys.length) c.add('args.fields', 'empty', `informe ao menos um campo: ${names.join(', ')}`);
      keys.forEach((name) => {
        const spec = Diary.FIELDS[name];
        const path = `args.fields.${name}`;
        if (!spec) { c.add(path, 'unknown_field', `campo desconhecido; aceitos: ${names.join(', ')}`); return; }
        if (fields[name] === null) return; // explicit clear (não informado)
        if (spec.type === 'text') c.value(fields[name], path, { type: 'text', maxLength: ApiValidator.TEXT_MAX[name] || 200 });
        else if (spec.type === 'enum') c.oneOf(fields[name], path, spec.enum, `em ${spec.label}`, { exact: true });
        else c.value(fields[name], path, { type: spec.type, min: spec.min, max: spec.max });
      });
    }
    return c.result({ date: args.date, fields });
  },

  /* workout.upsert ------------------------------------------------------------------------- */

  workoutUpsert(args) {
    const c = new ApiChecker_();
    if (!c.object(args, 'args')) return c.result(null);
    c.onlyKeys(args, 'args', ['date', 'session', 'exercises', 'complete']);
    const dateOk = c.date(args.date, 'args.date');
    if (args.complete !== undefined) c.value(args.complete, 'args.complete', { type: 'boolean' });
    const complete = args.complete === true;
    const day = dateOk ? Dates.fromKey(args.date) : Dates.today();
    // Sessions saved on that date stay valid even when the plan changed since.
    const saved = Workouts.sessionsOn(Workouts.rows(), day).map((s) => s.session);
    const sessions = Sessions.names(day).concat(saved.filter((s) => !Sessions.names(day).some((n) => ApiValidator.same_(n, s))));
    const session = c.name(args.session, 'args.session', sessions, 'na ficha vigente nem na rotação');
    const known = Exercises.known(day).map((e) => e.name);
    const list = args.exercises;
    const out = [];
    if (list === undefined) c.add('args.exercises', 'required', 'campo obrigatório (lista de exercícios)');
    else if (!Array.isArray(list)) c.add('args.exercises', 'wrong_type', `esperado lista, recebido ${ApiChecker_.show(list)}`);
    else {
      c.count(list, 'args.exercises', complete ? 0 : 1, ApiValidator.MAX_EXERCISES);
      const seen = [];
      list.forEach((ex, i) => {
        const path = `args.exercises[${i}]`;
        if (!c.object(ex, path)) return;
        c.onlyKeys(ex, path, ['name', 'warmup', 'feeder', 'work', 'pain', 'note', 'equipment']);
        const name = c.name(ex.name, `${path}.name`, known, 'no cadastro de Exercícios nem na ficha vigente');
        if (name) {
          if (seen.some((s) => ApiValidator.same_(s, name))) c.add(`${path}.name`, 'duplicate', 'exercício repetido na mesma requisição; junte as séries num só item');
          seen.push(name);
        }
        ['warmup', 'feeder'].forEach((k) => { if (ex[k] !== undefined) ApiValidator.set_(c, ex[k], `${path}.${k}`, false); });
        if (ex.work === undefined) c.add(`${path}.work`, 'required', 'campo obrigatório: 1 ou 2 work sets [{kg, reps, rir?}]; aquecimento e feeder vão em warmup/feeder');
        else if (!Array.isArray(ex.work)) c.add(`${path}.work`, 'wrong_type', `esperado lista de work sets, recebido ${ApiChecker_.show(ex.work)}`);
        else if (c.count(ex.work, `${path}.work`, 1, ApiValidator.MAX_WORK_SETS)) {
          ex.work.forEach((s, j) => ApiValidator.set_(c, s, `${path}.work[${j}]`, true));
        }
        if (ex.pain !== undefined) c.value(ex.pain, `${path}.pain`, { type: 'integer', min: 0, max: 10 });
        if (ex.note !== undefined) c.value(ex.note, `${path}.note`, { type: 'text', maxLength: 200 });
        if (ex.equipment !== undefined) c.value(ex.equipment, `${path}.equipment`, { type: 'text', maxLength: 100 });
        out.push(Object.assign({}, ex, { name }));
      });
    }
    return c.result({ date: args.date, session, complete, exercises: out });
  },

  /** {kg, reps} (warm-up/feeder) or {kg, reps, rir?} (work set). */
  set_(c, set, path, work) {
    if (!c.object(set, path)) return;
    c.onlyKeys(set, path, work ? ['kg', 'reps', 'rir'] : ['kg', 'reps']);
    if (c.required(set, path, 'kg')) c.value(set.kg, `${path}.kg`, { type: 'number', min: 0, max: 1000 });
    if (c.required(set, path, 'reps')) c.value(set.reps, `${path}.reps`, { type: 'integer', min: 1, max: 100 });
    if (work && set.rir !== undefined && set.rir !== null) c.value(set.rir, `${path}.rir`, { type: 'number', min: 0, max: 10 });
  },

  /* food.add ------------------------------------------------------------------------------- */

  foodAdd(args) {
    const c = new ApiChecker_();
    if (!c.object(args, 'args')) return c.result(null);
    c.onlyKeys(args, 'args', ['date', 'meal', 'items']);
    c.date(args.date, 'args.date');
    if (args.meal === undefined) c.add('args.meal', 'required', `campo obrigatório; ex.: ${FoodLog.MEALS.join(', ')}`);
    else c.value(args.meal, 'args.meal', { type: 'text', maxLength: 60 });
    const items = args.items;
    const out = [];
    if (items === undefined) c.add('args.items', 'required', 'campo obrigatório (lista de itens)');
    else if (!Array.isArray(items)) c.add('args.items', 'wrong_type', `esperado lista, recebido ${ApiChecker_.show(items)}`);
    else if (c.count(items, 'args.items', 1, ApiValidator.MAX_FOOD_ITEMS)) {
      const foods = Foods.all();
      const foodNames = foods.map((f) => String(f.name).trim());
      const favNames = Favorites.names();
      items.forEach((it, i) => out.push(ApiValidator.foodItem_(c, it, `args.items[${i}]`, foods, foodNames, favNames)));
    }
    return c.result({ date: args.date, meal: typeof args.meal === 'string' ? args.meal.trim() : args.meal, items: out });
  },

  foodItem_(c, it, path, foods, foodNames, favNames) {
    if (!c.object(it, path)) return null;
    const forms = ['food', 'favorite', 'description'].filter((k) => it[k] !== undefined);
    if (forms.length !== 1) {
      c.add(path, forms.length ? 'conflict' : 'required', 'cada item tem exatamente um de: food (alimento do catálogo + qty/unit), favorite (+ portions) ou description (sem cálculo)');
      return null;
    }
    const kind = forms[0];
    if (kind === 'food') {
      c.onlyKeys(it, path, ['food', 'qty', 'unit', 'measure', 'note']);
      const name = c.name(it.food, `${path}.food`, foodNames, 'no catálogo Alimentos (use description para sem cálculo)');
      let qtyOk = false;
      if (c.required(it, path, 'qty')) qtyOk = c.value(it.qty, `${path}.qty`, { type: 'number', min: 0.001, max: 100000 });
      const unitOk = it.unit === undefined || c.value(it.unit, `${path}.unit`, { type: 'text', maxLength: 20 });
      if (it.measure !== undefined) c.oneOf(it.measure, `${path}.measure`, FoodLog.MEASUREMENTS, 'em Medição', { exact: true });
      if (it.note !== undefined) c.value(it.note, `${path}.note`, { type: 'text', maxLength: 200 });
      if (name) {
        const food = foods.find((f) => ApiValidator.same_(f.name, name));
        const problems = Foods.problems(food);
        if (problems.length) {
          c.add(`${path}.food`, 'incomplete_food', `"${name}" tem cadastro incompleto em Alimentos (${problems.join('; ')}); lance como description (sem cálculo)`);
        } else if (qtyOk && unitOk) {
          const conv = Units.tryConvert(it.qty, it.unit, food);
          if (!conv.ok) {
            const units = [Units.normalize(food.baseUnit)].concat(food.householdUnit ? [Units.normalize(food.householdUnit)] : []);
            c.add(`${path}.unit`, 'invalid_unit', conv.error, units);
          }
        }
      }
      return Object.assign({}, it, { kind, food: name });
    }
    if (kind === 'favorite') {
      c.onlyKeys(it, path, ['favorite', 'portions']);
      const name = c.name(it.favorite, `${path}.favorite`, favNames, 'em Favoritas');
      if (it.portions !== undefined) c.value(it.portions, `${path}.portions`, { type: 'number', min: 0.01, max: 50 });
      return Object.assign({}, it, { kind, favorite: name });
    }
    c.onlyKeys(it, path, ['description', 'qty', 'unit', 'note']);
    c.value(it.description, `${path}.description`, { type: 'text', maxLength: 200 });
    if (it.qty !== undefined) c.value(it.qty, `${path}.qty`, { type: 'number', min: 0.001, max: 100000 });
    if (it.unit !== undefined) c.value(it.unit, `${path}.unit`, { type: 'text', maxLength: 20 });
    if (it.note !== undefined) c.value(it.note, `${path}.note`, { type: 'text', maxLength: 200 });
    return Object.assign({}, it, { kind });
  },

  /* reads ---------------------------------------------------------------------------------- */

  /** {date}; future dates refused unless allowFuture. */
  date(args, allowFuture) {
    const c = new ApiChecker_();
    if (!c.object(args, 'args')) return c.result(null);
    c.onlyKeys(args, 'args', ['date']);
    c.date(args.date, 'args.date', allowFuture);
    return c.result({ date: args.date });
  },

  /** diary.range and workout.range: {from, to}, inclusive, at most MAX_RANGE_DAYS days. */
  dateRange(args) {
    const c = new ApiChecker_();
    if (!c.object(args, 'args')) return c.result(null);
    c.onlyKeys(args, 'args', ['from', 'to']);
    // Future days are allowed: reading them is harmless and a week can end after today.
    const from = c.date(args.from, 'args.from', true);
    const to = c.date(args.to, 'args.to', true);
    if (from && to) {
      const days = Dates.diffDays(args.from, args.to) + 1;
      if (days < 1) c.add('args.to', 'invalid_range', `"to" (${args.to}) é antes de "from" (${args.from})`);
      else if (days > ApiValidator.MAX_RANGE_DAYS) {
        c.add('args.to', 'out_of_range', `período de no máximo ${ApiValidator.MAX_RANGE_DAYS} dias, recebido ${days}; divida em consultas menores`);
      }
    }
    return c.result({ from: args.from, to: args.to });
  },

  exerciseHistory(args) {
    const c = new ApiChecker_();
    if (!c.object(args, 'args')) return c.result(null);
    c.onlyKeys(args, 'args', ['name', 'limit']);
    const names = Exercises.known(Dates.today()).map((e) => e.name);
    Workouts.rows().forEach((r) => {
      const n = String(r.exercise).trim();
      if (!names.some((x) => ApiValidator.same_(x, n))) names.push(n);
    });
    const name = c.name(args.name, 'args.name', names, 'no cadastro de Exercícios nem no Registro de treino');
    if (args.limit !== undefined) c.value(args.limit, 'args.limit', { type: 'integer', min: 1, max: 50 });
    return c.result({ name, limit: args.limit === undefined ? 10 : args.limit });
  },

  writeUndo(args) {
    const c = new ApiChecker_();
    if (!c.object(args, 'args')) return c.result(null);
    c.onlyKeys(args, 'args', ['writeId']);
    if (args.writeId !== undefined) c.value(args.writeId, 'args.writeId', { type: 'text', maxLength: 40 });
    return c.result({ writeId: args.writeId });
  },

  empty(args) {
    const c = new ApiChecker_();
    if (!c.object(args, 'args')) return c.result(null);
    c.onlyKeys(args, 'args', []);
    return c.result({});
  },

  /* helpers -------------------------------------------------------------------------------- */

  same_(a, b) {
    return Exercises.normalize(a) === Exercises.normalize(b);
  },

  /** Up to 3 names closest to what was typed (Exercises.suggest, then a shared word). */
  suggest(typed, names) {
    const out = Exercises.suggest(typed, names, 3);
    if (out.length) return out;
    const words = Exercises.normalize(typed).split(' ').filter((w) => w.length >= 3);
    return names.filter((n) => words.some((w) => Exercises.normalize(n).split(' ').indexOf(w) >= 0)).slice(0, 3);
  },
};

/** Error accumulator with the primitive checks; each check returns true (or the value) when it passed. */
class ApiChecker_ {
  constructor() { this.errors = []; }

  static show(v) {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s;
  }

  add(path, code, message, suggestions) {
    const error = { path, code, message };
    if (suggestions && suggestions.length) error.suggestions = suggestions;
    this.errors.push(error);
    return false;
  }

  result(value) {
    return { value: this.errors.length ? null : value, errors: this.errors };
  }

  object(v, path) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return true;
    return this.add(path, 'wrong_type', `esperado objeto, recebido ${ApiChecker_.show(v)}`);
  }

  onlyKeys(obj, path, allowed) {
    Object.keys(obj).filter((k) => !allowed.includes(k))
      .forEach((k) => this.add(`${path}.${k}`, 'unknown_field', allowed.length ? `campo desconhecido; aceitos: ${allowed.join(', ')}` : 'esta operação não recebe argumentos'));
  }

  required(obj, path, key) {
    if (obj[key] !== undefined && obj[key] !== null) return true;
    return this.add(`${path}.${key}`, 'required', 'campo obrigatório');
  }

  count(list, path, min, max) {
    if (list.length >= min && list.length <= max) return true;
    return this.add(path, 'out_of_range', `deve ter entre ${min} e ${max} itens, recebido ${list.length}`);
  }

  /** spec = {type: number|integer|boolean|text, min?, max?, maxLength?} */
  value(v, path, spec) {
    if (spec.type === 'boolean') {
      return typeof v === 'boolean' || this.add(path, 'wrong_type', `esperado booleano true/false, recebido ${ApiChecker_.show(v)}`);
    }
    if (spec.type === 'text') {
      if (typeof v !== 'string') return this.add(path, 'wrong_type', `esperado texto, recebido ${ApiChecker_.show(v)}`);
      if (!v.trim()) return this.add(path, 'empty', 'texto vazio; omita o campo (ou mande null para apagar um campo do dia)');
      if (v.length > spec.maxLength) return this.add(path, 'too_long', `máximo ${spec.maxLength} caracteres, recebido ${v.length}`);
      return true;
    }
    const integer = spec.type === 'integer';
    if (typeof v !== 'number' || !Number.isFinite(v) || (integer && !Number.isInteger(v))) {
      return this.add(path, 'wrong_type', `esperado ${integer ? 'número inteiro' : 'número'} (JSON, ponto decimal), recebido ${ApiChecker_.show(v)}`);
    }
    if ((spec.min !== undefined && v < spec.min) || (spec.max !== undefined && v > spec.max)) {
      return this.add(path, 'out_of_range', `deve estar entre ${spec.min} e ${spec.max}, recebido ${v}`);
    }
    return true;
  }

  /** yyyy-MM-dd on the calendar, not before 2000; not after today unless allowFuture. */
  date(v, path, allowFuture) {
    const today = Dates.todayKey();
    if (v === undefined) return this.add(path, 'required', `campo obrigatório (yyyy-MM-dd), ex.: ${today}`);
    const ok = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Dates.key(v) === v;
    if (!ok) return this.add(path, 'invalid_date', `data inválida ${ApiChecker_.show(v)}; use yyyy-MM-dd (a partir de ${Dates.MIN_KEY}), ex.: ${today}`);
    if (!allowFuture && v > today) return this.add(path, 'date_in_future', `data ${v} é depois de hoje (${today})`);
    return true;
  }

  /** A value from a fixed list (exact) or a name matched ignoring case/accents (canonical returned). */
  oneOf(v, path, options, source, opts) {
    if (v === undefined) return this.add(path, 'required', `campo obrigatório; aceitos: ${options.join(', ')}`);
    if (typeof v !== 'string') return this.add(path, 'wrong_type', `esperado texto, recebido ${ApiChecker_.show(v)}`);
    if (options.includes(v)) return v;
    if (!(opts && opts.exact)) {
      const hit = options.find((o) => ApiValidator.same_(o, v));
      if (hit) return hit;
    }
    const hint = options.length <= 12 ? `aceitos: ${options.join(', ')}` : 'use um nome exato do catálogo (get_catalog)';
    return this.add(path, 'not_in_catalog', `"${v}" não existe ${source}; ${hint}`, ApiValidator.suggest(v, options));
  }

  /** Canonical name from `options` or null (error added). */
  name(v, path, options, source) {
    const r = this.oneOf(v, path, options, source);
    return typeof r === 'string' ? r : null;
  }
}
