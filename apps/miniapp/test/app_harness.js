'use strict';
/**
 * Boots src/app.js in a vm with a tiny fake DOM, fake timers and a fake Telegram.WebApp, so tests
 * can drive the page (MainButton, tabs) without a browser. Only what app.js touches is modelled.
 */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const C = require('../src/core.js');

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dev', 'sample-catalog.json'), 'utf8'));
const APP = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

class FakeNode {
  constructor(doc) { this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; }
  get firstChild() { return this.childNodes[0] || null; }
  get children() { return this.childNodes.filter((n) => n instanceof FakeElement); }
  appendChild(c) {
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this;
    this.childNodes.push(c);
    return c;
  }
  removeChild(c) {
    const i = this.childNodes.indexOf(c);
    if (i >= 0) this.childNodes.splice(i, 1);
    c.parentNode = null;
    return c;
  }
  replaceChild(next, old) {
    const i = this.childNodes.indexOf(old);
    if (i < 0) throw new Error('not a child');
    if (next.parentNode) next.parentNode.removeChild(next);
    this.childNodes[i] = next;
    next.parentNode = this;
    old.parentNode = null;
    return old;
  }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) {
    this.childNodes.forEach((c) => { c.parentNode = null; });
    this.childNodes = [];
    if (v !== '' && v !== null && v !== undefined) this.appendChild(new FakeText(this.ownerDocument, String(v)));
  }
}

class FakeText extends FakeNode {
  constructor(doc, text) { super(doc); this.data = text; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
}

function matchesSimple(el, part) {
  const m = /^([a-z0-9-]*)((?:\.[\w-]+)*)(?:#([\w-]+))?$/i.exec(part);
  if (!m) throw new Error(`fake DOM: unsupported selector ${part}`);
  if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
  const classes = (el.getAttribute('class') || '').split(/\s+/);
  if (m[2] && !m[2].split('.').filter(Boolean).every((c) => classes.includes(c))) return false;
  if (m[3] && el.getAttribute('id') !== m[3]) return false;
  return true;
}

function matches(el, selector) {
  const parts = selector.trim().split(/\s+/);
  if (!matchesSimple(el, parts[parts.length - 1])) return false;
  let i = parts.length - 2;
  for (let p = el.parentNode; p && i >= 0; p = p.parentNode) {
    if (p instanceof FakeElement && matchesSimple(p, parts[i])) i--;
  }
  return i < 0;
}

class FakeElement extends FakeNode {
  constructor(doc, tag) {
    super(doc);
    this.tagName = tag.toUpperCase();
    this.attrs = {};
    this.listeners = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.hidden = false;
    this.value = '';
    this.disabled = false;
    this.checked = false;
    const cls = () => (this.attrs.class || '').split(/\s+/).filter(Boolean);
    const set = (list) => { this.attrs.class = list.join(' '); };
    this.classList = {
      add: (...c) => set([...new Set([...cls(), ...c])]),
      remove: (...c) => set(cls().filter((x) => !c.includes(x))),
      toggle: (c, force) => {
        const on = force === undefined ? !cls().includes(c) : !!force;
        if (on) set([...new Set([...cls(), c])]); else set(cls().filter((x) => x !== c));
        return on;
      },
      contains: (c) => cls().includes(c),
    };
  }
  get className() { return this.attrs.class || ''; }
  set className(v) { this.attrs.class = String(v); }
  get id() { return this.attrs.id || ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
  set innerHTML(v) { this.textContent = ''; this.appendChild(new FakeElement(this.ownerDocument, 'svg')); }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
  dispatchEvent(ev) {
    ev.currentTarget = this;
    (this.listeners[ev.type] || []).slice().forEach((fn) => fn.call(this, ev));
    if (ev.bubbles && this.parentNode) this.parentNode.dispatchEvent(ev);
    return true;
  }
  click() { this.dispatchEvent({ type: 'click', bubbles: true, target: this, preventDefault() {}, stopPropagation() { this.bubbles = false; } }); }
  focus() { this.ownerDocument.activeElement = this; }
  blur() {}
  scrollIntoView() {}
  getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  matches(selector) { return matches(this, selector); }
  querySelectorAll(selector) {
    const out = [];
    const walk = (n) => n.children.forEach((c) => { if (matches(c, selector)) out.push(c); walk(c); });
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  replaceChildren(...nodes) {
    this.textContent = '';
    nodes.forEach((n) => this.appendChild(typeof n === 'string' ? new FakeText(this.ownerDocument, n) : n));
  }
}

class FakeDocument extends FakeElement {
  constructor() {
    super(null, '#document');
    this.ownerDocument = this;
    this.activeElement = null;
    this.documentElement = this.appendChild(new FakeElement(this, 'html'));
    this.body = this.documentElement.appendChild(new FakeElement(this, 'body'));
  }
  createElement(tag) { return new FakeElement(this, tag); }
  createTextNode(text) { return new FakeText(this, String(text)); }
  createRange() { return { selectNodeContents() {} }; }
  getElementById(id) { return this.querySelectorAll(`#${id}`)[0] || null; }
}

function page(doc) {
  const el = (tag, attrs, parent) => {
    const e = doc.createElement(tag);
    Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k]));
    (parent || doc.body).appendChild(e);
    return e;
  };
  el('p', { id: 'preview-banner' }).hidden = true;
  el('button', { id: 'shape', type: 'button', 'aria-label': 'Pulso: toque para uma dica', 'aria-describedby': 'say' });
  el('p', { id: 'say' });
  const nav = el('nav', { class: 'tabs' });
  el('button', { class: 'tab', id: 'tab-workout', 'data-view': 'workout' }, nav);
  el('button', { class: 'tab', id: 'tab-food', 'data-view': 'food' }, nav);
  el('div', { id: 'dates' });
  el('main', { id: 'view' });
  el('section', { id: 'review' }).hidden = true;
  const dock = el('div', { id: 'dock' });
  dock.hidden = true;
  el('button', { id: 'dock-secondary' }, dock).hidden = true;
  el('button', { id: 'dock-primary' }, dock);
  el('div', { id: 'sheet-backdrop' }).hidden = true;
  el('div', { id: 'sheet' }).hidden = true;
}

function fakeTimers() {
  let now = 0;
  let next = 1;
  const queue = new Map();
  return {
    setTimeout(fn, ms) { const id = next++; queue.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout(id) { queue.delete(id); },
    /** Runs every timer due within `ms`, in time order (the 8 s catalog timeout stays pending). */
    run(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...queue.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        queue.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

function fakeTelegram() {
  const main = {
    params: {},
    handler: null,
    onClick(fn) { this.handler = fn; },
    setParams(p) { Object.assign(this.params, p); },
    setText(t) { this.params.text = t; },
    show() { this.params.is_visible = true; },
    hide() { this.params.is_visible = false; },
    enable() { this.params.is_active = true; },
    disable() { this.params.is_active = false; },
    showProgress() { this.progress = true; },
    hideProgress() { this.progress = false; },
  };
  return {
    platform: 'android',
    initData: '',
    colorScheme: 'light',
    sent: [],
    failSend: false,
    ready() {},
    expand() {},
    onEvent() {},
    isVersionAtLeast: () => true,
    setHeaderColor() {},
    setBackgroundColor() {},
    showConfirm(text, cb) { cb(true); },
    HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
    BackButton: { onClick(fn) { this.handler = fn; }, show() {}, hide() {} },
    MainButton: main,
    sendData(data) {
      if (this.failSend) throw new Error('WebAppDataInvalid');
      this.sent.push(data);
    },
  };
}

function storageWith(entries) {
  const m = new Map(Object.entries(entries || {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    map: m,
  };
}

function blob(catalog) {
  return zlib.deflateRawSync(Buffer.from(JSON.stringify(catalog), 'utf8'), { level: 9 }).toString('base64url');
}

/**
 * Starts the page inside "Telegram". opts: {view: 'workout'|'food', storage, catalog, globals}
 * (`globals`: extra page globals, or a function of the page context returning them).
 * Resolves once the catalog is decoded and the form rendered.
 */
async function boot(opts = {}) {
  const doc = new FakeDocument();
  page(doc);
  const timers = fakeTimers();
  const tg = fakeTelegram();
  const storage = opts.storage || storageWith();
  const catalog = opts.catalog || SAMPLE;
  const ctx = {
    document: doc,
    Element: FakeElement,
    location: { hash: `#v=${opts.view || 'workout'}&c=${blob(catalog)}`, search: '' },
    localStorage: storage,
    navigator: {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    scrollTo() {},
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    confirm: () => true,
    console,
    ShapeCore: C,
    Telegram: { WebApp: tg },
  };
  Object.assign(ctx, typeof opts.globals === 'function' ? opts.globals(ctx) : opts.globals || {});
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(APP, ctx, { filename: 'app.js' });
  for (let i = 0; i < 500 && !tg.MainButton.params.text; i++) await new Promise((r) => setImmediate(r));
  if (!tg.MainButton.params.text) throw new Error(`the page did not start: ${doc.getElementById('say').textContent}`);
  return {
    doc,
    tg,
    timers,
    storage,
    review: doc.getElementById('review'),
    /** A Telegram MainButton tap (the client ignores taps while the button is inactive). */
    press() { if (tg.MainButton.params.is_active !== false) tg.MainButton.handler(); },
    tab(view) { doc.getElementById(`tab-${view}`).click(); },
    say() { return doc.getElementById('say').textContent; },
    focus(field) {
      const previous = doc.activeElement;
      doc.activeElement = field;
      if (previous) doc.dispatchEvent({ type: 'focusout', target: previous });
      if (field) doc.dispatchEvent({ type: 'focusin', target: field });
    },
    input(field, value) {
      field.value = value;
      field.dispatchEvent({ type: 'input', target: field, bubbles: true });
    },
  };
}

const today = (catalog) => C.todayIn((catalog || SAMPLE).tz, new Date());

/** A workout draft that is valid as is: the session marked done, no exercises. */
function doneWorkoutDraft(date, session) {
  const key = `shape-miniapp:v2:w:${encodeURIComponent(SAMPLE.client)}:${date}:${encodeURIComponent(session)}`;
  return { [key]: { v: 1, savedAt: 1, date, session, complete: true, cards: [] } };
}

/** A meal draft that is valid as is (a free description needs no catalog). */
function foodDraft(date, extra) {
  const item = { kind: 'description', description: 'pastel de feira', qty: '', unit: '', note: '' };
  return { [`shape-miniapp:v2:f:${encodeURIComponent(SAMPLE.client)}`]: Object.assign({ v: 1, savedAt: 1, date, meal: 'Almoço', items: [item] }, extra || {}) };
}

module.exports = { boot, storageWith, doneWorkoutDraft, foodDraft, today, SAMPLE, C };
