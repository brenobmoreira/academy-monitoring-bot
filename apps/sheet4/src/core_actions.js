/**
 * Action registry (spec §5.3). Every user action is registered once and reachable from the
 * "Projeto" menu and, when `quick`, from the Ação rápida dropdown on Hoje (mobile has no menus).
 *
 *   Actions.register({id, label, group, run, quick?, order?, logged?, locked?})
 *
 * Any file may register at top level (core_*.js load first; see .clasp.json.example). Menu order
 * comes from the group order and each action's `order` (then label), never from registration
 * order. Registering also defines a global `action_<id>()` so a menu item can call it by name.
 *
 * Actions.run(id) takes the script lock, records the writes as one undoable action (ChangeLog),
 * shows a toast with the result message or the error, and never throws to the UI.
 */
const Actions = {
  /** Menu groups in display order; `label: null` puts the items directly in the main menu. */
  GROUPS: {
    today: { label: 'Hoje', order: 10 },
    food: { label: 'Alimentação', order: 20 },
    phase: { label: 'Fase e metas', order: 30 },
    analysis: { label: 'Análise', order: 40 },
    undo: { label: null, order: 50 },
    system: { label: 'Sistema', order: 60 },
  },
  MENU_TITLE: 'Projeto',
  QUICK_EMPTY: '—',
  FUNCTION_PREFIX: 'action_',

  registry_: {},

  /**
   * @param {{id: string, label: string, group: string, run: function(Object=): *, quick?: boolean,
   *   order?: number, logged?: boolean, locked?: boolean}} def
   *   logged=false: writes are not recorded as an undoable action (e.g. Undo itself, Setup).
   *   locked=false: runs without the script lock (read-only actions).
   */
  register(def) {
    if (!def || !/^[A-Za-z][A-Za-z0-9_]*$/.test(def.id || '')) throw new Error(`Invalid action id: ${def && def.id}`);
    if (!def.label) throw new Error(`Action ${def.id} needs a label`);
    if (!Actions.GROUPS[def.group]) throw new Error(`Unknown action group: ${def.group}`);
    if (typeof def.run !== 'function') throw new Error(`Action ${def.id} needs run()`);
    if (Actions.registry_[def.id]) throw new Error(`Action already registered: ${def.id}`);
    Actions.registry_[def.id] = Object.assign({ quick: false, order: 100, logged: true, locked: true }, def);
    globalThis[Actions.functionName(def.id)] = function () { return Actions.run(def.id); };
    return Actions.registry_[def.id];
  },

  functionName(id) {
    return Actions.FUNCTION_PREFIX + id;
  },

  get(id) {
    return Actions.registry_[id] || null;
  },

  /** Actions in menu order. */
  list() {
    return Object.keys(Actions.registry_).map((k) => Actions.registry_[k]).sort((a, b) => (
      Actions.GROUPS[a.group].order - Actions.GROUPS[b.group].order
      || a.order - b.order
      || a.label.localeCompare(b.label)
    ));
  },

  /**
   * Menu structure: [{label, items: [{id, label, fn}]}] per group, or {id, label, fn} for items
   * of a group without label. Empty groups are left out.
   */
  menu() {
    const out = [];
    let lastGroup = null;
    Actions.list().forEach((a) => {
      const item = { id: a.id, label: a.label, fn: Actions.functionName(a.id) };
      const g = Actions.GROUPS[a.group];
      if (!g.label) { out.push(item); lastGroup = null; return; }
      if (lastGroup !== a.group) { out.push({ label: g.label, items: [] }); lastGroup = a.group; }
      out[out.length - 1].items.push(item);
    });
    return out;
  },

  /** Builds the "Projeto" menu. */
  buildMenu() {
    const ui = SpreadsheetApp.getUi();
    const menu = ui.createMenu(Actions.MENU_TITLE);
    Actions.menu().forEach((entry) => {
      if (entry.items) {
        const sub = ui.createMenu(entry.label);
        entry.items.forEach((i) => sub.addItem(i.label, i.fn));
        menu.addSubMenu(sub);
      } else {
        menu.addItem(entry.label, entry.fn);
      }
    });
    menu.addToUi();
  },

  /** Dropdown values for Ação rápida: the empty marker, then quick actions in menu order. */
  quickList() {
    return [Actions.QUICK_EMPTY].concat(Actions.list().filter((a) => a.quick).map((a) => a.label));
  },

  byLabel(label) {
    return Actions.list().find((a) => a.label === label) || null;
  },

  /**
   * Runs an action. Returns {ok: true, result} or {ok: false, error}; shows a toast either way
   * (the result's `message`, or a string result).
   */
  run(id, args) {
    const def = Actions.get(id);
    if (!def) return Actions.fail_(new Error(`Ação desconhecida: ${id}`));
    try {
      const exec = () => (def.logged ? ChangeLog.run(def.label, () => def.run(args)) : def.run(args));
      const result = def.locked ? Core.withLock(exec) : exec();
      const message = typeof result === 'string' ? result : (result && result.message);
      if (message) Actions.toast_(message, def.label);
      return { ok: true, result };
    } catch (err) {
      return Actions.fail_(err, def.label);
    }
  },

  /** Runs the quick action whose label is `label`; the empty marker does nothing. */
  runQuick(label) {
    if (!label || label === Actions.QUICK_EMPTY) return { ok: true, result: null };
    const def = Actions.byLabel(label);
    if (!def || !def.quick) return Actions.fail_(new Error(`Ação rápida desconhecida: ${label}`));
    return Actions.run(def.id);
  },

  fail_(err, title) {
    console.error(err);
    Actions.toast_(err && err.message ? err.message : String(err), title ? `Erro — ${title}` : 'Erro', 10);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  },

  toast_(message, title, seconds) {
    try {
      SpreadsheetApp.getActive().toast(message, title || '', seconds || 5);
    } catch (err) {
      console.error(err);
    }
  },
};

/** Simple trigger: the Projeto menu. */
function onOpen() {
  Actions.buildMenu();
}

Actions.register({
  id: 'undoLast', label: 'Desfazer última alteração', group: 'undo', quick: true, logged: false,
  run: () => {
    const r = Undo.last();
    return { message: `Desfeito: ${r.action} (${r.changes} ${r.changes === 1 ? 'alteração' : 'alterações'}).`, undo: r };
  },
});
