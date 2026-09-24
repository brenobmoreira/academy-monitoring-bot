/**
 * JSON API over the spreadsheet, the only write path into it. The agent calls it over HTTP
 * (doPost); the sheet menu calls SheetApi.run in-process.
 *
 * Request:  {"key": "<SHEET_API_KEY>", "op": "<operation>", "args": {...}}
 * Response: {"ok": true, "result": {...}} | {"ok": false, "errors": [{path, code, message, suggestions?}]}
 *
 * Apps Script cannot set HTTP status codes, so the outcome is always in the body. Any exception
 * (missing tab or header) becomes an `internal` error so callers never see an HTML error page.
 */
function doPost(e) {
  const text = e && e.postData ? e.postData.contents : '';
  return ContentService.createTextOutput(JSON.stringify(SheetApi.handle(text)))
    .setMimeType(ContentService.MimeType.JSON);
}

const SheetApi = {
  ENVELOPE: ['key', 'op', 'args'],

  OPS: {
    catalog: {
      write: false,
      run: () => ({
        today: Sheets.todayKey(),
        timezone: Session.getScriptTimeZone(),
        phase: HojeScreen.currentPhase() || Schema.DEFAULT_PHASE,
        sessions: WorkoutPlan.sessions(),
        exercises: WorkoutPlan.catalogue(),
        plan: WorkoutPlan.planRows(),
        lastWorkout: WorkoutRepo.last(),
      }),
    },
    'diary.upsert': {
      write: true,
      validate: (args, ctx) => Validator.diaryUpsert(args, ctx),
      run: (args) => {
        const r = DiaryRepo.upsert(Sheets.localDate(args.date), args.fields);
        const fields = {};
        r.written.forEach((f) => { fields[f] = args.fields[f]; });
        return { date: args.date, row: r.row, fields };
      },
    },
    'workout.upsert': {
      write: true,
      validate: (args, ctx) => Validator.workoutUpsert(args, ctx),
      run: (args) => {
        const phase = args.phase || HojeScreen.currentPhase() || Schema.DEFAULT_PHASE;
        const r = WorkoutRepo.saveSession(Sheets.localDate(args.date), { ...args, phase });
        return { date: args.date, session: args.session, phase: r.phase, sessionId: r.sessionId, exercises: r.exercises };
      },
    },
    'exercise.history': {
      write: false,
      validate: (args, ctx) => Validator.exerciseHistory(args, ctx),
      run: (args) => {
        const H = WorkoutRepo.HEADERS;
        const cell = (v) => (v === '' || v === undefined ? null : v);
        const sessions = WorkoutRepo.history(args.name, args.limit).map((r) => ({
          date: Sheets.dayKey(r[H.date]), session: r[H.session], sets: WorkoutRepo.sets(r),
          setsDone: cell(r[H.setsDone]), volume: cell(r[H.volume]), rir: cell(r[H.rir]), pain: cell(r[H.pain]),
        }));
        return { name: args.name, sessions };
      },
    },
    'day.get': {
      write: false,
      validate: (args, ctx) => Validator.dayGet(args, ctx),
      run: (args) => ({ date: args.date, diary: DiaryRepo.read(Sheets.localDate(args.date)), workout: WorkoutRepo.day(args.date) }),
    },
  },

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
    if (request.key !== expected) return SheetApi.fail_('key', 'unauthorized', 'chave inválida');
    const unknown = Object.keys(request).filter((k) => !SheetApi.ENVELOPE.includes(k));
    if (unknown.length) {
      return { ok: false, errors: unknown.map((k) => ({ path: k, code: 'unknown_field', message: `campo desconhecido; aceitos: ${SheetApi.ENVELOPE.join(', ')}` })) };
    }
    return SheetApi.run(request.op, request.args === undefined ? {} : request.args);
  },

  /** In-process entry (sheet menu, tests): validate, lock for writes, run. */
  run(op, args) {
    const spec = Object.prototype.hasOwnProperty.call(SheetApi.OPS, op) ? SheetApi.OPS[op] : null;
    if (!spec) return SheetApi.fail_('op', 'unknown_op', `operação desconhecida ${JSON.stringify(op)}; aceitas: ${Object.keys(SheetApi.OPS).join(', ')}`);
    const lock = spec.write ? LockService.getScriptLock() : null;
    try {
      if (lock) lock.waitLock(20000);
      let valid = args;
      if (spec.validate) {
        const checked = spec.validate(args, SheetApi.context_());
        if (checked.errors.length) return { ok: false, errors: checked.errors };
        valid = checked.value;
      }
      return { ok: true, result: spec.run(valid) };
    } catch (err) {
      console.error(err);
      return SheetApi.fail_('', 'internal', err.message);
    } finally {
      if (lock) lock.releaseLock();
    }
  },

  context_() {
    return {
      today: Sheets.todayKey(),
      sessions: WorkoutPlan.sessions(),
      exercises: WorkoutPlan.catalogue().map((e) => e.name),
    };
  },

  fail_(path, code, message) {
    return { ok: false, errors: [{ path, code, message }] };
  },
};
