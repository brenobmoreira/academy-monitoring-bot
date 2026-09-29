'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setup, row, done, snapshot, plain, SET_MODEL } = require('./workout_helpers');

const eq = (a, b, m) => assert.deepEqual(plain(a), b, m);
const key = (ctx, d) => ctx.Dates.key(d);
const logged = (ctx) => ctx.Tabs.read('workouts');
const UPPER = (w1 = [40, 10, 1], w2 = [40, 9, 0]) => [row('Supino inclinado', w1, w2), row('Puxada aberta', [50, 8, 1], [50, 8, 1])];
const LOWER = () => [row('Leg press', [100, 10, 1], [100, 10, 1]), row('Mesa flexora', [30, 10, 1], [30, 9, 1])];
const FULL = () => [row('Leg press', [100, 10, 1], [100, 10, 1]), row('Elevação lateral', [8, 12, 1], [8, 12, 1])];

/* Exercises ---------------------------------------------------------------------------------- */

test('Exercises: catalogue, accent/case-insensitive resolution, unknown names rejected with a suggestion', () => {
  const ctx = setup();
  const E = ctx.Exercises;
  eq(E.names().slice(0, 3), ['Supino inclinado', 'Puxada aberta', 'Leg press']);
  assert.equal(E.resolve('supino INCLINADO', '2026-10-20').name, 'Supino inclinado');
  assert.equal(E.resolve('Elevacao lateral', '2026-10-20').name, 'Elevação lateral');
  assert.throws(() => E.resolve('Supino inclinad', '2026-10-20'), /não está no cadastro.*Você quis dizer: Supino inclinado/);
  assert.throws(() => E.resolve('Zzzz qqq', '2026-10-20'), /Cadastre-o em Exercícios/);
  assert.equal(E.find('Leg Press').loadConvention, 'kg da máquina');
});

/* Rotation ----------------------------------------------------------------------------------- */

test('continuous rotation: advances only on concluded sessions and does not reset on Monday', () => {
  const ctx = setup();
  const S = ctx.Sessions;
  assert.equal(S.nextSession('2026-10-05'), 'Upper', 'no history → first of the rotation');
  done(ctx, '2026-10-05', 'Upper', UPPER());
  assert.equal(S.nextSession('2026-10-06'), 'Lower');
  done(ctx, '2026-10-07', 'Lower', LOWER());
  ctx.Sessions.savePartial('2026-10-09', 'Full Body', [FULL()[0]]);
  assert.equal(S.nextSession('2026-10-09'), 'Full Body', 'a partial session does not advance');
  assert.equal(S.nextSession('2026-10-12'), 'Full Body', 'Monday does not reset a continuous rotation');
  done(ctx, '2026-10-12', 'Full Body', FULL());
  assert.equal(S.nextSession('2026-10-13'), 'Upper', 'wraps around');
  assert.equal(S.nextSession('2026-10-06'), 'Lower', 'history after the date is ignored');
});

test('weekly rotation restarts on Monday; within the week it follows the last concluded session', () => {
  const ctx = setup({ config: { 'routine.rotationMode': 'weekly' } });
  const S = ctx.Sessions;
  done(ctx, '2026-10-05', 'Upper', UPPER());
  done(ctx, '2026-10-07', 'Lower', LOWER());
  assert.equal(S.nextSession('2026-10-09'), 'Full Body');
  ctx.Sessions.savePartial('2026-10-09', 'Full Body', [FULL()[0]]);
  assert.equal(S.nextSession('2026-10-10'), 'Full Body');
  assert.equal(S.nextSession('2026-10-12'), 'Upper', 'new week');
  done(ctx, '2026-10-12', 'Upper', UPPER());
  assert.equal(S.nextSession('2026-10-14'), 'Lower');
  assert.equal(S.nextSession('2026-10-19'), 'Upper');
});

test('a six-session rotation comes from Config; sessions of an older plan are skipped when looking back', () => {
  const ctx = setup({ config: { 'routine.sessionRotation': 'Push A, Pull A, Legs A, Push B, Pull B, Legs B' } });
  const S = ctx.Sessions;
  eq(S.rotation('2026-10-20'), ['Push A', 'Pull A', 'Legs A', 'Push B', 'Pull B', 'Legs B']);
  assert.equal(S.nextSession('2026-10-20'), 'Push A');
  // Log a concluded "Legs B" and then an off-rotation session: the rotation continues after Legs B.
  ctx.Tabs.appendMany('workouts', [
    { date: '2026-10-16', session: 'Legs B', exercise: 'Leg press', work1Kg: 100, work1Reps: 10, sessionState: 'Concluído' },
    { date: '2026-10-17', session: 'Upper', exercise: 'Supino inclinado', work1Kg: 40, work1Reps: 10, sessionState: 'Concluído' },
  ]);
  assert.equal(S.nextSession('2026-10-20'), 'Push A');
  const noRotation = setup({ config: { 'routine.sessionRotation': '' } });
  eq(noRotation.Sessions.rotation('2026-10-20'), ['Upper', 'Lower', 'Full Body'], 'falls back to the plan order');
  eq(noRotation.Sessions.names('2026-10-20'), ['Upper', 'Lower', 'Full Body']);
});

/* Load / resume / save ----------------------------------------------------------------------- */

test('load: plan rows of the plan in force, previous work sets as reference only (never pre-filled)', () => {
  const ctx = setup();
  done(ctx, '2026-10-05', 'Upper', [row('Supino inclinado', [40, 10, 1], [40, 9, 0], { warmupKg: 20, warmupReps: 10, feederKg: 30, feederReps: 6 })]);
  const v = ctx.Sessions.load('2026-10-08', 'upper');
  assert.equal(v.session, 'Upper');
  assert.equal(v.plan, 'F002');
  assert.equal(v.objective, 'O001');
  assert.equal(v.phase, 'Regular');
  assert.equal(v.state, null);
  assert.equal(v.resumed, false);
  eq(v.rows.map((r) => r.exercise), ['Supino inclinado', 'Puxada aberta']);
  const sup = v.rows[0];
  assert.equal(sup.prescriptionText, '2×6–10 · RIR 0–1 · 150 s · alt.: Supino reto');
  assert.equal(sup.referenceText, '05/10 · Upper: 40 kg × 10 (RIR 1) · 40 kg × 9 (RIR 0)');
  eq(sup.reference.sets.map((s) => [s.kg, s.reps, s.rir]), [[40, 10, 1], [40, 9, 0]]);
  assert.ok(Object.values(plain(sup.values)).every((x) => x === null), 'work cells are not pre-filled');
  assert.equal(sup.group, 'Peito');
  assert.equal(v.rows[1].reference, null);
  const screen = ctx.Sessions.screenView(v);
  assert.equal(screen.rows[0].work1Kg, null);
  assert.match(screen.rows[0].reference, /40 kg × 10/);
  assert.equal(screen.header, 'Upper · ficha F002 · Regular');
  assert.throws(() => ctx.Sessions.load('2026-10-08', 'Push A'), /Sessão "Push A" não existe/);
  assert.throws(() => ctx.Sessions.load('2026-09-01', 'Upper'), /Nenhuma ficha vigente em 01\/09\/2026/);
});

test('adaptation phase comes from Config weeks since the plan start and picks the adaptation columns', () => {
  const ctx = setup({ config: { 'routine.adaptationWeeks': 2 } });
  const early = ctx.Sessions.load('2026-10-11', 'Upper');
  assert.equal(early.phase, 'Adaptação');
  assert.equal(early.rows[0].prescriptionText, '1×6–10 · RIR 0–3 · 150 s · alt.: Supino reto');
  assert.equal(ctx.Sessions.load('2026-10-12', 'Upper').phase, 'Regular');
  const r = ctx.Sessions.savePartial('2026-10-11', 'Upper', [row('Supino inclinado', [40, 10, 2])]);
  assert.equal(r.phase, 'Adaptação');
  assert.equal(logged(ctx)[0].workSetsPrescribed, 1);
  const declared = ctx.Sessions.savePartial('2026-10-12', 'Upper', [row('Supino inclinado', [40, 10, 2])], { phase: 'Adaptação' });
  assert.equal(declared.phase, 'Adaptação', 'a phase declared on the screen wins');
  assert.throws(() => ctx.Sessions.savePartial('2026-10-12', 'Upper', [row('Supino inclinado', [40, 10, 2])], { phase: 'Deload' }), /Fase inválida/);
});

test('resume: a partial session comes back on load; saving again upserts by date+session+exercise', () => {
  const ctx = setup();
  const r1 = ctx.Sessions.savePartial('2026-10-20', 'Upper', [row('Supino inclinado', [40, 10, 1]), row('', null, null)]);
  assert.equal(r1.state, 'Parcial');
  assert.match(r1.message, /parcial/);
  assert.equal(ctx.Days.get('2026-10-20'), null, 'no concluded session → Diário untouched');
  const v = ctx.Sessions.load('2026-10-20');
  assert.equal(v.session, 'Upper', 'the partial session of the date wins over the rotation');
  assert.equal(v.resumed, true);
  assert.equal(v.state, 'Parcial');
  assert.equal(v.rows[0].values.work1Kg, 40);
  assert.equal(v.rows[0].values.work2Kg, null);
  assert.equal(v.rows[1].values.work1Kg, null);
  assert.equal(ctx.Sessions.nextSession('2026-10-20'), 'Upper');
  ctx.Sessions.savePartial('2026-10-20', 'Upper', [row('Supino inclinado', [40, 10, 1], [40, 9, 0]), row('Puxada aberta', [50, 8, 1])]);
  const rows = logged(ctx);
  assert.equal(rows.length, 2, 'no duplicate rows');
  eq(rows.map((r) => [r.exercise, r.workSetsDone, r.workVolume, r.sessionState]), [
    ['Supino inclinado', 2, 760, 'Parcial'], ['Puxada aberta', 1, 400, 'Parcial'],
  ]);
});

test('complete: every row concluded with plan, objective, phase, prescription and set model; Diário counts sessions', () => {
  const ctx = setup();
  ctx.Sessions.savePartial('2026-10-19', 'Upper', [row('Supino inclinado', [40, 10, 1])]);
  const r = ctx.Sessions.complete('2026-10-19', 'Upper', [row('Puxada aberta', [50, 8, 1], [50, 8, 0])]);
  assert.equal(r.state, 'Concluído');
  assert.equal(r.next, 'Lower');
  assert.match(r.message, /Treino concluído\. Upper em 19\/10\/2026: 1 exercício, 3 work sets, volume work 1200 kg\. Próxima sessão: Lower\./);
  const rows = logged(ctx);
  assert.ok(rows.every((x) => x.sessionState === 'Concluído'), 'the row saved as partial is concluded too');
  const p = rows[1];
  eq({ plan: p.plan, objective: p.objective, phase: p.phase, presc: p.workSetsPrescribed, min: p.repsMin, max: p.repsMax, model: p.setModel, id: p.sessionId },
    { plan: 'F002', objective: 'O001', phase: 'Regular', presc: 2, min: 6, max: 10, model: SET_MODEL, id: '2026-10-19/Upper' });
  assert.equal(ctx.Days.get('2026-10-19').sessions, 1);
  assert.equal(ctx.Days.get('2026-10-19').plan, 'F002');
  done(ctx, '2026-10-19', 'Lower', LOWER());
  assert.equal(ctx.Days.get('2026-10-19').sessions, 2);
  const again = ctx.Sessions.savePartial('2026-10-19', 'Upper', [row('Puxada aberta', [52.5, 8, 1])]);
  assert.equal(again.state, 'Concluído', 'a concluded session is never downgraded to partial');
  assert.match(again.message, /já concluída/);
  assert.equal(ctx.Days.get('2026-10-19').sessions, 2);
  assert.throws(() => ctx.Sessions.complete('2026-10-21', 'Upper', UPPER()), /data futura/);
  assert.throws(() => ctx.Sessions.complete('2026-10-18', 'Upper', []), /Nada para salvar/);
});

test('only Work 1 + Work 2 count in volume; warm-up and feeder are stored apart', () => {
  const ctx = setup();
  done(ctx, '2026-10-19', 'Upper', [row('Supino inclinado', [40, 10, 1], [40, 8, 0], { warmupKg: 20, warmupReps: 15, feederKg: 30, feederReps: 6 })]);
  const r = logged(ctx)[0];
  eq([r.warmupKg, r.warmupReps, r.feederKg, r.feederReps, r.workSetsDone, r.workVolume], [20, 15, 30, 6, 2, 720]);
  ctx.Sessions.savePartial('2026-10-20', 'Lower', [row('Leg press', null, null, { warmupKg: 60, warmupReps: 10 })]);
  const only = logged(ctx)[1];
  eq([only.workSetsDone, only.workVolume], [0, null], 'no work set → volume not informed, not 0');
  const w = ctx.Progression.weekSummary('2026-10-19', '2026-10-25');
  eq(w.workVolumeByGroup, { Peito: 720 });
  assert.equal(w.workVolume, 720);
  assert.equal(w.workSets, 2);
  eq(ctx.Progression.history('Leg press'), []);
});

test('validation: RIR 0 is valid; bad numbers, missing pairs, unknown exercise and session are rejected and nothing is written', () => {
  const ctx = setup();
  ctx.Sessions.savePartial('2026-10-20', 'Upper', [row('Supino inclinado', [40, 10, 0], [40, 8, '0'], { pain: 0 })]);
  const r = logged(ctx)[0];
  eq([r.rir1, r.rir2, r.pain], [0, 0, 0]);
  const before = snapshot(ctx, ['Registro de treino', 'Diário', 'Log']);
  const bad = (rows, re, session) => assert.throws(() => ctx.Sessions.complete('2026-10-20', session || 'Upper', rows), re);
  bad([row('Supino inclinado', [40, 8.5, 1])], /reps de work 1 devem ser um número inteiro/);
  bad([row('Supino inclinado', [-5, 8, 1])], /kg de work 1 deve ser um número ≥ 0/);
  bad([row('Supino inclinado', null, null, { work1Kg: 40 })], /informe kg e reps de work 1/);
  bad([row('Supino inclinado', null, null, { rir1: 1 })], /RIR de work 1 sem a série/);
  bad([row('Supino inclinado', [40, 8, 11])], /RIR de work 1 deve estar entre 0 e 10/);
  bad([row('Supino inclinado', [40, 8, 1], null, { pain: 12 })], /dor deve ser um inteiro de 0 a 10/);
  bad([row('Supino inclinad', [40, 8, 1])], /Você quis dizer: Supino inclinado/);
  bad([row('', [40, 8, 1])], /Linha 1: informe o exercício/);
  bad([row('Supino inclinado', [40, 8, 1]), row('supino inclinado', [40, 8, 1])], /aparece em mais de uma linha/);
  bad(UPPER(), /Sessão "Uper" não existe.*Você quis dizer: Upper/, 'Uper');
  assert.equal(snapshot(ctx, ['Registro de treino', 'Diário', 'Log']), before);
  const ok = ctx.Sessions.savePartial('2026-10-20', 'Upper', [row('Puxada aberta', ['50,5', '8', '1'])]);
  assert.equal(ok.workVolume, 1124, 'session total: 40×10 + 40×8 saved before + 50,5×8');
  assert.equal(logged(ctx)[1].work1Kg, 50.5, 'comma decimals accepted');
});

test('a historical session keeps its plan id after a new plan is opened', () => {
  const ctx = setup();
  done(ctx, '2026-10-05', 'Upper', UPPER());
  ctx.Transition.newPlan({ date: '2026-10-20', reason: 'Troca de exercícios', plan: [
    { session: 'Upper', exercise: 'Supino reto', group: 'Peito', workSetsRegular: 3, repsMin: 8, repsMax: 12 },
    { session: 'Lower', exercise: 'Leg press', group: 'Quadríceps', workSetsRegular: 3, repsMin: 8, repsMax: 12 },
  ] });
  assert.equal(logged(ctx)[0].plan, 'F002');
  const old = ctx.Sessions.load('2026-10-05');
  assert.equal(old.plan, 'F002');
  assert.equal(old.state, 'Concluído');
  eq(old.rows.map((r) => r.exercise), ['Supino inclinado', 'Puxada aberta']);
  const now = ctx.Sessions.load('2026-10-20', 'Upper');
  assert.equal(now.plan, 'F003');
  eq(now.rows.map((r) => [r.exercise, r.prescriptionText]), [['Supino reto', '3×8–12']]);
  done(ctx, '2026-10-20', 'Upper', [row('Supino reto', [50, 12, 1])]);
  eq(logged(ctx).map((r) => r.plan), ['F002', 'F002', 'F003']);
});

test('undo of Concluir treino restores the partial rows and the Diário, and removes appended rows', () => {
  const ctx = setup();
  ctx.Sessions.savePartial('2026-10-20', 'Upper', [row('Supino inclinado', [40, 10, 1])]);
  const before = snapshot(ctx, ['Registro de treino', 'Diário']);
  ctx.screen.state = { date: new Date('2026-10-20T00:00:00'), session: 'Upper', state: 'Parcial', rows: UPPER() };
  const res = ctx.Actions.run('completeWorkout');
  assert.equal(res.ok, true, res.error);
  assert.equal(logged(ctx).length, 2);
  assert.equal(ctx.Days.get('2026-10-20').sessions, 1);
  assert.equal(ctx.screen.state.state, 'Concluído', 'the screen shows the saved session');
  const u = ctx.Undo.last();
  assert.equal(u.action, 'Concluir treino');
  assert.equal(snapshot(ctx, ['Registro de treino', 'Diário']), before);
  assert.equal(logged(ctx)[0].sessionState, 'Parcial');
});

/* Actions and screen -------------------------------------------------------------------------- */

test('Carregar treino: rotation picks the session, the screen gets references but empty work cells; a concluded screen moves on', () => {
  const ctx = setup();
  done(ctx, '2026-10-19', 'Upper', UPPER());
  ctx.screen.state = { date: new Date('2026-10-20T00:00:00'), session: null, rows: [] };
  let r = ctx.Actions.run('loadWorkout');
  assert.equal(r.ok, true, r.error);
  const w = ctx.screen.writes[ctx.screen.writes.length - 1];
  assert.equal(w.session, 'Lower');
  eq(w.rows.map((x) => [x.exercise, x.work1Kg, x.work2Kg]), [['Leg press', null, null], ['Mesa flexora', null, null]]);
  assert.match(r.result.message, /Lower carregado \(ficha F002, Regular\): cargas anteriores só como referência/);
  ctx.screen.state = { date: new Date('2026-10-19T00:00:00'), session: 'Upper', state: 'Concluído', rows: [] };
  r = ctx.Actions.run('loadWorkout');
  assert.equal(ctx.screen.state.session, 'Upper', 'the date has a saved session: resume shows it');
  ctx.screen.state = { date: new Date('2026-10-20T00:00:00'), session: 'Upper', state: 'Concluído', rows: [] };
  ctx.Actions.run('loadWorkout');
  assert.equal(ctx.screen.state.session, 'Lower', 'a concluded session on the screen is not reloaded');
  const quick = plain(ctx.Actions.quickList());
  ['Salvar parcial do treino', 'Concluir treino', 'Carregar treino'].forEach((l) => assert.ok(quick.includes(l), l));
  const menu = plain(ctx.Actions.menu());
  eq(menu.find((m) => m.label === 'Fase e metas').items.map((i) => i.label).filter((l) => /ficha/.test(l)), ['Salvar nova ficha', 'Mostrar ficha vigente']);
  assert.ok(menu.find((m) => m.label === 'Análise').items.some((i) => i.label === 'Sugestões de progressão'));
});

test('Salvar parcial do treino from the screen, then Carregar treino on the same date resumes it', () => {
  const ctx = setup();
  ctx.screen.state = { date: new Date('2026-10-20T00:00:00'), session: 'Lower', rows: [row('Leg press', [100, 10, 1])] };
  const r = ctx.Actions.run('saveWorkoutPartial');
  assert.equal(r.ok, true, r.error);
  ctx.screen.state = { date: new Date('2026-10-20T00:00:00'), session: null, rows: [] };
  ctx.Actions.run('loadWorkout');
  assert.equal(ctx.screen.state.session, 'Lower');
  assert.equal(ctx.screen.state.state, 'Parcial');
  assert.equal(ctx.screen.state.rows[0].work1Kg, 100);
  const err = ctx.Actions.run('completeWorkout', { date: '2026-10-20', session: 'Lower', rows: [row('Leg pres', [1, 1, 1])] });
  assert.equal(err.ok, false);
  assert.match(err.error, /Você quis dizer: Leg press/);
});
