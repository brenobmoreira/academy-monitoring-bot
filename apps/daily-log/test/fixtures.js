/** Tab layouts copied from the spreadsheet model (headers only, no personal data). */
'use strict';

const blank = (n) => Array.from({ length: n }, () => []);

const DIARY_HEADERS = ['Data', 'Peso kg', 'Sono h', 'Passos', 'Cardio min', 'Muay Thai', 'Dieta completa',
  'Cintura cm', 'Fome 1–5', 'Cansaço 1–5', 'Observações', 'Meta versão', 'Meta kcal', 'Meta proteína',
  'Meta gordura', 'Meta carbo', 'Treinos meta', 'P mín', 'P máx', 'Tol kcal', 'Tol gordura', 'kcal',
  'Proteína g', 'Carboidrato g', 'Gordura g', 'Fibra g', 'Treinos', 'Média peso 7d', 'Aderência kcal',
  'Aderência proteína', 'Aderência gordura', 'Dias peso 7d'];

const WORKOUT_HEADERS = ['Data', 'Sessão', 'Exercício', 'Equipamento / carga', 'kg série 1', 'Reps 1',
  'kg série 2', 'Reps 2', 'kg série 3', 'Reps 3', 'kg série 4', 'Reps 4', 'Séries feitas', 'Volume kg×reps',
  'RIR final', 'Dor 0–10', 'Técnica / adaptação', 'Ficha', 'Séries prescritas', 'Reps mín', 'Reps máx',
  'Fase', 'ID sessão'];

const PLAN_HEADERS = ['Sessão', 'Exercício proposto', 'Grupo principal', 'Séries adaptação',
  'Séries após adaptação', 'Reps mín.', 'Reps máx.', 'RIR inicial', 'RIR posterior', 'Descanso s',
  'Alternativa', 'Revisão do Luan', 'Observações'];

const PLAN_ROWS = [
  ['Upper', 'Supino inclinado', 'Peito', 2, 3, 6, 10, 3, 2, 150, 'Supino inclinado máquina'],
  ['Upper', 'Puxada aberta', 'Costas', 2, 3, 8, 12, 3, 2, 150, 'Puxada neutra'],
  ['Lower', 'Leg press', 'Quadríceps', 2, 3, 8, 12, 3, 2, 150, 'Cadeira extensora'],
];

const EXERCISE_HEADERS = ['Exercício', 'Grupo', 'Convenção de carga'];
const EXERCISE_ROWS = [
  ['Supino inclinado', 'Peito', 'Carga total'],
  ['Puxada aberta', 'Costas', 'Carga total'],
  ['Leg press', 'Quadríceps', 'Carga total'],
];

const PLAN_HISTORY_HEADERS = ['Versão', 'Vigência', 'Sessão', 'Exercício'];

const PROGRESSION_HEADERS = ['Data', 'Ficha', 'Exercício', 'kg 1', 'reps 1', 'kg 2', 'reps 2', 'kg 3',
  'reps 3', 'kg 4', 'reps 4', 'Volume', 'Séries válidas', 'RIR final'];

function sheets({ diaryRows = [], workoutRows = [], planHistoryRows = [['F001', 1, 'Upper', 'Supino inclinado']], hoje } = {}) {
  return [
    { name: 'Diário', rows: [...blank(4), DIARY_HEADERS, ...diaryRows] },
    { name: 'Registro de treino', rows: [...blank(4), WORKOUT_HEADERS, ...workoutRows] },
    { name: 'Ficha de treino', rows: [...blank(4), PLAN_HEADERS, ...PLAN_ROWS] },
    { name: 'Exercícios', rows: [...blank(4), EXERCISE_HEADERS, ...EXERCISE_ROWS] },
    { name: 'Histórico de fichas', rows: [...blank(4), PLAN_HISTORY_HEADERS, ...planHistoryRows] },
    { name: 'Progressão', rows: [...blank(4), ['Exercício', 'Supino inclinado'], [], [], [], PROGRESSION_HEADERS] },
    { name: 'Hoje', rows: hoje || [] },
  ];
}

module.exports = { sheets, DIARY_HEADERS, WORKOUT_HEADERS, PROGRESSION_HEADERS };
