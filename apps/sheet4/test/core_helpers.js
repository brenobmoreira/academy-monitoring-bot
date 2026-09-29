/** Test helpers for the core modules: a context with tabs built from Tabs.SPEC. */
'use strict';
const { load, plain } = require('./harness');

const NOW = '2026-09-29T15:00:00-03:00';
const day = (s) => new Date(`${s}T00:00:00`);

/**
 * @param {{tabs?: Object<string, Object[]>, config?: Object<string, *>, now?: string, sheets?: Object[]}} opts
 *   tabs: tab id → rows (objects keyed by column key) written below a spec header; a tab listed
 *   with [] is created empty. config: key → value rows on the Config tab.
 */
function boot(opts = {}) {
  const ctx = load({ sheets: opts.sheets || [], properties: opts.properties || {}, now: opts.now || NOW });
  const tabs = Object.assign({}, opts.tabs || {});
  if (opts.config) tabs.config = Object.keys(opts.config).map((key) => ({ key, value: opts.config[key] }));
  Object.keys(tabs).forEach((id) => {
    ctx.Tabs.ensure(id);
    if (tabs[id].length) ctx.Tabs.appendMany(id, tabs[id]);
  });
  ctx.Tabs.invalidate();
  ctx.Config.invalidate();
  return ctx;
}

const sheet = (ctx, name) => ctx.__spreadsheet.getSheetByName(name);
/** Cell values of a sheet's data rows (from row 6), trailing empties trimmed per row. */
const dump = (ctx, name) => (sheet(ctx, name) ? sheet(ctx, name).rows.slice(5).map((r) => r.map((v) => (v instanceof Date ? v.getTime() : v))) : null);

module.exports = { boot, day, NOW, sheet, dump, plain };
