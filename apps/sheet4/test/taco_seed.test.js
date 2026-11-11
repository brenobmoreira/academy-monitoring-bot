'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const { load, plain } = require('./harness');

test('all 575 generated seed rows pass the real foods.seed validator, in batches <=250', () => {
  const root = path.resolve(__dirname, '../../..');
  const python = process.env.TACO_TEST_PYTHON || (process.platform === 'win32' ? 'C:/Users/LOUREN~1/AppData/Local/Temp/v312/Scripts/python.exe' : 'python3');
  const script = 'import json, runpy; m=runpy.run_path("tools/taco/seed_sheet.py"); print(json.dumps(m["rows"]()))';
  const rows = JSON.parse(execFileSync(python, ['-B', '-c', script], { cwd: root, encoding: 'utf8' }));
  const ctx = load();
  assert.equal(rows.length, 575);
  for (let i = 0; i < rows.length; i += 250) {
    const batch = rows.slice(i, i + 250);
    const r = plain(ctx.ApiValidator.foodsSeed({ foods: batch }));
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.value.foods, batch);
  }
});
