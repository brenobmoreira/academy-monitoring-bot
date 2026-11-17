'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const C = require('../src/core.js');
const V = require('../src/voice.js');

function makeCode(payload, sigChar = 'a') {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `c1.${b64}.${sigChar.repeat(43)}`;
}

const VALID_VU = 'https://voice.example.com';
const REF_A = 'ref_account_a_001';
const REF_B = 'ref_account_b_002';
const T_MS = 1_800_000_000_000;
const T_S = T_MS / 1000;
const CODE_A = makeCode({ r: REF_A, j: 'aaaaaaaaaaaaaaaaaaaaaa', e: T_S + 900 });
const CODE_B = makeCode({ r: REF_B, j: 'bbbbbbbbbbbbbbbbbbbbbb', e: T_S + 900 });

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  const ops = [];
  return {
    ops,
    getItem(k) {
      ops.push(['get', k]);
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      ops.push(['set', k]);
      map.set(k, String(v));
    },
    removeItem(k) {
      ops.push(['remove', k]);
      map.delete(k);
    },
    raw(k) {
      return map.has(k) ? map.get(k) : null;
    },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

/* 1. Valid stored session used without network ------------------------------------------------ */

test('resolveSession: valid stored session is reused without calling fetch (clock converted to seconds)', async () => {
  const storedA = {
    vu: VALID_VU,
    ref: REF_A,
    session: 's1.cached-token-a',
    expires_at: T_S + C.VOICE_LIMITS.SESSION_REFRESH_MARGIN_S + 60,
  };
  const storage = memoryStorage({ [C.VOICE_SESSION_KEY]: JSON.stringify(storedA) });
  let fetchCalls = 0;
  const fakeFetch = async () => {
    fetchCalls++;
    throw new Error('network should not be called');
  };

  const launch = { vu: VALID_VU, vc: CODE_A, vx: T_S - 10, initData: '' }; // even with expired vc
  const res = await V.resolveSession(launch, { storage, fetch: fakeFetch, clock: () => T_MS });

  assert.equal(fetchCalls, 0);
  assert.equal(res.ok, true);
  assert.equal(res.status, 'ready');
  assert.equal(res.source, 'stored');
  assert.equal(res.canRecord, true);
  assert.equal(res.showButton, true);
  assert.deepEqual(res.session, storedA);
  assert.deepEqual(JSON.parse(storage.raw(C.VOICE_SESSION_KEY)), storedA);
});

test('resolveSession: default Date.now clock passes seconds to pickSession', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const storedA = {
    vu: VALID_VU,
    ref: REF_A,
    session: 's1.live-clock-token',
    expires_at: nowSec + C.VOICE_LIMITS.SESSION_REFRESH_MARGIN_S + 300,
  };
  const storage = memoryStorage({ [C.VOICE_SESSION_KEY]: JSON.stringify(storedA) });
  let fetchCalls = 0;

  const res = await V.resolveSession(
    { vu: VALID_VU, vc: CODE_A, vx: nowSec + 600, initData: '' },
    { storage, fetch: async () => { fetchCalls++; return jsonResponse(500, {}); } }
  );

  assert.equal(fetchCalls, 0);
  assert.equal(res.ok, true);
  assert.equal(res.source, 'stored');
  assert.deepEqual(res.session, storedA);
});

/* 2. Code exchanged and persisted ------------------------------------------------------------- */

test('resolveSession: exchanges tg_link code and stores {vu, ref, session, expires_at}', async () => {
  const storage = memoryStorage();
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url, init });
    return jsonResponse(200, {
      v: 1,
      session: 's1.fresh-session-a',
      expires_at: T_S + 43200,
      scopes: ['voice'],
      ref: REF_A,
    });
  };

  const res = await V.resolveSession(
    { vu: VALID_VU, vc: CODE_A, vx: T_S + 600, initData: '' },
    { storage, fetch: fakeFetch, clock: () => T_MS }
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${VALID_VU}/v1/auth/sessions`);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.credentials, 'omit');
  assert.deepEqual(requests[0].init.headers, { 'Content-Type': 'application/json' });
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    v: 1,
    kind: 'tg_link',
    credential: CODE_A,
  });

  const expected = {
    vu: VALID_VU,
    ref: REF_A,
    session: 's1.fresh-session-a',
    expires_at: T_S + 43200,
  };
  assert.equal(res.ok, true);
  assert.equal(res.status, 'ready');
  assert.equal(res.source, 'exchange');
  assert.equal(res.persisted, true);
  assert.equal(res.canRecord, true);
  assert.deepEqual(res.session, expected);
  assert.deepEqual(JSON.parse(storage.raw(C.VOICE_SESSION_KEY)), expected);
});

test('resolveSession: account B deletes A before exchange and saves B; initData deletes stored and exchanges', async () => {
  const storedA = { vu: VALID_VU, ref: REF_A, session: 's1.tokenA', expires_at: T_S + 5000 };
  const storage = memoryStorage({ [C.VOICE_SESSION_KEY]: JSON.stringify(storedA) });

  const fakeFetch = async (_url, init) => {
    // Binding check must have deleted A's session before the exchange network call.
    assert.equal(storage.raw(C.VOICE_SESSION_KEY), null);
    const body = JSON.parse(init.body);
    return jsonResponse(200, {
      v: 1,
      session: body.kind === 'tg_link' ? 's1.tokenB' : 's1.tokenInit',
      expires_at: T_S + 43200,
      scopes: ['voice'],
      ref: REF_B,
    });
  };

  const resB = await V.resolveSession(
    { vu: VALID_VU, vc: CODE_B, vx: T_S + 600, initData: '' },
    { storage, fetch: fakeFetch, clock: () => T_MS }
  );
  assert.equal(resB.ok, true);
  assert.equal(resB.session.ref, REF_B);
  assert.equal(resB.session.session, 's1.tokenB');
  assert.equal(JSON.parse(storage.raw(C.VOICE_SESSION_KEY)).session, 's1.tokenB');

  // Non-empty initData deletes stored and sends tg_init_data
  let sentBody = null;
  const resInit = await V.resolveSession(
    { vu: VALID_VU, vc: '', vx: null, initData: 'query_id=1&auth_date=1800000000&hash=abc' },
    {
      storage,
      fetch: async (url, init) => {
        sentBody = JSON.parse(init.body);
        return fakeFetch(url, init);
      },
      clock: () => T_MS,
    }
  );
  assert.deepEqual(sentBody, {
    v: 1,
    kind: 'tg_init_data',
    credential: 'query_id=1&auth_date=1800000000&hash=abc',
  });
  assert.equal(resInit.ok, true);
  assert.equal(resInit.session.session, 's1.tokenInit');
});

/* 3. Error responses disable voice and delete what is needed ---------------------------------- */

test('resolveSession: exchange error responses disable voice and delete stale stored session', async () => {
  const cases = [
    {
      name: '401 auth_expired',
      res: jsonResponse(401, { v: 1, error: { code: 'auth_expired', message: 'Sessão expirada.', retry: false } }),
      expectedReason: 'auth_expired',
      expectedMessage: 'Envie /app para renovar a voz.',
    },
    {
      name: '401 unauthenticated',
      res: jsonResponse(401, { v: 1, error: { code: 'unauthenticated', message: 'Não autenticado.', retry: false } }),
      expectedReason: 'unauthenticated',
      expectedMessage: 'Envie /app para renovar a voz.',
    },
    {
      name: '401 credential_used',
      res: jsonResponse(401, { v: 1, error: { code: 'credential_used', message: 'Código usado.', retry: false } }),
      expectedReason: 'credential_used',
      expectedMessage: 'Envie /app para renovar a voz.',
    },
    {
      name: '403 forbidden',
      res: jsonResponse(403, { v: 1, error: { code: 'forbidden', message: 'Acesso negado.', retry: false } }),
      expectedReason: 'forbidden',
      expectedMessage: 'Acesso negado.',
    },
    {
      name: '429 rate_limited',
      res: jsonResponse(429, { v: 1, error: { code: 'rate_limited', message: 'Muitas tentativas.', retry: true } }),
      expectedReason: 'rate_limited',
      expectedMessage: 'Não consegui entender agora.',
    },
    {
      name: '503 disabled without json body',
      res: { ok: false, status: 503, async json() { throw new SyntaxError('html'); } },
      expectedReason: 'disabled',
      expectedMessage: 'Serviço de voz indisponível.',
    },
    {
      name: '500 internal',
      res: jsonResponse(500, { v: 1, error: { code: 'internal', message: 'Erro interno no serviço.', retry: true } }),
      expectedReason: 'internal',
      expectedMessage: 'Erro interno no serviço.',
    },
  ];

  for (const c of cases) {
    // Expiring session (< 5 min left) triggers deleteStored + exchange
    const expiringA = { vu: VALID_VU, ref: REF_A, session: 's1.old', expires_at: T_S + 100 };
    const storage = memoryStorage({ [C.VOICE_SESSION_KEY]: JSON.stringify(expiringA) });

    const out = await V.resolveSession(
      { vu: VALID_VU, vc: CODE_A, vx: T_S + 600, initData: '' },
      { storage, fetch: async () => c.res, clock: () => T_MS }
    );

    assert.equal(out.ok, false, c.name);
    assert.equal(out.status, 'disabled', c.name);
    assert.equal(out.canRecord, false, c.name);
    assert.equal(out.showButton, true, c.name);
    assert.equal(out.session, null, c.name);
    assert.equal(out.reason, c.expectedReason, c.name);
    assert.equal(out.message, c.expectedMessage, c.name);
    assert.equal(storage.raw(C.VOICE_SESSION_KEY), null, `${c.name} must delete stored session`);
  }
});

test('resolveSession: ref mismatch or malformed 200 body discards session, clears storage and disables voice', async () => {
  const storedA = { vu: VALID_VU, ref: REF_A, session: 's1.old', expires_at: T_S + 100 };

  const storageMismatch = memoryStorage({ [C.VOICE_SESSION_KEY]: JSON.stringify(storedA) });
  const mismatch = await V.resolveSession(
    { vu: VALID_VU, vc: CODE_A, vx: T_S + 600, initData: '' },
    {
      storage: storageMismatch,
      fetch: async () => jsonResponse(200, { v: 1, session: 's1.forB', expires_at: T_S + 43200, scopes: ['voice'], ref: REF_B }),
      clock: () => T_MS,
    }
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.status, 'disabled');
  assert.equal(mismatch.session, null);
  assert.equal(mismatch.reason, 'ref_mismatch');
  assert.equal(mismatch.message, 'Envie /app para renovar a voz.');
  assert.equal(storageMismatch.raw(C.VOICE_SESSION_KEY), null);

  const storageBadJson = memoryStorage({ [C.VOICE_SESSION_KEY]: JSON.stringify(storedA) });
  const badJson = await V.resolveSession(
    { vu: VALID_VU, vc: CODE_A, vx: T_S + 600, initData: '' },
    {
      storage: storageBadJson,
      fetch: async () => ({ ok: true, status: 200, async json() { throw new SyntaxError('bad'); } }),
      clock: () => T_MS,
    }
  );
  assert.equal(badJson.ok, false);
  assert.equal(badJson.status, 'disabled');
  assert.equal(badJson.reason, 'invalid_response');
  assert.equal(badJson.message, 'Envie /app para renovar a voz.');
  assert.equal(storageBadJson.raw(C.VOICE_SESSION_KEY), null);
});

test('resolveSession: network rejection, expired code with stored session, and missing vu behave per §7.2', async () => {
  const storedA = { vu: VALID_VU, ref: REF_A, session: 's1.old', expires_at: T_S + 5000 };

  // Network failure during exchange
  const storageNet = memoryStorage({ [C.VOICE_SESSION_KEY]: JSON.stringify(storedA) });
  const netErr = await V.resolveSession(
    { vu: VALID_VU, vc: CODE_B, vx: T_S + 600, initData: '' },
    {
      storage: storageNet,
      fetch: async () => { throw new TypeError('Failed to fetch'); },
      clock: () => T_MS,
    }
  );
  assert.equal(netErr.ok, false);
  assert.equal(netErr.status, 'disabled');
  assert.equal(netErr.reason, 'network_error');
  assert.equal(netErr.message, 'Não consegui entender agora.');
  assert.equal(storageNet.raw(C.VOICE_SESSION_KEY), null);

  // Account B with expired code while A is stored -> deletes A, no network, disabled
  const storageExp = memoryStorage({ [C.VOICE_SESSION_KEY]: JSON.stringify(storedA) });
  let fetchCalled = false;
  const expiredB = await V.resolveSession(
    { vu: VALID_VU, vc: CODE_B, vx: T_S - 1, initData: '' },
    { storage: storageExp, fetch: async () => { fetchCalled = true; }, clock: () => T_MS }
  );
  assert.equal(fetchCalled, false);
  assert.equal(expiredB.ok, false);
  assert.equal(expiredB.status, 'disabled');
  assert.equal(expiredB.reason, 'auth_expired');
  assert.equal(expiredB.message, 'Envie /app para renovar a voz.');
  assert.equal(storageExp.raw(C.VOICE_SESSION_KEY), null);

  // Missing vu -> unavailable, hides button, leaves storage untouched
  const storageKeep = memoryStorage({ [C.VOICE_SESSION_KEY]: JSON.stringify(storedA) });
  const noVu = await V.resolveSession(
    { vu: '', vc: '', vx: null, initData: '' },
    { storage: storageKeep, fetch: async () => { fetchCalled = true; }, clock: () => T_MS }
  );
  assert.equal(fetchCalled, false);
  assert.equal(noVu.ok, false);
  assert.equal(noVu.status, 'disabled');
  assert.equal(noVu.showButton, false);
  assert.equal(noVu.reason, 'unavailable');
  assert.equal(storageKeep.raw(C.VOICE_SESSION_KEY), JSON.stringify(storedA));
});

test('exchangeSession: direct 401 auth_expired clears stored session even without prior pickSession', async () => {
  const storedA = { vu: VALID_VU, ref: REF_A, session: 's1.tokenA', expires_at: T_S + 5000 };
  const storage = memoryStorage({ [C.VOICE_SESSION_KEY]: JSON.stringify(storedA) });

  const out = await V.exchangeSession(
    { vu: VALID_VU, kind: 'tg_link', credential: CODE_A, currentRef: REF_A },
    {
      storage,
      fetch: async () => jsonResponse(401, { v: 1, error: { code: 'auth_expired', message: 'Expirado.', retry: false } }),
    }
  );
  assert.equal(out.ok, false);
  assert.equal(out.status, 'disabled');
  assert.equal(out.reason, 'auth_expired');
  assert.equal(storage.raw(C.VOICE_SESSION_KEY), null);
});

/* 4. Throwing / missing / corrupt storage never breaks ----------------------------------------- */

test('throwing, missing, or corrupt storage does not break session resolution or helpers', async () => {
  const throwingStorage = {
    getItem() { throw new Error('SecurityError: blocked'); },
    setItem() { throw new Error('QuotaExceededError'); },
    removeItem() { throw new Error('SecurityError: blocked'); },
  };

  assert.equal(V.readSession(throwingStorage), null);
  assert.equal(V.writeSession(throwingStorage, { session: 'x' }), false);
  assert.equal(V.clearSession(throwingStorage), false);
  assert.equal(V.readSession(null), null);
  assert.equal(V.writeSession(null, { session: 'x' }), false);
  assert.equal(V.clearSession(null), false);

  // Valid exchange succeeds in memory even when storage throws on getItem/setItem/removeItem
  const okInMemory = await V.resolveSession(
    { vu: VALID_VU, vc: CODE_A, vx: T_S + 600, initData: '' },
    {
      storage: throwingStorage,
      fetch: async () => jsonResponse(200, { v: 1, session: 's1.mem', expires_at: T_S + 43200, scopes: ['voice'], ref: REF_A }),
      clock: () => T_MS,
    }
  );
  assert.equal(okInMemory.ok, true);
  assert.equal(okInMemory.status, 'ready');
  assert.equal(okInMemory.persisted, false);
  assert.equal(okInMemory.session.session, 's1.mem');

  // Error response with throwing storage does not throw
  const errWithThrowingStorage = await V.resolveSession(
    { vu: VALID_VU, vc: CODE_A, vx: T_S + 600, initData: '' },
    {
      storage: throwingStorage,
      fetch: async () => jsonResponse(401, { v: 1, error: { code: 'auth_expired', message: 'x', retry: false } }),
      clock: () => T_MS,
    }
  );
  assert.equal(errWithThrowingStorage.ok, false);
  assert.equal(errWithThrowingStorage.status, 'disabled');

  // Missing storage (storage: null) works in memory
  const okNullStorage = await V.resolveSession(
    { vu: VALID_VU, vc: CODE_A, vx: T_S + 600, initData: '' },
    {
      storage: null,
      fetch: async () => jsonResponse(200, { v: 1, session: 's1.nullstore', expires_at: T_S + 43200, scopes: ['voice'], ref: REF_A }),
      clock: () => T_MS,
    }
  );
  assert.equal(okNullStorage.ok, true);
  assert.equal(okNullStorage.persisted, false);
  assert.equal(okNullStorage.session.session, 's1.nullstore');

  // Corrupt JSON in storage is ignored/cleared and replaced cleanly on exchange
  const corruptStorage = memoryStorage({ [C.VOICE_SESSION_KEY]: '{not-valid-json' });
  const afterCorrupt = await V.resolveSession(
    { vu: VALID_VU, vc: CODE_A, vx: T_S + 600, initData: '' },
    {
      storage: corruptStorage,
      fetch: async () => jsonResponse(200, { v: 1, session: 's1.clean', expires_at: T_S + 43200, scopes: ['voice'], ref: REF_A }),
      clock: () => T_MS,
    }
  );
  assert.equal(afterCorrupt.ok, true);
  assert.equal(afterCorrupt.persisted, true);
  assert.equal(JSON.parse(corruptStorage.raw(C.VOICE_SESSION_KEY)).session, 's1.clean');
});

/* 5. Classic-script browser global loading ---------------------------------------------------- */

test('voice.js loads as a classic browser script exposing global ShapeVoice', async () => {
  const coreSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core.js'), 'utf8');
  const voiceSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'voice.js'), 'utf8');
  const storage = memoryStorage();
  const sandbox = {
    URL,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Intl,
    localStorage: storage,
    fetch: async () => jsonResponse(200, { v: 1, session: 's1.vm', expires_at: T_S + 43200, scopes: ['voice'], ref: REF_A }),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(coreSrc, sandbox, { filename: 'core.js' });
  vm.runInContext(voiceSrc, sandbox, { filename: 'voice.js' });

  assert.equal(typeof sandbox.ShapeVoice.resolveSession, 'function');
  const res = await sandbox.ShapeVoice.resolveSession(
    { vu: VALID_VU, vc: CODE_A, vx: T_S + 600, initData: '' },
    { clock: () => T_MS }
  );
  assert.equal(res.ok, true);
  assert.equal(res.session.session, 's1.vm');
  assert.equal(JSON.parse(storage.raw(C.VOICE_SESSION_KEY)).session, 's1.vm');
});

/* 6. C6b-2: microphone, MediaRecorder, generation guard, stop_tracks & consent ----------------- */

function makeDeferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeFakeStream(trackCount = 2) {
  const tracks = Array.from({ length: trackCount }, (_, i) => ({
    id: `t-${i}`,
    stopCalls: 0,
    stop() { this.stopCalls++; },
  }));
  return {
    tracks,
    getTracks() { return tracks; },
    allStopped() { return tracks.every((t) => t.stopCalls > 0); },
    totalStopCalls() { return tracks.reduce((n, t) => n + t.stopCalls, 0); },
  };
}

function makeFakeRecorderClass({ syncOnStop = false } = {}) {
  const instances = [];
  class FakeMediaRecorder {
    static isTypeSupported(mime) {
      return mime === 'audio/webm;codecs=opus';
    }
    constructor(stream, opts) {
      this.stream = stream;
      this.opts = opts;
      this.state = 'inactive';
      this.startCalls = 0;
      this.stopCalls = 0;
      this.ondataavailable = null;
      this.onstop = null;
      this.onerror = null;
      instances.push(this);
    }
    start() {
      this.startCalls++;
      this.state = 'recording';
    }
    stop() {
      this.stopCalls++;
      this.state = 'inactive';
      if (syncOnStop) this.finishStop();
    }
    emitChunk(data = new Uint8Array([1, 2, 3, 4])) {
      if (this.ondataavailable) this.ondataavailable({ data });
    }
    finishStop() {
      if (this.ondataavailable) this.ondataavailable({ data: new Uint8Array([5, 6, 7, 8]) });
      if (this.onstop) this.onstop();
    }
    triggerError(err) {
      if (this.onerror) this.onerror({ error: err });
    }
  }
  return { FakeMediaRecorder, instances };
}

function makeFakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    timers,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fireAll() {
      for (const [id, t] of [...timers.entries()]) {
        timers.delete(id);
        t.fn();
      }
    },
  };
}

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

test('C6b-2: consent is shown only once via save_consent, and re-shown when storage is missing or throws', async () => {
  const storage = memoryStorage();
  const gumCalls = [];
  const { FakeMediaRecorder, instances } = makeFakeRecorderClass();
  const stream = makeFakeStream();
  const timers = makeFakeTimers();

  const ctrl1 = V.createVoiceController({
    storage,
    clock: () => 1000,
    getUserMedia: async (c) => { gumCalls.push(c); return stream; },
    MediaRecorder: FakeMediaRecorder,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  // First time: START -> consent (does not request mic)
  assert.equal(ctrl1.hasConsent(), false);
  ctrl1.start();
  assert.equal(ctrl1.state().status, 'consent');
  assert.equal(gumCalls.length, 0);

  // Declining returns to idle without saving consent
  ctrl1.declineConsent();
  assert.equal(ctrl1.state().status, 'idle');
  assert.equal(ctrl1.hasConsent(), false);
  assert.equal(storage.raw(C.VOICE_CONSENT_KEY), null);

  // Start again -> consent, accept -> saves consent & asks mic
  ctrl1.start();
  assert.equal(ctrl1.state().status, 'consent');
  ctrl1.acceptConsent();
  assert.equal(ctrl1.state().status, 'asking_permission');
  assert.equal(ctrl1.hasConsent(), true);
  assert.equal(storage.raw(C.VOICE_CONSENT_KEY), '1');
  await flushMicrotasks();
  assert.equal(ctrl1.state().status, 'listening');
  assert.equal(instances.length, 1);
  ctrl1.cancel();
  assert.equal(ctrl1.state().status, 'idle');
  assert.equal(stream.allStopped(), true);

  // New controller sharing same storage skips consent completely
  const stream2 = makeFakeStream();
  const ctrl2 = V.createVoiceController({
    storage,
    clock: () => 5000,
    getUserMedia: async (c) => { gumCalls.push(c); return stream2; },
    MediaRecorder: FakeMediaRecorder,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  assert.equal(ctrl2.hasConsent(), true);
  ctrl2.start();
  assert.equal(ctrl2.state().status, 'asking_permission');
  await flushMicrotasks();
  assert.equal(ctrl2.state().status, 'listening');
  ctrl2.cancel();
  assert.equal(stream2.allStopped(), true);

  // Unavailable/throwing storage never breaks and keeps asking consent
  const throwingStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('blocked'); },
    removeItem() { throw new Error('blocked'); },
  };
  const ctrl3 = V.createVoiceController({
    storage: throwingStorage,
    getUserMedia: async () => makeFakeStream(),
    MediaRecorder: FakeMediaRecorder,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  ctrl3.start();
  assert.equal(ctrl3.state().status, 'consent');
  ctrl3.acceptConsent();
  assert.equal(ctrl3.state().status, 'asking_permission');
  await flushMicrotasks();
  ctrl3.cancel();
  assert.equal(ctrl3.hasConsent(), false);
});

test('C6b-2: permission resolved AFTER Cancelar stops all tracks and never starts MediaRecorder', async () => {
  const storage = memoryStorage({ [C.VOICE_CONSENT_KEY]: '1' });
  const deferred = makeDeferred();
  const stream = makeFakeStream(3);
  const { FakeMediaRecorder, instances } = makeFakeRecorderClass();
  const gumConstraints = [];
  const timers = makeFakeTimers();

  const ctrl = V.createVoiceController({
    storage,
    clock: () => 1000,
    getUserMedia: (constraints) => {
      gumConstraints.push(constraints);
      return deferred.promise;
    },
    MediaRecorder: FakeMediaRecorder,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  ctrl.start();
  assert.equal(ctrl.state().status, 'asking_permission');
  assert.equal(ctrl.state().generation, 1);
  assert.deepEqual(gumConstraints, [{
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  }]);

  // User clicks Cancelar while OS permission prompt is still pending
  ctrl.cancel();
  assert.equal(ctrl.state().status, 'idle');
  assert.equal(ctrl.state().generation, 2);
  assert.equal(stream.totalStopCalls(), 0);

  // Now the user clicks "Allow" on the OS prompt -> promise resolves late
  deferred.resolve(stream);
  await flushMicrotasks();

  assert.equal(ctrl.state().status, 'idle');
  assert.equal(instances.length, 0);
  assert.equal(stream.allStopped(), true);
  assert.deepEqual(stream.tracks.map((t) => t.stopCalls), [1, 1, 1]);
});

test('C6b-2: stale permission from cancelled attempt 1 stops its tracks without disturbing active attempt 2', async () => {
  const storage = memoryStorage({ [C.VOICE_CONSENT_KEY]: '1' });
  const d1 = makeDeferred();
  const d2 = makeDeferred();
  const stream1 = makeFakeStream(2);
  const stream2 = makeFakeStream(2);
  const { FakeMediaRecorder, instances } = makeFakeRecorderClass();
  const timers = makeFakeTimers();
  let call = 0;

  const ctrl = V.createVoiceController({
    storage,
    clock: () => 1000,
    getUserMedia: () => (++call === 1 ? d1.promise : d2.promise),
    MediaRecorder: FakeMediaRecorder,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });

  ctrl.start(); // gen 1
  ctrl.cancel(); // gen 2
  ctrl.start(); // gen 3
  assert.equal(ctrl.state().status, 'asking_permission');
  assert.equal(ctrl.state().generation, 3);

  d2.resolve(stream2);
  await flushMicrotasks();
  assert.equal(ctrl.state().status, 'listening');
  assert.equal(instances.length, 1);
  assert.equal(stream2.totalStopCalls(), 0);

  // Attempt 1 finally resolves: must stop stream1 tracks, leave stream2 untouched
  d1.resolve(stream1);
  await flushMicrotasks();
  assert.equal(ctrl.state().status, 'listening');
  assert.equal(ctrl.state().generation, 3);
  assert.equal(instances.length, 1);
  assert.equal(stream1.allStopped(), true);
  assert.equal(stream2.totalStopCalls(), 0);

  ctrl.cancel();
  assert.equal(stream2.allStopped(), true);
});

test('C6b-2: every exit path (cancel, hide, collapse, errors, send, auto-stop) stops recorder and all tracks', async () => {
  const storage = memoryStorage({ [C.VOICE_CONSENT_KEY]: '1' });

  // Helper to boot controller straight into listening
  async function startListening(extraOpts = {}) {
    let now = 1000;
    const stream = makeFakeStream(2);
    const { FakeMediaRecorder, instances } = makeFakeRecorderClass(extraOpts);
    const timers = makeFakeTimers();
    const uploads = [];
    const sends = [];
    const ctrl = V.createVoiceController({
      storage,
      clock: () => now,
      getUserMedia: async () => stream,
      MediaRecorder: FakeMediaRecorder,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      onUpload: (u) => uploads.push(u),
      onSendData: (s) => sends.push(s),
      ...extraOpts,
    });
    ctrl.start();
    await flushMicrotasks();
    assert.equal(ctrl.state().status, 'listening');
    assert.equal(instances.length, 1);
    assert.equal(instances[0].startCalls, 1);
    assert.deepEqual(instances[0].opts, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 32000 });
    return { ctrl, stream, rec: instances[0], timers, uploads, sends, advance: (ms) => { now += ms; } };
  }

  // 1. Cancelar
  {
    const { ctrl, stream, rec, timers } = await startListening();
    ctrl.cancel();
    assert.equal(ctrl.state().status, 'idle');
    assert.equal(rec.stopCalls, 1);
    assert.equal(stream.allStopped(), true);
    assert.equal(timers.timers.size, 0);
  }

  // 2. Esconder (HIDE)
  {
    const { ctrl, stream, rec } = await startListening();
    ctrl.hide();
    assert.equal(ctrl.state().status, 'idle');
    assert.equal(rec.stopCalls, 1);
    assert.equal(stream.allStopped(), true);
  }

  // 3. Colapsar (COLLAPSE)
  {
    const { ctrl, stream, rec } = await startListening();
    ctrl.collapse();
    assert.equal(ctrl.state().status, 'idle');
    assert.equal(rec.stopCalls, 1);
    assert.equal(stream.allStopped(), true);
  }

  // 4. Erro: gravação curta (< 700 ms)
  {
    const { ctrl, stream, rec, advance, uploads } = await startListening();
    advance(500);
    ctrl.stop();
    assert.equal(ctrl.state().status, 'error');
    assert.equal(ctrl.state().error.code, 'too_short');
    assert.equal(rec.stopCalls, 1);
    assert.equal(stream.allStopped(), true);
    assert.equal(uploads.length, 0);
    assert.equal(ctrl.blob(), null);
  }

  // 5. Erro do MediaRecorder (RECORDER_ERROR via onerror)
  {
    const { ctrl, stream, rec } = await startListening();
    rec.triggerError({ name: 'NotReadableError' });
    assert.equal(ctrl.state().status, 'error');
    assert.equal(ctrl.state().error.code, 'NotReadableError');
    assert.equal(rec.stopCalls, 1);
    assert.equal(stream.allStopped(), true);
  }

  // 6. Erro de permissão (getUserMedia rejeita) + retryPermission / missing getUserMedia
  {
    const ctrl = V.createVoiceController({
      storage,
      getUserMedia: async () => { throw { name: 'NotAllowedError' }; },
      MediaRecorder: makeFakeRecorderClass().FakeMediaRecorder,
    });
    ctrl.start();
    await flushMicrotasks();
    assert.equal(ctrl.state().status, 'error');
    assert.equal(ctrl.state().error.code, 'NotAllowedError');

    const ctrlNoApi = V.createVoiceController({ storage, getUserMedia: null, MediaRecorder: null });
    ctrlNoApi.start();
    await flushMicrotasks();
    assert.equal(ctrlNoApi.state().status, 'error');
    assert.equal(ctrlNoApi.state().error.code, 'api_missing');
  }

  // 7. Erro no start() do MediaRecorder para as tracks
  {
    class BrokenRecorder {
      static isTypeSupported() { return true; }
      start() { throw new Error('device busy'); }
      stop() {}
    }
    const stream = makeFakeStream(2);
    const ctrl = V.createVoiceController({
      storage,
      getUserMedia: async () => stream,
      MediaRecorder: BrokenRecorder,
    });
    ctrl.start();
    await flushMicrotasks();
    assert.equal(ctrl.state().status, 'error');
    assert.equal(stream.allStopped(), true);
  }

  // 8. Envio (STOP >= 700 ms -> sending -> TRANSCRIBE_OK -> SEND)
  {
    const { ctrl, stream, rec, advance, uploads, sends } = await startListening();
    rec.emitChunk(new Uint8Array([10, 20, 30]));
    advance(1500);
    ctrl.stop();
    assert.equal(ctrl.state().status, 'sending');
    assert.equal(rec.stopCalls, 1);
    assert.equal(stream.allStopped(), true);

    rec.finishStop();
    assert.equal(uploads.length, 1);
    assert.ok(uploads[0].blob);
    assert.equal(uploads[0].mimeType, 'audio/webm;codecs=opus');
    assert.equal(uploads[0].durationMs, 1500);

    ctrl.dispatch({ type: 'TRANSCRIBE_OK', generation: ctrl.state().generation, text: 'supino 80 por 8' });
    assert.equal(ctrl.state().status, 'transcribed');
    assert.equal(ctrl.blob(), null);

    ctrl.send('0123456789abcdef0123456789abcdef');
    assert.equal(ctrl.state().status, 'idle');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].payload.text, 'supino 80 por 8');
    assert.equal(stream.allStopped(), true);
  }

  // 9. Auto-stop aos 90 s para gravador e todas as tracks
  {
    const { ctrl, stream, rec, timers, advance, uploads } = await startListening({ syncOnStop: true });
    assert.equal(timers.timers.size, 1);
    const scheduled = [...timers.timers.values()][0];
    assert.equal(scheduled.ms, 90_000);
    rec.emitChunk(new Uint8Array([1, 2]));
    advance(90_000);
    timers.fireAll();
    assert.equal(ctrl.state().status, 'sending');
    assert.equal(rec.stopCalls, 1);
    assert.equal(stream.allStopped(), true);
    assert.equal(uploads.length, 1);
  }
});

/* 7. C6b-3: transcription upload, AbortController, Blob retention & 120s ms retry window ----- */

function makeTestSession(overrides = {}) {
  return {
    vu: VALID_VU,
    ref: REF_A,
    session: 's1.voice-token-c6b3',
    expires_at: T_S + 3600,
    ...overrides,
  };
}

test('C6b-3: ms clock enforces 119 999 ms retry sends vs 120 001 ms does not send and drops Blob', async () => {
  let nowMs = T_MS;
  const storage = memoryStorage({
    [C.VOICE_CONSENT_KEY]: '1',
    [C.VOICE_SESSION_KEY]: JSON.stringify(makeTestSession()),
  });
  const stream = makeFakeStream(2);
  const { FakeMediaRecorder, instances } = makeFakeRecorderClass();
  const timers = makeFakeTimers();
  const requests = [];
  let fetchMode = 'fail_502';

  const ctrl = V.createVoiceController({
    storage,
    session: makeTestSession(),
    clock: () => nowMs,
    getUserMedia: async () => stream,
    MediaRecorder: FakeMediaRecorder,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    fetch: async (url, init) => {
      requests.push({ url, init });
      if (fetchMode === 'fail_502') {
        return jsonResponse(502, {
          v: 1,
          error: { code: 'transcription_failed', message: 'Falhou.', retry: true },
        });
      }
      if (fetchMode === 'fail_net') {
        throw new TypeError('Failed to fetch');
      }
      return jsonResponse(200, { v: 1, id: '0123456789abcdef0123456789abcdef', text: 'agachamento 100 por 5' });
    },
  });

  ctrl.start();
  await flushMicrotasks();
  const rec = instances[0];
  rec.emitChunk(new Uint8Array([1, 2, 3, 4]));
  nowMs += 1500;
  ctrl.stop();
  rec.finishStop();
  await flushMicrotasks();

  // First attempt failed at failedAt = T_MS + 1500
  const tFail = T_MS + 1500;
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${VALID_VU}/v1/voice/transcriptions`);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.credentials, 'omit');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer s1.voice-token-c6b3');
  assert.equal(requests[0].init.headers['Content-Type'], 'audio/webm;codecs=opus');
  assert.match(requests[0].init.headers['Idempotency-Key'], /^[0-9a-f]{32}$/);
  assert.equal(requests[0].init.headers['X-Audio-Duration-Ms'], '1500');
  assert.ok(ctrl.blob(), 'Blob must stay in memory while retryable');
  assert.equal(requests[0].init.body, ctrl.blob());
  assert.equal(ctrl.state().status, 'error');
  assert.equal(ctrl.state().error.canRetry, true);
  assert.equal(ctrl.state().failedAt, tFail);

  // Retry at 119 999 ms -> MUST send with the exact same Blob & Idempotency-Key
  nowMs = tFail + 119_999;
  fetchMode = 'fail_net';
  ctrl.retry();
  assert.equal(ctrl.state().status, 'sending');
  await flushMicrotasks();

  assert.equal(requests.length, 2);
  assert.equal(requests[1].init.headers['Idempotency-Key'], requests[0].init.headers['Idempotency-Key']);
  assert.equal(requests[1].init.body, requests[0].init.body);
  assert.equal(ctrl.state().status, 'error');
  assert.equal(ctrl.state().error.canRetry, true);
  assert.equal(ctrl.state().failedAt, tFail);
  assert.ok(ctrl.blob(), 'Blob stays kept up to 120 000 ms');

  // Remaining retry expiry timer must reflect only the 1 ms left (not another 120 000 ms)
  const retryTimers = [...timers.timers.values()];
  assert.equal(retryTimers.length, 1);
  assert.equal(retryTimers[0].ms, 1);

  // Retry at 120 001 ms (even before timer callback runs) -> MUST NOT call fetch and MUST drop Blob
  nowMs = tFail + 120_001;
  fetchMode = 'ok';
  ctrl.retry();
  await flushMicrotasks();

  assert.equal(requests.length, 2, 'retry at 120 001 ms must not call fetch');
  assert.equal(ctrl.state().status, 'error');
  assert.equal(ctrl.state().error.canRetry, false);
  assert.deepEqual(ctrl.state().error.actions, ['plan_b']);
  assert.equal(ctrl.blob(), null, 'Blob must be dropped at 120 001 ms');
  assert.equal(timers.timers.size, 0);
});

test('C6b-3: 120 s timer dispatches RETRY_EXPIRED and drops Blob; 45 s timeout aborts fetch', async () => {
  let nowMs = T_MS;
  const storage = memoryStorage({ [C.VOICE_CONSENT_KEY]: '1' });
  const { FakeMediaRecorder, instances } = makeFakeRecorderClass({ syncOnStop: true });
  const timers = makeFakeTimers();
  const requests = [];
  let pendingFetch = null;

  const ctrl = V.createVoiceController({
    storage,
    vu: VALID_VU,
    session: 's1.timeout-test',
    clock: () => nowMs,
    getUserMedia: async () => makeFakeStream(1),
    MediaRecorder: FakeMediaRecorder,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    fetch: (url, init) => {
      pendingFetch = makeDeferred();
      requests.push({ url, init, deferred: pendingFetch });
      return pendingFetch.promise;
    },
  });

  ctrl.start();
  await flushMicrotasks();
  instances[0].emitChunk(new Uint8Array([9, 8, 7]));
  nowMs += 2000;
  ctrl.stop();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.signal.aborted, false);
  const timeoutTimer = [...timers.timers.values()].find((t) => t.ms === 45_000);
  assert.ok(timeoutTimer, '45 s upload AbortController timer must be scheduled');

  // Trigger 45 s upload timeout
  nowMs += 45_000;
  timeoutTimer.fn();
  assert.equal(requests[0].init.signal.aborted, true);
  assert.equal(ctrl.state().status, 'error');
  assert.equal(ctrl.state().error.code, 'timeout');
  assert.equal(ctrl.state().error.canRetry, true);
  assert.ok(ctrl.blob());

  // Delayed rejection from the aborted fetch must be ignored
  requests[0].deferred.reject(new TypeError('aborted'));
  await flushMicrotasks();
  assert.equal(ctrl.state().status, 'error');
  assert.ok(ctrl.blob());

  // 120 s RETRY_EXPIRED timer must be scheduled
  const retryTimer = [...timers.timers.values()].find((t) => t.ms === 120_000);
  assert.ok(retryTimer, '120 s RETRY_EXPIRED timer must be scheduled');
  nowMs += 120_000;
  retryTimer.fn();

  assert.equal(ctrl.state().status, 'error');
  assert.equal(ctrl.state().error.canRetry, false);
  assert.equal(ctrl.blob(), null, 'RETRY_EXPIRED timer must drop Blob');
});

test('C6b-3: delayed response from an old generation is ignored without altering new attempt or Blob', async () => {
  let nowMs = T_MS;
  const storage = memoryStorage({ [C.VOICE_CONSENT_KEY]: '1' });
  const { FakeMediaRecorder, instances } = makeFakeRecorderClass({ syncOnStop: true });
  const timers = makeFakeTimers();
  const requests = [];

  const ctrl = V.createVoiceController({
    storage,
    session: makeTestSession(),
    clock: () => nowMs,
    getUserMedia: async () => makeFakeStream(1),
    MediaRecorder: FakeMediaRecorder,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    fetch: (url, init) => {
      const d = makeDeferred();
      requests.push({ url, init, deferred: d });
      return d.promise;
    },
  });

  // Attempt 1
  ctrl.start();
  await flushMicrotasks();
  instances[0].emitChunk(new Uint8Array([1, 1]));
  nowMs += 1000;
  ctrl.stop();
  const gen1 = ctrl.state().generation;
  assert.equal(ctrl.state().status, 'sending');
  assert.equal(requests.length, 1);

  // Cancel during sending -> aborts fetch 1 and drops Blob 1
  ctrl.cancel();
  assert.equal(requests[0].init.signal.aborted, true);
  assert.equal(ctrl.blob(), null);
  assert.equal(ctrl.state().status, 'idle');

  // Attempt 2 starts and enters sending
  ctrl.start();
  await flushMicrotasks();
  instances[1].emitChunk(new Uint8Array([2, 2, 2]));
  nowMs += 1200;
  ctrl.stop();
  const gen2 = ctrl.state().generation;
  const blob2 = ctrl.blob();
  assert.ok(gen2 > gen1);
  assert.equal(ctrl.state().status, 'sending');
  assert.ok(blob2);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].init.signal.aborted, false);

  // Delayed 200 OK from attempt 1 AND stale manual dispatch with gen1 must both be ignored
  requests[0].deferred.resolve(jsonResponse(200, { v: 1, id: '1'.repeat(32), text: 'transcricao velha' }));
  await flushMicrotasks();
  ctrl.dispatch({ type: 'TRANSCRIBE_OK', generation: gen1, text: 'fantasma' });
  ctrl.dispatch({ type: 'TRANSCRIBE_ERROR', generation: gen1, error: 'too_large' });

  assert.equal(ctrl.state().status, 'sending');
  assert.equal(ctrl.state().generation, gen2);
  assert.equal(ctrl.state().text, '');
  assert.equal(ctrl.blob(), blob2, 'new Blob must remain intact when old generation settles');

  // Attempt 2 succeeds -> transcribed, Blob dropped
  requests[1].deferred.resolve(jsonResponse(200, { v: 1, id: '2'.repeat(32), text: 'supino 90 por 6' }));
  await flushMicrotasks();
  assert.equal(ctrl.state().status, 'transcribed');
  assert.equal(ctrl.state().text, 'supino 90 por 6');
  assert.equal(ctrl.blob(), null);
});

test('C6b-3: abort_fetch on cancel/hide/collapse, 401 clears session, and no audio or transcript enters storage', async () => {
  const AUDIO_SENTINEL_BYTES = Buffer.from('SENTINEL-AUDIO-7f3a');
  const TRANSCRIPT_SENTINEL = 'SENTINELA-TEXTO-91c2';

  for (const exitFn of [(c) => c.cancel(), (c) => c.hide(), (c) => c.collapse()]) {
    let nowMs = T_MS;
    const storage = memoryStorage({ [C.VOICE_CONSENT_KEY]: '1' });
    const { FakeMediaRecorder, instances } = makeFakeRecorderClass({ syncOnStop: true });
    const timers = makeFakeTimers();
    const signals = [];
    const ctrl = V.createVoiceController({
      storage,
      session: makeTestSession(),
      clock: () => nowMs,
      getUserMedia: async () => makeFakeStream(1),
      MediaRecorder: FakeMediaRecorder,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      fetch: (_url, init) => {
        signals.push(init.signal);
        return makeDeferred().promise;
      },
    });
    ctrl.start();
    await flushMicrotasks();
    instances[0].emitChunk(AUDIO_SENTINEL_BYTES);
    nowMs += 1000;
    ctrl.stop();
    assert.equal(ctrl.state().status, 'sending');
    assert.equal(signals[0].aborted, false);

    exitFn(ctrl);
    assert.equal(ctrl.state().status, 'idle');
    assert.equal(signals[0].aborted, true);
    assert.equal(ctrl.blob(), null);
    assert.equal(timers.timers.size, 0);
  }

  // Storage spy checks that no audio, blob, or transcript text is ever written to storage
  let nowMs = T_MS;
  const writtenValues = [];
  const rawStorage = memoryStorage();
  const auditStorage = {
    getItem(k) { return rawStorage.getItem(k); },
    setItem(k, v) {
      writtenValues.push({ k, v: String(v) });
      rawStorage.setItem(k, v);
    },
    removeItem(k) { rawStorage.removeItem(k); },
  };
  await V.resolveSession(
    { vu: VALID_VU, vc: CODE_A, vx: T_S + 600, initData: '' },
    {
      storage: auditStorage,
      fetch: async () => jsonResponse(200, { v: 1, session: 's1.audit', expires_at: T_S + 3600, scopes: ['voice'], ref: REF_A }),
      clock: () => nowMs,
    }
  );

  const { FakeMediaRecorder, instances } = makeFakeRecorderClass({ syncOnStop: true });
  const timers = makeFakeTimers();
  const sends = [];
  let respond401 = false;
  const ctrl = V.createVoiceController({
    storage: auditStorage,
    getSession: () => V.readSession(auditStorage),
    clock: () => nowMs,
    getUserMedia: async () => makeFakeStream(1),
    MediaRecorder: FakeMediaRecorder,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onSendData: (s) => sends.push(s),
    fetch: async () => (respond401
      ? jsonResponse(401, { v: 1, error: { code: 'auth_expired', message: 'Expirou.', retry: false } })
      : jsonResponse(200, { v: 1, id: '3'.repeat(32), text: TRANSCRIPT_SENTINEL })),
  });

  ctrl.start();
  assert.equal(ctrl.state().status, 'consent');
  ctrl.acceptConsent();
  await flushMicrotasks();
  instances[0].emitChunk(AUDIO_SENTINEL_BYTES);
  nowMs += 1000;
  ctrl.stop();
  await flushMicrotasks();

  assert.equal(ctrl.state().status, 'transcribed');
  assert.equal(ctrl.state().text, TRANSCRIPT_SENTINEL);
  assert.equal(ctrl.blob(), null);

  ctrl.send('4'.repeat(32));
  assert.equal(ctrl.state().status, 'idle');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].payload.text, TRANSCRIPT_SENTINEL);

  // Only VOICE_SESSION_KEY and VOICE_CONSENT_KEY are ever stored; never audio or transcript
  const allowedKeys = new Set([C.VOICE_SESSION_KEY, C.VOICE_CONSENT_KEY]);
  for (const w of writtenValues) {
    assert.equal(allowedKeys.has(w.k), true, `unexpected storage key: ${w.k}`);
    assert.equal(w.v.includes(TRANSCRIPT_SENTINEL), false);
    assert.equal(w.v.includes('SENTINEL-AUDIO'), false);
    assert.equal(w.v.includes(AUDIO_SENTINEL_BYTES.toString('base64')), false);
  }

  // 401 auth_expired clears stored session and drops Blob
  respond401 = true;
  ctrl.start();
  await flushMicrotasks();
  instances[1].emitChunk(AUDIO_SENTINEL_BYTES);
  nowMs += 1000;
  ctrl.stop();
  await flushMicrotasks();

  assert.equal(ctrl.state().status, 'error');
  assert.equal(ctrl.state().error.code, 'auth_expired');
  assert.equal(ctrl.blob(), null);
  assert.equal(rawStorage.raw(C.VOICE_SESSION_KEY), null);
});

test('C6b-fix1: cancelled recording late ondataavailable/onstop/onerror cannot pollute or trigger next recording upload', async () => {
  let nowMs = T_MS;
  const storage = memoryStorage({ [C.VOICE_CONSENT_KEY]: '1' });
  const recorders = [];

  class BrowserLikeMediaRecorder {
    static isTypeSupported(mime) {
      return mime === 'audio/webm;codecs=opus';
    }
    constructor(stream, opts) {
      this.stream = stream;
      this.opts = opts;
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
      this.onerror = null;
      recorders.push(this);
    }
    start() {
      this.state = 'recording';
    }
    stop() {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      // Real browsers emit final ondataavailable and onstop asynchronously AFTER stop() returns.
    }
    deliverLateStop(finalBytes) {
      if (this.ondataavailable) this.ondataavailable({ data: new Uint8Array(finalBytes) });
      if (this.onstop) this.onstop();
    }
  }

  const uploads = [];
  const fetchCalls = [];
  const timers = makeFakeTimers();

  const ctrl = V.createVoiceController({
    storage,
    session: makeTestSession(),
    clock: () => nowMs,
    getUserMedia: async () => makeFakeStream(1),
    MediaRecorder: BrowserLikeMediaRecorder,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onUpload: (u) => uploads.push(u),
    fetch: async (url, init) => {
      fetchCalls.push({ url, init });
      return jsonResponse(200, { v: 1, id: 'a'.repeat(32), text: 'ok' });
    },
  });

  // Scenario 1: Cancel A -> start B -> B stops (sending) -> A's late events arrive BEFORE B's onstop
  ctrl.start();
  await flushMicrotasks();
  const recA = recorders[0];
  recA.ondataavailable({ data: new Uint8Array([1, 1]) });
  ctrl.cancel();
  assert.equal(ctrl.state().status, 'idle');

  ctrl.start();
  await flushMicrotasks();
  const recB = recorders[1];
  recB.ondataavailable({ data: new Uint8Array([2, 2]) });
  nowMs += 1500;
  ctrl.stop();
  assert.equal(ctrl.state().status, 'sending');
  assert.equal(uploads.length, 0, 'B must wait for B.onstop before uploading');
  assert.equal(fetchCalls.length, 0);

  // Late events from cancelled A arrive while B is waiting for B.onstop
  recA.deliverLateStop([9, 9]);
  if (recA.onerror) recA.onerror({ error: { name: 'NotReadableError' } });
  await flushMicrotasks();

  assert.equal(ctrl.state().status, 'sending', 'late events from A must not trigger upload or error B');
  assert.equal(uploads.length, 0, 'A.onstop must NOT trigger B upload');
  assert.equal(fetchCalls.length, 0);

  // Now B's async post-stop ondataavailable and delayed onstop arrive
  recB.deliverLateStop([3, 3]);
  assert.equal(uploads.length, 1);
  assert.equal(fetchCalls.length, 1);
  const uploadedBytes = new Uint8Array(await fetchCalls[0].init.body.arrayBuffer());
  assert.deepEqual([...uploadedBytes], [2, 2, 3, 3]);

  await flushMicrotasks();
  assert.equal(ctrl.state().status, 'transcribed');

  // Scenario 2: Cancel C -> start D (still listening) -> C's late events arrive while D is listening -> D stops
  ctrl.rerecord();
  await flushMicrotasks();
  const recC = recorders[2];
  recC.ondataavailable({ data: new Uint8Array([7, 7]) });
  ctrl.cancel();

  ctrl.start();
  await flushMicrotasks();
  const recD = recorders[3];
  recD.ondataavailable({ data: new Uint8Array([4, 4]) });

  // C's late events arrive while D is listening
  recC.deliverLateStop([8, 8]);
  if (recC.onerror) recC.onerror({ error: { name: 'AbortError' } });
  assert.equal(ctrl.state().status, 'listening');

  nowMs += 1200;
  ctrl.stop();
  recD.deliverLateStop([5, 5]);
  assert.equal(fetchCalls.length, 2);
  const uploadedBytes2 = new Uint8Array(await fetchCalls[1].init.body.arrayBuffer());
  assert.deepEqual([...uploadedBytes2], [4, 4, 5, 5]);
  await flushMicrotasks();
  assert.equal(ctrl.state().status, 'transcribed');
});

test('C6b-fix2: 45 s timeout and cancel abort controller remain active while res.json() is pending after headers', async () => {
  let nowMs = T_MS;
  const storage = memoryStorage({ [C.VOICE_CONSENT_KEY]: '1' });
  const { FakeMediaRecorder, instances } = makeFakeRecorderClass({ syncOnStop: true });
  const timers = makeFakeTimers();
  const requests = [];

  const ctrl = V.createVoiceController({
    storage,
    session: makeTestSession(),
    clock: () => nowMs,
    getUserMedia: async () => makeFakeStream(1),
    MediaRecorder: FakeMediaRecorder,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    fetch: async (_url, init) => {
      const bodyDeferred = makeDeferred();
      requests.push({ init, bodyDeferred });
      // Headers arrive immediately; res.json() remains pending.
      return {
        ok: true,
        status: 200,
        json: () => bodyDeferred.promise,
      };
    },
  });

  // Part A: headers arrive, json() stalls -> 45 s timer stays active and aborts -> timeout error
  ctrl.start();
  await flushMicrotasks();
  instances[0].emitChunk(new Uint8Array([1, 2, 3]));
  nowMs += 1500;
  ctrl.stop();
  await flushMicrotasks();

  assert.equal(requests.length, 1);
  assert.equal(ctrl.state().status, 'sending');
  assert.equal(requests[0].init.signal.aborted, false);
  const timeoutEntry1 = [...timers.timers.entries()].find(([, t]) => t.ms === 45_000);
  assert.ok(timeoutEntry1, '45 s timer must remain active while res.json() is pending');

  nowMs += 45_000;
  timers.timers.delete(timeoutEntry1[0]);
  timeoutEntry1[1].fn();
  assert.equal(requests[0].init.signal.aborted, true);
  assert.equal(ctrl.state().status, 'error');
  assert.equal(ctrl.state().error.code, 'timeout');
  assert.equal(ctrl.state().error.canRetry, true);
  assert.ok(ctrl.blob());

  // Late body resolution after timeout must be ignored
  requests[0].bodyDeferred.resolve({ v: 1, id: 'a'.repeat(32), text: 'late body' });
  await flushMicrotasks();
  assert.equal(ctrl.state().status, 'error');
  assert.equal(ctrl.state().error.code, 'timeout');

  // Part B: retry -> headers arrive, json() pending -> cancel() must abort signal and clear timer
  nowMs += 1000;
  ctrl.retry();
  await flushMicrotasks();

  assert.equal(requests.length, 2);
  assert.equal(ctrl.state().status, 'sending');
  assert.equal(requests[1].init.signal.aborted, false);
  assert.ok([...timers.timers.values()].some((t) => t.ms === 45_000));

  ctrl.cancel();
  assert.equal(ctrl.state().status, 'idle');
  assert.equal(requests[1].init.signal.aborted, true, 'cancel during pending res.json() must abort signal');
  assert.equal(ctrl.blob(), null);
  assert.equal(timers.timers.size, 0);

  const abortErr = new Error('aborted');
  abortErr.name = 'AbortError';
  requests[1].bodyDeferred.reject(abortErr);
  await flushMicrotasks();
  assert.equal(ctrl.state().status, 'idle');
});




