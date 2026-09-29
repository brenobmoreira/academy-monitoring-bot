'use strict';
/** Signals, rule sets (spec §7) and recommendations (spec §8) on hand-built weeks. */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, day, plain } = require('./core_helpers');

const eq = (a, b, m) => assert.deepEqual(plain(a), b, m);
const ctx = boot({ tabs: {} });

/** A closed week with full data, weight stable, food on target, no progression, recovery ok. */
function week(type, o = {}, phase = {}) {
  return Object.assign({
    start: day('2026-11-02'), end: day('2026-11-08'), closed: true, objective: 'O001', goal: 'M001', transition: null,
    weighIns: 7, weightAvg: 80, weightDeltaPct: 0, waistCm: null, waistDelta: null,
    completeDays: 7, daysElapsed: 7, foodCoverage: '7 de 7 dias', kcalAvg: 2400, proteinAvg: 140, fatAvg: 65,
    kcalAdherence: 1, proteinAdherence: 1, fatAdherence: 1,
    sessions: 3, sessionsGoal: 3, progressions: 0, regressions: 0, comparedExercises: 3,
    sleepAvg: 7.5, hungerAvg: 2, fatigueAvg: 2, painMax: 1,
    sufficiency: { weight: true, food: true },
    targets: { kcal: 2400, kcalTolerance: 0.05, proteinMin: 135, proteinMax: 145, fat: 65, fatTolerance: 0.15 },
    phase: Object.assign({ id: 'O001', analysisType: type, rateMinPct: null, rateMaxPct: null, weeks: 3, weightChangeKg: 0, waistChangeCm: 0 }, phase),
  }, o);
}
const run = (w, history = []) => {
  const hist = [];
  history.forEach((h) => hist.push(Object.assign({}, h, ctx.Analysis.evaluate(h, hist.slice()))));
  const ev = ctx.Analysis.evaluate(w, hist);
  const full = Object.assign({}, w, ev);
  return Object.assign(ev, { rec: ctx.Recommend.for(full, hist), full, hist });
};

test('every analysis type of the spec is registered with its default range', () => {
  eq(ctx.Rules.types().sort(), plain(ctx.Tabs.ENUMS.ANALYSIS_TYPES.slice().sort()));
  eq(plain(ctx.Rules.get('deficit').defaults), { weightPctMin: -1, weightPctMax: -0.5 });
  eq(plain(ctx.Rules.get('personalizado').defaults), { weightPctMin: null, weightPctMax: null });
});

test('(5) recomposição positive patterns are No caminho', () => {
  const a = run(week('recomposicao', { waistDelta: -0.6, progressions: 2 }));
  assert.equal(a.status, 'No caminho', a.reasons.join(' '));
  for (const s of ['peso_estavel', 'peso_na_faixa', 'cintura_caindo', 'desempenho_subindo']) assert.ok(a.signals.includes(s), s);
  const b = run(week('recomposicao', { weightDeltaPct: -0.4 }));
  assert.equal(b.status, 'No caminho', b.reasons.join(' '));
  eq(b.signals.filter((s) => s.startsWith('peso_') || s.startsWith('desempenho_')), ['peso_caindo_lento', 'peso_na_faixa', 'desempenho_mantido']);
  assert.match(b.reasons.join(' '), /perda lenta de peso com desempenho mantido/);
  const c = run(week('recomposicao', { progressions: 1 }));
  assert.equal(c.status, 'No caminho');
  assert.equal(c.rec.code, 'MANTER');
});

test('(5) recomposição attention and off patterns', () => {
  const flat = run(week('recomposicao'));
  assert.equal(flat.status, 'Atenção');
  assert.match(flat.reasons.join(' '), /sem sinal de cintura caindo ou desempenho subindo/);
  const up = run(week('recomposicao', { weightDeltaPct: 0.6, waistDelta: 0.8 }));
  assert.equal(up.status, 'Fora do esperado');
  assert.equal(up.rec.code, 'REVISAR ENERGIA');
});

test('(5) déficit: in range, too fast, stalled 2+ weeks, rising', () => {
  assert.equal(run(week('deficit', { weightDeltaPct: -0.7, progressions: 1 })).status, 'No caminho');
  const fast = run(week('deficit', { weightDeltaPct: -1.5 }));
  assert.equal(fast.status, 'Atenção');
  assert.ok(fast.signals.includes('peso_caindo_rapido') && fast.signals.includes('peso_abaixo_faixa'));
  assert.match(fast.reasons.join(' '), /Perda rápida demais/);
  assert.equal(fast.rec.code, 'MANTER');
  assert.match(fast.rec.reason, /^Manter e acompanhar/);
  const fastTired = run(week('deficit', { weightDeltaPct: -1.5, regressions: 2 }));
  assert.equal(fastTired.status, 'Fora do esperado');
  const once = run(week('deficit', { weightDeltaPct: -0.1 }));
  assert.equal(once.status, 'Atenção');
  const stalled = run(week('deficit', { weightDeltaPct: -0.1 }), [week('deficit', { weightDeltaPct: -0.2, start: day('2026-10-26'), end: day('2026-11-01') })]);
  assert.equal(stalled.status, 'Fora do esperado');
  assert.match(stalled.reasons.join(' '), /estagnada há 2\+ semanas/);
  assert.equal(stalled.rec.code, 'REVISAR ENERGIA');
  // A stalled previous week under another objective does not count.
  const other = week('deficit', { weightDeltaPct: -0.2, objective: 'O000' });
  assert.equal(run(week('deficit', { weightDeltaPct: -0.1 }), [other]).status, 'Atenção');
  assert.equal(run(week('deficit', { weightDeltaPct: 0.4 })).status, 'Fora do esperado');
});

test("the objective's own range overrides the rule defaults", () => {
  const def = run(week('deficit', { weightDeltaPct: -0.3, progressions: 1 }));
  assert.equal(def.status, 'Atenção');
  const own = run(week('deficit', { weightDeltaPct: -0.3, progressions: 1 }, { rateMinPct: -0.5, rateMaxPct: -0.25 }));
  assert.equal(own.status, 'No caminho');
  eq(plain(own.range), { min: -0.5, max: -0.25, source: 'objetivo' });
  assert.equal(ctx.Analysis.rangeText(own.range), '−0,5 a −0,25 %/sem (objetivo)');
});

test('(5) ganho: in range with progression, too fast, too fast with waist up, flat performance', () => {
  assert.equal(run(week('ganho_controlado', { weightDeltaPct: 0.2, progressions: 2 })).status, 'No caminho');
  const fast = run(week('ganho_controlado', { weightDeltaPct: 0.6, progressions: 2 }));
  assert.equal(fast.status, 'Atenção');
  assert.match(fast.reasons.join(' '), /Ganho mais rápido que a faixa/);
  const waist = run(week('ganho_controlado', { weightDeltaPct: 0.6, waistDelta: 0.7, progressions: 2 }));
  assert.equal(waist.status, 'Fora do esperado');
  assert.equal(waist.rec.code, 'REVISAR ENERGIA');
  const flat = run(week('ganho_controlado', { weightDeltaPct: 0.2 }));
  assert.equal(flat.status, 'Atenção');
  assert.match(flat.reasons.join(' '), /desempenho estável/);
  assert.equal(run(week('ganho_agressivo', { weightDeltaPct: 0.5, progressions: 1 })).status, 'No caminho');
  assert.equal(run(week('ganho_controlado', { weightDeltaPct: 0.5, progressions: 1 })).status, 'Atenção');
});

test('(5) manutenção: stable is on track, a drift of 2+ weeks is off', () => {
  assert.equal(run(week('manutencao', { weightDeltaPct: 0.1 })).status, 'No caminho');
  const once = run(week('manutencao', { weightDeltaPct: 0.5 }));
  assert.equal(once.status, 'Atenção');
  assert.equal(once.rec.code, 'MANTER');
  const drift = run(week('manutencao', { weightDeltaPct: 0.5 }), [week('manutencao', { weightDeltaPct: 0.45 })]);
  assert.equal(drift.status, 'Fora do esperado');
  assert.match(drift.reasons.join(' '), /fora da faixa há 2\+ semanas/);
  assert.equal(drift.rec.code, 'REVISAR ENERGIA');
  assert.equal(run(week('manutencao_pos_cut', { weightDeltaPct: 0.35 })).status, 'No caminho');
});

test('adaptação, performance and personalizado', () => {
  assert.equal(run(week('adaptacao', { weighIns: 1, sufficiency: { weight: false, food: false }, completeDays: 1 })).status, 'Atenção');
  const better = run(week('adaptacao', { weighIns: 2, sufficiency: { weight: false, food: false }, completeDays: 3 }),
    [week('adaptacao', { weighIns: 1, sufficiency: { weight: false, food: false }, completeDays: 1 })]);
  assert.equal(better.status, 'No caminho');
  assert.ok(better.signals.includes('cobertura_melhorando'));
  assert.equal(better.rec.code, 'DADOS INSUFICIENTES');
  assert.equal(run(week('performance', { progressions: 3 })).status, 'No caminho');
  assert.equal(run(week('performance', { regressions: 3 })).status, 'Atenção');
  assert.equal(run(week('performance', { comparedExercises: 0, progressions: null, regressions: null })).status, 'Dados insuficientes');
  const custom = run(week('personalizado', { weightDeltaPct: 1.2 }));
  assert.equal(custom.status, 'No caminho', 'no range: only data and recovery checks');
  assert.equal(run(week('personalizado', { weightDeltaPct: 1.2 }, { rateMinPct: 0, rateMaxPct: 0.5 })).status, 'Atenção');
  assert.equal(run(week('personalizado', { weighIns: 1, sufficiency: { weight: false, food: true } })).status, 'No caminho');
});

test('an unknown analysis type falls back to personalizado with a note', () => {
  const a = run(week('mini_bulk_x'));
  eq([a.analysisType, a.ruleLabel], ['personalizado', 'Personalizado']);
  assert.match(a.reasons.join(' '), /Tipo de análise "mini_bulk_x" desconhecido/);
});

test('recovery signals turn a No caminho week into Atenção and outrank energy/macros', () => {
  const a = run(week('recomposicao', { progressions: 2, sleepAvg: 6.2 }));
  assert.equal(a.status, 'Atenção');
  assert.match(a.reasons.join(' '), /Recuperação: sono abaixo do mínimo/);
  assert.equal(a.rec.code, 'REVISAR RECUPERAÇÃO');
  const b = run(week('manutencao', { weightDeltaPct: 0.5, painMax: 6, proteinAvg: 100 }), [week('manutencao', { weightDeltaPct: 0.5 })]);
  assert.equal(b.rec.code, 'REVISAR RECUPERAÇÃO');
});

test('precedence: energy only when the diet was followed; macros; training', () => {
  const low = run(week('manutencao', { weightDeltaPct: 0.5, kcalAvg: 2800, kcalAdherence: 0.2 }), [week('manutencao', { weightDeltaPct: 0.5 })]);
  assert.equal(low.status, 'Fora do esperado');
  assert.equal(low.rec.code, 'REVISAR MACROS', 'off target because the goal was not followed');
  assert.match(low.rec.reason, /kcal média 2800 fora de 2400 ± 5%/);
  const prot = run(week('recomposicao', { progressions: 2, proteinAvg: 120, proteinAdherence: 0.3 }));
  assert.equal(prot.rec.code, 'REVISAR MACROS');
  assert.match(prot.rec.reason, /proteína média 120 g abaixo do mínimo 135 g/);
  const tr = run(week('recomposicao', { waistDelta: -0.6, sessions: 1 }));
  assert.ok(tr.signals.includes('treinos_abaixo'));
  assert.equal(tr.rec.code, 'REVISAR TREINO');
  assert.ok(!run(week('recomposicao', { closed: false, sessions: 1, waistDelta: -0.6 })).signals.includes('treinos_abaixo'), 'a running week is not judged on sessions');
});

test('(6) few weigh-ins: Dados insuficientes, no weight signal, no false classification', () => {
  const a = run(week('deficit', { weighIns: 2, weightDeltaPct: -3, sufficiency: { weight: false, food: true } }));
  assert.equal(a.status, 'Dados insuficientes');
  assert.ok(!a.signals.some((s) => /^peso_(estavel|caindo|subindo|na_faixa|abaixo|acima)/.test(s)), a.signals.join());
  assert.ok(a.signals.includes('pesagens_insuficientes') && a.signals.includes('dados_insuficientes'));
  assert.match(a.reasons.join(' '), /Pesagens insuficientes: 2 de 3/);
  assert.equal(a.rec.code, 'DADOS INSUFICIENTES');
  assert.match(a.rec.reason, /registre o peso em pelo menos 3 dias \(2 nesta semana\)/);
  assert.match(a.rec.reason, /Nenhuma meta deve mudar/);
});

test('(6) few complete food days: DADOS INSUFICIENTES and no diet signal even when averages are off', () => {
  const a = run(week('recomposicao', {
    progressions: 2, completeDays: 2, foodCoverage: '2 de 7 dias', kcalAvg: 1200, proteinAvg: 60, kcalAdherence: 0, proteinAdherence: 0,
    sufficiency: { weight: true, food: false },
  }));
  assert.equal(a.status, 'No caminho', 'weight trend is still classified');
  for (const s of ['kcal_fora', 'proteina_baixa', 'aderencia_baixa', 'gordura_fora']) assert.ok(!a.signals.includes(s), s);
  assert.ok(a.signals.includes('alimentacao_insuficiente'));
  assert.equal(a.rec.code, 'DADOS INSUFICIENTES');
  assert.match(a.rec.reason, /alimentação completa em pelo menos 4 dias \(2 de 7 dias\)/);
});

test('(8) REVISAR OBJETIVO/FASE after the minimum weeks on track with the expectation met', () => {
  const on = (weeks, extra = {}) => week('recomposicao', Object.assign({ waistDelta: -0.6, progressions: 1 }, extra), { weeks, waistChangeCm: -2.4, expectation: 'Cintura −2 cm' });
  const a = run(on(10), [on(8), on(9)]);
  eq([a.status, a.expectationMet], ['No caminho', true]);
  assert.equal(a.rec.code, 'REVISAR OBJETIVO/FASE');
  assert.match(a.rec.reason, /A fase O001 dura 10 semanas e as últimas 3 estão no caminho com a expectativa atendida \(Cintura −2 cm\)/);
  assert.equal(run(on(7), [on(5), on(6)]).rec.code, 'MANTER', 'before analysis.minWeeksForPhaseReview');
  const notMet = (w) => week('recomposicao', { progressions: 1 }, { weeks: w, waistChangeCm: 0 });
  const b = run(notMet(10), [notMet(8), notMet(9)]);
  eq([b.status, b.expectationMet, b.rec.code], ['No caminho', false, 'MANTER']);
  const mixed = run(on(10), [on(8, { objective: 'O000' }), on(9)]);
  assert.equal(mixed.rec.code, 'MANTER', 'the streak must be inside the same objective');
});

test('recommendation shape: code, reason, data and next review (Sunday + reviewEveryDays)', () => {
  const a = run(week('recomposicao', { progressions: 1 }));
  eq(Object.keys(a.rec).sort(), ['code', 'data', 'nextReview', 'reason']);
  assert.equal(ctx.Dates.key(a.rec.nextReview), '2026-11-15');
  eq([a.rec.data.objective, a.rec.data.status, a.rec.data.weighIns], ['O001', 'No caminho', 7]);
  assert.ok(ctx.Tabs.ENUMS.RECOMMENDATIONS.includes(a.rec.code));
});

/* Aggregation of data states on a real Diário ------------------------------------------------ */

const NOW = '2026-10-14T12:00:00-03:00';
function dataStates() {
  const base = { foodLog: 'Completo', kcal: 2400, protein: 140, fat: 65, carbs: 313, noCalcItems: 0 };
  const diary = [
    { date: '2026-10-05', weightKg: 80, sleepH: 0, steps: 0, cardioMin: 0, ...base },
    { date: '2026-10-06', weightKg: 80.2, ...base },
    { date: '2026-10-07', foodLog: 'Completo', kcal: 2000, protein: 100, noCalcItems: 2 }, // no-calc items: not complete
    { date: '2026-10-08', foodLog: 'Completo' }, // declared complete, no totals: not complete
    { date: '2026-10-09', foodLog: 'Parcial', kcal: 900, protein: 50 }, // partial: never averaged
    { date: '2026-10-10', sleepH: 8, hunger: 3 },
    { date: '2026-10-11', ...base, kcal: 2600, fat: null },
  ];
  return boot({
    now: NOW,
    tabs: {
      objectives: [{ id: 'O001', name: 'Recomposição', analysisType: 'recomposicao', start: '2026-09-28', status: 'Vigente' }],
      goals: [{ id: 'M001', objective: 'O001', start: '2026-09-28', status: 'Vigente', kcal: 2400, protein: 140, proteinMin: 135, proteinMax: 145, fat: 65 }],
      plans: [], diary, measures: [], workouts: [],
    },
  });
}

test('(7) empty is não informado, zero is zero: averages, counts and coverage', () => {
  const c = dataStates();
  const w = c.Weeks.compute('2026-10-05');
  eq([w.completeDays, w.daysLogged, w.foodCoverage], [3, 6, '3 de 7 dias']);
  eq([w.kcalAvg, w.proteinAvg, w.fatAvg], [2467, 140, 65], 'fat averaged over the 2 days that have it');
  eq([w.kcalAdherence, w.fatAdherence], [0.67, 1]);
  eq([w.noCalcItems, w.estimatedItems], [2, null]);
  eq([w.sleepAvg, w.stepsAvg, w.cardioMin, w.hungerAvg, w.fatigueAvg, w.painMax, w.activities], [4, 0, 0, 3, null, null, null]);
  eq([w.weighIns, w.weightAvg, w.weightPrevAvg, w.weightDeltaPct], [2, 80.1, null, null]);
  eq([w.waistCm, w.waistDelta, w.sessions, w.workVolume, w.progressions], [null, null, 0, null, null]);
  eq(plain(w.sufficiency), { weight: false, weightPrevious: false, food: false, waist: false, training: false });
  assert.match(w.sufficiencyText, /Peso insuficiente \(2 de 3 pesagens, sem semana anterior\)/);
  const a = c.Weeks.analyze('2026-10-05');
  eq([a.status, a.recommendation.code], ['Dados insuficientes', 'DADOS INSUFICIENTES']);
  assert.ok(a.signals.includes('sono_baixo'), 'a typed 0 h of sleep is a value');
  const s = c.Weeks.store('2026-10-05');
  assert.equal(s.status, 'Dados insuficientes');
  const row = c.Weeks.stored('2026-10-05');
  eq([row.fatigueAvg, row.painMax, row.cardioMin, row.stepsAvg, row.weightDelta], [null, null, 0, 0, null], 'empty cells stay empty, zeros stay 0');
});
