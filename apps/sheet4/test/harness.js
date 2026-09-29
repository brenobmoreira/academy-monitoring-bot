/**
 * Loads every apps/sheet4/src/*.js into one VM context, mimicking Apps Script's single global scope.
 * Top-level `const X = ...` becomes `var X = ...` so namespaces are reachable from tests.
 * src/*.html files are served to HtmlService.create*FromFile by name (without extension).
 *
 * Load order mirrors the Apps Script project: the core files first (in LOAD_ORDER, the same list
 * as `filePushOrder` in .clasp.json.example), so any other file may call `Actions.register(...)`
 * at top level; the rest alphabetically.
 *
 * load(options) accepts every createContext option (see fakes.js); `fixture` may also be a
 * fixture name such as 'breno_3_0' (apps/sheet4/test/fixtures/<name>.json).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createContext } = require('./fakes');

const SRC = path.join(__dirname, '..', 'src');
const FIXTURES = path.join(__dirname, 'fixtures');

const LOAD_ORDER = ['core_dates.js', 'core_tabs.js', 'core_config.js', 'core_log.js', 'core_actions.js', 'core_versions.js'];

function listSrc(ext) {
  if (!fs.existsSync(SRC)) return [];
  return fs.readdirSync(SRC).filter((f) => f.endsWith(ext)).sort();
}

function sourceFiles() {
  const all = listSrc('.js');
  const core = LOAD_ORDER.filter((f) => all.includes(f));
  return core.concat(all.filter((f) => !core.includes(f)));
}

function loadSources() {
  return sourceFiles()
    .map((f) => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/^const (\w+) =/gm, 'var $1 ='))
    .join('\n');
}

function htmlFiles() {
  return Object.fromEntries(listSrc('.html').map((f) => [f.slice(0, -5), fs.readFileSync(path.join(SRC, f), 'utf8')]));
}

const fixtureCache = new Map();
/** Parsed fixture JSON (a fresh deep copy on every call). */
function fixture(name) {
  if (!fixtureCache.has(name)) fixtureCache.set(name, fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
  return JSON.parse(fixtureCache.get(name));
}

function load(options = {}) {
  const opts = { htmlFiles: htmlFiles(), ...options };
  if (typeof opts.fixture === 'string') opts.fixture = fixture(opts.fixture);
  const ctx = createContext(opts);
  vm.createContext(ctx);
  vm.runInContext(loadSources(), ctx, { filename: 'src.js' });
  return ctx;
}

/** Strips VM-realm prototypes so assert.deepEqual can compare with host literals. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { load, plain, fixture, sourceFiles, LOAD_ORDER };
