'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, plain } = require('./core_helpers');

const eq = (a, b, m) => assert.deepEqual(plain(a), b, m);
const noop = () => null;

/** Registers a representative set of actions in a scrambled order. */
function registerSample(A) {
  // Modules register their own actions at load; keep only the core one so the sample is exact.
  Object.keys(A.registry_).forEach((k) => { if (k !== 'undoLast') delete A.registry_[k]; });
  A.register({ id: 'setup', label: 'Configuração inicial', group: 'system', order: 10, run: noop });
  A.register({ id: 'newGoal', label: 'Nova meta', group: 'phase', order: 10, run: noop });
  A.register({ id: 'saveDay', label: 'Salvar dia', group: 'today', order: 20, quick: true, run: noop });
  A.register({ id: 'loadDay', label: 'Carregar dia', group: 'today', order: 10, quick: true, run: noop });
  A.register({ id: 'logFood', label: 'Lançar alimento', group: 'food', order: 10, quick: true, run: noop });
  A.register({ id: 'updateWeek', label: 'Atualizar semana', group: 'analysis', run: noop });
}

test('the menu is grouped as spec §5.3 whatever the registration order', () => {
  const ctx = boot();
  registerSample(ctx.Actions);
  eq(ctx.Actions.menu().map((e) => (e.items ? [e.label, e.items.map((i) => i.label)] : e.label)), [
    ['Hoje', ['Carregar dia', 'Salvar dia']],
    ['Alimentação', ['Lançar alimento']],
    ['Fase e metas', ['Nova meta']],
    ['Análise', ['Atualizar semana']],
    'Desfazer última alteração',
    ['Sistema', ['Configuração inicial']],
  ]);
  ctx.onOpen();
  const [menu] = ctx.__menus;
  assert.equal(menu.name, 'Projeto');
  eq(menu.items.map((i) => i[0]), ['Hoje', 'Alimentação', 'Fase e metas', 'Análise', 'Desfazer última alteração', 'Sistema']);
  eq(menu.items[0][1].items, [['Carregar dia', 'action_loadDay'], ['Salvar dia', 'action_saveDay']]);
  assert.equal(menu.items[4][1], 'action_undoLast');
});

test('quickList lists quick actions in menu order after the empty marker', () => {
  const ctx = boot();
  registerSample(ctx.Actions);
  eq(ctx.Actions.quickList(), ['—', 'Carregar dia', 'Salvar dia', 'Lançar alimento', 'Desfazer última alteração']);
  assert.equal(ctx.Actions.byLabel('Salvar dia').id, 'saveDay');
});

test('register validates its input and defines a global function per action', () => {
  const ctx = boot();
  const A = ctx.Actions;
  assert.throws(() => A.register({ id: 'bad id', label: 'x', group: 'today', run: noop }), /Invalid action id/);
  assert.throws(() => A.register({ id: 'x', group: 'today', run: noop }), /needs a label/);
  assert.throws(() => A.register({ id: 'x', label: 'x', group: 'nope', run: noop }), /Unknown action group/);
  assert.throws(() => A.register({ id: 'x', label: 'x', group: 'today' }), /needs run/);
  A.register({ id: 'hello', label: 'Olá', group: 'today', run: () => 'feito' });
  assert.throws(() => A.register({ id: 'hello', label: 'Olá', group: 'today', run: noop }), /already registered/);
  eq(ctx.action_hello(), { ok: true, result: 'feito' });
  eq(ctx.__toasts.at(-1), { msg: 'feito', title: 'Olá', seconds: 5 });
});

test('run takes the lock, records one undoable action and undo reverts it', () => {
  const ctx = boot({ tabs: { diary: [{ date: '2026-09-28', weightKg: 67 }] } });
  ctx.Actions.register({
    id: 'saveDay', label: 'Salvar dia', group: 'today', quick: true,
    run: () => { ctx.Tabs.update('diary', 6, { weightKg: 66 }); ctx.Tabs.append('diary', { date: '2026-09-29', weightKg: 65.8 }); return { message: 'Dia salvo.' }; },
  });
  const r = ctx.Actions.run('saveDay');
  assert.equal(r.ok, true);
  eq(ctx.__locks, ['wait', 'release']);
  eq(ctx.ChangeLog.actions().map((a) => [a.label, a.changes.length]), [['Salvar dia', 2]]);
  assert.equal(ctx.__toasts.at(-1).msg, 'Dia salvo.');
  const u = ctx.Actions.runQuick('Desfazer última alteração');
  assert.equal(u.ok, true);
  assert.equal(ctx.__toasts.at(-1).msg, 'Desfeito: Salvar dia (2 alterações).');
  assert.equal(ctx.Tabs.readRow('diary', 6).weightKg, 67);
  assert.equal(ctx.Tabs.read('diary').length, 1);
  assert.equal(ctx.ChangeLog.actions().length, 1, 'undo itself is not logged as an action');
});

test('errors become a toast and {ok: false}; the partial writes are rolled back', () => {
  const ctx = boot({ tabs: { diary: [{ date: '2026-09-28', weightKg: 67 }] } });
  ctx.Actions.register({
    id: 'broken', label: 'Quebrada', group: 'analysis',
    run: () => { ctx.Tabs.update('diary', 6, { weightKg: 1 }); throw new Error('Peso fora do intervalo.'); },
  });
  const r = ctx.Actions.run('broken');
  eq(r, { ok: false, error: 'Peso fora do intervalo.' });
  eq(ctx.__toasts.at(-1), { msg: 'Peso fora do intervalo.', title: 'Erro — Quebrada', seconds: 10 });
  assert.equal(ctx.Tabs.readRow('diary', 6).weightKg, 67);
  eq(ctx.__locks, ['wait', 'release']);
  assert.equal(ctx.Actions.run('missing').ok, false);
  assert.equal(ctx.Actions.runQuick('—').ok, true);
  assert.equal(ctx.Actions.runQuick('Inexistente').ok, false);
  assert.equal(ctx.Actions.run('undoLast').error, 'Nada para desfazer.');
});

test('logged=false and locked=false opt out of the log and the lock', () => {
  const ctx = boot({ tabs: { diary: [] } });
  ctx.Actions.register({ id: 'setupish', label: 'Reaplicar layout', group: 'system', logged: false, locked: false, run: () => ctx.Tabs.append('diary', { date: '2026-09-28' }) });
  assert.equal(ctx.Actions.run('setupish').ok, true);
  eq(ctx.__locks, []);
  assert.equal(ctx.ChangeLog.actions().length, 0);
});
