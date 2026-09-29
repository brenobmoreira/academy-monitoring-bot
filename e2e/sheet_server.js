/**
 * Serves the real Apps Script code over local HTTP, backed by the in-memory spreadsheet fake the
 * unit tests use. It stands in for the published Web App URL.
 *
 *   POST /          body goes to doPost, exactly like the Web App
 *   GET  /__sheets  current rows of the written tabs, as objects keyed by header
 *
 * Default: the sheet 4.0 product (apps/sheet4/src, loaded like apps/sheet4/test/harness.js: core
 * files first). The spreadsheet is built by Setup.apply() when that exists, else by Tabs.ensure for
 * every table tab, and gets a small synthetic client (fake names, no real client data) with an
 * objective, a goal and a plan in force. SHEET_SRC=legacy (or --legacy) serves the old apps/sheet
 * code with its test fixtures instead.
 *
 * Prints "LISTENING <port>" on stdout once ready. SHEET_API_KEY comes from the environment.
 */
'use strict';
const http = require('node:http');

const HEADER_ROW = 5;
const legacy = process.env.SHEET_SRC === 'legacy' || process.argv.includes('--legacy');
const properties = { SHEET_API_KEY: process.env.SHEET_API_KEY || '' };

function isoDay(offset) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Synthetic client: generic names and round numbers, nothing from a real spreadsheet. */
function seed(ctx) {
  const start = isoDay(-28);
  const config = {
    'client.name': 'Cliente Exemplo',
    'client.reviewer': 'Revisor Exemplo',
    'client.sex': 'M',
    'client.age': 30,
    'client.heightCm': 175,
    'client.startWeightKg': 80,
    'client.startDate': start,
    'routine.strengthPerWeek': 3,
    'routine.sessionRotation': ['Upper', 'Lower'],
    'routine.rotationMode': 'continuous',
  };
  Object.keys(config).forEach((k) => ctx.Config.set(k, config[k]));
  const plan = (session, exercise, group) => ({
    id: 'F001', legacyStart: start, start, status: 'Vigente', session, exercise, group,
    workSetsAdapt: 1, workSetsRegular: 2, repsMin: 6, repsMax: 10, rirAdapt: 3, rirRegular: 1, restS: 120,
    notes: '1 aquecimento + 1 feeder + 2 work sets',
  });
  const tables = {
    objectives: [{ id: 'O001', name: 'Recomposição corporal', analysisType: 'recomposicao', start, status: 'Vigente', goal: 'M001', plan: 'F001', kcal: 2400, protein: 150, fat: 70, strengthPerWeek: 3 }],
    goals: [{ id: 'M001', objective: 'O001', start, status: 'Vigente', kcal: 2400, protein: 150, proteinMin: 140, proteinMax: 160, fat: 70, carbs: 292.5, fiber: 30, strengthPerWeek: 3 }],
    plans: [
      plan('Upper', 'Supino inclinado', 'Peito'),
      plan('Upper', 'Puxada aberta', 'Costas'),
      plan('Lower', 'Leg press', 'Quadríceps'),
      plan('Lower', 'Mesa flexora', 'Posteriores'),
    ],
    exercises: [
      { name: 'Supino inclinado', group: 'Peito', loadConvention: 'Carga total' },
      { name: 'Puxada aberta', group: 'Costas', loadConvention: 'kg da máquina' },
      { name: 'Leg press', group: 'Quadríceps', loadConvention: 'kg da máquina' },
      { name: 'Mesa flexora', group: 'Posteriores', loadConvention: 'kg da máquina' },
    ],
    foods: [
      { name: 'Arroz branco cozido', baseUnit: 'g', baseQty: 100, kcal: 128, protein: 2.5, carbs: 28.1, fat: 0.2, fiber: 1.6, quality: 'TACO/fonte confiável' },
      { name: 'Peito de frango cozido', baseUnit: 'g', baseQty: 100, kcal: 163, protein: 31.5, carbs: 0, fat: 3.2, fiber: 0, quality: 'TACO/fonte confiável' },
      { name: 'Ovo inteiro cozido', baseUnit: 'g', baseQty: 100, kcal: 146, protein: 13.3, carbs: 0.6, fat: 9.5, fiber: 0, householdUnit: 'un', perHousehold: 50, quality: 'TACO/fonte confiável' },
    ],
  };
  Object.keys(tables).forEach((id) => ctx.Tabs.appendMany(id, tables[id]));
  ctx.Tabs.invalidate();
  ctx.Config.invalidate();
}

function build4() {
  const { load } = require('../apps/sheet4/test/harness');
  const ctx = load({ properties });
  let built = false;
  if (ctx.Setup && typeof ctx.Setup.apply === 'function') {
    try {
      ctx.Setup.apply();
      built = true;
    } catch (err) {
      process.stderr.write(`Setup.apply failed, falling back to Tabs.ensure: ${err.message}\n`);
    }
  }
  if (!built) ctx.Tabs.ids().filter((id) => ctx.Tabs.get(id).kind === 'table').forEach((id) => ctx.Tabs.ensure(id));
  ctx.Tabs.invalidate();
  seed(ctx);
  return { ctx, dayKey: (d) => ctx.Dates.key(d), tabs: ['Diário', 'Registro de treino', 'Alimentação'] };
}

function buildLegacy() {
  const { load } = require('../apps/sheet/test/harness');
  const { sheets } = require('../apps/sheet/test/fixtures');
  const ctx = load({ sheets: sheets(), properties });
  return { ctx, dayKey: (d) => ctx.Sheets.dayKey(d), tabs: ['Diário', 'Registro de treino'] };
}

const { ctx, dayKey, tabs } = legacy ? buildLegacy() : build4();

function dump(name) {
  const sheet = ctx.__spreadsheet.getSheetByName(name);
  if (!sheet) return [];
  const headers = sheet.rows[HEADER_ROW - 1] || [];
  return sheet.rows.slice(HEADER_ROW).filter((line) => line.some((v) => v !== '' && v !== undefined && v !== null)).map((line) => {
    const row = {};
    headers.forEach((h, i) => {
      const v = line[i];
      if (h && v !== '' && v !== undefined && v !== null) row[h] = v instanceof Date ? dayKey(v) : v;
    });
    return row;
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__sheets') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Object.fromEntries(tabs.map((t) => [t, dump(t)]))));
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const out = ctx.doPost({ postData: { contents: body } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(out.getContent ? out.getContent() : out.text);
  });
});

server.listen(0, '127.0.0.1', () => {
  console.log(`LISTENING ${server.address().port}`);
});
