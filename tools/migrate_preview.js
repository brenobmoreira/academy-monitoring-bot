#!/usr/bin/env node
/**
 * Runs the 3.0 → 4.0 migration on a fixture (the real 3.0 export) with the client's file and writes
 * the migrated fake spreadsheet as a preview .xlsx for the owner.
 *
 *   node tools/migrate_preview.js [breno|zoio|all] [--now 2026-09-29] [--out sheets/preview]
 *
 * Steps: load apps/sheet4/test/fixtures/<name>_3_0.json into the fakes, Migrate.run(clients/<name>.json),
 * dump snapshot() to <tmp>/<name>_4_0.json, then `python3 tools/fixture_to_xlsx.py` it to
 * <out>/<name>_4_0.xlsx. Needs Python 3 with openpyxl (see tools/README.md).
 */
'use strict';
process.env.TZ = process.env.TZ || 'America/Sao_Paulo';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const { load } = require(path.join(ROOT, 'apps', 'sheet4', 'test', 'harness'));
const { snapshot } = require(path.join(ROOT, 'apps', 'sheet4', 'test', 'fakes'));

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function preview(name, opts) {
  const client = JSON.parse(fs.readFileSync(path.join(ROOT, 'clients', `${name}.json`), 'utf8'));
  const ctx = load({ fixture: `${name}_3_0`, now: opts.now ? `${opts.now}T12:00:00` : undefined });
  const result = ctx.Migrate.run(client);
  const jsonPath = path.join(opts.tmp, `${name}_4_0.json`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(snapshot(ctx), null, 1)}\n`);
  fs.mkdirSync(opts.out, { recursive: true });
  const xlsxPath = path.join(opts.out, `${name}_4_0.xlsx`);
  execFileSync('python3', [path.join(ROOT, 'tools', 'fixture_to_xlsx.py'), jsonPath, xlsxPath], { stdio: 'inherit' });
  const open = result.findingsAfter.length;
  console.log(`${name}: ${result.changes} alterações, ${open} achados abertos → ${path.relative(ROOT, xlsxPath)} (snapshot ${jsonPath})`);
}

const which = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'all';
const names = which === 'all' ? ['breno', 'zoio'] : [which];
const opts = {
  now: arg('--now', null),
  out: path.resolve(ROOT, arg('--out', path.join('sheets', 'preview'))),
  tmp: fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-preview-')),
};
names.forEach((n) => preview(n, opts));
