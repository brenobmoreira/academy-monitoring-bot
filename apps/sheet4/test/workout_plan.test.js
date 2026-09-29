'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');
const { setup, row, snapshot, plain } = require('./workout_helpers');

const eq = (a, b, m) => assert.deepEqual(plain(a), b, m);
const cell = (ctx, tab, a1) => ctx.__spreadsheet.getSheetByName(tab).getRange(a1).getValue();
const setCell = (ctx, tab, a1, v) => ctx.__spreadsheet.getSheetByName(tab).getRange(a1).setValue(v);

/* Ficha de treino ----------------------------------------------------------------------------- */

test('Ficha de treino shows the plan in force with a status derived from the entity, never typed', () => {
  const ctx = setup();
  const r = ctx.PlanDraft.render();
  eq([r.plan, r.rows], ['F002', 6]);
  assert.equal(cell(ctx, 'Ficha de treino', 'A2'), 'Ficha vigente F002 · Vigente desde 28/09/2026');
  assert.equal(cell(ctx, 'Ficha de treino', 'A4'), 'Início da nova ficha');
  const draft = ctx.Tabs.read('planDraft');
  eq(draft.map((x) => [x.session, x.exercise]).slice(0, 2), [['Upper', 'Supino inclinado'], ['Upper', 'Puxada aberta']]);
  eq([draft[0].planStatus, draft[0].workSetsRegular, draft[0].alternative], ['Confirmado', 2, 'Supino reto']);
  assert.match(draft[0].setTypes, /2 work sets/);
  // A typed review text (3.0 "Revisar novamente") no longer decides the status shown.
  ctx.Tabs.update('planDraft', draft[0]._row, { planStatus: 'Revisar novamente' });
  assert.equal(ctx.PlanDraft.statusText(), 'Ficha vigente F002 · Vigente desde 28/09/2026');
  const noPlan = setup({ tabs: { plans: [] } });
  assert.equal(noPlan.PlanDraft.statusText(), 'Nenhuma ficha vigente');
});

test('Salvar nova ficha: the edited draft becomes F003 from the given date; F002 closes; one undoable action', () => {
  const ctx = setup();
  ctx.PlanDraft.render();
  const before = snapshot(ctx, ['Fichas', 'Revisões', 'Ficha de treino']);
  const draft = ctx.Tabs.read('planDraft');
  ctx.Tabs.update('planDraft', draft[0]._row, { repsMin: 8, repsMax: 12, exercise: 'supino reto', group: null });
  const res = ctx.Actions.run('savePlan', { date: '2026-10-26', reason: 'Nova faixa de reps no supino' });
  assert.equal(res.ok, true, res.error);
  assert.match(res.result.message, /^Ficha F003 salva a partir de 26\/10\/2026; F002 vale até 25\/10\/2026\./);
  const f3 = ctx.Plans.get('F003');
  eq([f3.status, f3.rows.length, f3.rows[0].exercise, f3.rows[0].group, f3.rows[0].repsMax], ['Planejada', 6, 'Supino reto', 'Peito', 12]);
  assert.equal(ctx.Dates.key(ctx.Plans.get('F002').end), '2026-10-25');
  assert.equal(ctx.Plans.on('2026-10-20').id, 'F002');
  assert.equal(cell(ctx, 'Ficha de treino', 'A2'), 'Ficha vigente F002 · Vigente desde 28/09/2026 até 25/10/2026 · próxima F003 a partir de 26/10/2026 (Planejada) — em edição abaixo');
  eq(ctx.Tabs.read('reviews').map((x) => [x.area, x.plan, x.status]), [['Ficha', 'F003', 'Planejado']]);
  assert.equal(ctx.Sessions.load('2026-10-26', 'Upper').rows[0].prescriptionText, '2×8–12 · RIR 0–1 · 150 s · alt.: Supino reto');
  const u = ctx.Undo.last();
  assert.equal(u.action, 'Salvar nova ficha');
  assert.equal(snapshot(ctx, ['Fichas', 'Revisões']), JSON.stringify(JSON.parse(before).slice(0, 2)));
});

test('Salvar nova ficha reads the form cells and rejects an unchanged draft, unknown exercises and bad numbers', () => {
  const ctx = setup();
  ctx.PlanDraft.render();
  const run = (args) => ctx.Actions.run('savePlan', args);
  assert.match(run().error, /Informe o início da nova ficha \(Ficha de treino!B4\)/);
  setCell(ctx, 'Ficha de treino', 'B4', '26/10/2026');
  assert.match(run().error, /Informe o motivo/);
  setCell(ctx, 'Ficha de treino', 'D4', 'Revisão mensal');
  assert.match(run().error, /A Ficha de treino é igual à F002; nada a salvar/);
  const draft = ctx.Tabs.read('planDraft');
  ctx.Tabs.update('planDraft', draft[1]._row, { exercise: 'Puxada aberto' });
  assert.match(run().error, /exercício "Puxada aberto" não está em Exercícios\. Você quis dizer: Puxada aberta\?/);
  ctx.Tabs.update('planDraft', draft[1]._row, { exercise: 'Puxada aberta', repsMin: 12, repsMax: 8 });
  assert.match(run().error, /reps mín\. maior que reps máx\./);
  ctx.Tabs.update('planDraft', draft[1]._row, { repsMin: 8, repsMax: 12, session: 'Push A' });
  const ok = run();
  assert.equal(ok.ok, true, ok.error);
  assert.match(ok.result.message, /Avisos: Sessões fora da rotação da Config: Push A\./);
  assert.equal(cell(ctx, 'Ficha de treino', 'B4'), '', 'form cleared');
  assert.equal(ctx.Plans.get('F003').rows.length, 6);
});

/* Hoje wiring --------------------------------------------------------------------------------- */

test('TrainingScreen on Hoje: load writes session, plan and notes (prescription + reference); complete reads the table', () => {
  const ctx = setup();
  ctx.TrainingScreen.use(null);
  ctx.Hoje.ensure();
  ctx.Sessions.complete('2026-10-13', 'Upper', [row('Supino inclinado', [40, 10, 1], [40, 9, 0])]);
  setCell(ctx, 'Hoje', 'B5', new Date('2026-10-20T00:00:00'));
  const r = ctx.Actions.run('loadWorkout');
  assert.equal(r.ok, true, r.error);
  eq(['B38', 'B39', 'B40', 'B41', 'A44', 'A45', 'F44', 'A46'].map((a) => cell(ctx, 'Hoje', a)), ['Lower', 'Regular', '', 'F002', 'Leg press', 'Mesa flexora', '', '']);
  assert.equal(ctx.__spreadsheet.getSheetByName('Hoje').getRange('A44').getNote(), 'Ficha: 2×6–10 · RIR 0–1 · 150 s');
  setCell(ctx, 'Hoje', 'B38', 'Upper');
  ctx.Actions.run('loadWorkout');
  assert.equal(cell(ctx, 'Hoje', 'A44'), 'Supino inclinado');
  assert.equal(cell(ctx, 'Hoje', 'F44'), '', 'previous load is not pre-filled');
  assert.equal(ctx.__spreadsheet.getSheetByName('Hoje').getRange('A44').getNote(),
    'Ficha: 2×6–10 · RIR 0–1 · 150 s · alt.: Supino reto\nÚltima: 13/10 · Upper: 40 kg × 10 (RIR 1) · 40 kg × 9 (RIR 0)');
  ['F44', 'G44', 'H44', 'I44', 'J44', 'K44'].forEach((a, i) => setCell(ctx, 'Hoje', a, [42.5, 10, 0, 42.5, '9', 1][i]));
  const c = ctx.Actions.run('completeWorkout');
  assert.equal(c.ok, true, c.error);
  const saved = ctx.Tabs.read('workouts').filter((x) => ctx.Dates.key(x.date) === '2026-10-20');
  eq(saved.map((x) => [x.exercise, x.work1Kg, x.work2Reps, x.rir1, x.workVolume, x.sessionState]), [['Supino inclinado', 42.5, 9, 0, 807.5, 'Concluído']]);
  eq(['B40', 'F44'].map((a) => cell(ctx, 'Hoje', a)), ['Concluído', 42.5]);
  assert.match(c.result.message, /Próxima sessão: Lower/);
});

test('hoje.loaded shows the session saved on that date when the training table is empty, never over typed values', () => {
  const ctx = setup();
  ctx.TrainingScreen.use(null);
  ctx.Hoje.ensure();
  ctx.Sessions.savePartial('2026-10-19', 'Lower', [row('Leg press', [100, 10, 1])]);
  ctx.HojeActions.loadDay('2026-10-19');
  eq(['B38', 'B40', 'A44', 'F44'].map((a) => cell(ctx, 'Hoje', a)), ['Lower', 'Parcial', 'Leg press', 100]);
  setCell(ctx, 'Hoje', 'F44', 105);
  ctx.HojeActions.loadDay('2026-10-19');
  assert.equal(cell(ctx, 'Hoje', 'F44'), 105, 'typed value kept');
  ctx.Hoje.clear('training');
  ctx.HojeActions.loadDay('2026-10-20');
  assert.equal(cell(ctx, 'Hoje', 'A44'), '', 'no saved session → nothing loaded');
});

/* 3.0 plan data ------------------------------------------------------------------------------- */

for (const [fixture, rotation, sessions] of [
  ['breno_3_0', 'Upper, Lower, Full Body', 3],
  ['zoio_3_0', 'Push A, Pull A, Legs A, Push B, Pull B, Legs B', 6],
]) {
  test(`3.0 export ${fixture}: the F002 draft validates against the real catalogue and rotation`, () => {
    const ctx = load({ fixture, now: '2026-09-29T15:00:00-03:00' });
    ctx.Tabs.ensure('config');
    ctx.Config.set('routine.sessionRotation', rotation);
    const rows = ctx.Plans.draftRows();
    const check = ctx.PlanDraft.validate(rows, null);
    eq(check.errors, []);
    const s = [];
    rows.forEach((r) => { if (!s.includes(r.session)) s.push(r.session); });
    assert.equal(s.length, sessions);
    assert.ok(rows.every((r) => r.workSetsAdapt === r.workSetsRegular && r.rirAdapt === r.rirRegular), 'F002 has no adaptation difference');
    if (fixture === 'breno_3_0') {
      eq(check.warnings, ['Remada com apoio: alternativa "Máquina disponível; confirmar execução com Luan" não está em Exercícios.']);
    } else {
      eq(check.warnings, []);
    }
  });
}
