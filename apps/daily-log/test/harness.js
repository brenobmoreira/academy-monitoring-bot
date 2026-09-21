/**
 * Loads every src/*.js into one VM context, mimicking Apps Script's single global scope.
 * Top-level `const X = ...` becomes `var X = ...` so namespaces are reachable from tests.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createContext } = require('./fakes');

const SRC = path.join(__dirname, '..', 'src');

function loadSources() {
  return fs.readdirSync(SRC).filter((f) => f.endsWith('.js')).sort()
    .map((f) => fs.readFileSync(path.join(SRC, f), 'utf8').replace(/^const (\w+) =/gm, 'var $1 ='))
    .join('\n');
}

function load(options) {
  const ctx = createContext(options);
  vm.createContext(ctx);
  vm.runInContext(loadSources(), ctx, { filename: 'src.js' });
  return ctx;
}

module.exports = { load };

/** Strips VM-realm prototypes so assert.deepEqual can compare with host literals. */
function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

module.exports.plain = plain;
