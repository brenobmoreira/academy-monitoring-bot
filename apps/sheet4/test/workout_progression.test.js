'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, row, done, snapshot, plain } = require('./workout_helpers');

const eq = (a, b, m) => assert.deepEqual(plain(a), b, m);
const entry = (sets, equipment) => ({ sets: sets.map(([kg, reps, rir], i) => ({ n: i + 1, kg, reps, rir: rir === undefined ? null : rir })), equipment: equipment || null });

test('compare: load or reps up at the same or better RIR progresses; the mirror regresses; mixed holds', () => {
  const { Progression: P } = setup();
  const base = entry([[40, 10, 1], [40, 9, 1]]);
  assert.equal(P.compare(base, entry([[42.5, 10, 1], [42.5, 9, 1]])), 'progressed', 'load up, same reps');
  assert.equal(P.compare(base, entry([[40, 10, 1], [40, 10, 1]])), 'progressed', 'reps up on one set');
  assert.equal(P.compare(base, entry([[40, 11, 2], [40, 9, 1]])), 'progressed', 'reps up with more reserve');
  assert.equal(P.compare(base, entry([[40, 11, 0], [40, 9, 1]])), 'held', 'reps up but harder: not progression');
  assert.equal(P.compare(base, entry([[40, 10, 1], [40, 9, 1]])), 'held');
  assert.equal(P.compare(base, entry([[45, 8, 1], [45, 8, 1]])), 'held', 'load up, reps down');
  assert.equal(P.compare(base, entry([[40, 8, 1], [40, 9, 1]])), 'regressed');
  assert.equal(P.compare(base, entry([[40, 8, 3], [40, 9, 1]])), 'held', 'fewer reps with more reserve is not a regression');
  assert.equal(P.compare(base, entry([[42.5, 10, 1], [40, 8, 1]])), 'held', 'one set up, one down');
  assert.equal(P.compare(base, entry([[40, 12, null]])), 'progressed', 'unknown RIR does not block');
  assert.equal(P.compare(base, entry([[50, 10, 1]], 'Máquina')), 'progressed', 'equipment empty on one side counts as same');
  assert.equal(P.compare(entry([[40, 10]], 'Barra'), entry([[20, 10]], 'Halteres')), null, 'different load convention');
  assert.equal(P.compare(null, base), null);
  assert.equal(P.compare(base, entry([])), null);
});

test('weekSummary: concluded sessions, volume by group (work sets only), progressed and regressed exercises', () => {
  const ctx = setup();
  done(ctx, '2026-10-06', 'Upper', [row('Supino inclinado', [40, 10, 1], [40, 9, 1]), row('Puxada aberta', [50, 10, 1], [50, 10, 1])]);
  done(ctx, '2026-10-13', 'Upper', [
    row('Supino inclinado', [42.5, 10, 1], [42.5, 9, 1], { warmupKg: 20, warmupReps: 10 }),
    row('Puxada aberta', [50, 8, 1], [50, 8, 1]),
  ]);
  ctx.Sessions.savePartial('2026-10-15', 'Lower', [row('Leg press', [100, 10, 1])]);
  const w = ctx.Progression.weekSummary('2026-10-12', '2026-10-18');
  eq({ s: w.sessions, p: w.partialSessions, v: w.workVolume, g: w.workVolumeByGroup, up: w.progressedExercises, down: w.regressedExercises, n: w.comparedExercises }, {
    s: 1, p: 1, v: 42.5 * 19 + 800 + 1000, g: { Peito: 807.5, Costas: 800, Quadríceps: 1000 },
    up: ['Supino inclinado'], down: ['Puxada aberta'], n: 2,
  });
  eq(w.sessionList, [{ date: '2026-10-13', session: 'Upper', state: 'Concluído' }, { date: '2026-10-15', session: 'Lower', state: 'Parcial' }]);
  const empty = ctx.Progression.weekSummary('2026-09-28');
  eq([empty.sessions, empty.workVolume, empty.progressedExercises, empty.comparedExercises], [0, null, null, 0], 'nothing measured → null, not 0');
  assert.equal(empty.end, '2026-10-04');
});

test('suggestions: top of the rep range at the same load in N sessions → propose load + increment; regressions → review', () => {
  const ctx = setup();
  done(ctx, '2026-10-06', 'Upper', [row('Supino inclinado', [40, 10, 1], [40, 10, 0]), row('Puxada aberta', [55, 10, 1], [55, 10, 1])]);
  done(ctx, '2026-10-13', 'Upper', [row('Supino inclinado', [40, 10, 0], [40, 10, 1]), row('Puxada aberta', [55, 9, 1], [55, 9, 1])]);
  done(ctx, '2026-10-20', 'Upper', [row('Puxada aberta', [55, 8, 1], [55, 8, 1])]);
  const s = ctx.Progression.suggestions('2026-10-20');
  eq(s.map((x) => [x.exercise, x.kind]), [['Supino inclinado', 'load'], ['Puxada aberta', 'review']]);
  assert.equal(s[0].text, 'Supino inclinado: 2×10 a 0–1 RIR em 2 sessões com 40 kg → sugerir 42,5 kg (+2,5 kg). Aprovar com o revisor antes de mudar.');
  eq([s[0].currentKg, s[0].suggestedKg, s[0].dates], [40, 42.5, ['2026-10-06', '2026-10-13']]);
  assert.match(s[1].text, /Puxada aberta: queda em 2 sessões seguidas/);
  eq(ctx.Progression.suggestions('2026-10-12').map((x) => x.exercise), [], 'only one session by then');
  const cfg = setup({ config: { 'routine.loadIncrementKg': '2', 'analysis.progressionSessions': 1 } });
  done(cfg, '2026-10-13', 'Upper', [row('Supino inclinado', [40, 10, 1], [40, 10, 1])]);
  assert.match(cfg.Progression.suggestions('2026-10-20')[0].text, /em 1 sessão com 40 kg → sugerir 42 kg \(\+2 kg\)/);
  const short = setup();
  done(short, '2026-10-06', 'Upper', [row('Supino inclinado', [40, 10, 1])]);
  done(short, '2026-10-13', 'Upper', [row('Supino inclinado', [40, 10, 1])]);
  eq(short.Progression.suggestions('2026-10-20'), [], 'fewer work sets than prescribed: no suggestion');
});

test('suggestions never modify the plan, the draft, the log or the screen; the action records them once in Revisões', () => {
  const ctx = setup();
  done(ctx, '2026-10-06', 'Upper', [row('Supino inclinado', [40, 10, 1], [40, 10, 0])]);
  done(ctx, '2026-10-13', 'Upper', [row('Supino inclinado', [40, 10, 0], [40, 10, 1])]);
  ctx.PlanDraft.render();
  const tabs = ['Fichas', 'Ficha de treino', 'Registro de treino', 'Diário', 'Objetivos', 'Metas', 'Config'];
  const all = () => snapshot(ctx, tabs.concat(['Revisões', 'Progressão', 'Log']));
  const before = all();
  ctx.Progression.suggestions('2026-10-20');
  ctx.Progression.weekSummary('2026-10-12', '2026-10-18');
  assert.equal(all(), before, 'pure functions write nothing');
  const writes = ctx.screen.writes.length;
  const beforeData = snapshot(ctx, tabs);
  const r = ctx.Actions.run('progressionSuggestions');
  assert.equal(r.ok, true, r.error);
  assert.match(r.result.message, /1 sugestão de progressão \(1 nova\(s\) em Revisões para aprovação\)\. Nada foi alterado na ficha\./);
  assert.equal(snapshot(ctx, tabs), beforeData, 'plan, draft, log, diary, entities and config untouched');
  assert.equal(ctx.screen.writes.length, writes, 'no load pre-filled on Hoje');
  const reviews = ctx.Tabs.read('reviews');
  eq(reviews.map((x) => [x.area, x.status, x.plan, x.recommendation]), [['Treino', 'A revisar', 'F002', 'REVISAR TREINO']]);
  assert.match(reviews[0].change, /sugerir 42,5 kg/);
  ctx.Actions.run('progressionSuggestions');
  assert.equal(ctx.Tabs.read('reviews').length, 1, 'the same pending suggestion is not recorded twice');
  eq(ctx.Plans.get('F002').rows.map((x) => x.repsMax), [10, 10, 10, 10, 10, 10]);
});

test('Progressão tab: one summary row per exercise of the plan in force, plus the picked exercise history', () => {
  const ctx = setup();
  done(ctx, '2026-10-06', 'Upper', [row('Supino inclinado', [40, 10, 1], [40, 9, 1])]);
  done(ctx, '2026-10-13', 'Upper', [row('Supino inclinado', [42.5, 10, 1], [42.5, 9, 0])]);
  done(ctx, '2026-10-14', 'Full Body', [row('Leg press', [100, 10, 1], [100, 10, 1])]);
  const r = ctx.Progression.refreshProgressionTab();
  eq([r.exercise, r.rows, r.history], ['Supino inclinado', 5, 2]);
  const rows = ctx.Tabs.read('progression');
  eq(rows.map((x) => [x.exercise, x.group, x.session, x.trend, x.plan]), [
    ['Supino inclinado', 'Peito', 'Upper', 'Progrediu', 'F002'],
    ['Puxada aberta', 'Costas', 'Upper', 'Sem comparação', 'F002'],
    ['Leg press', 'Quadríceps', 'Lower, Full Body', 'Sem comparação', 'F002'],
    ['Mesa flexora', 'Posteriores', 'Lower', 'Sem comparação', 'F002'],
    ['Elevação lateral', 'Ombros', 'Full Body', 'Sem comparação', 'F002'],
  ]);
  assert.equal(rows[0].lastWork, '42,5 kg × 10 (RIR 1) · 42,5 kg × 9 (RIR 0)');
  assert.equal(rows[0].rir, 0);
  assert.equal(rows[1].lastWork, 'Sem registro');
  const sheet = ctx.__spreadsheet.getSheetByName('Progressão');
  assert.equal(ctx.Progression.pickerCell(), 'L4');
  assert.equal(sheet.getRange('K4').getValue(), 'Exercício');
  assert.equal(sheet.getRange('L4').getValue(), 'Supino inclinado');
  eq(sheet.getRange('K5:V5').getValues()[0], ['Data', 'Treino', 'Versão da ficha', 'W1 kg', 'W1 reps', 'W1 RIR', 'W2 kg', 'W2 reps', 'W2 RIR', 'Volume work', 'Estado', 'Leitura']);
  const h = sheet.getRange('K6:V7').getValues().map((l) => [ctx.Dates.key(l[0])].concat(l.slice(1)));
  eq(h, [
    ['2026-10-13', 'Upper', 'F002', 42.5, 10, 1, 42.5, 9, 0, 807.5, 'Concluído', 'Progrediu'],
    ['2026-10-06', 'Upper', 'F002', 40, 10, 1, 40, 9, 1, 760, 'Concluído', 'Primeiro registro'],
  ]);
  ctx.Progression.refreshProgressionTab('leg press');
  assert.equal(sheet.getRange('K6').getValue() instanceof Date, true);
  assert.equal(sheet.getRange('L6').getValue(), 'Full Body');
  assert.equal(sheet.getRange('K7').getValue(), '', 'the previous history is cleared');
});
