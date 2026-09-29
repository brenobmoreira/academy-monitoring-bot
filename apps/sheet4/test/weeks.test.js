'use strict';
/**
 * Weekly engine against a synthetic history across three phases (spec §13):
 *   O001 recomposição 28/09–25/10 (4 weeks) → O002 ganho controlado 26/10–18/11 →
 *   O003 déficit from Thu 19/11 (mid-week transition); goals M001 → M002 on 26/10;
 *   plan F001 → F002 on Wed 11/11 (mid-week). Today is Tue 15/12/2026.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, day, plain } = require('./core_helpers');

const NOW = '2026-12-15T12:00:00-03:00';
const eq = (a, b, m) => assert.deepEqual(plain(a), b, m);

const add = (s, n) => { const d = day(s); d.setDate(d.getDate() + n); return d; };
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Weekly weight level (kg) by Monday; every day of the week weighs that. */
const WEIGHT = {
  '2026-09-21': 80.0,
  '2026-09-28': 80.0, '2026-10-05': 79.9, '2026-10-12': 79.8, '2026-10-19': 79.7, // recomposição: stable
  '2026-10-26': 79.9, '2026-11-02': 80.1, '2026-11-09': 80.3, // ganho +0.25%/sem
  '2026-11-16': 80.6, // transition week: still rising, analysed as déficit
  '2026-11-23': 79.9, '2026-11-30': 79.3, '2026-12-07': 78.7, // déficit −0.75%/sem
  '2026-12-14': 78.3,
};
/** Waist measured on Sundays (Medidas e fotos). */
const WAIST = {
  '2026-09-27': 90.5, '2026-10-04': 90.0, '2026-10-11': 89.4, '2026-10-18': 88.8, '2026-10-25': 88.2,
  '2026-11-01': 88.2, '2026-11-08': 88.3, '2026-11-15': 88.4, '2026-11-22': 88.4, '2026-11-29': 87.8,
  '2026-12-06': 87.2, '2026-12-13': 86.6,
};

const GOALS = {
  M001: { kcal: 2400, protein: 140, proteinMin: 135, proteinMax: 145, fat: 65, carbs: 313.75, strengthPerWeek: 3 },
  M002: { kcal: 2800, protein: 150, proteinMin: 140, proteinMax: 160, fat: 75, carbs: 381.25, strengthPerWeek: 3 },
};

function history() {
  const diary = [];
  const workouts = [];
  let load = 60;
  for (let d = day('2026-09-25'); d <= day('2026-12-15'); d = add(iso(d), 1)) {
    const k = iso(d);
    const monday = iso(add(k, -((d.getDay() + 6) % 7)));
    const goal = k >= '2026-10-26' ? GOALS.M002 : GOALS.M001;
    diary.push({
      date: k, weightKg: WEIGHT[monday], sleepH: 7.5, hunger: 2, fatigue: 2, pain: 1, steps: 8000,
      foodLog: 'Completo', kcal: goal.kcal, protein: goal.protein, fat: goal.fat, carbs: goal.carbs, fiber: 30, noCalcItems: 0, estimatedItems: 0,
    });
    if ([1, 3, 5].includes(d.getDay())) {
      load += 1;
      workouts.push({
        date: k, session: 'Full', exercise: 'Supino', sessionId: `S${k}`, warmupKg: 20, warmupReps: 10, feederKg: 40, feederReps: 5,
        work1Kg: load, work1Reps: 8, rir1: 2, work2Kg: load, work2Reps: 7, rir2: 2, sessionState: 'Concluído',
      });
    }
  }
  return {
    objectives: [
      { id: 'O001', name: 'Recomposição corporal', analysisType: 'recomposicao', start: '2026-09-28', end: '2026-10-25', status: 'Encerrado', startWeightKg: 80, startWaistCm: 90.5, goal: 'M001', plan: 'F001' },
      { id: 'O002', name: 'Ganho controlado', analysisType: 'ganho_controlado', start: '2026-10-26', end: '2026-11-18', status: 'Encerrado', goal: 'M002', plan: 'F001' },
      { id: 'O003', name: 'Mini-cut', analysisType: 'deficit', start: '2026-11-19', status: 'Vigente', goal: 'M002', plan: 'F002' },
    ],
    goals: [
      Object.assign({ id: 'M001', objective: 'O001', start: '2026-09-28', end: '2026-10-25', status: 'Encerrada' }, GOALS.M001),
      Object.assign({ id: 'M002', objective: 'O002', start: '2026-10-26', status: 'Vigente' }, GOALS.M002),
    ],
    plans: [
      { id: 'F001', legacyStart: '2026-09-28', session: 'Full', exercise: 'Supino', group: 'Peito', start: '2026-09-28', end: '2026-11-10', status: 'Encerrada' },
      { id: 'F002', legacyStart: '2026-11-11', session: 'Full', exercise: 'Supino', group: 'Peito', start: '2026-11-11', status: 'Vigente' },
    ],
    diary,
    measures: Object.keys(WAIST).map((k) => ({ date: k, waistCm: WAIST[k] })),
    workouts,
    exercises: [{ name: 'Supino', group: 'Peito' }],
    reviews: [],
  };
}

const setup = (opts = {}) => boot({ tabs: Object.assign(history(), opts.tabs || {}), config: opts.config, now: opts.now || NOW });
const rows = (ctx, id) => ctx.Tabs.read(id).map((r) => { const o = Object.assign({}, r); delete o._row; return o; });
const byWeek = (ctx) => Object.fromEntries(ctx.Weeks.list().map((r) => [ctx.Dates.key(r.start), r]));
/** Raw cell values of the stored Semanas rows, except "Calculado em". */
const cells = (ctx, { keepComputedAt = false } = {}) => {
  const sheet = ctx.__spreadsheet.getSheetByName('Semanas');
  const col = ctx.Tabs.headerMap('weeks').computedAt;
  return sheet.getRange(6, 1, sheet.getLastRow() - 5, sheet.getLastColumn()).getValues()
    .map((line) => line.map((v, i) => (!keepComputedAt && i === col - 1 ? '' : v instanceof Date ? v.getTime() : v)));
};

test('compute: ids on the Sunday, transitions inside the week, moving average and %/week', () => {
  const ctx = setup();
  const w = ctx.Weeks.compute('2026-11-18');
  assert.equal(ctx.Dates.key(w.start), '2026-11-16');
  eq([w.objective, w.goal, w.plan], ['O003', 'M002', 'F002']);
  assert.equal(w.transition, 'Objetivo O002 → O003 em 19/11/2026');
  eq([w.weighIns, w.weightAvg, w.weightPrevAvg, w.weightDelta, w.weightDeltaPct], [7, 80.6, 80.3, 0.3, 0.37]);
  eq([w.waistCm, w.waistPrev, w.waistDelta], [88.4, 88.4, 0]);
  const plan = ctx.Weeks.compute('2026-11-09');
  assert.equal(plan.transition, 'Ficha F001 → F002 em 11/11/2026');
  eq([plan.objective, plan.plan], ['O002', 'F002']);
  assert.equal(ctx.Weeks.compute('2026-10-26').transition, null, 'a change on Monday is not inside the week');
});

test('compute: food over complete days, adherence against the goal of each day, coverage text', () => {
  const ctx = setup();
  const w = ctx.Weeks.compute('2026-10-05');
  eq([w.daysLogged, w.completeDays, w.foodCoverage, w.kcalAvg, w.proteinAvg, w.fatAvg, w.fiberAvg], [7, 7, '7 de 7 dias', 2400, 140, 65, 30]);
  eq([w.kcalAdherence, w.proteinAdherence, w.fatAdherence], [1, 1, 1]);
  eq([w.targets.kcal, w.targets.proteinMin, w.targets.proteinMax, w.targets.kcalTolerance], [2400, 135, 145, 0.05]);
  const cur = ctx.Weeks.compute('2026-12-15');
  eq([cur.closed, cur.daysElapsed, cur.foodCoverage, cur.weighIns], [false, 2, '2 de 2 dias', 2]);
});

test('compute: training from Registro de treino counts work sets only and progression vs the previous session', () => {
  const ctx = setup();
  const viaWorkout = ctx.Weeks.compute('2026-10-05');
  assert.equal(viaWorkout.trainingSource, 'Progression');
  eq([viaWorkout.sessions, viaWorkout.workVolume, viaWorkout.progressions, viaWorkout.regressions, viaWorkout.comparedExercises],
    [3, (65 + 66 + 67) * 15, 1, 0, 1], 'the workout module agrees with the fallback');
  eq(viaWorkout.volumeByGroup, { Peito: (65 + 66 + 67) * 15 });
  ctx.Progression = undefined;
  const w = ctx.Weeks.compute('2026-10-05');
  assert.equal(w.trainingSource, 'Registro de treino');
  assert.equal(w.sessions, 3);
  // Loads 65, 66, 67 kg on Mon/Wed/Fri: (8 + 7) reps each, warm-up and feeder excluded.
  assert.equal(w.workVolume, (65 + 66 + 67) * 15);
  eq(w.volumeByGroup, { Peito: (65 + 66 + 67) * 15 });
  eq([w.progressions, w.regressions, w.comparedExercises], [1, 0, 1]);
  assert.equal(w.sessionsGoal, 3);
});

test('compute: Progression.weekSummary is used when the workout module provides it', () => {
  const ctx = setup();
  const calls = [];
  ctx.Progression = { weekSummary: (s, e) => { calls.push([ctx.Dates.key(s), ctx.Dates.key(e)]); return { sessions: 2, workVolume: 1234.56, volumeByGroup: { Costas: 1234.56 }, progressedExercises: ['Remada', 'Barra'], regressedExercises: [] }; } };
  const w = ctx.Weeks.compute('2026-10-05');
  eq(calls, [['2026-10-05', '2026-10-11']]);
  eq([w.trainingSource, w.sessions, w.workVolume, w.progressions, w.regressions], ['Progression', 2, 1234.6, 2, 0]);
});

test('(1) every stored week carries the ids and the classification of its own objective', () => {
  const ctx = setup();
  ctx.Weeks.closeFinished();
  ctx.Weeks.refreshCurrent();
  const w = byWeek(ctx);
  eq(Object.keys(w), ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02',
    '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30', '2026-12-07', '2026-12-14']);
  const pick = (k) => [w[k].objective, w[k].goal, w[k].plan, w[k].status, w[k].recommendation];
  eq(pick('2026-09-21'), [null, null, null, 'Dados insuficientes', 'DADOS INSUFICIENTES']);
  eq(pick('2026-10-05'), ['O001', 'M001', 'F001', 'No caminho', 'MANTER']);
  eq(pick('2026-10-19'), ['O001', 'M001', 'F001', 'No caminho', 'MANTER']);
  eq(pick('2026-11-02'), ['O002', 'M002', 'F001', 'No caminho', 'MANTER']);
  eq(pick('2026-11-16'), ['O003', 'M002', 'F002', 'Fora do esperado', 'REVISAR ENERGIA']);
  eq(pick('2026-11-30'), ['O003', 'M002', 'F002', 'No caminho', 'MANTER']);
  // The same weight trend (+0.25%/sem) is on track under ganho and off under déficit.
  assert.equal(w['2026-11-09'].weightDeltaPct, 0.25);
  assert.equal(w['2026-11-09'].status, 'No caminho');
  assert.match(w['2026-11-16'].reasons, /Peso subindo \(0,37%\/sem\) durante o déficit/);
  assert.match(w['2026-10-05'].targetRange, /−0,5 a 0,25 %\/sem \(padrão\)/);
  assert.match(w['2026-11-02'].targetRange, /0,1 a 0,3 %\/sem/);
  assert.match(w['2026-11-23'].targetRange, /−1 a −0,5 %\/sem/);
  assert.match(w['2026-10-05'].signals, /peso_estavel/);
  assert.match(w['2026-10-05'].signals, /cintura_caindo/);
  assert.match(w['2026-10-05'].signals, /desempenho_subindo/);
  assert.equal(w['2026-10-05'].foodCoverage, '7 de 7 dias');
  // Evolução: one row per week, all phases.
  const evo = rows(ctx, 'evolution');
  assert.equal(evo.length, 13);
  eq(evo.map((r) => r.objective), [null, 'O001', 'O001', 'O001', 'O001', 'O002', 'O002', 'O002', 'O003', 'O003', 'O003', 'O003', 'O003']);
  eq([evo[2].weightAvg, evo[2].waistCm, evo[2].status, evo[2].recommendation], [79.9, 89.4, 'No caminho', 'MANTER']);
});

test('(4) a week with a mid-week transition is flagged and analysed with the later objective', () => {
  const ctx = setup();
  ctx.Weeks.closeFinished();
  const w = byWeek(ctx);
  assert.equal(w['2026-11-16'].transition, 'Objetivo O002 → O003 em 19/11/2026');
  assert.match(w['2026-11-16'].signals, /transicao_na_semana/);
  assert.match(w['2026-11-16'].reasons, /análise pelo objetivo O003, vigente no domingo/);
  assert.equal(w['2026-11-09'].transition, 'Ficha F001 → F002 em 11/11/2026');
  assert.equal(w['2026-11-23'].transition, null);
});

test('(2) opening a new objective today leaves every stored closed week byte-identical', () => {
  const ctx = setup();
  ctx.Weeks.closeFinished();
  ctx.Weeks.refreshCurrent();
  const before = cells(ctx, { keepComputedAt: true });
  const evoBefore = JSON.stringify(rows(ctx, 'evolution').slice(0, -1));
  const r = ctx.Transition.apply({ date: '2026-12-15', objective: { name: 'Manutenção', analysisType: 'manutencao' }, reason: 'Fim do mini-cut' });
  assert.equal(r.ok, true);
  const after = cells(ctx, { keepComputedAt: true });
  eq(after.slice(0, -1), before.slice(0, -1), 'closed weeks untouched');
  assert.equal(JSON.stringify(rows(ctx, 'evolution').slice(0, -1)), evoBefore);
  const cur = ctx.Weeks.stored('2026-12-15');
  eq([cur.objective, cur.transition], ['O004', 'Objetivo O003 → O004 em 15/12/2026']);
  // The daily trigger after the week ends closes it and still leaves the older weeks alone.
  ctx.__clock.set('2026-12-22T06:00:00-03:00');
  const d = ctx.dailyRefresh();
  eq(d.closed, ['2026-12-14']);
  eq(d.current, ['2026-12-21']);
  eq(cells(ctx, { keepComputedAt: true }).slice(0, 12), before.slice(0, 12));
  // Closing again writes nothing.
  eq(ctx.Weeks.closeFinished().written, []);
});

test('(3) recomputeAll gives identical rows, before and after a later phase change', () => {
  const ctx = setup();
  ctx.Weeks.closeFinished();
  ctx.Weeks.refreshCurrent();
  const stored = cells(ctx);
  ctx.__clock.set('2026-12-15T18:00:00-03:00');
  eq(ctx.Weeks.recomputeAll().written.length, 13);
  eq(cells(ctx), stored);
  ctx.Transition.apply({ date: '2026-12-15', objective: { name: 'Manutenção', analysisType: 'manutencao' }, reason: 'Fim do mini-cut' });
  ctx.Weeks.recomputeAll();
  eq(cells(ctx).slice(0, -1), stored.slice(0, -1));
  assert.equal(ctx.Tabs.read('weeks').length, 13, 'rows are rewritten in place, never duplicated');
  assert.equal(ctx.Tabs.read('evolution').length, 13);
});

test('a closed week stored while it was running is rewritten once when it closes', () => {
  const ctx = setup({ now: '2026-12-13T20:00:00-03:00' });
  ctx.Weeks.refreshCurrent();
  const running = ctx.Weeks.stored('2026-12-07');
  assert.equal(running.foodCoverage, '7 de 7 dias');
  ctx.__clock.set('2026-12-14T06:00:00-03:00');
  eq(ctx.Weeks.closeFinished().written.includes('2026-12-07'), true);
  const col = ctx.Tabs.headerMap('weeks').computedAt;
  const k = ctx.Dates.key(ctx.Weeks.stored('2026-12-07').computedAt);
  assert.equal(k, '2026-12-14');
  assert.ok(col);
  eq(ctx.Weeks.closeFinished().written, []);
});

test('a committed phase change refreshes the current week only; the action and dailyRefresh are wired', () => {
  const ctx = setup();
  ctx.Weeks.closeFinished();
  const closedCount = ctx.Tabs.read('weeks').length;
  assert.equal(ctx.Weeks.stored('2026-12-15'), null);
  ctx.Core.emit('action.committed', { label: 'Mudar objetivo/fase', tabs: ['Objetivos', 'Revisões'] });
  assert.equal(ctx.Tabs.read('weeks').length, closedCount + 1);
  assert.equal(ctx.Actions.get('weeksRefresh').group, 'analysis');
  assert.equal(ctx.Actions.get('weeksRefresh').label, 'Atualizar semana');
  assert.equal(ctx.Actions.get('weeksRecompute').label, 'Recalcular histórico');
  const r = ctx.Actions.run('weeksRecompute');
  assert.equal(r.ok, true, r.error);
  assert.match(r.result.message, /13 semana/);
  assert.equal(ctx.ChangeLog.actions().length, 0, 'derived rows are not undoable actions');
  assert.equal(ctx.Actions.run('weeksRefresh').ok, true);
  assert.equal(typeof ctx.dailyRefresh, 'function');
});

test('a transition without a Semanas tab does nothing (transitions never fail because of it)', () => {
  const ctx = boot({ tabs: { objectives: history().objectives, goals: [], plans: [], reviews: [] }, now: NOW });
  const r = ctx.Transition.apply({ date: '2026-12-15', objective: { name: 'X', analysisType: 'manutencao' }, reason: 'y' });
  assert.equal(r.ok, true);
  assert.equal(ctx.Tabs.findSheet('weeks'), null);
});

test('phaseSummary: one entry per objective with dates, changes inside the phase, weeks on track and outcome', () => {
  const ctx = setup();
  ctx.Weeks.closeFinished();
  ctx.Weeks.refreshCurrent();
  const p = plain(ctx.Weeks.phaseSummary());
  eq(p.map((x) => [x.id, x.label, x.weeks, x.weeksOnTrack]), [
    ['O001', 'Recomposição corporal', 4, 4],
    ['O002', 'Ganho controlado', 3, 3],
    ['O003', 'Déficit (perda de gordura)', 5, 3],
  ]);
  eq([p[0].durationDays, p[0].startWeightKg, p[0].endWeightKg, p[0].weightChangeKg, p[0].startWaistCm, p[0].endWaistCm, p[0].waistChangeCm],
    [28, 80, 79.7, -0.3, 90.5, 88.2, -2.3]);
  assert.match(p[0].outcome, /^Maioria no caminho — 4 de 4 semanas avaliadas no caminho$/);
  assert.match(p[2].outcome, /^Em andamento/);
  assert.equal(p[2].end, null);
});

test('an action that writes a source tab refreshes the running week once; closed weeks stay frozen', () => {
  const ctx = setup();
  ctx.Weeks.closeFinished();
  const closed = cells(ctx, { keepComputedAt: true });
  let refreshes = 0;
  const original = ctx.Weeks.refreshCurrent;
  ctx.Weeks.refreshCurrent = () => { refreshes += 1; return original(); };
  ctx.Core.emit('action.committed', { label: 't', tabs: ['Semanas'] });
  assert.equal(refreshes, 0, 'derived tabs do not trigger a refresh');
  ctx.Core.emit('action.committed', { label: 't', tabs: ['Diário', 'Alimentação'] });
  assert.equal(refreshes, 1);
  const after = cells(ctx, { keepComputedAt: true });
  eq(after.slice(0, closed.length - 1), closed.slice(0, closed.length - 1), 'closed weeks unchanged');
  assert.equal(ctx.Weeks.stored('2026-12-15').foodCoverage, '2 de 2 dias');
});
