#!/usr/bin/env node
/**
 * Visual preview of the sheet 4.0 product on a brand-new spreadsheet: Setup.apply on an empty
 * file, a synthetic client (fake names, apps/sheet4/test/dashboard_helpers.js), seven weeks of
 * days, measures and sessions, and a phase transition (O001 → O002). The fake spreadsheet is
 * snapshotted and written to sheets/preview/produto-exemplo.xlsx with tools/fixture_to_xlsx.py.
 *
 * Usage: TZ=America/Sao_Paulo node tools/preview_setup.js [out.xlsx] [--json out.json] [--dump]
 *   --dump prints the Hoje and Painel values (row: cells) to review the layout in a terminal.
 *
 * The xlsx is an approximation of Google Sheets: values, formats, merges, widths, validations,
 * conditional formats and chart ranges; chart series colours/markers and protections are not
 * written by fixture_to_xlsx.py.
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { scenario } = require(path.join(ROOT, 'apps/sheet4/test/dashboard_helpers'));
const { snapshot } = require(path.join(ROOT, 'apps/sheet4/test/fakes'));

const args = process.argv.slice(2);
const out = args.find((a) => a.endsWith('.xlsx')) || path.join(ROOT, 'sheets/preview/produto-exemplo.xlsx');
const jsonAt = args.indexOf('--json');
const jsonOut = jsonAt >= 0 ? args[jsonAt + 1] : path.join(os.tmpdir(), 'produto-exemplo.json');

const ctx = scenario();
ctx.HojeActions.loadDay(ctx.Dates.today());
const snap = snapshot(ctx);
fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
fs.writeFileSync(jsonOut, JSON.stringify(snap));
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync('python3', [path.join(ROOT, 'tools/fixture_to_xlsx.py'), jsonOut, out], { stdio: 'inherit' });
console.log(`preview: ${path.relative(ROOT, out)} (${snap.sheets.length} tabs)`);

if (args.includes('--dump')) {
  const show = (v) => (v === null ? '' : v && typeof v === 'object' ? (v.$formula || v.$date || v.$datetime || JSON.stringify(v)) : String(v));
  ['Hoje', 'Painel'].forEach((name) => {
    const s = snap.sheets.find((x) => x.name === name);
    console.log(`\n== ${name}`);
    s.values.forEach((row, i) => {
      const cells = row.slice(0, 13).map(show);
      if (cells.some(Boolean)) console.log(String(i + 1).padStart(3), cells.map((c) => c.slice(0, 60)).join(' | '));
    });
    console.log('charts:', JSON.stringify(s.charts.map((c) => ({ at: c.position.row, ranges: c.ranges, title: c.options.title }))));
  });
}
