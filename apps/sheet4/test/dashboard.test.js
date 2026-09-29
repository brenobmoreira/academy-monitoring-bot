'use strict';
/**
 * Painel (spec §10) on a synthetic client: only the objective in force, timeline of every phase,
 * charts with one series per phase plus transition markers, empty states, refresh wiring.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load, plain } = require('./harness');
const { scenario } = require('./dashboard_helpers');

const painel = (ctx) => ctx.__spreadsheet.getSheetByName('Painel');
const text = (ctx, a1) => painel(ctx).getRange(a1).getValue();
/** Visible Painel values (A:E) by row, as strings. */
function rows(ctx) {
  const v = painel(ctx).getRange(1, 1, painel(ctx).getLastRow(), 5).getDisplayValues();
  return v.map((r) => r.join(' | '));
}

test('brand-new spreadsheet: empty states read well', () => {
  const ctx = load({ sheets: [{ name: 'Página1', rows: [] }], now: '2026-09-29T15:00:00-03:00' });
  ctx.Setup.apply();
  assert.equal(text(ctx, 'A2'), 'Painel');
  assert.equal(text(ctx, 'A5'), 'OBJETIVO ATUAL — nenhum objetivo em vigor');
  assert.match(text(ctx, 'A9'), /^Nenhum objetivo em vigor/);
  assert.match(text(ctx, 'A15'), /^Nenhuma meta em vigor/);
  assert.equal(text(ctx, 'A27'), 'Sem dados ainda — registre o primeiro dia em Hoje.');
  assert.equal(text(ctx, 'A37'), 'Sem dados ainda — registre o primeiro dia em Hoje.');
  assert.equal(text(ctx, 'A42'), 'Nenhuma fase registrada ainda.');
  assert.match(text(ctx, 'A45'), /^Sem dados ainda — os gráficos aparecem/);
  assert.equal(painel(ctx).getCharts().length, 0);
  assert.equal(painel(ctx).getRowHeight(28), ctx.Style.ROW.collapsed, 'empty card rows collapse');
});

test('after a transition the Painel shows only O002; the timeline lists O001 and O002', () => {
  const ctx = scenario();
  assert.equal(text(ctx, 'A2'), 'Painel · Ana Exemplo');
  assert.equal(text(ctx, 'A5'), 'OBJETIVO ATUAL — O002 · Ganho controlado');
  assert.match(text(ctx, 'A6'), /^Desde 26\/10\/2026 · semana 3 da fase \(16 dias\) · Revisor: Revisora Teste · Meta M002 · Ficha F001$/);
  assert.equal(text(ctx, 'A14'), 'Metas atuais · M002');
  assert.equal(text(ctx, 'B15'), '2.150');
  assert.equal(text(ctx, 'C16'), 'faixa 115–135 g');
  assert.match(text(ctx, 'C22'), /^estimado/);
  assert.match(text(ctx, 'C23'), /^estimado · TMB × 1,55/);
  assert.match(text(ctx, 'C24'), /^planejado/);
  const all = rows(ctx);
  const timeline = all.findIndex((r) => r.startsWith('Linha do tempo das fases'));
  assert.ok(timeline > 0);
  all.slice(0, timeline).forEach((r, i) => assert.ok(!/O001|Recomposição/.test(r), `row ${i + 1} shows history: ${r}`));
  const phases = all.slice(timeline).filter((r) => /^O00\d · /.test(r));
  assert.equal(phases.length, 2);
  assert.match(phases[0], /^O001 · Recomposição corporal \| 28\/09\/2026 → 25\/10\/2026 \| 4 semanas · 28 dias/);
  assert.match(phases[1], /^O002 · Ganho controlado \(atual\) \| 26\/10\/2026 → hoje/);
  // The week before the transition belongs to O001: shown only as "fase anterior".
  const m = plain(ctx.Dashboard.model());
  assert.equal(m.phase.id, 'O002');
  assert.equal(m.recommendation.code, 'MANTER');
  assert.equal(text(ctx, 'B37'), 'MANTER');
  assert.equal(text(ctx, 'A34'), 'Situação geral');
  // Values, not live formulas: only navigation links.
  const formulas = painel(ctx).getDataRange().getFormulas().flat().filter(Boolean);
  assert.ok(formulas.length === 5 && formulas.every((f) => f.startsWith('=HYPERLINK("#gid=')));
});

test('charts: one series per phase plus transition markers, over the hidden chart block', () => {
  const ctx = scenario();
  const s = painel(ctx);
  const charts = s.getCharts();
  assert.equal(charts.length, 2);
  const [w, c] = charts;
  assert.equal(w.getOptions().get('title'), 'Peso — média de 7 dias (kg)');
  assert.equal(c.getOptions().get('title'), 'Cintura (cm)');
  const range = w.getRanges()[0];
  assert.equal(range.getA1Notation(), 'H2:L10');
  const head = range.getValues()[0];
  assert.deepEqual(plain(head), ['Semana', 'Sem objetivo', 'O001 · Recomposição corporal', 'O002 · Ganho controlado', 'Mudança de fase']);
  const series = w.getOptions().get('series');
  assert.equal(Object.keys(series).length, 4);
  assert.equal(series[3].lineWidth, 0, 'marker series has points only');
  assert.notEqual(series[1].color, series[2].color, 'each phase its colour');
  assert.equal(w.getOptions().get('hiddenDimensionStrategy'), 'SHOW_BOTH');
  const body = range.getValues().slice(1).map((r) => [ctx.Dates.key(r[0])].concat(r.slice(1)));
  const col = (j) => body.filter((r) => r[j] !== '').map((r) => r[0]);
  assert.deepEqual(plain(col(2)), ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'], 'O001 weeks + the bridge week before');
  assert.deepEqual(plain(col(3)), ['2026-10-19', '2026-10-26', '2026-11-02', '2026-11-09'], 'O002 starts at the last O001 point');
  assert.deepEqual(plain(col(4)), ['2026-10-26'], 'one marker, at the transition week (not at the start of tracking)');
  assert.ok(s.isColumnHiddenByUser(8) && s.isColumnHiddenByUser(12));
  assert.equal(w.getContainerInfo().getAnchorColumn(), 1);
  // A render with the same shape keeps the same charts (no rebuild).
  const ids = charts.map((x) => x.getChartId());
  ctx.Dashboard.memo_ = null;
  ctx.Dashboard.render();
  assert.deepEqual(s.getCharts().map((x) => x.getChartId()), ids);
});

test('refresh wiring: a saved day and a new transition re-render the Painel', () => {
  const ctx = scenario();
  ctx.Hoje.write('diary', { weightKg: 63.5 });
  ctx.Actions.run('saveDay');
  assert.match(text(ctx, 'C28'), /^62,[0-9] kg · .* · 2 pesagens$/);
  ctx.Transition.apply({
    date: '2026-11-10', objective: { name: 'Manutenção', analysisType: 'manutencao' }, reason: 'Teste', reviewer: 'Revisora Teste',
  });
  assert.equal(text(ctx, 'A5'), 'OBJETIVO ATUAL — O003 · Manutenção');
  const r = ctx.Actions.run('dashboardRefresh');
  assert.equal(r.ok, true);
  assert.match(r.result.message, /^Painel atualizado/);
});

test('a 3.0 Painel is left alone by automatic refreshes until the migration', () => {
  const ctx = load({ fixture: 'breno_3_0', now: '2026-09-29T15:00:00-03:00' });
  const before = painel(ctx).getRange('A2').getValue();
  assert.equal(ctx.Dashboard.renderSafely_(), null);
  assert.equal(painel(ctx).getRange('A2').getValue(), before);
});
