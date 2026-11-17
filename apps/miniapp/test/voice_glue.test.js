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
