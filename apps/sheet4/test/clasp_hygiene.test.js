'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SHEET4_DIR = path.resolve(__dirname, '..');
const SRC_DIR = path.join(SHEET4_DIR, 'src');

test('clasp.json.example declares rootDir "src" and placeholder scriptId', () => {
  const examplePath = path.join(SHEET4_DIR, '.clasp.json.example');
  assert.equal(fs.existsSync(examplePath), true, '.clasp.json.example must exist');

  const content = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  assert.equal(content.rootDir, 'src', 'rootDir must be src to prevent test/ upload');
  assert.match(content.scriptId, /^<.*>$/, 'scriptId must be a placeholder, not a real ID');

  // Verify filePushOrder entries exist on disk and have src/ prefix
  if (Array.isArray(content.filePushOrder)) {
    for (const f of content.filePushOrder) {
      assert.equal(f.startsWith('src/'), true, `filePushOrder entry ${f} must start with src/`);
      const fullPath = path.join(SHEET4_DIR, f);
      assert.equal(fs.existsSync(fullPath), true, `filePushOrder entry ${f} must exist on disk`);
    }
  }
});

test('.claspignore exists and shields Apps Script from tests, fixtures, node_modules, and secrets', () => {
  const claspignorePath = path.join(SHEET4_DIR, '.claspignore');
  assert.equal(fs.existsSync(claspignorePath), true, '.claspignore must exist');

  const lines = fs
    .readFileSync(claspignorePath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));

  // Must ignore all by default and whitelist only script files
  assert.equal(lines.includes('**/**'), true, 'must ignore all by default');
  assert.equal(lines.some((l) => l.includes('appsscript.json')), true, 'must whitelist appsscript.json');
  assert.equal(lines.some((l) => l.includes('*.js')), true, 'must whitelist .js files');
  assert.equal(lines.some((l) => l.includes('*.html')), true, 'must whitelist .html files');

  // Must explicitly blacklist tests, fixtures, node_modules, secrets
  assert.equal(lines.some((l) => l.includes('.test.js')), true, 'must ignore .test.js');
  assert.equal(lines.some((l) => l.includes('test')), true, 'must ignore test directory');
  assert.equal(lines.some((l) => l.includes('node_modules')), true, 'must ignore node_modules');
  assert.equal(lines.some((l) => l.includes('.env')), true, 'must ignore .env files');
});

test('all files in apps/sheet4/src are production source files, no tests or artifacts', () => {
  const srcFiles = fs.readdirSync(SRC_DIR);
  assert.ok(srcFiles.length >= 30, 'src should contain all production files');

  for (const f of srcFiles) {
    const isJs = f.endsWith('.js') && !f.endsWith('.test.js') && !f.endsWith('.spec.js');
    const isHtml = f.endsWith('.html');
    const isManifest = f === 'appsscript.json';
    assert.equal(
      isJs || isHtml || isManifest,
      true,
      `Unexpected file in apps/sheet4/src: ${f} (only production .js, .html, appsscript.json allowed)`
    );
  }
});

test('appsscript.json has explicit Sao Paulo timeZone and strictly minimal OAuth scopes', () => {
  const manifestPath = path.join(SRC_DIR, 'appsscript.json');
  assert.equal(fs.existsSync(manifestPath), true, 'appsscript.json must exist in src/');

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.timeZone, 'America/Sao_Paulo', 'timeZone must be America/Sao_Paulo');

  const EXPECTED_SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/script.container.ui',
    'https://www.googleapis.com/auth/script.scriptapp',
  ];

  assert.deepEqual(
    (manifest.oauthScopes || []).slice().sort(),
    EXPECTED_SCOPES.slice().sort(),
    'oauthScopes must contain strictly spreadsheets, script.container.ui, and script.scriptapp'
  );
});

test('no real scriptId or spreadsheetId is versioned in apps/sheet4/src', () => {
  const srcFiles = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.js') || f.endsWith('.json'));
  const realIdPattern = /AKfycb[a-zA-Z0-9_-]{40,}|1[a-zA-Z0-9_-]{40,}/;

  for (const f of srcFiles) {
    const content = fs.readFileSync(path.join(SRC_DIR, f), 'utf8');
    assert.equal(
      realIdPattern.test(content),
      false,
      `Potential real ID found in apps/sheet4/src/${f}`
    );
  }
});
