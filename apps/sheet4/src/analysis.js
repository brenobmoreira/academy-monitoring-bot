/**
 * Weekly analysis (spec §7): signals computed once per week, and one rule set per `Tipo de
 * análise` that only combines them into a status.
 *
 *   Analysis.signals(week, history)  -> ['peso_estavel', 'cintura_caindo', …]
 *   Analysis.evaluate(week, history) -> {status, signals, reasons, expectationMet, analysisType,
 *                                        ruleLabel, range}
 *   Rules.register(type, {label, defaults: {weightPctMin, weightPctMax}, needs?, evaluate,
 *                         expectation?})
 *
 * `week` is an aggregate from Weeks.compute (it carries `phase`: the objective of its Sunday,
 * and `targets`: that Sunday's goal); `history` the previous weeks, oldest first, analysed the
 * same way. The objective's own `Variação de peso alvo %/sem mín/máx` overrides the rule's
 * defaults. An unknown type falls back to `personalizado` with a note.
 *
 * Status: No caminho | Atenção | Fora do esperado | Dados insuficientes. A rule returns issues
 * ({level: 'warn'|'off', text}) and whether the positive pattern was seen; the status is
 *   any 'off' or 2+ 'warn'   -> Fora do esperado
 *   1 'warn'                 -> Atenção
 *   none, positive pattern   -> No caminho (none, no positive pattern -> Atenção)
 * and a No caminho week with sono_baixo / fadiga_alta / dor_alta becomes Atenção. A rule that
 * needs weight (every type but adaptacao and performance; personalizado only with a range) gives
 * Dados insuficientes when the week has fewer than analysis.minWeighInsPerWeek weigh-ins or no
 * previous week to compare; performance needs training data. A week with no objective in force
 * is Dados insuficientes (no rule applies).
 *
 * Signals (thresholds from Config, defaults in parentheses):
 *   weight %/week vs analysis.weightNoisePctPerWeek (0.25) and analysis.weightFastPctPerWeek (0.5):
 *     peso_estavel |%| ≤ noise; peso_caindo_lento / peso_subindo_lento up to fast;
 *     peso_caindo_rapido / peso_subindo_rapido beyond it;
 *   against the objective's range: peso_na_faixa, peso_abaixo_faixa, peso_acima_faixa;
 *   waist change vs analysis.waistNoiseCm (0.5): cintura_caindo, cintura_estavel, cintura_subindo;
 *   training: desempenho_subindo (more exercises progressed than regressed), desempenho_caindo,
 *     desempenho_mantido, treinos_abaixo (closed week, sessions < goal);
 *   food, only with enough complete days: kcal_fora (average outside kcal ± tolerance),
 *     proteina_baixa (average < mín), gordura_fora, aderencia_baixa (kcal or protein adherence <
 *     analysis.adherenceMin (0.7));
 *   recovery: sono_baixo (< analysis.sleepMinH 7), fadiga_alta (≥ analysis.fatigueHigh 4),
 *     fome_alta (≥ analysis.hungerHigh 4), dor_alta (max ≥ analysis.painHigh 4);
 *   data: pesagens_insuficientes, alimentacao_insuficiente, dados_insuficientes (either),
 *     cobertura_baixa, cobertura_melhorando; transicao_na_semana.
 *
 * Default target ranges (%/week), overridden per objective:
 *   adaptacao −0.5..0.5 · recomposicao −0.5..0.25 · manutencao −0.3..0.3 ·
 *   manutencao_pos_cut −0.2..0.4 · deficit −1.0..−0.5 · ganho_controlado 0.1..0.3 ·
 *   ganho_agressivo 0.3..0.6 · performance −0.25..0.5 · personalizado none.
 */
const Rules = {
  registry_: {},
  FALLBACK: 'personalizado',

  /**
   * @param {string} type Tipo de análise
   * @param {{label: string, defaults?: {weightPctMin: ?number, weightPctMax: ?number},
   *   needs?: string[]|function(ctx): string[], evaluate: function(Object, Object): {issues, positive, reasons?},
   *   expectation?: function(Object, Object): boolean}} def
   */
  register(type, def) {
    if (!type || typeof def.evaluate !== 'function' || !def.label) throw new Error(`Invalid rule: ${type}`);
    Rules.registry_[type] = Object.assign({ type, defaults: { weightPctMin: null, weightPctMax: null }, needs: ['weight'], expectation: null }, def);
    return Rules.registry_[type];
  },

  get(type) {
    return Rules.registry_[type] || null;
  },

  types() {
    return Object.keys(Rules.registry_);
  },

  /** {rule, note}: the rule of `type`, or personalizado with a Portuguese note. */
  resolve(type) {
    const rule = Rules.get(type);
    if (rule) return { rule, note: null };
    const note = type
      ? `Tipo de análise "${type}" desconhecido: usadas as regras de personalizado.`
      : 'Objetivo sem tipo de análise: usadas as regras de personalizado.';
    return { rule: Rules.get(Rules.FALLBACK), note };
  },
};

const Analysis = {
  STATUS: { OK: 'No caminho', WARN: 'Atenção', OFF: 'Fora do esperado', NODATA: 'Dados insuficientes' },
  RECOVERY: ['sono_baixo', 'fadiga_alta', 'dor_alta'],

  /** Thresholds from Config. */
  cfg_() {
    const g = (k) => Config.get(`analysis.${k}`);
    return {
      noise: g('weightNoisePctPerWeek'), fast: g('weightFastPctPerWeek'), waistNoise: g('waistNoiseCm'),
      minWeighIns: g('minWeighInsPerWeek'), minFoodDays: g('minCompleteFoodDays'), adherenceMin: g('adherenceMin'),
      sleepMin: g('sleepMinH'), fatigueHigh: g('fatigueHigh'), hungerHigh: g('hungerHigh'), painHigh: g('painHigh'),
    };
  },

  num_(v) {
    return typeof v === 'number' && isFinite(v);
  },

  /** The phase of a week; resolved from Objetivos by id when the week does not carry it. */
  phase_(week) {
    if (week.phase) return week.phase;
    if (!week.objective || !Tabs.findSheet('objectives')) return null;
    const o = Objectives.get(week.objective);
    if (!o) return null;
    return {
      id: o.id, name: o.fields.name, analysisType: o.fields.analysisType, start: o.start, end: o.end,
      rateMinPct: Analysis.num_(o.fields.weightRateMinPct) ? o.fields.weightRateMinPct : null,
      rateMaxPct: Analysis.num_(o.fields.weightRateMaxPct) ? o.fields.weightRateMaxPct : null,
      weeks: null, weightChangeKg: null, waistChangeCm: null,
    };
  },

  /** Target range {min, max, source}: the objective's columns, else the rule's defaults. */
  range(phase, rule) {
    const p = phase || {};
    const d = rule.defaults || {};
    const own = Analysis.num_(p.rateMinPct) || Analysis.num_(p.rateMaxPct);
    return {
      min: Analysis.num_(p.rateMinPct) ? p.rateMinPct : (own ? null : d.weightPctMin),
      max: Analysis.num_(p.rateMaxPct) ? p.rateMaxPct : (own ? null : d.weightPctMax),
      source: own ? 'objetivo' : 'padrão',
    };
  },

  /** "−0,5 a 0,25 %/sem (padrão)"; '' without a range. */
  rangeText(range) {
    if (!range || (range.min === null && range.max === null) || (range.min === undefined && range.max === undefined)) return '';
    const f = (v) => (v === null || v === undefined ? '…' : Analysis.fmt(v));
    return `${f(range.min)} a ${f(range.max)} %/sem (${range.source})`;
  },

  /** Portuguese number: 0.25 → "0,25", −0.5 → "−0,5". */
  fmt(v, digits) {
    if (!Analysis.num_(v)) return '—';
    const d = digits === undefined ? 2 : digits;
    const s = String(Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).replace('.', ',');
    return s.replace(/^-/, '−');
  },

  /** Signal names of a week (see file header). history: previous weeks, oldest first. */
  signals(week, history) {
    const c = Analysis.cfg_();
    const phase = Analysis.phase_(week);
    const range = Analysis.range(phase, Rules.resolve(phase && phase.analysisType).rule);
    const out = [];
    const add = (s) => { if (out.indexOf(s) < 0) out.push(s); };
    const suff = week.sufficiency || {};
    const prev = history && history.length ? history[history.length - 1] : null;

    const pct = week.weightDeltaPct;
    if (suff.weight && Analysis.num_(pct)) {
      if (Math.abs(pct) <= c.noise) add('peso_estavel');
      else if (pct < 0) add(-pct > c.fast ? 'peso_caindo_rapido' : 'peso_caindo_lento');
      else add(pct > c.fast ? 'peso_subindo_rapido' : 'peso_subindo_lento');
      if (range.min !== null && range.min !== undefined && pct < range.min) add('peso_abaixo_faixa');
      else if (range.max !== null && range.max !== undefined && pct > range.max) add('peso_acima_faixa');
      else if ((range.min !== null && range.min !== undefined) || (range.max !== null && range.max !== undefined)) add('peso_na_faixa');
    } else {
      add('pesagens_insuficientes');
    }

    if (Analysis.num_(week.waistDelta)) {
      if (week.waistDelta <= -c.waistNoise) add('cintura_caindo');
      else if (week.waistDelta >= c.waistNoise) add('cintura_subindo');
      else add('cintura_estavel');
    }

    if (Analysis.performanceKnown_(week)) {
      const up = week.progressions || 0;
      const down = week.regressions || 0;
      add(up > down ? 'desempenho_subindo' : down > up ? 'desempenho_caindo' : 'desempenho_mantido');
    }
    if (week.closed && Analysis.num_(week.sessionsGoal) && Analysis.num_(week.sessions) && week.sessions < week.sessionsGoal) add('treinos_abaixo');

    if (suff.food) {
      const t = week.targets || {};
      if (Analysis.num_(t.kcal) && Analysis.num_(week.kcalAvg) && Math.abs(week.kcalAvg - t.kcal) > t.kcal * t.kcalTolerance + 1e-9) add('kcal_fora');
      if (Analysis.num_(t.proteinMin) && Analysis.num_(week.proteinAvg) && week.proteinAvg < t.proteinMin - 1e-9) add('proteina_baixa');
      if (Analysis.num_(t.fat) && Analysis.num_(week.fatAvg) && Math.abs(week.fatAvg - t.fat) > t.fat * t.fatTolerance + 1e-9) add('gordura_fora');
      const low = (v) => Analysis.num_(v) && v < c.adherenceMin - 1e-9;
      if (low(week.kcalAdherence) || low(week.proteinAdherence)) add('aderencia_baixa');
    } else {
      add('alimentacao_insuficiente');
    }
    if (out.indexOf('pesagens_insuficientes') >= 0 || out.indexOf('alimentacao_insuficiente') >= 0) add('dados_insuficientes');

    if (Analysis.num_(week.sleepAvg) && week.sleepAvg < c.sleepMin) add('sono_baixo');
    if (Analysis.num_(week.fatigueAvg) && week.fatigueAvg >= c.fatigueHigh) add('fadiga_alta');
    if (Analysis.num_(week.hungerAvg) && week.hungerAvg >= c.hungerHigh) add('fome_alta');
    if (Analysis.num_(week.painMax) && week.painMax >= c.painHigh) add('dor_alta');

    if ((week.completeDays || 0) < c.minFoodDays) add('cobertura_baixa');
    if (prev && ((week.completeDays || 0) > (prev.completeDays || 0) || (week.weighIns || 0) > (prev.weighIns || 0))
      && (week.completeDays || 0) >= (prev.completeDays || 0) && (week.weighIns || 0) >= (prev.weighIns || 0)) add('cobertura_melhorando');
    if (week.transition) add('transicao_na_semana');
    return out;
  },

  performanceKnown_(week) {
    return (week.comparedExercises || 0) > 0 && (Analysis.num_(week.progressions) || Analysis.num_(week.regressions));
  },

  /**
   * Status of a week with the rules of its objective.
   * @returns {{status, signals: string[], reasons: string[], expectationMet: boolean,
   *   analysisType: string, ruleLabel: string, range: {min, max, source}}}
   */
  evaluate(week, history) {
    const hist = (history || []).map((h, i, arr) => (h.signals ? h : Object.assign({}, h, { signals: Analysis.signals(h, arr.slice(0, i)) })));
    const signals = Analysis.signals(week, hist);
    const phase = Analysis.phase_(week);
    const { rule, note } = Rules.resolve(phase && phase.analysisType);
    const range = Analysis.range(phase, rule);
    const prev = hist.length ? hist[hist.length - 1] : null;
    const samePrev = prev && phase && prev.objective === phase.id ? prev : null;
    const has = (s) => signals.indexOf(s) >= 0;
    const ctx = {
      signals, has, range, cfg: Analysis.cfg_(), phase, history: hist, prev: samePrev,
      prevHas: (s) => Boolean(samePrev && samePrev.signals && samePrev.signals.indexOf(s) >= 0),
      pct: week.weightDeltaPct,
    };
    const reasons = [];
    if (!phase) reasons.push('Nenhum objetivo vigente nesta semana: sem regra para avaliar.');
    if (note) reasons.push(note);
    if (week.transition) reasons.push(`Transição na semana (${week.transition}): análise pelo objetivo ${phase ? phase.id : '—'}, vigente no domingo.`);

    const needs = typeof rule.needs === 'function' ? rule.needs(ctx) : rule.needs;
    const missing = Analysis.missing_(week, needs, ctx.cfg);
    let status;
    if (!phase) {
      status = Analysis.STATUS.NODATA;
    } else if (missing.length) {
      status = Analysis.STATUS.NODATA;
      missing.forEach((m) => reasons.push(m));
    } else {
      const r = rule.evaluate(week, ctx) || {};
      const issues = r.issues || [];
      const offs = issues.filter((i) => i.level === 'off').length;
      const warns = issues.filter((i) => i.level === 'warn').length;
      if (offs || warns >= 2) status = Analysis.STATUS.OFF;
      else if (warns === 1) status = Analysis.STATUS.WARN;
      else status = r.positive ? Analysis.STATUS.OK : Analysis.STATUS.WARN;
      issues.forEach((i) => reasons.push(`${i.text}.`));
      (r.reasons || []).forEach((t) => reasons.push(`${t}.`));
      if (!issues.length && !r.positive && r.missingPositive) reasons.push(`${r.missingPositive}.`);
    }
    if (status === Analysis.STATUS.OK) {
      const rec = Analysis.recoveryIssues_(ctx);
      if (rec.length) {
        status = Analysis.STATUS.WARN;
        reasons.push(`Recuperação: ${rec.join(', ')}.`);
      }
    }
    const expectationMet = status === Analysis.STATUS.OK && (rule.expectation ? Boolean(rule.expectation(week, ctx)) : true);
    return { status, signals, reasons, expectationMet, analysisType: rule.type, ruleLabel: rule.label, range };
  },

  recoveryIssues_(ctx) {
    const labels = { sono_baixo: 'sono abaixo do mínimo', fadiga_alta: 'cansaço alto', dor_alta: 'dor alta' };
    return Analysis.RECOVERY.filter((s) => ctx.has(s)).map((s) => labels[s]);
  },

  /** Portuguese reasons for the data a rule needs and the week lacks. */
  missing_(week, needs, c) {
    const out = [];
    (needs || []).forEach((n) => {
      if (n === 'weight' && !(week.sufficiency && week.sufficiency.weight)) {
        if ((week.weighIns || 0) < c.minWeighIns) out.push(`Pesagens insuficientes: ${week.weighIns || 0} de ${c.minWeighIns} na semana.`);
        else out.push('Sem média de peso da semana anterior para comparar.');
      }
      if (n === 'training' && !Analysis.performanceKnown_(week)) out.push('Sem treinos comparáveis registrados para avaliar o desempenho.');
    });
    return out;
  },
};

/* Rule sets ----------------------------------------------------------------------------------- */
(function registerRules() {
  const warn = (text) => ({ level: 'warn', text });
  const off = (text) => ({ level: 'off', text });
  const pctText = (ctx) => `${Analysis.fmt(ctx.pct)}%/sem`;
  const rangeText = (ctx) => Analysis.rangeText(ctx.range);
  const falling = (ctx) => ctx.has('peso_caindo_lento') || ctx.has('peso_caindo_rapido');
  const rising = (ctx) => ctx.has('peso_subindo_lento') || ctx.has('peso_subindo_rapido');

  Rules.register('recomposicao', {
    label: 'Recomposição corporal',
    defaults: { weightPctMin: -0.5, weightPctMax: 0.25 },
    evaluate(week, ctx) {
      const issues = [];
      if (ctx.has('peso_acima_faixa')) issues.push(warn(`Peso subindo ${pctText(ctx)}, acima da faixa ${rangeText(ctx)}`));
      if (ctx.has('peso_abaixo_faixa')) issues.push(warn(`Peso caindo ${pctText(ctx)}, mais rápido que a faixa ${rangeText(ctx)}`));
      if (ctx.has('cintura_subindo')) issues.push(warn(`Cintura subindo (${Analysis.fmt(week.waistDelta, 1)} cm)`));
      if (ctx.has('desempenho_caindo')) issues.push(warn('Desempenho caindo'));
      const good = [];
      if (ctx.has('cintura_caindo')) good.push(`cintura caindo (${Analysis.fmt(week.waistDelta, 1)} cm)`);
      if (ctx.has('desempenho_subindo')) good.push('desempenho subindo');
      if (ctx.has('desempenho_mantido') && falling(ctx) && ctx.has('peso_na_faixa')) good.push('perda lenta de peso com desempenho mantido');
      const reasons = good.length && !issues.length ? [`Peso ${ctx.has('peso_estavel') ? 'estável' : pctText(ctx)} na faixa, ${good.join(', ')}`] : [];
      return { issues, positive: good.length > 0, reasons, missingPositive: 'Peso na faixa, mas sem sinal de cintura caindo ou desempenho subindo' };
    },
    /** Waist down since the phase started, beyond the measurement noise. */
    expectation(week, ctx) {
      const p = ctx.phase;
      return Boolean(p && Analysis.num_(p.waistChangeCm) && p.waistChangeCm <= -ctx.cfg.waistNoise);
    },
  });

  Rules.register('deficit', {
    label: 'Déficit (perda de gordura)',
    defaults: { weightPctMin: -1.0, weightPctMax: -0.5 },
    evaluate(week, ctx) {
      const issues = [];
      if (rising(ctx)) issues.push(off(`Peso subindo (${pctText(ctx)}) durante o déficit`));
      else if (ctx.has('peso_acima_faixa')) {
        if (ctx.prevHas('peso_acima_faixa')) issues.push(off(`Perda estagnada há 2+ semanas (${pctText(ctx)}; faixa ${rangeText(ctx)})`));
        else issues.push(warn(`Perda abaixo do esperado (${pctText(ctx)}; faixa ${rangeText(ctx)})`));
      }
      if (ctx.has('peso_abaixo_faixa')) issues.push(warn(`Perda rápida demais (${pctText(ctx)}; faixa ${rangeText(ctx)})`));
      if (ctx.has('desempenho_caindo')) issues.push(warn('Desempenho caindo'));
      if (ctx.has('fome_alta')) issues.push(warn('Fome alta'));
      if (ctx.has('fadiga_alta')) issues.push(warn('Cansaço alto'));
      const positive = ctx.has('peso_na_faixa');
      return { issues, positive, reasons: positive && !issues.length ? [`Perda de ${pctText(ctx)} dentro da faixa ${rangeText(ctx)}`] : [] };
    },
    expectation(week, ctx) {
      return Boolean(ctx.phase && Analysis.num_(ctx.phase.weightChangeKg) && ctx.phase.weightChangeKg < 0);
    },
  });

  const gain = {
    evaluate(week, ctx) {
      const issues = [];
      if (ctx.has('peso_acima_faixa')) {
        if (ctx.has('cintura_subindo')) issues.push(off(`Ganho rápido demais (${pctText(ctx)}) com cintura subindo (${Analysis.fmt(week.waistDelta, 1)} cm)`));
        else issues.push(warn(`Ganho mais rápido que a faixa (${pctText(ctx)}; faixa ${rangeText(ctx)})`));
      }
      if (ctx.has('peso_abaixo_faixa')) {
        if (ctx.prevHas('peso_abaixo_faixa')) issues.push(off(`Ganho estagnado há 2+ semanas (${pctText(ctx)}; faixa ${rangeText(ctx)})`));
        else issues.push(warn(`Ganho abaixo da faixa (${pctText(ctx)}; faixa ${rangeText(ctx)})`));
      }
      if (ctx.has('desempenho_caindo')) issues.push(warn('Desempenho caindo'));
      const positive = ctx.has('peso_na_faixa') && ctx.has('desempenho_subindo');
      return {
        issues, positive,
        reasons: positive && !issues.length ? [`Ganho de ${pctText(ctx)} na faixa com desempenho subindo`] : [],
        missingPositive: ctx.has('desempenho_mantido') ? 'Peso na faixa, mas desempenho estável' : 'Peso na faixa, mas sem progressão registrada',
      };
    },
    expectation(week, ctx) {
      return Boolean(ctx.phase && Analysis.num_(ctx.phase.weightChangeKg) && ctx.phase.weightChangeKg > 0);
    },
  };
  Rules.register('ganho_controlado', Object.assign({ label: 'Ganho controlado', defaults: { weightPctMin: 0.1, weightPctMax: 0.3 } }, gain));
  Rules.register('ganho_agressivo', Object.assign({ label: 'Ganho agressivo', defaults: { weightPctMin: 0.3, weightPctMax: 0.6 } }, gain));

  const maintenance = {
    evaluate(week, ctx) {
      const issues = [];
      const out = ctx.has('peso_acima_faixa') || ctx.has('peso_abaixo_faixa');
      if (out) {
        const repeated = ctx.prevHas('peso_acima_faixa') || ctx.prevHas('peso_abaixo_faixa');
        if (repeated) issues.push(off(`Peso fora da faixa há 2+ semanas (${pctText(ctx)}; faixa ${rangeText(ctx)})`));
        else issues.push(warn(`Peso fora da faixa nesta semana (${pctText(ctx)}; faixa ${rangeText(ctx)})`));
      }
      if (ctx.has('cintura_subindo')) issues.push(warn(`Cintura subindo (${Analysis.fmt(week.waistDelta, 1)} cm)`));
      const positive = ctx.has('peso_na_faixa');
      return { issues, positive, reasons: positive && !issues.length ? [`Peso estável na faixa ${rangeText(ctx)}`] : [] };
    },
  };
  Rules.register('manutencao', Object.assign({ label: 'Manutenção', defaults: { weightPctMin: -0.3, weightPctMax: 0.3 } }, maintenance));
  Rules.register('manutencao_pos_cut', Object.assign({ label: 'Manutenção pós-cut', defaults: { weightPctMin: -0.2, weightPctMax: 0.4 } }, maintenance));

  Rules.register('adaptacao', {
    label: 'Adaptação',
    defaults: { weightPctMin: -0.5, weightPctMax: 0.5 },
    needs: [],
    evaluate(week, ctx) {
      const covered = !ctx.has('cobertura_baixa') && !ctx.has('pesagens_insuficientes');
      const improving = ctx.has('cobertura_melhorando');
      const issues = [];
      if (!covered && !improving) issues.push(warn(`Cobertura de dados baixa (${week.foodCoverage || '—'} completos, ${week.weighIns || 0} pesagens)`));
      if (ctx.has('aderencia_baixa') && !improving) issues.push(warn('Aderência à meta baixa'));
      return { issues, positive: covered || improving, reasons: !issues.length ? [covered ? 'Registro completo o suficiente para avaliar' : 'Cobertura de dados melhorando'] : [] };
    },
    expectation(week, ctx) {
      return !ctx.has('cobertura_baixa') && !ctx.has('pesagens_insuficientes');
    },
  });

  Rules.register('performance', {
    label: 'Performance',
    defaults: { weightPctMin: -0.25, weightPctMax: 0.5 },
    needs: ['training'],
    evaluate(week, ctx) {
      const issues = [];
      if (ctx.has('desempenho_caindo')) issues.push(warn('Desempenho caindo'));
      if (ctx.has('treinos_abaixo')) issues.push(warn(`Treinos abaixo da meta (${week.sessions} de ${week.sessionsGoal})`));
      if (ctx.has('peso_acima_faixa') || ctx.has('peso_abaixo_faixa')) issues.push(warn(`Peso fora da faixa (${pctText(ctx)})`));
      if (ctx.has('fadiga_alta') && ctx.has('desempenho_caindo')) issues.push(off('Desempenho caindo com cansaço alto'));
      const positive = ctx.has('desempenho_subindo');
      return { issues, positive, reasons: positive && !issues.length ? ['Desempenho subindo'] : [], missingPositive: 'Desempenho estável' };
    },
    expectation(week, ctx) {
      return ctx.has('desempenho_subindo');
    },
  });

  Rules.register('personalizado', {
    label: 'Personalizado',
    defaults: { weightPctMin: null, weightPctMax: null },
    /** Weight is needed only when the objective sets a range. */
    needs(ctx) {
      return ctx.range.min !== null || ctx.range.max !== null ? ['weight'] : [];
    },
    evaluate(week, ctx) {
      const issues = [];
      const hasRange = ctx.range.min !== null || ctx.range.max !== null;
      if (hasRange && (ctx.has('peso_acima_faixa') || ctx.has('peso_abaixo_faixa'))) {
        const repeated = ctx.prevHas('peso_acima_faixa') || ctx.prevHas('peso_abaixo_faixa');
        issues.push((repeated ? off : warn)(`Peso fora da faixa ${rangeText(ctx)} (${pctText(ctx)})${repeated ? ' há 2+ semanas' : ''}`));
      }
      return { issues, positive: true, reasons: !issues.length ? [hasRange ? `Peso na faixa ${rangeText(ctx)}` : 'Sem faixa de peso definida: avaliados só dados e recuperação'] : [] };
    },
  });
})();
