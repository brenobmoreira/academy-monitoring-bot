/** Test helpers for the daily engine (Diary, Measures, Hoje, Hoje actions). */
'use strict';
const { load, plain } = require('./harness');

const NOW = '2026-09-29T15:00:00-03:00'; // Tuesday

/** History: O001 and M001 from 28/09 (in force); F001 until 27/09, F002 from 28/09. */
function history() {
  return {
    objectives: [
      { id: 'O001', name: 'Recomposição corporal', analysisType: 'recomposicao', start: '2026-09-28', status: 'Vigente', goal: 'M001', plan: 'F002' },
    ],
    goals: [
      {
        id: 'M001', objective: 'O001', start: '2026-09-28', status: 'Vigente', kcal: 2400, protein: 140, proteinMin: 135,
        proteinMax: 145, fat: 65, carbs: 313.75, fiber: 30, kcalTolerance: 0.05, fatTolerance: 0.15, stepsPerDay: 8000,
      },
    ],
    plans: [
      { id: 'F001', legacyStart: '2026-09-15', session: 'A', exercise: 'Supino', start: '2026-09-15', end: '2026-09-27', status: 'Encerrada' },
      { id: 'F002', legacyStart: '2026-09-28', session: 'A', exercise: 'Supino inclinado', start: '2026-09-28', status: 'Vigente' },
    ],
    reviews: [],
    diary: [],
    measures: [],
  };
}

/**
 * @param {{tabs?: Object, config?: Object, now?: string, uiResponses?: Array, hoje?: boolean,
 *   trigger?: boolean}} opts  tabs override history() per tab (null leaves the tab out); hoje
 *   (default true) builds the bare Hoje tab; trigger (default true) installs onEditInstalled as
 *   Setup will.
 */
function bootDaily(opts = {}) {
  const ctx = load({ now: opts.now || NOW, uiResponses: opts.uiResponses || [] });
  const tabs = Object.assign(history(), opts.tabs || {});
  if (opts.config) tabs.config = Object.keys(opts.config).map((key) => ({ key, value: opts.config[key] }));
  Object.keys(tabs).forEach((id) => {
    if (tabs[id] === null) return;
    ctx.Tabs.ensure(id);
    if (tabs[id].length) ctx.Tabs.appendMany(id, tabs[id]);
  });
  ctx.Tabs.invalidate();
  ctx.Config.invalidate();
  if (opts.hoje !== false) ctx.Hoje.ensure();
  if (opts.trigger !== false) {
    ctx.ScriptApp.newTrigger('onEditInstalled').forSpreadsheet(ctx.SpreadsheetApp.getActive()).onEdit().create();
  }
  return ctx;
}

const range = (ctx, a1, tab) => ctx.SpreadsheetApp.getActive().getSheetByName(tab || 'Hoje').getRange(a1);

/** Value of a cell (Dates as yyyy-MM-dd). */
function cell(ctx, a1, tab) {
  const v = range(ctx, a1, tab).getValue();
  return v && typeof v === 'object' && typeof v.getTime === 'function' ? ctx.Dates.key(v) : v;
}

function setCell(ctx, a1, value, tab) {
  range(ctx, a1, tab).setValue(value);
}

/** A Diário row as a plain object of the given keys (dates as keys), or null. */
function dayRow(ctx, date, keys) {
  const r = ctx.Days.get(date);
  if (!r) return null;
  const out = {};
  keys.forEach((k) => { out[k] = r[k] && typeof r[k] === 'object' && r[k].getTime ? ctx.Dates.key(r[k]) : r[k]; });
  return plain(out);
}

module.exports = { bootDaily, history, cell, setCell, dayRow, plain, NOW };
