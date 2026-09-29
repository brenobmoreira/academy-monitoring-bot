'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');
const { boot, day, NOW, sheet, plain } = require('./core_helpers');

const eq = (a, b, m) => assert.deepEqual(plain(a), b, m);

const TAB_NAMES = {
  1: ['Hoje', 'Painel', 'Progressão', 'Dieta base', 'Ficha de treino', 'Medidas e fotos'],
  2: ['Semanas', 'Evolução', 'Alimentação', 'Registro de treino', 'Diário', 'Revisões', 'Objetivos', 'Metas', 'Fichas'],
  3: ['Config', 'Alimentos', 'Favoritas', 'Ingredientes', 'Equivalências', 'Exercícios', 'Guia', 'Auditoria', 'Log'],
};

test('the registry covers every tab of spec §3 in its layer', () => {
  const T = load({ now: NOW }).Tabs;
  [1, 2, 3].forEach((n) => eq(T.layer(n).map((id) => T.get(id).name), TAB_NAMES[n]));
  assert.equal(T.ids().length, 24);
  T.ids().forEach((id) => {
    const s = T.get(id);
    if (s.kind === 'layout') { eq(s.columns, []); return; }
    assert.equal(s.headerRow, 5);
    assert.equal(s.firstDataRow, 6);
    assert.ok(s.title && s.help, `${id} has title and help`);
    const keys = new Set();
    const headers = new Set();
    s.columns.forEach((c) => {
      assert.ok(!keys.has(c.key), `${id}.${c.key} unique`);
      assert.ok(!headers.has(c.header), `${id} header ${c.header} unique`);
      keys.add(c.key); headers.add(c.header);
      assert.ok(['date', 'datetime', 'number', 'integer', 'text', 'enum', 'bool', 'id'].includes(c.type), `${id}.${c.key} type`);
      assert.ok(['input', 'calc', 'id'].includes(c.role), `${id}.${c.key} role`);
      if (c.type === 'enum') assert.ok(Array.isArray(c.enum) && c.enum.length, `${id}.${c.key} enum list`);
    });
  });
});

test('4.0 headers of the entity, daily and log tabs follow spec §3.1/§3.3', () => {
  const T = load({ now: NOW }).Tabs;
  eq(T.headers('objectives'), ['ID', 'Objetivo', 'Tipo de análise', 'Início', 'Fim', 'Status', 'Peso inicial kg',
    'Cintura inicial cm', 'Motivo da mudança', 'Expectativa principal', 'Variação de peso alvo %/sem mín',
    'Variação de peso alvo %/sem máx', 'kcal iniciais', 'Proteína g', 'Gordura g', 'Carboidrato g', 'Treinos/sem',
    'Cardio/sem', 'Atividades/sem', 'Meta ligada', 'Ficha ligada', 'Revisor', 'Observações']);
  eq(T.headers('goals'), ['ID', 'Objetivo', 'Início', 'Fim', 'Status', 'kcal', 'Proteína g', 'Proteína mín',
    'Proteína máx', 'Gordura g', 'Carboidrato g', 'Fibra g', 'Tolerância kcal', 'Tolerância gordura', 'Treinos/sem',
    'Cardio/sem', 'Atividades/sem', 'Passos/dia', 'TMB kcal', 'Método TMB', 'Fator de atividade', 'Gasto estimado kcal',
    'Motivo', 'Revisor']);
  eq(T.headers('diary'), ['Data', 'Peso kg', 'Cintura cm', 'Sono h', 'Passos', 'Cardio min', 'Atividade min',
    'Atividade', 'Fome 1–5', 'Cansaço 1–5', 'Dor 0–10', 'Registro alimentar', 'Observações', 'Objetivo', 'Meta', 'Ficha',
    'kcal', 'Proteína g', 'Carboidrato g', 'Gordura g', 'Fibra g', 'Itens sem cálculo', 'Itens estimados', 'Treinos',
    'Estado do dia']);
  eq(T.headers('reviews'), ['Data', 'Área', 'Observação / motivo', 'Alteração', 'Revisor', 'Status',
    'Próxima revisão', 'Resultado', 'Objetivo', 'Meta', 'Ficha', 'Recomendação']);
  eq(T.headers('log'), ['Quando', 'ID ação', 'Ação', 'Aba', 'Linha', 'Tipo', 'Antes (JSON)', 'Depois (JSON)', 'Desfeito']);
});

test('3.0 tabs keep their exact headers plus the 4.0 additions', () => {
  const T = load({ now: NOW }).Tabs;
  const food30 = ['Data', 'Refeição', 'Alimento', 'Quantidade', 'Unidade', 'kcal', 'Proteína g', 'Carboidrato g', 'Gordura g',
    'Fibra g', 'Medição', 'Observação', 'Conferência', 'ID lançamento', 'Favorita / versão'];
  eq(T.headers('food'), food30.concat(['Fonte', 'Cálculo']));
  const workout30 = ['Data', 'Sessão', 'Exercício', 'Equipamento / carga', 'Aquecimento kg', 'Aquecimento reps', 'Feeder kg',
    'Feeder reps', 'Work 1 kg', 'Work 1 reps', 'Work 2 kg', 'Work 2 reps', 'Work sets realizadas', 'Volume work kg×reps',
    'RIR work 2', 'Dor 0–10', 'Observação', 'Ficha', 'Work sets prescritas', 'Reps work mín', 'Reps work máx', 'Fase',
    'ID sessão', 'RIR work 1', 'Estado sessão', 'Modelo de séries'];
  eq(T.headers('workouts'), workout30.concat(['Objetivo']));
  const plans30 = ['Versão', 'Vigência', 'Sessão', 'Exercício', 'Grupo', 'Work sets adaptação', 'Work sets regular',
    'Reps work mín', 'Reps work máx', 'RIR work adaptação', 'RIR work regular', 'Descanso s', 'Alternativa', 'Revisão', 'Observações'];
  eq(T.headers('plans'), plans30.concat(['Início', 'Fim', 'Status']));
  assert.equal(T.headers('measures').length, 11);
  assert.equal(T.headers('foods').length, 15);
  eq(T.byName('Histórico de metas').id, 'goals');
  eq(T.byName('Macros e perfil').id, 'config');
  assert.equal(T.byName('Nada'), null);
});

test('enum lists live on Tabs.ENUMS', () => {
  const E = load({ now: NOW }).Tabs.ENUMS;
  eq(plain(E.FOOD_LOG), ['Não informado', 'Parcial', 'Completo']);
  eq(plain(E.FOOD_CALC), ['Calculado', 'Estimado', 'Sem cálculo']);
  eq(plain(E.FOOD_SOURCE), ['Rótulo confirmado', 'TACO/fonte confiável', 'Estimativa', 'Pendente']);
  eq(plain(E.SESSION_STATE), ['Parcial', 'Concluído']);
  assert.equal(E.ANALYSIS_TYPES.length, 9);
  eq(plain(E.OBJECTIVE_STATUS), ['Vigente', 'Encerrado', 'Planejado']);
});

test('read maps by header text regardless of column order, empty is null, technical dates are null', () => {
  const ctx = load({
    now: NOW,
    sheets: [{
      name: 'Diário',
      rows: [[], ['Resumo'], [], [], ['Peso kg', 'Extra', 'Data', 'Registro alimentar', 'Passos'],
        [67.2, 'x', day('2026-09-28'), 'Parcial', 0],
        [],
        ['', '', new Date('1900-01-01T00:00:00'), '', 8000],
        ['', '', '28/09/2026', '', '']],
    }],
  });
  const rows = plain(ctx.Tabs.read('diary'));
  assert.equal(rows.length, 3, 'empty row 7 skipped');
  assert.equal(rows[0]._row, 6);
  assert.equal(rows[0].weightKg, 67.2);
  assert.equal(rows[0].steps, 0, 'zero stays zero');
  assert.equal(rows[0].sleepH, null, 'missing column reads as null');
  assert.equal(rows[0].foodLog, 'Parcial');
  assert.equal(rows[1].date, null, '1900 is missing');
  assert.equal(rows[1].weightKg, null);
  assert.equal(ctx.Dates.key(ctx.Tabs.read('diary')[2].date), '2026-09-28', 'text date parsed');
  eq(plain(ctx.Tabs.missingColumns('diary')).includes('sleepH'), true);
  assert.equal(ctx.Tabs.findByDate('diary', '2026-09-28').length, 2);
  assert.equal(ctx.Tabs.findBy('diary', 'steps', 8000)._row, 8);
});

test('aliases read 3.0 headers before migration renames them', () => {
  const ctx = load({
    now: NOW,
    sheets: [{ name: 'Metas', rows: [[], [], [], [], ['Vigência', 'Versão', 'kcal', 'Treinos semana'], [day('2026-09-28'), 'M001', 2400, 3]] }],
  });
  const [m] = ctx.Tabs.read('goals');
  assert.equal(m.id, 'M001');
  assert.equal(ctx.Dates.key(m.start), '2026-09-28');
  assert.equal(m.strengthPerWeek, 3);
});

test('append writes by header, after the last row, and refuses unknown keys, bad enums and technical dates', () => {
  const ctx = boot({ tabs: { diary: [{ date: '2026-09-27', weightKg: 67 }] } });
  const row = ctx.Tabs.append('diary', { date: '28/09/2026', weightKg: 66.8, foodLog: 'Completo', steps: 0 });
  assert.equal(row, 7);
  const r = ctx.Tabs.readRow('diary', 7);
  assert.equal(ctx.Dates.key(r.date), '2026-09-28');
  assert.equal(r.steps, 0);
  assert.equal(r.sleepH, null);
  assert.throws(() => ctx.Tabs.append('diary', { date: '2026-09-29', bogus: 1 }), /Unknown column diary.bogus/);
  assert.throws(() => ctx.Tabs.append('diary', { date: '2026-09-29', foodLog: 'Sim' }), /Valor inválido para "Registro alimentar"/);
  assert.throws(() => ctx.Tabs.append('diary', { date: new Date('1900-01-01T00:00:00') }), /Data inválida/);
  assert.equal(ctx.Tabs.read('diary').length, 2);
});

test('append refuses a non-empty value for a column the sheet lacks', () => {
  const ctx = load({ now: NOW, sheets: [{ name: 'Diário', rows: [[], [], [], [], ['Data', 'Peso kg']] }] });
  assert.throws(() => ctx.Tabs.append('diary', { date: '2026-09-28', sleepH: 7 }), /Coluna "Sono h" não encontrada/);
  assert.equal(ctx.Tabs.append('diary', { date: '2026-09-28', sleepH: null, weightKg: 70 }), 6);
});

test('update writes only the given keys and leaves formulas in other columns alone', () => {
  const ctx = boot({ tabs: { diary: [{ date: '2026-09-28', weightKg: 67, notes: 'a' }] } });
  const s = sheet(ctx, 'Diário');
  const kcalCol = ctx.Tabs.headerMap('diary').kcal;
  s.setCell_(6, kcalCol, '=SUM(1,2)');
  ctx.Tabs.update('diary', 6, { weightKg: 66.5, notes: null });
  const r = ctx.Tabs.readRow('diary', 6);
  assert.equal(r.weightKg, 66.5);
  assert.equal(r.notes, null);
  assert.equal(s.cell_(6, kcalCol), '=SUM(1,2)');
  assert.throws(() => ctx.Tabs.update('diary', 5, { weightKg: 1 }), /above the data/);
});

test('remove deletes the row; ensure creates a bare tab with title, help and header', () => {
  const ctx = boot({ tabs: { exercises: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] } });
  ctx.Tabs.remove('exercises', 7);
  eq(ctx.Tabs.read('exercises').map((r) => r.name), ['A', 'C']);
  const s = ctx.Tabs.ensure('audit');
  assert.equal(s.cell_(2, 1), 'Auditoria');
  assert.equal(s.cell_(5, 1), 'Quando');
  assert.equal(ctx.Tabs.ensure('audit'), s, 'idempotent');
});

test('a missing tab gives a Portuguese message', () => {
  const ctx = load({ now: NOW });
  assert.throws(() => ctx.Tabs.read('diary'), /Aba "Diário" não encontrada/);
  assert.equal(ctx.Tabs.findSheet('diary'), null);
});

test('setCells writes layout cells, formulas included', () => {
  const ctx = boot();
  ctx.__spreadsheet.insertSheet('Hoje');
  ctx.Tabs.setCells('today', { B5: day('2026-09-28'), B7: 67, C1: '=1+1' });
  const s = sheet(ctx, 'Hoje');
  assert.equal(s.cell_(7, 2), 67);
  assert.equal(s.cell_(1, 3), '=1+1');
});
