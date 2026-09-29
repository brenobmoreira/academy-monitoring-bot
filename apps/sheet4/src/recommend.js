/**
 * Weekly recommendation (spec §8). Suggests; never changes a target.
 *
 *   Recommend.for(week, history) -> {code, reason, data, nextReview}
 *
 * `week` is an analysed week (Analysis.evaluate fields; evaluated here when missing), `history`
 * the previous analysed weeks, oldest first. The first matching code wins:
 *
 *   DADOS INSUFICIENTES   status Dados insuficientes, or too few weigh-ins / complete food days
 *                         (analysis.minWeighInsPerWeek, analysis.minCompleteFoodDays)
 *   REVISAR RECUPERAÇÃO   sono_baixo, fadiga_alta, dor_alta or fome_alta
 *   REVISAR ENERGIA       weight %/week outside the objective's range and the week is Fora do
 *                         esperado (or Atenção two weeks running, same objective), with the diet
 *                         followed (no aderencia_baixa / kcal_fora — otherwise it is a macros issue)
 *   REVISAR MACROS        proteina_baixa, kcal_fora, gordura_fora or aderencia_baixa
 *   REVISAR TREINO        desempenho_caindo or treinos_abaixo
 *   REVISAR OBJETIVO/FASE the phase has lasted analysis.minWeeksForPhaseReview (8) weeks and the
 *                         last analysis.phaseReviewStreak (3) weeks of this objective are No caminho
 *                         with the rule's expectation met; or those weeks are all Fora do esperado
 *                         (only reached when no energy/macros/training cause was found)
 *   MANTER
 *
 * nextReview = the week's Sunday + analysis.reviewEveryDays (7).
 */
const Recommend = {
  CODES: {
    KEEP: 'MANTER', ENERGY: 'REVISAR ENERGIA', MACROS: 'REVISAR MACROS', TRAINING: 'REVISAR TREINO',
    RECOVERY: 'REVISAR RECUPERAÇÃO', PHASE: 'REVISAR OBJETIVO/FASE', NODATA: 'DADOS INSUFICIENTES',
  },

  for(week, history) {
    const hist = history || [];
    const w = week.status ? week : Object.assign({}, week, Analysis.evaluate(week, hist));
    const has = (s) => (w.signals || []).indexOf(s) >= 0;
    const C = Recommend.CODES;
    const f = Analysis.fmt;
    const phaseId = w.phase ? w.phase.id : w.objective;
    const data = {
      objective: phaseId || null, goal: w.goal || null, status: w.status, signals: (w.signals || []).slice(),
      weighIns: w.weighIns, weightAvg: w.weightAvg, weightDeltaPct: w.weightDeltaPct,
      range: w.range || null, waistCm: w.waistCm, waistDelta: w.waistDelta,
      completeDays: w.completeDays, foodCoverage: w.foodCoverage, kcalAvg: w.kcalAvg, proteinAvg: w.proteinAvg,
      kcalAdherence: w.kcalAdherence, proteinAdherence: w.proteinAdherence,
      sessions: w.sessions, sessionsGoal: w.sessionsGoal, progressions: w.progressions, regressions: w.regressions,
      sleepAvg: w.sleepAvg, fatigueAvg: w.fatigueAvg, hungerAvg: w.hungerAvg, painMax: w.painMax,
      phaseWeeks: w.phase ? w.phase.weeks : null,
    };
    const end = w.end ? Dates.parse(w.end) : null;
    const nextReview = end ? Dates.addDays(end, Config.get('analysis.reviewEveryDays')) : null;
    const out = (code, reason) => ({ code, reason, data, nextReview });

    const minW = Config.get('analysis.minWeighInsPerWeek');
    const minF = Config.get('analysis.minCompleteFoodDays');
    if (w.status === Analysis.STATUS.NODATA || has('dados_insuficientes')) {
      const parts = [];
      if (has('pesagens_insuficientes')) {
        parts.push((w.weighIns || 0) < minW
          ? `registre o peso em pelo menos ${minW} dias (${w.weighIns || 0} nesta semana)`
          : 'falta a média de peso da semana anterior para comparar');
      }
      if (has('alimentacao_insuficiente')) parts.push(`registre a alimentação completa em pelo menos ${minF} dias (${w.foodCoverage || '—'})`);
      if (!parts.length) parts.push(...(w.reasons || []).map((r) => r.replace(/\.$/, '')));
      return out(C.NODATA, `Dados insuficientes para avaliar a semana: ${parts.join('; ')}. Nenhuma meta deve mudar com base nesta semana.`);
    }

    const rec = [];
    if (has('sono_baixo')) rec.push(`sono médio ${f(w.sleepAvg, 1)} h`);
    if (has('fadiga_alta')) rec.push(`cansaço médio ${f(w.fatigueAvg, 1)}`);
    if (has('dor_alta')) rec.push(`dor máxima ${f(w.painMax, 0)}`);
    if (has('fome_alta')) rec.push(`fome média ${f(w.hungerAvg, 1)}`);
    if (rec.length) return out(C.RECOVERY, `Recuperação a revisar: ${rec.join(', ')}.`);

    const prev = hist.length ? hist[hist.length - 1] : null;
    const samePrev = prev && prev.objective === phaseId ? prev : null;
    const outOfRange = has('peso_acima_faixa') || has('peso_abaixo_faixa');
    const prevOut = samePrev && (samePrev.signals || []).some((s) => s === 'peso_acima_faixa' || s === 'peso_abaixo_faixa');
    const dietFollowed = !has('aderencia_baixa') && !has('kcal_fora');
    if (outOfRange && dietFollowed && (w.status === Analysis.STATUS.OFF || (w.status === Analysis.STATUS.WARN && prevOut))) {
      return out(C.ENERGY, `Peso variou ${f(w.weightDeltaPct)}%/sem, fora da faixa ${Analysis.rangeText(w.range)} do objetivo ${phaseId}, com a dieta seguida (${w.foodCoverage || '—'} completos). Avaliar a meta de energia.`);
    }

    const mac = [];
    const t = w.targets || {};
    if (has('proteina_baixa')) mac.push(`proteína média ${f(w.proteinAvg, 0)} g abaixo do mínimo ${f(t.proteinMin, 0)} g`);
    if (has('kcal_fora')) mac.push(`kcal média ${f(w.kcalAvg, 0)} fora de ${f(t.kcal, 0)} ± ${f((t.kcalTolerance || 0) * 100, 0)}%`);
    if (has('gordura_fora')) mac.push(`gordura média ${f(w.fatAvg, 0)} g fora de ${f(t.fat, 0)} g ± ${f((t.fatTolerance || 0) * 100, 0)}%`);
    if (has('aderencia_baixa')) mac.push(`aderência kcal ${Recommend.pct_(w.kcalAdherence)}, proteína ${Recommend.pct_(w.proteinAdherence)} dos dias completos`);
    if (mac.length) return out(C.MACROS, `Alimentação a revisar: ${mac.join('; ')}.`);

    const tr = [];
    if (has('desempenho_caindo')) tr.push(`${w.regressions} exercício(s) com regressão contra ${w.progressions} com progressão`);
    if (has('treinos_abaixo')) tr.push(`${w.sessions} de ${w.sessionsGoal} treinos na semana`);
    if (tr.length) return out(C.TRAINING, `Treino a revisar: ${tr.join('; ')}.`);

    const phase = Recommend.phaseReview_(w, hist);
    if (phase) return out(C.PHASE, phase);

    const why = (w.reasons || []).join(' ').replace(/\.$/, '') || w.status;
    return out(C.KEEP, w.status === Analysis.STATUS.OK ? `Manter o plano: ${why}.` : `Manter e acompanhar na próxima semana: ${why}.`);
  },

  /** Reason for REVISAR OBJETIVO/FASE, or null. */
  phaseReview_(w, hist) {
    const streak = Config.get('analysis.phaseReviewStreak');
    const minWeeks = Config.get('analysis.minWeeksForPhaseReview');
    const id = w.phase ? w.phase.id : w.objective;
    if (!id) return null;
    const last = (streak > 1 ? hist.slice(-(streak - 1)) : []).concat([w]);
    if (last.length < streak || last.some((x) => x.objective !== id)) return null;
    const weeks = w.phase && typeof w.phase.weeks === 'number' ? w.phase.weeks : null;
    if (weeks !== null && weeks >= minWeeks && last.every((x) => x.status === Analysis.STATUS.OK && x.expectationMet)) {
      const exp = w.phase && w.phase.expectation ? ` (${w.phase.expectation})` : '';
      return `A fase ${id} dura ${weeks} semanas e as últimas ${streak} estão no caminho com a expectativa atendida${exp}. Revisar se o objetivo continua ou se é hora da próxima fase.`;
    }
    if (last.every((x) => x.status === Analysis.STATUS.OFF)) {
      return `${streak} semanas seguidas fora do esperado no objetivo ${id}. Revisar se o objetivo e a faixa ainda fazem sentido.`;
    }
    return null;
  },

  pct_(v) {
    return typeof v === 'number' && isFinite(v) ? `${Math.round(v * 100)}%` : '—';
  },
};
