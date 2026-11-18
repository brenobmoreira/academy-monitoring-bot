'use strict';
/**
 * C6b-4 DOM, MainButton, mascot states, Plan B, and preview stub tests for apps/miniapp/src/app.js.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { storageWith, today, SAMPLE, C } = require('./app_harness');

const MINIAPP_DIR = path.join(__dirname, '..');
const AVATAR_JS = fs.readFileSync(path.join(MINIAPP_DIR, 'src', 'avatar.js'), 'utf8');
const VOICE_JS = fs.readFileSync(path.join(MINIAPP_DIR, 'src', 'voice.js'), 'utf8');
const VOICE_STUB_JS = fs.readFileSync(path.join(MINIAPP_DIR, 'dev', 'voice-stub.js'), 'utf8');
const APP_JS = fs.readFileSync(path.join(MINIAPP_DIR, 'src', 'app.js'), 'utf8');

function makeCode(ref, extraPayload) {
  const payload = Object.assign({ r: ref, iat: 1700000000, exp: 1700000900 }, extraPayload || {});
  const p = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHash('sha256').update(p).digest().toString('base64url').slice(0, 43);
  return 'c1.' + p + '.' + sig;
}

function makeVoiceCatalog(overrides) {
  const nowSec = 1700000100;
  return Object.assign({}, SAMPLE, {
    vu: 'https://voice.example.test',
    vc: makeCode('acct-a'),
    vx: nowSec + 900,
  }, overrides || {});
}

function makeFakeDOM() {
  // Reuse app_harness's exact DOM classes by evaluating a lightweight loader via a custom FakeDOM
  // or building compatible nodes. Let's inspect what app_harness exposes: app_harness doesn't export
  // FakeDocument directly, so let's require node:vm and wrap a minimal DOM or clone via boot.
  // Actually, app_harness exports `boot`, which takes `{ view, storage, catalog, globals }`.
  // Wait: for preview (!inTelegram) tests we need Telegram: null and location.hash = ''.
  // Let's build a clean minimal DOM compatible with app.js + voice_ui tests!
  class Node {
    constructor(doc) {
      this.ownerDocument = doc;
      this.childNodes = [];
      this.parentNode = null;
    }
    get firstChild() { return this.childNodes[0] || null; }
    get children() { return this.childNodes.filter((n) => n instanceof El); }
    appendChild(c) {
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      this.childNodes.push(c);
      return c;
    }
    insertBefore(c, ref) {
      if (!ref) return this.appendChild(c);
      const idx = this.childNodes.indexOf(ref);
      if (idx < 0) return this.appendChild(c);
      if (c.parentNode) c.parentNode.removeChild(c);
      c.parentNode = this;
      this.childNodes.splice(idx, 0, c);
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
      if (v !== '' && v !== null && v !== undefined) this.appendChild(new Txt(this.ownerDocument, String(v)));
    }
  }
  class Txt extends Node {
    constructor(doc, text) { super(doc); this.data = text; }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
  }
  function matchesSimple(el, part) {
    if (part.endsWith(':last-child')) {
      if (!el.parentNode || el.parentNode.children.at(-1) !== el) return false;
      part = part.slice(0, -11);
    }
    const m = /^([a-z0-9-]*)((?:\.[\w-]+)*)(?:#([\w-]+))?$/i.exec(part);
    if (!m) throw new Error(`unsupported selector ${part}`);
    if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
    const classes = (el.getAttribute('class') || '').split(/\s+/);
    if (m[2] && !m[2].split('.').filter(Boolean).every((c) => classes.includes(c))) return false;
    if (m[3] && el.getAttribute('id') !== m[3]) return false;
    return true;
  }
  function matches(el, selector) {
    if (selector.includes(' > ')) {
      const [parent, child] = selector.split(' > ');
      return matchesSimple(el, child) && el.parentNode instanceof El && matches(el.parentNode, parent);
    }
    const parts = selector.trim().split(/\s+/);
    if (!matchesSimple(el, parts[parts.length - 1])) return false;
    let i = parts.length - 2;
    for (let p = el.parentNode; p && i >= 0; p = p.parentNode) {
      if (p instanceof El && matchesSimple(p, parts[i])) i--;
    }
    return i < 0;
  }
  class El extends Node {
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
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; if (k === 'disabled') this.disabled = true; }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
    removeAttribute(k) { delete this.attrs[k]; if (k === 'disabled') this.disabled = false; }
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); }
    set innerHTML(v) { this.textContent = ''; this.appendChild(new El(this.ownerDocument, 'svg')); }
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
    removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn); }
    dispatchEvent(ev) {
      ev.currentTarget = this;
      (this.listeners[ev.type] || []).slice().forEach((fn) => fn.call(this, ev));
      if (ev.bubbles && this.parentNode) this.parentNode.dispatchEvent(ev);
      return true;
    }
    click() {
      if (this.disabled || this.hasAttribute('disabled')) return;
      this.dispatchEvent({ type: 'click', bubbles: true, target: this, preventDefault() {}, stopPropagation() { this.bubbles = false; } });
    }
    focus() { this.ownerDocument.activeElement = this; }
    blur() {}
    scrollIntoView() {}
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
    matches(selector) { return matches(this, selector); }
    closest(selector) {
      for (let el = this; el instanceof El; el = el.parentNode) if (matches(el, selector)) return el;
      return null;
    }
    querySelectorAll(selector) {
      const out = [];
      const walk = (n) => n.children.forEach((c) => { if (matches(c, selector)) out.push(c); walk(c); });
      walk(this);
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    replaceChildren(...nodes) {
      this.textContent = '';
      nodes.forEach((n) => this.appendChild(typeof n === 'string' ? new Txt(this.ownerDocument, n) : n));
    }
  }
  class Doc extends El {
    constructor() {
      super(null, '#document');
      this.ownerDocument = this;
      this.activeElement = null;
      this.hidden = false;
      this.documentElement = this.appendChild(new El(this, 'html'));
      this.body = this.documentElement.appendChild(new El(this, 'body'));
    }
    createElement(tag) { return new El(this, tag); }
    createTextNode(text) { return new Txt(this, String(text)); }
    createRange() { return { selectNodeContents() {} }; }
    getElementById(id) { return this.querySelectorAll(`#${id}`)[0] || null; }
  }
  const doc = new Doc();
  const el = (tag, attrs, parent) => {
    const e = doc.createElement(tag);
    Object.keys(attrs).forEach((k) => e.setAttribute(k, attrs[k]));
    (parent || doc.body).appendChild(e);
    return e;
  };
  el('p', { id: 'preview-banner' }).hidden = true;
  el('button', { id: 'shape', type: 'button', 'data-state': 'idle' });
  el('p', { id: 'say' });
  const nav = el('nav', { class: 'tabs' });
  el('button', { class: 'tab', id: 'tab-workout', 'data-view': 'workout' }, nav);
  el('button', { class: 'tab', id: 'tab-food', 'data-view': 'food' }, nav);
  el('div', { id: 'dates' });
  el('main', { id: 'view' });
  el('section', { id: 'voice-panel', class: 'voice-panel' }).hidden = true;
  el('section', { id: 'review' }).hidden = true;
  const dock = el('div', { id: 'dock', class: 'dock' });
  dock.hidden = true;
  el('button', { id: 'dock-secondary', class: 'dock-secondary' }, dock).hidden = true;
  el('button', { id: 'dock-primary', class: 'dock-primary' }, dock);
  el('button', { id: 'dock-mic', class: 'dock-mic' }, dock).hidden = true;
  el('div', { id: 'sheet-backdrop' }).hidden = true;
  el('div', { id: 'sheet' }).hidden = true;
  return { doc, El };
}

function makeFakeTelegram() {
  const events = {};
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
  };
  return {
    platform: 'android',
    initData: '',
    colorScheme: 'light',
    isExpanded: true,
    sent: [],
    closed: 0,
    events,
    ready() {},
    expand() {},
    close() { this.closed += 1; },
    onEvent(name, fn) { (events[name] = events[name] || []).push(fn); },
    emit(name, payload) { (events[name] || []).forEach((fn) => fn(payload)); },
    isVersionAtLeast: () => true,
    setHeaderColor() {},
    setBackgroundColor() {},
    showConfirm(text, cb) { cb(true); },
    HapticFeedback: { impactOccurred() {}, notificationOccurred() {}, selectionChanged() {} },
    BackButton: { onClick(fn) { this.handler = fn; }, show() {}, hide() {} },
    MainButton: main,
    sendData(data) { this.sent.push(data); },
  };
}

function makeFakeMediaHarness() {
  const tracks = [];
  const recorders = [];
  let deferredGum = null;

  class FakeMediaRecorder {
    constructor(stream, opts) {
      this.stream = stream;
      this.mimeType = (opts && opts.mimeType) || 'audio/webm;codecs=opus';
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
      this.onerror = null;
      recorders.push(this);
    }
    static isTypeSupported(mime) {
      return mime === 'audio/webm;codecs=opus';
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      Promise.resolve().then(() => {
        if (this.ondataavailable) this.ondataavailable({ data: new Uint8Array([10, 20, 30]) });
        if (this.onstop) this.onstop();
      });
    }
  }

  function makeStream() {
    const track = { kind: 'audio', readyState: 'live', stopCalls: 0, stop() { this.stopCalls += 1; this.readyState = 'ended'; } };
    tracks.push(track);
    return {
      getTracks: () => [track],
      getAudioTracks: () => [track],
    };
  }

  return {
    tracks,
    recorders,
    deferPermission() {
      let resolveFn, rejectFn;
      const p = new Promise((res, rej) => { resolveFn = res; rejectFn = rej; });
      deferredGum = { promise: p, resolve: () => resolveFn(makeStream()), reject: (err) => rejectFn(err) };
      return deferredGum;
    },
    getUserMedia() {
      if (deferredGum) {
        const current = deferredGum;
        deferredGum = null;
        return current.promise;
      }
      return Promise.resolve(makeStream());
    },
    MediaRecorder: FakeMediaRecorder,
  };
}

function blobCatalog(catalog) {
  return zlib.deflateRawSync(Buffer.from(JSON.stringify(catalog), 'utf8'), { level: 9 }).toString('base64url');
}

async function flushMicrotasks(n = 12) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

async function bootApp(opts = {}) {
  const { doc, El } = makeFakeDOM();
  const storage = opts.storage || storageWith();
  const tg = opts.telegram === null ? null : (opts.telegram || makeFakeTelegram());
  let nowMs = opts.nowMs !== undefined ? opts.nowMs : 1700000100000;
  const FakeDate = class extends Date {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
  };
  const timers = [];
  let nextTimerId = 1;
  const setTimer = (fn, ms) => {
    const id = nextTimerId++;
    timers.push({ id, fn, ms });
    return id;
  };
  const clearTimer = (id) => {
    const i = timers.findIndex((t) => t.id === id);
    if (i >= 0) timers.splice(i, 1);
  };
  const ctx = {
    document: doc,
    Element: El,
    Date: FakeDate,
    location: {
      hash: opts.preview ? '' : `#v=${opts.view || 'workout'}&c=${blobCatalog(opts.catalog || makeVoiceCatalog())}`,
      search: '',
    },
    localStorage: storage,
    navigator: opts.navigator || {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    setTimeout: setTimer,
    clearTimeout: clearTimer,
    scrollTo() {},
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    confirm: () => true,
    console,
    fetch: opts.fetch,
    ShapeCore: C,
    Telegram: tg ? { WebApp: tg } : undefined,
    addEventListener(type, fn) { (this._winListeners[type] = this._winListeners[type] || []).push(fn); },
    removeEventListener(type, fn) { this._winListeners[type] = (this._winListeners[type] || []).filter((f) => f !== fn); },
    dispatchEvent(ev) {
      const list = (this._winListeners[ev.type] || []).slice();
      for (const fn of list) fn.call(this, ev);
      return true;
    },
    _winListeners: {},
  };
  Object.assign(ctx, opts.globals || {});
  ctx.window = ctx;
  vm.createContext(ctx);
  if (opts.loadAvatar) {
    vm.runInContext(AVATAR_JS, ctx, { filename: 'avatar.js' });
  }
  vm.runInContext(VOICE_JS, ctx, { filename: 'voice.js' });
  if (opts.loadStub !== false) {
    vm.runInContext(VOICE_STUB_JS, ctx, { filename: 'voice-stub.js' });
  }
  vm.runInContext(APP_JS, ctx, { filename: 'app.js' });

  const deadline = Date.now() + 5000;
  const started = () => (tg ? !!tg.MainButton.params.text : doc.getElementById('dock-primary').textContent !== '');
  while (!started() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1));
  if (!started()) throw new Error(`page did not start: ${doc.getElementById('say').textContent}`);
  await flushMicrotasks();

  return {
    doc,
    ctx,
    tg,
    storage,
    setNow(ms) { nowMs = ms; },
    advanceMs(ms) { nowMs += ms; },
    button(text) {
      return doc.querySelectorAll('button').find((b) => !b.hidden && b.textContent === text) || null;
    },
    pressMain() {
      if (tg) {
        if (tg.MainButton.params.is_visible && tg.MainButton.params.is_active !== false) tg.MainButton.handler();
      } else {
        doc.getElementById('dock-primary').click();
      }
    },
    runPendingTimers(predicate) {
      const list = timers.splice(0, timers.length);
      for (const t of list) {
        if (!predicate || predicate(t)) t.fn();
        else timers.push(t);
      }
    },
  };
}

test('C6b-4 preview (!inTelegram): shows dock mic, uses dev stub, never calls real network for voice', async () => {
  const realFetchUrls = [];
  const p = await bootApp({
    preview: true,
    telegram: null,
    fetch: async (url) => {
      realFetchUrls.push(String(url));
      assert.equal(url, 'dev/sample-catalog.json');
      return { ok: true, status: 200, json: async () => SAMPLE };
    },
  });

  const micBtn = p.doc.getElementById('dock-mic');
  assert.equal(micBtn.hidden, false);
  assert.equal(p.doc.getElementById('preview-banner').hidden, false);

  // First click shows one-time consent
  micBtn.click();
  assert.equal(p.doc.getElementById('voice-panel').hidden, false);
  assert.ok(p.button('Entendi'));
  assert.equal(p.doc.getElementById('view').classList.contains('is-voice-locked'), true);

  // Accept consent -> asks mic -> stub resolves -> listening
  p.button('Entendi').click();
  await flushMicrotasks();
  assert.equal(p.doc.getElementById('shape').getAttribute('data-state'), 'listening');
  assert.equal(p.storage.getItem(C.VOICE_CONSENT_KEY), '1');

  // Stop after 1.5s -> sending -> recorder onstop (0ms) -> stub fetch resolves after its 250ms timer
  p.advanceMs(1500);
  p.button('Parar').click();
  await flushMicrotasks();
  assert.equal(p.doc.getElementById('shape').getAttribute('data-state'), 'thinking');

  // Fire recorder onstop (0ms) then stub's 250ms timeout
  p.runPendingTimers((t) => t.ms === 0);
  await flushMicrotasks();
  p.runPendingTimers((t) => t.ms === 250);
  await flushMicrotasks();

  const ta = p.doc.getElementById('voice-textarea');
  assert.ok(ta);
  assert.equal(ta.value, p.ctx.ShapeVoiceStub.SAMPLES.workout);
  assert.equal(p.doc.getElementById('dock-primary').textContent, 'Enviar');

  // Confirm -> displays JSON locally in preview; never hits real network
  p.pressMain();
  const out = p.doc.getElementById('voice-json-out');
  assert.ok(out);
  const parsed = JSON.parse(out.textContent);
  assert.equal(parsed.t, 'text');
  assert.equal(parsed.src, 'voice');
  assert.equal(parsed.text, p.ctx.ShapeVoiceStub.SAMPLES.workout);
  assert.deepEqual(realFetchUrls, ['dev/sample-catalog.json']);

  // Second run skips consent
  p.button('Gravar outro').click();
  await flushMicrotasks();
  assert.equal(p.doc.getElementById('shape').getAttribute('data-state'), 'listening');
});

test('C6b-4 Telegram without vu keeps existing forms untouched and mic button hidden', async () => {
  const media = makeFakeMediaHarness();
  const p = await bootApp({
    catalog: SAMPLE,
    navigator: { mediaDevices: { getUserMedia: () => media.getUserMedia() } },
    globals: { MediaRecorder: media.MediaRecorder },
  });
  assert.equal(p.doc.getElementById('dock-mic').hidden, true);
  assert.equal(p.doc.getElementById('dock').hidden, true);
  assert.equal(p.tg.MainButton.params.text, 'Revisar treino');
});

test('C6b-4 Telegram voice happy path: MainButton hand-over, mascot state names, read-only lock, sendData only confirmed textPayload', async () => {
  const media = makeFakeMediaHarness();
  const fetchCalls = [];
  const p = await bootApp({
    catalog: makeVoiceCatalog(),
    navigator: { mediaDevices: { getUserMedia: () => media.getUserMedia() } },
    globals: { MediaRecorder: media.MediaRecorder },
    fetch: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      if (String(url).endsWith('/v1/auth/sessions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ v: 1, session: 's1.live-token', expires_at: 1700043200, scopes: ['voice'], ref: 'acct-a' }),
        };
      }
      if (String(url).endsWith('/v1/voice/transcriptions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ v: 1, id: 'a'.repeat(32), text: 'supino 80 kg por 8' }),
        };
      }
      throw new Error('unexpected url: ' + url);
    },
  });

  // Startup redeemed vc once
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.endsWith('/v1/auth/sessions'));

  // Button visible on both Treino and Refeição views
  const micBtn = p.doc.getElementById('dock-mic');
  assert.equal(micBtn.hidden, false);
  assert.equal(p.doc.getElementById('dock').classList.contains('dock-voice-only'), true);
  p.doc.getElementById('tab-food').click();
  assert.equal(micBtn.hidden, false);
  p.doc.getElementById('tab-workout').click();
  assert.equal(micBtn.hidden, false);

  // Fill a form field before opening voice to verify draft stays preserved
  const kgInput = p.doc.querySelector('.card .step-input');
  kgInput.value = '75';
  kgInput.dispatchEvent({ type: 'input', target: kgInput, bubbles: true });

  // Start -> consent -> Entendi -> listening
  micBtn.click();
  p.button('Entendi').click();
  await flushMicrotasks();

  const shape = p.doc.getElementById('shape');
  assert.equal(shape.getAttribute('data-state'), 'listening');
  assert.equal(shape.classList.contains('voice-listening'), true);
  assert.equal(p.doc.getElementById('view').classList.contains('is-voice-locked'), true);
  assert.equal(kgInput.disabled, true);
  assert.equal(p.tg.MainButton.params.is_visible, false);

  // Advance 12s and tick timer -> 0:12 / 1:30; Stop -> sending -> thinking mascot -> transcribed
  p.advanceMs(12000);
  p.runPendingTimers((t) => t.ms === 250);
  assert.equal(p.doc.getElementById('voice-timer').textContent, '0:12 / 1:30');

  p.button('Parar').click();
  assert.equal(shape.getAttribute('data-state'), 'thinking');
  assert.equal(shape.classList.contains('voice-thinking'), true);
  assert.equal(media.tracks[0].readyState, 'ended');
  assert.equal(p.tg.MainButton.params.is_visible, false);

  await flushMicrotasks();
  const ta = p.doc.getElementById('voice-textarea');
  assert.ok(ta);
  assert.equal(ta.value, 'supino 80 kg por 8');
  assert.equal(p.tg.MainButton.params.is_visible, true);
  assert.equal(p.tg.MainButton.params.text, 'Enviar');

  // Empty text refuses sendData and keeps exact textarea DOM node
  ta.value = '   ';
  ta.dispatchEvent({ type: 'input', target: ta, bubbles: true });
  p.pressMain();
  assert.equal(p.tg.sent.length, 0);
  assert.equal(p.doc.getElementById('voice-textarea'), ta);
  assert.equal(ta.classList.contains('is-bad'), true);
  assert.equal(p.doc.getElementById('voice-text-error').hidden, false);

  // Edit to valid text and confirm via Telegram MainButton
  ta.value = '  supino 82,5 kg por 8  ';
  ta.dispatchEvent({ type: 'input', target: ta, bubbles: true });
  p.pressMain();

  assert.equal(p.tg.sent.length, 1);
  const sentObj = JSON.parse(p.tg.sent[0]);
  assert.deepEqual(Object.keys(sentObj).sort(), ['id', 'src', 't', 'text', 'v']);
  assert.equal(sentObj.v, 1);
  assert.equal(sentObj.t, 'text');
  assert.equal(sentObj.src, 'voice');
  assert.match(sentObj.id, /^[0-9a-f]{32}$/);
  assert.equal(sentObj.text, 'supino 82,5 kg por 8');

  // Form unlocks and keeps prior draft intact
  assert.equal(p.doc.getElementById('view').classList.contains('is-voice-locked'), false);
  assert.equal(kgInput.disabled, false);
  assert.equal(kgInput.value, '75');
});

test('C6b-4 Plan B closes Telegram Mini App on unsupported device and on expired session', async () => {
  // Case A: unsupported device (no getUserMedia / MediaRecorder)
  const p1 = await bootApp({
    catalog: makeVoiceCatalog(),
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ v: 1, session: 's1.live-token', expires_at: 1700043200, scopes: ['voice'], ref: 'acct-a' }),
    }),
  });
  const mic1 = p1.doc.getElementById('dock-mic');
  assert.equal(mic1.hidden, false);
  mic1.click();
  assert.ok(p1.doc.getElementById('voice-panel').textContent.includes('Este aparelho não grava aqui.'));
  p1.button('Gravar no chat').click();
  assert.ok(p1.doc.getElementById('voice-panel').textContent.includes('Feche e segure o 🎤 na conversa'));
  assert.equal(p1.tg.MainButton.params.text, 'Fechar app');
  p1.button('Fechar app').click();
  assert.equal(p1.tg.closed, 1);

  // Case B: expired/rejected auth (401 auth_expired on startup)
  const media = makeFakeMediaHarness();
  const p2 = await bootApp({
    catalog: makeVoiceCatalog(),
    navigator: { mediaDevices: { getUserMedia: () => media.getUserMedia() } },
    globals: { MediaRecorder: media.MediaRecorder },
    fetch: async () => ({
      ok: false,
      status: 401,
      json: async () => ({ v: 1, error: { code: 'auth_expired', message: 'Envie /app para renovar a voz.', retry: false } }),
    }),
  });
  const mic2 = p2.doc.getElementById('dock-mic');
  assert.equal(mic2.hidden, false);
  assert.equal(mic2.classList.contains('is-disabled'), true);
  mic2.click();
  assert.ok(p2.doc.getElementById('voice-panel').textContent.includes('Envie /app para renovar a voz.'));
  p2.button('Gravar no chat').click();
  p2.pressMain(); // MainButton 'Fechar app'
  assert.equal(p2.tg.closed, 1);
});

test('C6b-4 visibilitychange, viewportChanged collapse, and cancelled permission clean up tracks and abort fetch', async () => {
  const media = makeFakeMediaHarness();
  let abortSeen = false;
  const p = await bootApp({
    catalog: makeVoiceCatalog(),
    storage: storageWith({ [C.VOICE_CONSENT_KEY]: '1' }),
    navigator: { mediaDevices: { getUserMedia: () => media.getUserMedia() } },
    globals: { MediaRecorder: media.MediaRecorder },
    fetch: async (url, init) => {
      if (String(url).endsWith('/v1/auth/sessions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ v: 1, session: 's1.tok', expires_at: 1700043200, scopes: ['voice'], ref: 'acct-a' }),
        };
      }
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          abortSeen = true;
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    },
  });

  // 1) Cancel before getUserMedia resolves -> late permission stops tracks & never starts recorder
  const deferred = media.deferPermission();
  p.doc.getElementById('dock-mic').click();
  p.button('Cancelar').click();
  deferred.resolve();
  await flushMicrotasks();
  assert.equal(media.tracks.length, 1);
  assert.equal(media.tracks[0].stopCalls, 1);
  assert.equal(media.recorders.length, 0);

  // 2) visibilitychange hidden during listening stops recorder and tracks
  p.doc.getElementById('dock-mic').click();
  await flushMicrotasks();
  assert.equal(media.recorders.length, 1);
  assert.equal(media.recorders[0].state, 'recording');
  p.doc.hidden = true;
  p.doc.dispatchEvent({ type: 'visibilitychange', target: p.doc });
  assert.equal(media.recorders[0].state, 'inactive');
  assert.equal(media.tracks[1].stopCalls, 1);
  assert.equal(p.doc.getElementById('voice-panel').hidden, true);
  p.doc.hidden = false;

  // 3) viewportChanged collapse during sending aborts upload
  p.doc.getElementById('dock-mic').click();
  await flushMicrotasks();
  p.advanceMs(1000);
  p.button('Parar').click();
  await flushMicrotasks();
  assert.equal(abortSeen, false);
  p.tg.isExpanded = false;
  p.tg.emit('viewportChanged', { isExpanded: false });
  assert.equal(abortSeen, true);
  assert.equal(p.doc.getElementById('voice-panel').hidden, true);
  assert.equal(p.doc.getElementById('view').classList.contains('is-voice-locked'), false);
});

test('C6b-fix3: preview (!inTelegram) with real global getUserMedia and MediaRecorder starts recorder without api_missing', async () => {
  const media = makeFakeMediaHarness();
  let gumCalls = 0;
  const mediaDevices = {
    getUserMedia(constraints) {
      if (this !== mediaDevices) {
        return Promise.reject(new TypeError('Illegal invocation'));
      }
      gumCalls += 1;
      return media.getUserMedia(constraints);
    },
  };
  assert.equal(typeof mediaDevices.getUserMedia, 'function');

  const p = await bootApp({
    preview: true,
    telegram: null,
    navigator: { mediaDevices },
    globals: { MediaRecorder: media.MediaRecorder },
    fetch: async (url) => {
      assert.equal(url, 'dev/sample-catalog.json');
      return { ok: true, status: 200, json: async () => SAMPLE };
    },
  });

  p.doc.getElementById('dock-mic').click();
  p.button('Entendi').click();
  await flushMicrotasks();

  assert.equal(gumCalls, 1, 'real global navigator.mediaDevices.getUserMedia must be called');
  assert.equal(media.recorders.length, 1, 'real global MediaRecorder must start');
  assert.equal(p.doc.getElementById('shape').getAttribute('data-state'), 'listening');
  assert.equal(p.doc.getElementById('voice-panel').textContent.includes('Este aparelho não grava aqui.'), false);

  p.advanceMs(1500);
  p.button('Parar').click();
  await flushMicrotasks();
  p.runPendingTimers((t) => t.ms === 250);
  await flushMicrotasks();

  const ta = p.doc.getElementById('voice-textarea');
  assert.ok(ta);
  assert.equal(ta.value, p.ctx.ShapeVoiceStub.SAMPLES.workout);
});

test('C6b-fix4: voice lock disables date navigation and tabs (click and keyboard) and keeps recreated controls disabled', async () => {
  const media = makeFakeMediaHarness();
  const tg = makeFakeTelegram();
  let pendingConfirm = null;
  tg.showConfirm = (_text, cb) => { pendingConfirm = cb; };

  const p = await bootApp({
    catalog: makeVoiceCatalog(),
    telegram: tg,
    storage: storageWith({ [C.VOICE_CONSENT_KEY]: '1' }),
    navigator: { mediaDevices: { getUserMedia: () => media.getUserMedia() } },
    globals: { MediaRecorder: media.MediaRecorder },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ v: 1, session: 's1.lock-tok', expires_at: 1700043200, scopes: ['voice'], ref: 'acct-a' }),
    }),
  });

  function collectFormControls() {
    const roots = [p.doc.querySelector('.tabs'), p.doc.getElementById('dates'), p.doc.getElementById('view')];
    const out = [];
    for (const r of roots) {
      for (const sel of ['input', 'textarea', 'button', 'select']) {
        out.push(...r.querySelectorAll(sel));
      }
    }
    return out;
  }

  function pressButtonKey(btn, key) {
    let prevented = false;
    btn.dispatchEvent({
      type: 'keydown',
      key,
      bubbles: true,
      target: btn,
      preventDefault() { prevented = true; },
      stopPropagation() { this.bubbles = false; },
    });
    // Browser native button activation fires click on Enter/Space ONLY if not disabled
    if (!prevented && (key === 'Enter' || key === ' ') && !btn.disabled && !btn.hasAttribute('disabled')) {
      btn.click();
    }
  }

  // Enter a value and queue an async confirmDialog ("Limpar este treino") before starting voice
  const origHead = p.doc.querySelector('.card .card-head');
  const kgInput = p.doc.querySelector('.card .step-input');
  kgInput.value = '80';
  kgInput.dispatchEvent({ type: 'input', target: kgInput, bubbles: true });
  p.button('Limpar este treino').click();
  assert.equal(typeof pendingConfirm, 'function');

  // Start voice recording -> listening
  p.doc.getElementById('dock-mic').click();
  await flushMicrotasks();
  assert.equal(media.recorders.length, 1);
  assert.equal(media.recorders[0].state, 'recording');

  // Every control in #tabs, #dates, and #view must be disabled via property AND attribute
  const dateBtns = p.doc.getElementById('dates').querySelectorAll('button');
  assert.ok(dateBtns.length >= 2);
  const hojeBtn = dateBtns[0];
  const ontemBtn = dateBtns[1];
  assert.equal(hojeBtn.getAttribute('aria-checked'), 'true');
  assert.equal(ontemBtn.getAttribute('aria-checked'), 'false');

  for (const btn of dateBtns) {
    assert.equal(btn.disabled, true, 'date button must have .disabled = true');
    assert.equal(btn.hasAttribute('disabled'), true, 'date button must have disabled attribute');
  }
  const controlsBefore = collectFormControls();
  assert.ok(controlsBefore.length >= 11);
  for (const ctrl of controlsBefore) {
    assert.equal(ctrl.disabled, true);
    assert.equal(ctrl.hasAttribute('disabled'), true);
  }

  // Attempt date & tab switch via click, keyboard (Enter / Space), and raw click dispatch -> all refused
  ontemBtn.click();
  pressButtonKey(ontemBtn, 'Enter');
  pressButtonKey(ontemBtn, ' ');
  ontemBtn.dispatchEvent({ type: 'click', target: ontemBtn, bubbles: true, preventDefault() {}, stopPropagation() { this.bubbles = false; } });
  const foodTab = p.doc.getElementById('tab-food');
  foodTab.click();
  pressButtonKey(foodTab, 'Enter');

  assert.equal(p.doc.getElementById('dates').querySelectorAll('button')[0].getAttribute('aria-checked'), 'true');
  assert.equal(p.doc.getElementById('dates').querySelectorAll('button')[1].getAttribute('aria-checked'), 'false');
  assert.equal(p.doc.getElementById('tab-workout').getAttribute('aria-selected'), 'true');
  assert.equal(p.doc.querySelector('.card .step-input'), kgInput);
  assert.equal(kgInput.value, '80');
  assert.equal(media.recorders[0].state, 'recording');

  // Trigger a view re-render while voice is active (pending showConfirm resolves -> renderWorkout recreates DOM)
  pendingConfirm(true);
  const recreatedHead = p.doc.querySelector('.card .card-head');
  assert.ok(recreatedHead);
  assert.notEqual(recreatedHead, origHead, 'renderWorkout recreated the form DOM');

  const recreatedControls = collectFormControls();
  assert.ok(recreatedControls.length >= 11);
  for (const ctrl of recreatedControls) {
    assert.equal(ctrl.disabled, true, 'recreated control must be born disabled');
    assert.equal(ctrl.hasAttribute('disabled'), true, 'recreated control must carry disabled attribute');
  }
  assert.equal(media.recorders[0].state, 'recording');

  // Cancel voice -> form unlocks all controls (including recreated ones) and date switching works again
  p.button('Cancelar').click();
  assert.equal(media.recorders[0].state, 'inactive');
  for (const ctrl of collectFormControls()) {
    assert.equal(ctrl.disabled, false);
    assert.equal(ctrl.hasAttribute('disabled'), false);
  }
  p.doc.getElementById('dates').querySelectorAll('button')[1].click();
  assert.equal(p.doc.getElementById('dates').querySelectorAll('button')[1].getAttribute('aria-checked'), 'true');
});

test('C6b-fix5: real window pagehide stops tracks/upload and stale permission A settling before B never starts A', async () => {
  const media = makeFakeMediaHarness();
  let abortSeen = false;
  const p = await bootApp({
    catalog: makeVoiceCatalog(),
    storage: storageWith({ [C.VOICE_CONSENT_KEY]: '1' }),
    navigator: { mediaDevices: { getUserMedia: () => media.getUserMedia() } },
    globals: { MediaRecorder: media.MediaRecorder },
    fetch: async (url, init) => {
      if (String(url).endsWith('/v1/auth/sessions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ v: 1, session: 's1.fix5-tok', expires_at: 1700043200, scopes: ['voice'], ref: 'acct-a' }),
        };
      }
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => {
          abortSeen = true;
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    },
  });

  // 1. Permission resolution ordering: A starts -> cancel -> B starts (still asking_permission) -> A resolves BEFORE B
  const defA = media.deferPermission();
  p.doc.getElementById('dock-mic').click();
  p.button('Cancelar').click();
  const defB = media.deferPermission();
  p.doc.getElementById('dock-mic').click();
  assert.equal(p.doc.getElementById('shape').getAttribute('data-state'), 'listening');
  assert.ok(p.doc.getElementById('voice-panel').textContent.includes('Permita o microfone'));

  defA.resolve();
  await flushMicrotasks();
  assert.equal(media.tracks.length, 1);
  assert.equal(media.tracks[0].stopCalls, 1, 'stale stream A must stop immediately');
  assert.equal(media.recorders.length, 0, 'stale stream A must not start MediaRecorder');
  assert.ok(p.doc.getElementById('voice-panel').textContent.includes('Permita o microfone'));

  defB.resolve();
  await flushMicrotasks();
  assert.equal(media.recorders.length, 1);
  assert.equal(media.recorders[0].state, 'recording');
  assert.equal(media.tracks[1].stopCalls, 0);

  // 2. Real window pagehide event during listening stops recorder, stops tracks, hides panel, and unlocks form
  p.ctx.dispatchEvent({ type: 'pagehide', persisted: false, target: p.ctx });
  assert.equal(media.recorders[0].state, 'inactive');
  assert.equal(media.tracks[1].stopCalls, 1);
  assert.equal(p.doc.getElementById('voice-panel').hidden, true);
  assert.equal(p.doc.getElementById('view').classList.contains('is-voice-locked'), false);

  // 3. Real window pagehide event during sending aborts upload fetch and unlocks form
  p.doc.getElementById('dock-mic').click();
  await flushMicrotasks();
  p.advanceMs(1000);
  p.button('Parar').click();
  await flushMicrotasks();
  assert.equal(abortSeen, false);
  p.ctx.dispatchEvent({ type: 'pagehide', persisted: false, target: p.ctx });
  assert.equal(abortSeen, true);
  assert.equal(p.doc.getElementById('voice-panel').hidden, true);
  assert.equal(p.doc.getElementById('view').classList.contains('is-voice-locked'), false);
});

test('Muscle voice integration: ShapeAvatar enters listening, thinking, understood on transcribed, and oops on voice error', async () => {
  const media = makeFakeMediaHarness();
  let failTranscribe = false;
  const p = await bootApp({
    loadAvatar: true,
    catalog: makeVoiceCatalog(),
    storage: storageWith({ [C.VOICE_CONSENT_KEY]: '1' }),
    navigator: { mediaDevices: { getUserMedia: () => media.getUserMedia() } },
    globals: { MediaRecorder: media.MediaRecorder },
    fetch: async (url) => {
      if (String(url).endsWith('/v1/auth/sessions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ v: 1, session: 's1.muscle-tok', expires_at: 1700043200, scopes: ['voice'], ref: 'acct-a' }),
        };
      }
      if (failTranscribe) {
        return {
          ok: false,
          status: 502,
          json: async () => ({ v: 1, error: { code: 'provider_error', message: 'Falha ao transcrever.', retry: true } }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ v: 1, id: 'b'.repeat(32), text: 'agachamento 100 kg por 5' }),
      };
    },
  });

  const shape = p.doc.getElementById('shape');
  assert.equal(p.ctx.ShapeAvatar.form(), 'treino');

  // 1) Start recording -> listening
  p.doc.getElementById('dock-mic').click();
  await flushMicrotasks();
  assert.equal(shape.getAttribute('data-state'), 'listening');
  assert.equal(p.ctx.ShapeAvatar.mood(), 'listening');
  assert.equal(shape.classList.contains('voice-listening'), true);

  // 2) Stop -> sending -> thinking
  p.advanceMs(1500);
  p.button('Parar').click();
  assert.equal(shape.getAttribute('data-state'), 'thinking');
  assert.equal(p.ctx.ShapeAvatar.mood(), 'thinking');
  assert.equal(shape.classList.contains('voice-thinking'), true);

  // 3) Transcription arrives -> confirming state enters native 'understood'
  await flushMicrotasks();
  assert.equal(shape.getAttribute('data-state'), 'understood');
  assert.equal(p.ctx.ShapeAvatar.mood(), 'understood');
  assert.equal(shape.classList.contains('voice-understood'), true);

  // Empty text error switches to alert, then editing valid text restores understood
  const ta = p.doc.getElementById('voice-textarea');
  ta.value = '   ';
  ta.dispatchEvent({ type: 'input', target: ta, bubbles: true });
  p.pressMain();
  assert.equal(shape.getAttribute('data-state'), 'alert');
  ta.value = 'agachamento 102,5 kg por 5';
  ta.dispatchEvent({ type: 'input', target: ta, bubbles: true });
  assert.equal(shape.getAttribute('data-state'), 'understood');

  // 4) Rerecord with failing backend -> native 'oops'
  failTranscribe = true;
  p.button('Regravar').click();
  await flushMicrotasks();
  assert.equal(shape.getAttribute('data-state'), 'listening');
  p.advanceMs(1500);
  p.button('Parar').click();
  await flushMicrotasks();
  assert.equal(shape.getAttribute('data-state'), 'oops');
  assert.equal(p.ctx.ShapeAvatar.mood(), 'oops');
  assert.equal(shape.classList.contains('voice-alert'), true);

  // Cancel returns cleanly to form mood and active tab form
  p.button('Cancelar').click();
  assert.equal(shape.classList.contains('voice-alert'), false);
  assert.equal(p.ctx.ShapeAvatar.form(), 'treino');
});

test('Muscle smoothness: setVoiceMascot calls setMood once per transition and typing in #voice-textarea does not re-trigger setMood(understood)', async () => {
  const media = makeFakeMediaHarness();
  const p = await bootApp({
    loadAvatar: true,
    catalog: makeVoiceCatalog(),
    storage: storageWith({ [C.VOICE_CONSENT_KEY]: '1' }),
    navigator: { mediaDevices: { getUserMedia: () => media.getUserMedia() } },
    globals: { MediaRecorder: media.MediaRecorder },
    fetch: async (url) => {
      if (String(url).endsWith('/v1/auth/sessions')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ v: 1, session: 's1.smooth-tok', expires_at: 1700043200, scopes: ['voice'], ref: 'acct-a' }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ v: 1, id: 'c'.repeat(32), text: 'remada 60 kg por 10' }),
      };
    },
  });

  const shape = p.doc.getElementById('shape');
  const moodCalls = [];
  const origSetMood = p.ctx.ShapeAvatar.setMood;
  p.ctx.ShapeAvatar.setMood = function (mood) {
    moodCalls.push(mood);
    return origSetMood.call(this, mood);
  };

  // Start recording -> asking_permission ('listening') -> granted ('listening')
  p.doc.getElementById('dock-mic').click();
  assert.deepEqual(moodCalls, ['listening'], 'setVoiceMascot must call setMood once, not twice');
  await flushMicrotasks();

  // Stop -> sending ('thinking') -> transcribed ('understood')
  moodCalls.length = 0;
  p.advanceMs(1500);
  p.button('Parar').click();
  assert.deepEqual(moodCalls, ['thinking'], 'transition to thinking calls setMood once');

  moodCalls.length = 0;
  await flushMicrotasks();
  assert.deepEqual(moodCalls, ['understood'], 'transition to transcribed calls setMood(understood) once');
  assert.equal(shape.getAttribute('data-state'), 'understood');
  assert.equal(shape.classList.contains('voice-understood'), true);

  // Typing multiple characters in #voice-textarea keeps data-state="understood" without re-triggering setMood
  const ta = p.doc.getElementById('voice-textarea');
  assert.ok(ta);
  moodCalls.length = 0;
  for (const nextVal of ['remada 60 kg por 10!', 'remada 62,5 kg por 10', 'remada 65 kg por 12']) {
    ta.value = nextVal;
    ta.dispatchEvent({ type: 'input', target: ta, bubbles: true });
    assert.equal(shape.getAttribute('data-state'), 'understood');
    assert.equal(shape.classList.contains('voice-understood'), true);
  }
  assert.deepEqual(moodCalls, [], 'typing in #voice-textarea must not re-trigger setMood(understood)');

  // Submitting blank text triggers alert, and typing valid text again restores understood once
  ta.value = '   ';
  ta.dispatchEvent({ type: 'input', target: ta, bubbles: true });
  assert.deepEqual(moodCalls, []);
  p.pressMain();
  assert.deepEqual(moodCalls, ['alert']);
  assert.equal(shape.getAttribute('data-state'), 'alert');

  moodCalls.length = 0;
  ta.value = 'remada 65 kg por 10';
  ta.dispatchEvent({ type: 'input', target: ta, bubbles: true });
  assert.deepEqual(moodCalls, ['understood'], 'recovering from textError calls setMood(understood) once');
  assert.equal(shape.getAttribute('data-state'), 'understood');

  moodCalls.length = 0;
  ta.value = 'remada 65 kg por 10 séries';
  ta.dispatchEvent({ type: 'input', target: ta, bubbles: true });
  assert.deepEqual(moodCalls, [], 'subsequent typing stays quiet again');
});
