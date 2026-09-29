/**
 * Synthetic client for the setup/dashboard tests and the visual preview (tools/preview_setup.js).
 * Fake person, fake reviewer, generic session names: nothing here is a real client.
 *
 *   O001 recomposição from Mon 28/09/2026 (M001, F001) → O002 ganho controlado from Mon 26/10/2026
 *   (M002, plan continues). Daily weigh-ins, weekly waist (Sundays), three sessions a week.
 */
'use strict';
const { load } = require('./harness');

const NOW = '2026-11-10T15:00:00-03:00'; // Tuesday
const CONFIG = {
  'client.name': 'Ana Exemplo',
  'client.sex': 'F',
  'client.age': 31,
  'client.heightCm': 165,
  'client.startWeightKg': 62,
  'client.startDate': '2026-09-21',
  'client.reviewer': 'Revisora Teste',
  'routine.strengthPerWeek': 3,
  'routine.cardioPerWeek': 1,
  'routine.activities': 'Corrida',
  'routine.activitiesPerWeek': 2,
  'routine.sessionRotation': 'Treino A, Treino B, Treino C',
};
const EXERCISES = [
  { name: 'Agachamento livre', group: 'Pernas', loadConvention: 'Carga total na barra' },
  { name: 'Supino reto', group: 'Peito', loadConvention: 'Carga total na barra' },
  { name: 'Remada curvada', group: 'Costas', loadConvention: 'Carga total na barra' },
];

const day = (s) => new Date(`${s}T00:00:00`);
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const add = (s, n) => { const d = day(s); d.setDate(d.getDate() + n); return iso(d); };

/** Weight level (kg) per Monday; every day of that week weighs about that. */
const WEIGHT = {
  '2026-09-21': 62.4, '2026-09-28': 62.3, '2026-10-05': 62.2, '2026-10-12': 62.1, '2026-10-19': 62.0,
  '2026-10-26': 62.1, '2026-11-02': 62.3, '2026-11-09': 62.4,
};
const WAIST = {
  '2026-09-27': 74.0, '2026-10-04': 73.6, '2026-10-11': 73.2, '2026-10-18': 72.9, '2026-10-25': 72.6,
  '2026-11-01': 72.6, '2026-11-08': 72.7,
};
const GOALS = {
  M001: { kcal: 1900, protein: 120, proteinMin: 110, proteinMax: 130, fat: 60, fiber: 25, strengthPerWeek: 3, cardioPerWeek: 1, activitiesPerWeek: 2, stepsPerDay: 8000 },
  M002: { kcal: 2150, protein: 125, proteinMin: 115, proteinMax: 135, fat: 65, fiber: 28, strengthPerWeek: 3, cardioPerWeek: 1, activitiesPerWeek: 2, stepsPerDay: 8000 },
};

/** Diário, Medidas and Registro rows from 21/09 to the day before `until`. */
function data(until) {
  const diary = [];
  const workouts = [];
  let load = 40;
  for (let k = '2026-09-21'; k < until; k = add(k, 1)) {
    const d = day(k);
    const monday = add(k, -((d.getDay() + 6) % 7));
    const g = k >= '2026-10-26' ? GOALS.M002 : GOALS.M001;
    const wiggle = ((d.getDate() * 7) % 5 - 2) / 10;
    diary.push({
      date: k, weightKg: Math.round((WEIGHT[monday] + wiggle) * 10) / 10, sleepH: 7 + (d.getDay() % 2) / 2, steps: 7500 + d.getDay() * 150,
      hunger: 2, fatigue: 2, pain: 0, foodLog: d.getDay() === 0 ? 'Parcial' : 'Completo',
      kcal: g.kcal + (d.getDay() - 3) * 20, protein: g.protein + 2, carbs: Math.round((g.kcal - 4 * g.protein - 9 * g.fat) / 4), fat: g.fat, fiber: g.fiber,
      noCalcItems: 0, estimatedItems: 0,
    });
    if ([1, 3, 5].includes(d.getDay())) {
      load += 1.25;
      const session = { 1: 'Treino A', 3: 'Treino B', 5: 'Treino C' }[d.getDay()];
      const exercise = { 1: 'Agachamento livre', 3: 'Supino reto', 5: 'Remada curvada' }[d.getDay()];
      workouts.push({
        date: k, session, exercise, sessionId: `S${k}`, warmupKg: 20, warmupReps: 10, feederKg: load - 10, feederReps: 5,
        work1Kg: load, work1Reps: 8, rir1: 2, work2Kg: load, work2Reps: 7, rir2: 2, sessionState: 'Concluído',
      });
    }
  }
  const measures = Object.keys(WAIST).filter((k) => k < until).map((k) => ({ date: k, waistCm: WAIST[k], notes: 'Manhã, em jejum' }));
  return { diary, workouts, measures };
}

/**
 * A brand-new spreadsheet set up by Setup.apply, with the synthetic client.
 * @param {{now?: string, transition?: boolean, data?: boolean}} opts
 */
function scenario(opts = {}) {
  const now = opts.now || NOW;
  const ctx = load({ sheets: [{ name: 'Sheet1', rows: [] }], now });
  ctx.Setup.apply();
  Object.keys(CONFIG).forEach((k) => ctx.Config.set(k, CONFIG[k]));
  ctx.Tabs.appendMany('exercises', EXERCISES);
  ctx.Objectives.open({ name: 'Recomposição corporal', analysisType: 'recomposicao', startWeightKg: 62.3, startWaistCm: 74, reviewer: CONFIG['client.reviewer'], expectation: 'Cintura caindo com peso estável', goal: 'M001', plan: 'F001' }, '2026-09-28');
  ctx.Goals.open(Object.assign({ objective: 'O001', reason: 'Início do acompanhamento', reviewer: CONFIG['client.reviewer'] }, GOALS.M001), '2026-09-28', { weightKg: 62.3 });
  ctx.Plans.open(EXERCISES.map((e, i) => ({
    session: ['Treino A', 'Treino B', 'Treino C'][i], exercise: e.name, group: e.group, workSetsAdapt: 2, workSetsRegular: 2,
    repsMin: 6, repsMax: 10, rirAdapt: 2, rirRegular: 1, restS: 120,
  })), '2026-09-28');
  if (opts.data !== false) {
    const d = data(now.slice(0, 10));
    ctx.Tabs.appendMany('diary', d.diary);
    ctx.Tabs.appendMany('measures', d.measures);
    ctx.Tabs.appendMany('workouts', d.workouts);
    ctx.Days.restampAll();
  }
  if (opts.transition !== false) {
    ctx.Transition.apply({
      date: '2026-10-26',
      objective: { name: 'Ganho controlado', analysisType: 'ganho_controlado', expectation: 'Peso subindo 0,1–0,3%/sem com cintura estável' },
      goal: Object.assign({}, GOALS.M002),
      reason: 'Recomposição concluída; fase de ganho',
      reviewer: CONFIG['client.reviewer'],
    });
  }
  ctx.Weeks.recomputeAll();
  return ctx;
}

module.exports = { scenario, data, NOW, CONFIG, EXERCISES, GOALS };
