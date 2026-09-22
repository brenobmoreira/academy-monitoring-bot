'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');
const { sheets, DIARY_HEADERS, WORKOUT_HEADERS } = require('./fixtures');

const day = (s) => new Date(`${s}T00:00:00`);
const NOW = '2026-09-21T15:00:00-03:00';

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

test('readDiaryArgs maps the yellow cells; unchecked yes/no cells are not statements', () => {
  const ctx = load({ sheets: sheets({ hoje: hojeRows() }) });
  assert.deepEqual(plain(ctx.HojeScreen.readDiaryArgs()), {
    date: '2026-09-21', fields: { weightKg: 82.4, sleepH: 7.5, steps: 8000, muayThai: true, hunger: 3, notes: 'ok' },
  });
});

test('readWorkoutArgs reads session, phase and only rows with sets', () => {
  const ctx = load({ sheets: sheets({ hoje: hojeRows() }) });
  assert.deepEqual(plain(ctx.HojeScreen.readWorkoutArgs()), { date: '2026-09-21', session: 'Upper', phase: 'Adaptação', exercises: [
    { name: 'Supino inclinado', sets: [{ kg: 60, reps: 8 }, { kg: 62, reps: 8 }], rir: 2 },
    { name: 'Leg press', sets: [{ kg: 100, reps: 10 }], pain: 1, note: 'joelho' },
  ] });
});

test('menuSaveDay writes the diary, clears the inputs and alerts the summary', () => {
  const ctx = load({ sheets: sheets({ hoje: hojeRows() }), now: NOW });
  ctx.menuSaveDay();
  const diary = ctx.__spreadsheet.getSheetByName('Diário');
  assert.equal(diary.getRange(6, DIARY_HEADERS.indexOf('Peso kg') + 1).getValue(), 82.4);
  const hoje = ctx.__spreadsheet.getSheetByName('Hoje');
  assert.equal(hoje.getRange('B7').getValue(), '');
  assert.equal(hoje.getRange('E9').getValue(), 'Não');
  assert.equal(ctx.__alerts[0], '21/09 · Peso kg 82,4 · Sono h 7,5 · Passos 8000 · Muay Thai Sim · Fome 3 · Observações ok');
});

test('menuSaveWorkout writes rows, keeps exercise names and clears sets', () => {
  const ctx = load({ sheets: sheets({ hoje: hojeRows() }), now: NOW });
  ctx.menuSaveWorkout();
  const w = ctx.__spreadsheet.getSheetByName('Registro de treino');
  assert.equal(w.getLastRow(), 7);
  assert.equal(w.getRange(7, WORKOUT_HEADERS.indexOf('Exercício') + 1).getValue(), 'Leg press');
  const hoje = ctx.__spreadsheet.getSheetByName('Hoje');
  assert.equal(hoje.getRange('A27').getValue(), 'Supino inclinado');
  assert.equal(hoje.getRange('B27').getValue(), '');
  assert.equal(ctx.__alerts[0], ['21/09 · Upper (Adaptação):', '• Supino inclinado 60×8 62×8 (RIR 2)', '• Leg press 100×10 (dor 1)'].join('\n'));
});

test('validation errors are listed in the alert and nothing is written or cleared', () => {
  const rows = hojeRows(); rows[22] = ['Sessão', '', '', 'Fase', '']; rows[6][1] = '82,4';
  const ctx = load({ sheets: sheets({ hoje: rows }), now: NOW });
  ctx.menuSaveWorkout();
  assert.match(ctx.__alerts[0], /^Não gravei:\n• session: campo obrigatório/);
  ctx.menuSaveDay();
  assert.match(ctx.__alerts[1], /• fields\.weightKg: esperado número/);
  assert.equal(ctx.__spreadsheet.getSheetByName('Hoje').getRange('B7').getValue(), '82,4');
  assert.equal(ctx.__spreadsheet.getSheetByName('Diário').getLastRow(), 5);
});

test('empty blocks are reported without calling the API', () => {
  const empty = load({ sheets: sheets({ hoje: Array.from({ length: 40 }, () => []) }), now: NOW });
  empty.menuSaveDay();
  empty.menuSaveWorkout();
  assert.deepEqual(plain(empty.__alerts), ['Nada preenchido no bloco do dia.', 'Nenhuma série preenchida na tabela de treino.']);
});

test('onOpen registers the three menu items', () => {
  const ctx = load({ sheets: sheets() });
  ctx.onOpen();
  assert.deepEqual(plain(ctx.__menus[0].items.map((i) => i[1])), ['menuSaveDay', 'menuSaveWorkout', 'menuRefreshProgression']);
});
