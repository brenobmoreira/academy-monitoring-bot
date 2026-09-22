/**
 * Free text -> Entry. LLM first (structured output); keyword regex as fallback when no LLM is
 * configured or the call fails. Fields not found are left undefined so upserts preserve what is
 * already stored.
 */
const Parser = {
  /**
   * @param {string} text
   * @param {{today?: Date, phase?: string}} [options]
   * @returns {{date: Date, diary?: Object, workout?: Object, source: 'llm'|'regex', warning?: string}}
   */
  parse(text, options) {
    const opts = options || {};
    const today = opts.today || Sheets.today();
    if (Config.llm()) {
      try {
        return Parser.fromLlm_(text, today, opts.phase);
      } catch (err) {
        console.error(`LLM parse failed, falling back to regex: ${err.message}`);
        const entry = Parser.fromRegex_(text, today);
        entry.warning = `LLM unavailable (${err.message}); regex used`;
        return entry;
      }
    }
    return Parser.fromRegex_(text, today);
  },

  // ---- LLM path ---------------------------------------------------------------------------

  SCHEMA: {
    type: 'object',
    additionalProperties: false,
    properties: {
      date: { type: ['string', 'null'], description: 'yyyy-MM-dd the message refers to, null when today' },
      diary: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          weightKg: { type: ['number', 'null'] },
          sleepH: { type: ['number', 'null'], description: 'hours, decimal (7h30 -> 7.5)' },
          steps: { type: ['integer', 'null'] },
          cardioMin: { type: ['number', 'null'] },
          muayThai: { type: ['boolean', 'null'] },
          dietComplete: { type: ['boolean', 'null'] },
          waistCm: { type: ['number', 'null'] },
          hunger: { type: ['integer', 'null'], description: '1-5' },
          fatigue: { type: ['integer', 'null'], description: '1-5' },
          notes: { type: ['string', 'null'] },
        },
        required: ['weightKg', 'sleepH', 'steps', 'cardioMin', 'muayThai', 'dietComplete', 'waistCm', 'hunger', 'fatigue', 'notes'],
      },
      workout: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: {
          session: { type: 'string' },
          exercises: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                sets: {
                  type: 'array',
                  items: {
                    type: 'object', additionalProperties: false,
                    properties: { kg: { type: 'number' }, reps: { type: 'integer' } },
                    required: ['kg', 'reps'],
                  },
                },
                rir: { type: ['integer', 'null'] },
                pain: { type: ['integer', 'null'] },
                note: { type: ['string', 'null'] },
              },
              required: ['name', 'sets', 'rir', 'pain', 'note'],
            },
          },
        },
        required: ['session', 'exercises'],
      },
    },
    required: ['date', 'diary', 'workout'],
  },

  systemPrompt_(today, sessions, exercises) {
    return [
      'You extract a fitness log entry from a short chat message written in Portuguese (Brazil).',
      `Today is ${Sheets.dayKey(today)}. Resolve relative dates ("ontem") to yyyy-MM-dd; use null for today.`,
      'Return only the JSON object. Use null for anything the message does not state. Never guess values.',
      'diary: daily scalars. Sleep in decimal hours (7h30 = 7.5). "8k passos" = 8000.',
      'workout: only when the message lists exercises with sets. "60x8 62x8" means two sets: 60 kg x 8 reps, 62 kg x 8 reps.',
      '"3x8 60kg" means three sets of 8 reps at 60 kg. rir = reps in reserve if stated; pain 0-10 if stated.',
      `Known sessions: ${sessions.join(', ')}. Pick the closest; if the message names none, infer from the exercises' groups or use the first.`,
      `Known exercises (use these exact names when the message clearly refers to one): ${exercises.join('; ')}.`,
    ].join('\n');
  },

  fromLlm_(text, today, phase) {
    const catalogue = WorkoutPlan.catalogue();
    const sessions = Parser.sessions_();
    const raw = LlmClient.extract({
      system: Parser.systemPrompt_(today, sessions, catalogue.map((e) => `${e.name} (${e.group})`)),
      user: text,
      schemaName: 'fitness_entry',
      schema: Parser.SCHEMA,
    });
    const entry = { date: raw.date ? Sheets.localDate(raw.date) : today, source: 'llm' };
    if (raw.diary) {
      const diary = Schema.normalizeDiary(Parser.dropNulls_(raw.diary));
      if (Object.keys(diary).length) entry.diary = diary;
    }
    if (raw.workout && raw.workout.exercises && raw.workout.exercises.length) {
      entry.workout = {
        session: raw.workout.session,
        phase,
        exercises: raw.workout.exercises.map((ex) => Parser.dropNulls_({
          name: ex.name,
          sets: (ex.sets || []).filter((s) => Number(s.reps) > 0),
          rir: ex.rir, pain: ex.pain, note: ex.note,
        })).filter((ex) => ex.sets.length > 0),
      };
      if (!entry.workout.exercises.length) delete entry.workout;
    }
    return entry;
  },

  sessions_() {
    const seen = [];
    Sheets.readRows(WorkoutPlan.sheet_(Config.SHEETS.PLAN), Config.headerRow()).forEach((r) => {
      const s = String(r['Sessão'] || '').trim();
      if (s && !seen.includes(s)) seen.push(s);
    });
    return seen.length ? seen : ['Upper', 'Lower', 'Full Body'];
  },

  dropNulls_(obj) {
    const out = {};
    Object.keys(obj).forEach((k) => { if (obj[k] !== null && obj[k] !== undefined) out[k] = obj[k]; });
    return out;
  },

  // ---- Regex path (diary only) ------------------------------------------------------------

  NUM: '(\\d+(?:[.,]\\d+)?)',
  YESNO: '(sim|s|n[aã]o|n|✓|✔|x)',

  fromRegex_(text, today) {
    const t = ` ${text} `;
    const diary = {};
    const num = (re) => { const m = re.exec(t); return m ? m[1] : undefined; };
    const yesno = (re) => { const m = re.exec(t); return m ? Schema.toBoolean_(m[1] === '✓' || m[1] === '✔' ? 'sim' : m[1]) : undefined; };

    diary.weightKg = num(new RegExp(`\\bpeso\\s*[:=]?\\s*${Parser.NUM}`, 'i'));
    diary.sleepH = Parser.sleep_(t);
    diary.steps = num(new RegExp(`\\bpassos?\\s*[:=]?\\s*${Parser.NUM}\\s*k?`, 'i'));
    const stepsK = /\bpassos?\s*[:=]?\s*(\d+(?:[.,]\d+)?)\s*k\b/i.exec(t);
    if (stepsK) diary.steps = String(Number(stepsK[1].replace(',', '.')) * 1000);
    diary.cardioMin = num(new RegExp(`\\bcardio\\s*[:=]?\\s*${Parser.NUM}`, 'i'));
    diary.muayThai = yesno(new RegExp(`\\bmuay(?:\\s*thai)?\\s*[:=]?\\s*${Parser.YESNO}\\b`, 'i'));
    diary.dietComplete = yesno(new RegExp(`\\bdieta\\s*[:=]?\\s*${Parser.YESNO}\\b`, 'i'));
    diary.waistCm = num(new RegExp(`\\bcintura\\s*[:=]?\\s*${Parser.NUM}`, 'i'));
    diary.hunger = num(new RegExp(`\\bfome\\s*[:=]?\\s*${Parser.NUM}`, 'i'));
    diary.fatigue = num(new RegExp(`\\bcansa[cç]o\\s*[:=]?\\s*${Parser.NUM}`, 'i'));
    const obs = /\bobs\.?\s*[:=]?\s*(.+?)\s*$/i.exec(t);
    if (obs) diary.notes = obs[1];

    const normalized = Schema.normalizeDiary(diary);
    const entry = { date: today, source: 'regex' };
    if (Object.keys(normalized).length) entry.diary = normalized;
    return entry;
  },

  /** "sono 7h30", "sono 7:30", "sono 7,5", "dormi 6h" -> decimal hours */
  sleep_(t) {
    const m = /\b(?:sono|dormi)\s*[:=]?\s*(\d+)(?:\s*[h:]\s*(\d{1,2}))?(?:[.,](\d+))?/i.exec(t);
    if (!m) return undefined;
    if (m[2]) return String(Number(m[1]) + Number(m[2]) / 60);
    if (m[3]) return `${m[1]}.${m[3]}`;
    return m[1];
  },
};
