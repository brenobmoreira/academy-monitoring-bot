'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');
const { sheets, DIARY_HEADERS, WORKOUT_HEADERS } = require('./fixtures');

const day = (s) => new Date(`${s}T00:00:00`);

function hojeRows() {
  const rows = Array.from({ length: 40 }, () => []);
  rows[4] = ['Data', day('2026-09-21'), '', 'Status', 'Pronto'];
  rows[6] = ['Peso kg', 82.4, '', 'Sono h', 7.5, '', 'Passos', 8000, '', 'Cardio min', ''];
  rows[8] = ['Dieta completa?', 'Não', '', 'Muay Thai?', 'Sim', '', 'Cintura cm', '', '', 'Fome 1–5', 3];
  rows[10] = ['Cansaço 1–5', '', '', 'Observações', 'ok'];
  rows[22] = ['Sessão', 'Upper', '', 'Fase', 'Adaptação'];
  rows[25] = ['Exercício', 'kg 1', 'reps 1', 'kg 2', 'reps 2', 'kg 3', 'reps 3', 'kg 4', 'reps 4', 'RIR', 'Dor 0–10', 'Observação'];
  rows[26] = ['Supino inclinado', 60, 8, 62, 8, '', '', '', '', 2, '', ''];
  rows[27] = ['Puxada aberta', '', '', '', '', '', '', '', '', '', '', ''];
  rows[28] = ['Leg press', 100, 10, '', '', '', '', '', '', '', 1, 'joelho'];
  return rows;
}

test('readDiary maps the yellow cells; unchecked yes/no cells are not statements', () => {
  const ctx = load({ sheets: sheets({ hoje: hojeRows() }) });
  const e = ctx.HojeScreen.readDiary();
  assert.equal(e.date.getTime(), day('2026-09-21').getTime());
  assert.deepEqual(plain(e.diary), { weightKg: 82.4, sleepH: 7.5, steps: 8000, muayThai: true, hunger: 3, notes: 'ok' });
});

test('readWorkout reads session, phase and only rows with sets', () => {
  const ctx = load({ sheets: sheets({ hoje: hojeRows() }) });
  const e = ctx.HojeScreen.readWorkout();
  assert.deepEqual(plain(e.workout), { session: 'Upper', phase: 'Adaptação', exercises: [
    { name: 'Supino inclinado', sets: [{ kg: 60, reps: 8 }, { kg: 62, reps: 8 }], rir: 2 },
    { name: 'Leg press', sets: [{ kg: 100, reps: 10 }], pain: 1, note: 'joelho' },
  ] });
});

test('menuSaveDay writes the diary, clears the inputs and alerts the confirmation', () => {
  const ctx = load({ sheets: sheets({ hoje: hojeRows() }) });
  ctx.menuSaveDay();
  const diary = ctx.__spreadsheet.getSheetByName('Diário');
  assert.equal(diary.getRange(6, DIARY_HEADERS.indexOf('Peso kg') + 1).getValue(), 82.4);
  const hoje = ctx.__spreadsheet.getSheetByName('Hoje');
  assert.equal(hoje.getRange('B7').getValue(), '');
  assert.equal(hoje.getRange('E9').getValue(), 'Não');
  assert.match(ctx.__alerts[0], /21\/09 · Peso kg 82,4/);
});

test('menuSaveWorkout writes rows, keeps exercise names and clears sets', () => {
  const ctx = load({ sheets: sheets({ hoje: hojeRows() }) });
  ctx.menuSaveWorkout();
  const w = ctx.__spreadsheet.getSheetByName('Registro de treino');
  assert.equal(w.getLastRow(), 7);
  assert.equal(w.getRange(7, WORKOUT_HEADERS.indexOf('Exercício') + 1).getValue(), 'Leg press');
  const hoje = ctx.__spreadsheet.getSheetByName('Hoje');
  assert.equal(hoje.getRange('A27').getValue(), 'Supino inclinado');
  assert.equal(hoje.getRange('B27').getValue(), '');
  assert.match(ctx.__alerts[0], /Upper \(Adaptação\)/);
});

test('menu actions surface errors as alerts and require a session when sets exist', () => {
  const rows = hojeRows(); rows[22] = ['Sessão', '', '', 'Fase', ''];
  const ctx = load({ sheets: sheets({ hoje: rows }) });
  ctx.menuSaveWorkout();
  assert.match(ctx.__alerts[0], /Selecione a Sessão/);
  const empty = load({ sheets: sheets({ hoje: Array.from({ length: 40 }, () => []) }) });
  empty.menuSaveDay();
  assert.equal(empty.__alerts[0], 'Nada preenchido no bloco do dia.');
});

test('onOpen registers the three menu items', () => {
  const ctx = load({ sheets: sheets() });
  ctx.onOpen();
  assert.deepEqual(plain(ctx.__menus[0].items.map((i) => i[1])), ['menuSaveDay', 'menuSaveWorkout', 'menuRefreshProgression']);
});
