'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bootDaily, cell, setCell, dayRow, plain } = require('./daily_helpers');

const KEYS = ['weightKg', 'sleepH', 'steps', 'hunger', 'foodLog', 'notes', 'objective', 'dayState'];

test('Hoje actions are registered in the Hoje menu and in Ação rápida; onOpen stays the core one', () => {
  const ctx = bootDaily();
  const hoje = ctx.Actions.menu().find((e) => e.label === 'Hoje');
  assert.deepEqual(plain(hoje.items.map((i) => i.label)), ['Carregar dia', 'Salvar dia', 'Salvar parcial do treino', 'Concluir treino', 'Carregar treino', 'Ir para hoje', 'Ir para data', 'Limpar tela']);
  const quick = plain(ctx.Actions.quickList());
  ['Carregar dia', 'Salvar dia', 'Ir para hoje', 'Limpar tela'].forEach((l) => assert.ok(quick.includes(l), l));
  assert.ok(!quick.includes('Ir para data'), 'prompts do not work on mobile');
  ctx.onOpen();
  assert.equal(ctx.__menus[0].name, 'Projeto');
  assert.equal(typeof ctx.onEditInstalled, 'function');
});

test('Ação rápida: choosing Salvar dia saves the screen and the cell goes back to —', () => {
  const ctx = bootDaily();
  setCell(ctx, 'B5', '29/09/2026');
  setCell(ctx, 'B10', '67,8');
  setCell(ctx, 'B13', 0);
  setCell(ctx, 'B20', 'Parcial');
  ctx.__simulateEdit('Hoje', 'B4', 'Salvar dia');
  assert.equal(cell(ctx, 'B4'), '—');
  assert.deepEqual(dayRow(ctx, '2026-09-29', KEYS), {
    weightKg: 67.8, sleepH: null, steps: 0, hunger: null, foodLog: 'Parcial', notes: null, objective: 'O001', dayState: 'Parcial',
  });
  assert.equal(cell(ctx, 'B6'), 'O001 Recomposição corporal · M001 · F002');
  assert.equal(cell(ctx, 'B7'), 'Parcial');
  assert.equal(cell(ctx, 'B10'), 67.8, 'screen reloaded with the stored number');
  assert.match(ctx.__toasts[ctx.__toasts.length - 1].msg, /Dia 29\/09\/2026 salvo \(3 campos alterados\)\. Estado: Parcial\./);
  assert.equal(ctx.ChangeLog.actions()[0].label, 'Salvar dia');
});

test('Salvar dia: an empty cell keeps the stored value, "-" erases it, 0 is saved as zero; undo restores', () => {
  const ctx = bootDaily({ tabs: { diary: [{ date: '2026-09-29', weightKg: 67, sleepH: 7, hunger: 3, notes: 'x' }] } });
  ctx.__simulateEdit('Hoje', 'B5', '29/09/2026');
  assert.deepEqual([cell(ctx, 'B10'), cell(ctx, 'B12'), cell(ctx, 'B17'), cell(ctx, 'B21')], [67, 7, 3, 'x'], 'date change loaded the day');
  setCell(ctx, 'B10', '');
  setCell(ctx, 'B12', '-');
  setCell(ctx, 'B17', 0 + 2);
  setCell(ctx, 'B13', 0);
  setCell(ctx, 'B21', 'limpar');
  const r = ctx.Actions.run('saveDay');
  assert.ok(r.ok, r.error);
  assert.deepEqual(dayRow(ctx, '2026-09-29', KEYS).weightKg, 67, 'empty screen cell did not erase');
  const row = dayRow(ctx, '2026-09-29', KEYS);
  assert.deepEqual([row.sleepH, row.hunger, row.steps, row.notes], [null, 2, 0, null]);
  assert.deepEqual([cell(ctx, 'B10'), cell(ctx, 'B12'), cell(ctx, 'B21')], [67, '', ''], 'screen shows what is stored');
  ctx.Actions.run('undoLast');
  const back = dayRow(ctx, '2026-09-29', KEYS);
  assert.deepEqual([back.sleepH, back.hunger, back.steps, back.notes], [7, 3, null, 'x']);
});

test('Salvar dia reports invalid values as a toast and writes nothing', () => {
  const ctx = bootDaily();
  setCell(ctx, 'B5', '29/09/2026');
  setCell(ctx, 'B17', 9);
  setCell(ctx, 'B10', 70);
  ctx.__simulateEdit('Hoje', 'B4', 'Salvar dia');
  assert.equal(cell(ctx, 'B4'), '—');
  assert.match(ctx.__toasts[ctx.__toasts.length - 1].msg, /Fome 1–5: 9 fora da faixa/);
  assert.equal(ctx.Days.get('2026-09-29'), null);
});

test('changing the date reloads the day; an unknown date shows empty cells, not zeros', () => {
  const ctx = bootDaily({
    tabs: { diary: [{ date: '2026-09-28', weightKg: 67.1, steps: 0, foodLog: 'Completo', kcal: 2380, protein: 140, noCalcItems: 0 }] },
  });
  ctx.__simulateEdit('Hoje', 'B5', '28/09/2026');
  assert.deepEqual([cell(ctx, 'B10'), cell(ctx, 'B13'), cell(ctx, 'B20'), cell(ctx, 'B7')], [67.1, 0, 'Completo', 'Completo']);
  assert.equal(cell(ctx, 'E60'), 'Dentro da meta');
  ctx.__simulateEdit('Hoje', 'B5', '27/09/2026');
  assert.deepEqual([cell(ctx, 'B10'), cell(ctx, 'B13'), cell(ctx, 'B20'), cell(ctx, 'B7')], ['', '', '', 'Sem registro']);
  assert.equal(cell(ctx, 'B6'), 'Sem objetivo · sem meta · F001');
  assert.equal(ctx.ChangeLog.actions().length, 0, 'loading is not an undoable change');
  ctx.__simulateEdit('Hoje', 'B5', 'ontem');
  assert.match(ctx.__toasts[ctx.__toasts.length - 1].msg, /Data inválida em Hoje/);
});

test('hoje.loaded lets Food and Workout fill their cards', () => {
  const ctx = bootDaily();
  const seen = [];
  ctx.Core.on('hoje.loaded', (e) => { seen.push(ctx.Dates.key(e.date)); ctx.Hoje.write('training', { session: 'Upper' }); });
  ctx.__simulateEdit('Hoje', 'B5', '28/09/2026');
  assert.deepEqual(seen, ['2026-09-28']);
  assert.equal(cell(ctx, 'B38'), 'Upper');
});

test('Limpar tela, Ir para hoje and Ir para data (prompt)', () => {
  const ctx = bootDaily({ uiResponses: [{ button: 'OK', text: '28/09/2026' }, { button: 'CANCEL', text: '' }] });
  ctx.Hoje.write('diary', { weightKg: 70 });
  ctx.Hoje.write('food', { meal: 'Jantar' });
  ctx.Hoje.write('training', [{ exercise: 'Remada', work1Kg: 50 }]);
  ctx.__simulateEdit('Hoje', 'B4', 'Limpar tela');
  assert.deepEqual([cell(ctx, 'B10'), cell(ctx, 'B24'), cell(ctx, 'A44'), cell(ctx, 'F44'), cell(ctx, 'B4')], ['', '', '', '', '—']);

  ctx.__simulateEdit('Hoje', 'B4', 'Ir para hoje');
  assert.equal(cell(ctx, 'B5'), '2026-09-29');
  assert.ok(ctx.Actions.run('goToDate').ok);
  assert.equal(cell(ctx, 'B5'), '2026-09-28');
  assert.ok(ctx.Actions.run('goToDate').ok, 'cancel does nothing');
  assert.equal(cell(ctx, 'B5'), '2026-09-28');
  assert.equal(ctx.Actions.run('goToDate', { date: '2026-02-30' }).ok, false);
});

test('Carregar dia with an empty date cell loads today; other Hoje cells do not trigger anything', () => {
  const ctx = bootDaily({ tabs: { diary: [{ date: '2026-09-29', weightKg: 66.9 }] } });
  ctx.__simulateEdit('Hoje', 'B4', 'Carregar dia');
  assert.deepEqual([cell(ctx, 'B5'), cell(ctx, 'B10')], ['2026-09-29', 66.9]);
  ctx.__simulateEdit('Hoje', 'B11', 80);
  assert.equal(ctx.Days.get('2026-09-29').waistCm, null, 'typing is not saving');
  ctx.__simulateEdit('Hoje', 'B4', '—');
  assert.equal(cell(ctx, 'B4'), '—');
});
