/**
 * Strict validation of API arguments. Nothing is coerced: "82,4" is not a number and "sim" is not
 * a boolean. Every error is collected in one pass so the caller (usually an LLM agent) can fix
 * them all before retrying.
 *
 * Each validator returns {value, errors}; value is null whenever errors is non-empty.
 * Error = {path, code, message, suggestions?}. Messages are Portuguese and aimed at the model.
 *
 * ctx = {today: 'yyyy-MM-dd', sessions: string[], exercises: string[]}
 */
const Validator = {
  diaryUpsert(args, ctx) {
    const c = new Checker_();
    if (!c.object(args, 'args')) return c.result(null);
    c.onlyKeys(args, 'args', ['date', 'fields']);
    c.date(args.date, 'args.date', ctx.today);
    const fields = args.fields;
    if (fields === undefined) c.add('args.fields', 'required', 'campo obrigatório');
    else if (c.object(fields, 'args.fields')) {
      const names = Object.keys(fields);
      if (!names.length) c.add('args.fields', 'empty', `informe ao menos um campo: ${Object.keys(Schema.DIARY_FIELDS).join(', ')}`);
      names.forEach((name) => {
        const spec = Schema.DIARY_FIELDS[name];
        const path = `args.fields.${name}`;
        if (!spec) c.add(path, 'unknown_field', `campo desconhecido; aceitos: ${Object.keys(Schema.DIARY_FIELDS).join(', ')}`);
        else c.value(fields[name], path, spec);
      });
    }
    return c.result({ date: args.date, fields });
  },

  workoutUpsert(args, ctx) {
    const c = new Checker_();
    if (!c.object(args, 'args')) return c.result(null);
    c.onlyKeys(args, 'args', ['date', 'session', 'phase', 'exercises']);
    c.date(args.date, 'args.date', ctx.today);
    c.oneOf(args.session, 'args.session', ctx.sessions, 'Ficha de treino');
    if (args.phase !== undefined) c.oneOf(args.phase, 'args.phase', Schema.PHASES, 'fases');
    const list = args.exercises;
    if (list === undefined) c.add('args.exercises', 'required', 'campo obrigatório');
    else if (!Array.isArray(list)) c.add('args.exercises', 'wrong_type', `esperado lista, recebido ${Checker_.show(list)}`);
    else {
      c.count(list, 'args.exercises', 1, Schema.MAX_EXERCISES);
      const seen = [];
      list.forEach((ex, i) => {
        const path = `args.exercises[${i}]`;
        if (!c.object(ex, path)) return;
        c.onlyKeys(ex, path, ['name', 'sets', 'rir', 'pain', 'note', 'equipment']);
        if (c.oneOf(ex.name, `${path}.name`, ctx.exercises, 'Exercícios')) {
          if (seen.includes(ex.name)) c.add(`${path}.name`, 'duplicate', 'exercício repetido na mesma requisição; junte as séries num só item');
          seen.push(ex.name);
        }
        Validator.sets_(c, ex.sets, `${path}.sets`);
        if (ex.rir !== undefined) c.value(ex.rir, `${path}.rir`, { type: 'integer', min: 0, max: 10 });
        if (ex.pain !== undefined) c.value(ex.pain, `${path}.pain`, { type: 'integer', min: 0, max: 10 });
        if (ex.note !== undefined) c.value(ex.note, `${path}.note`, { type: 'text', maxLength: 200 });
        if (ex.equipment !== undefined) c.value(ex.equipment, `${path}.equipment`, { type: 'text', maxLength: 200 });
      });
    }
    return c.result(args);
  },

  exerciseHistory(args, ctx) {
    const c = new Checker_();
    if (!c.object(args, 'args')) return c.result(null);
    c.onlyKeys(args, 'args', ['name', 'limit']);
    c.oneOf(args.name, 'args.name', ctx.exercises, 'Exercícios');
    if (args.limit !== undefined) c.value(args.limit, 'args.limit', { type: 'integer', min: 1, max: 50 });
    return c.result({ name: args.name, limit: args.limit === undefined ? 10 : args.limit });
  },

  /** diary.range and workout.range: {from, to}, inclusive, at most MAX_RANGE_DAYS days. */
  dateRange(args, ctx) {
    const c = new Checker_();
    if (!c.object(args, 'args')) return c.result(null);
    c.onlyKeys(args, 'args', ['from', 'to']);
    // Future days are allowed: reading them is harmless and a week can end after today.
    const from = c.date(args.from, 'args.from', ctx.today, true);
    const to = c.date(args.to, 'args.to', ctx.today, true);
    if (from && to) {
      const days = (Date.parse(args.to) - Date.parse(args.from)) / 86400000 + 1;
      if (days < 1) c.add('args.to', 'invalid_range', `"to" (${args.to}) é antes de "from" (${args.from})`);
      else if (days > Schema.MAX_RANGE_DAYS) {
        c.add('args.to', 'out_of_range', `período de no máximo ${Schema.MAX_RANGE_DAYS} dias, recebido ${days}; divida em consultas menores`);
      }
    }
    return c.result({ from: args.from, to: args.to });
  },

  writeUndo(args) {
    const c = new Checker_();
    if (!c.object(args, 'args')) return c.result(null);
    c.onlyKeys(args, 'args', ['writeId']);
    if (args.writeId !== undefined) c.value(args.writeId, 'args.writeId', { type: 'text', maxLength: 20 });
    return c.result({ writeId: args.writeId });
  },

  dayGet(args, ctx) {
    const c = new Checker_();
    if (!c.object(args, 'args')) return c.result(null);
    c.onlyKeys(args, 'args', ['date']);
    c.date(args.date, 'args.date', ctx.today);
    return c.result({ date: args.date });
  },

  sets_(c, sets, path) {
    if (sets === undefined) { c.add(path, 'required', 'campo obrigatório'); return; }
    if (!Array.isArray(sets)) { c.add(path, 'wrong_type', `esperado lista, recebido ${Checker_.show(sets)}`); return; }
    c.count(sets, path, 1, Schema.MAX_SETS);
    sets.forEach((set, j) => {
      const p = `${path}[${j}]`;
      if (!c.object(set, p)) return;
      c.onlyKeys(set, p, ['kg', 'reps']);
      c.required(set, p, 'kg') && c.value(set.kg, `${p}.kg`, { type: 'number', min: 0, max: 1000 });
      c.required(set, p, 'reps') && c.value(set.reps, `${p}.reps`, { type: 'integer', min: 1, max: 100 });
    });
  },

  /**
   * Up to 3 catalogue names close to what was typed: equal ignoring case/accents, then one
   * containing the other, then sharing a word of 3+ letters.
   */
  suggest(typed, names) {
    const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
    const wanted = norm(typed);
    if (!wanted) return [];
    const words = wanted.split(' ').filter((w) => w.length >= 3);
    const scored = names.map((name, i) => {
      const key = norm(name);
      let score = 0;
      if (key === wanted) score = 3;
      else if (key.includes(wanted) || wanted.includes(key)) score = 2;
      else if (words.some((w) => key.split(' ').includes(w))) score = 1;
      return { name, score, i };
    }).filter((s) => s.score > 0);
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored.slice(0, 3).map((s) => s.name);
  },
};

/** Error accumulator with the primitive checks; each check returns true when it passed. */
class Checker_ {
  constructor() { this.errors = []; }

  static show(v) {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s;
  }

  add(path, code, message, suggestions) {
    const error = { path, code, message };
    if (suggestions) error.suggestions = suggestions;
    this.errors.push(error);
    return false;
  }

  result(value) {
    return { value: this.errors.length ? null : value, errors: this.errors };
  }

  object(v, path) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return true;
    return this.add(path, 'wrong_type', `esperado objeto, recebido ${Checker_.show(v)}`);
  }

  onlyKeys(obj, path, allowed) {
    Object.keys(obj).filter((k) => !allowed.includes(k))
      .forEach((k) => this.add(`${path}.${k}`, 'unknown_field', `campo desconhecido; aceitos: ${allowed.join(', ')}`));
  }

  required(obj, path, key) {
    if (obj[key] !== undefined) return true;
    return this.add(`${path}.${key}`, 'required', 'campo obrigatório');
  }

  count(list, path, min, max) {
    if (list.length >= min && list.length <= max) return true;
    return this.add(path, 'out_of_range', `deve ter entre ${min} e ${max} itens, recebido ${list.length}`);
  }

  /** spec = {type: number|integer|boolean|text, min?, max?, maxLength?} */
  value(v, path, spec) {
    if (spec.type === 'boolean') {
      return typeof v === 'boolean' || this.add(path, 'wrong_type', `esperado booleano true/false, recebido ${Checker_.show(v)}`);
    }
    if (spec.type === 'text') {
      if (typeof v !== 'string') return this.add(path, 'wrong_type', `esperado texto, recebido ${Checker_.show(v)}`);
      if (!v.trim()) return this.add(path, 'empty', 'texto vazio; omita o campo em vez de mandar vazio');
      if (v.length > spec.maxLength) return this.add(path, 'too_long', `máximo ${spec.maxLength} caracteres, recebido ${v.length}`);
      return true;
    }
    const integer = spec.type === 'integer';
    if (typeof v !== 'number' || !Number.isFinite(v) || (integer && !Number.isInteger(v))) {
      return this.add(path, 'wrong_type', `esperado ${integer ? 'número inteiro' : 'número'} (JSON, ponto decimal), recebido ${Checker_.show(v)}`);
    }
    if (v < spec.min || v > spec.max) return this.add(path, 'out_of_range', `deve estar entre ${spec.min} e ${spec.max}, recebido ${v}`);
    return true;
  }

  /** yyyy-MM-dd on the calendar; not after today unless allowFuture. */
  date(v, path, today, allowFuture) {
    if (v === undefined) return this.add(path, 'required', 'campo obrigatório (yyyy-MM-dd)');
    const m = typeof v === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    const d = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (!d || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
      return this.add(path, 'invalid_date', `data inválida ${Checker_.show(v)}; use yyyy-MM-dd, ex.: ${today}`);
    }
    if (!allowFuture && v > today) return this.add(path, 'date_in_future', `data ${v} é depois de hoje (${today})`);
    return true;
  }

  oneOf(v, path, options, source) {
    if (v === undefined) return this.add(path, 'required', `campo obrigatório; aceitos: ${options.join(', ')}`);
    if (typeof v !== 'string') return this.add(path, 'wrong_type', `esperado texto, recebido ${Checker_.show(v)}`);
    if (options.includes(v)) return true;
    const suggestions = Validator.suggest(v, options);
    const hint = options.length <= 10 ? `aceitos: ${options.join(', ')}` : 'use um nome exato do catálogo (get_catalog)';
    return this.add(path, 'not_in_catalog', `"${v}" não existe em ${source}; ${hint}`, suggestions);
  }
}
