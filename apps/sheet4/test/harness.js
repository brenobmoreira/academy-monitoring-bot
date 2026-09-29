/**
 * Loads every src/*.js into one VM context, mimicking Apps Script's single global scope.
 * Top-level `const X = ...` becomes `var X = ...` so namespaces are reachable from tests.
 *
 * Load order mirrors the Apps Script project: the core files first (in LOAD_ORDER, the same list
 * as `filePushOrder` in .clasp.json.example), so any other file may call `Actions.register(...)`
 * at top level; the rest alphabetically.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createContext } = require('./fakes');

const SRC = path.join(__dirname, '..', 'src');

const LOAD_ORDER = ['core_dates.js', 'core_tabs.js', 'core_config.js', 'core_log.js', 'core_actions.js', 'core_versions.js'];

function sourceFiles() {
  const all = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'));
  const core = LOAD_ORDER.filter((f) => all.includes(f));
  return core.concat(all.filter((f) => !core.includes(f)).sort());
}

function loadSources() {
  return sourceFiles()
    .map((f) => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/^const (\w+) =/gm, 'var $1 ='))
    .join('\n');
}

function load(options) {
  const ctx = createContext(options);
  vm.createContext(ctx);
  vm.runInContext(loadSources(), ctx, { filename: 'src.js' });
  return ctx;
}

/** Strips VM-realm prototypes so assert.deepEqual can compare with host literals. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports = { load, plain, sourceFiles, LOAD_ORDER };
