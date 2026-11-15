'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');

function makeCode(payload, sigChar = 'a') {
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `c1.${b64}.${sigChar.repeat(43)}`;
}

const VALID_VU = 'https://voice.example.com';
const REF_A = 'ref_account_a_001';
const REF_B = 'ref_account_b_002';
const CODE_A = makeCode({ r: REF_A, j: 'aaaaaaaaaaaaaaaaaaaaaa', e: 2000 });
const CODE_B = makeCode({ r: REF_B, j: 'bbbbbbbbbbbbbbbbbbbbbb', e: 2000 });

const BASE_CATALOG = {
  v: 1,
  today: '2026-11-15',
  tz: 'America/Sao_Paulo',
  client: 'Cliente Teste',
  next: 'Treino A',
  sessions: ['Treino A'],
  plan: [],
  ex: [['Supino', 'Peito']],
  foods: ['Arroz'],
  fav: [],
  meals: ['Almoço'],
  units: ['g'],
};

/* §7.1 normalizeCatalog voice keys ------------------------------------------------------------ */

test('normalizeCatalog keeps valid vu, vc and vx (including optional port)', () => {
  const cat = C.normalizeCatalog({ ...BASE_CATALOG, vu: `${VALID_VU}:8443`, vc: CODE_A, vx: 2000 });
  assert.equal(cat.vu, `${VALID_VU}:8443`);
  assert.equal(cat.vc, CODE_A);
  assert.equal(cat.vx, 2000);
});

test('normalizeCatalog drops all three voice keys when any key is missing or invalid', () => {
  const cases = [
    { vu: 'http://voice.example.com', vc: CODE_A, vx: 2000 }, // not https
    { vu: `${VALID_VU}/v1`, vc: CODE_A, vx: 2000 }, // path not allowed
    { vu: `${VALID_VU}/`, vc: CODE_A, vx: 2000 }, // trailing slash
    { vu: 'https://VOICE.example.com', vc: CODE_A, vx: 2000 }, // uppercase
    { vu: VALID_VU, vc: 'c2.aaaaaaaaaaaaaaaaaaaa.' + 'a'.repeat(43), vx: 2000 }, // wrong prefix
    { vu: VALID_VU, vc: 'c1.short.' + 'a'.repeat(43), vx: 2000 }, // payload too short
    { vu: VALID_VU, vc: 'c1.' + 'a'.repeat(30) + '.' + 'a'.repeat(42), vx: 2000 }, // bad sig len
    { vu: VALID_VU, vc: CODE_A, vx: 0 }, // non-positive
    { vu: VALID_VU, vc: CODE_A, vx: -10 }, // negative
    { vu: VALID_VU, vc: CODE_A, vx: 12.5 }, // float
    { vu: VALID_VU, vc: CODE_A, vx: '2000' }, // string
    { vu: VALID_VU, vc: CODE_A, vx: true }, // boolean
    { vu: VALID_VU, vc: CODE_A }, // missing vx
    { vu: VALID_VU, vx: 2000 }, // missing vc
    { vc: CODE_A, vx: 2000 }, // missing vu
    {}, // none
  ];
  for (const extra of cases) {
    const cat = C.normalizeCatalog({ ...BASE_CATALOG, ...extra });
    assert.equal(cat.vu, '', JSON.stringify(extra));
    assert.equal(cat.vc, '', JSON.stringify(extra));
    assert.equal(cat.vx, null, JSON.stringify(extra));
  }
});

test('invalid catalog keys disable voice', () => {
  const cat = C.normalizeCatalog({ ...BASE_CATALOG, vu: 'https://voice.example.com/bad', vc: CODE_A, vx: 2000 });
  const avail = C.voiceAvailable({
    vu: cat.vu,
    hasSession: false,
    canExchange: false,
    hasGetUserMedia: true,
    hasMediaRecorder: true,
    isTypeSupported: () => true,
  });
  assert.equal(avail.showButton, false);
  assert.equal(avail.canRecord, false);
});

/* §7.2 codeRef --------------------------------------------------------------------------------- */

test('codeRef reads r from c1 codes even after expiry, and rejects malformed inputs', () => {
  const expired = makeCode({ r: REF_A, j: 'jjjjjjjjjjjjjjjjjjjjjj', e: 100 });
  assert.equal(C.codeRef(expired), REF_A);
  for (const bad of [
    null, undefined, '', 123,
    'c2.' + Buffer.from('{"r":"x"}').toString('base64url') + '.sig',
    'c1.onlytwo',
    'c1.a.b.c',
    'c1.not+base64!.sig',
    'c1.' + Buffer.from('[]').toString('base64url') + '.sig',
    'c1.' + Buffer.from('{"r":""}').toString('base64url') + '.sig',
    'c1.' + Buffer.from('{"r":123}').toString('base64url') + '.sig',
    'c1.' + Buffer.from('not json').toString('base64url') + '.sig',
  ]) {
    assert.equal(C.codeRef(bad), null, String(bad));
  }
});

/* §7.2 pickSession & acceptExchange ------------------------------------------------------------ */

test('pickSession: fresh keyboard launch exchanges tg_link', () => {
  const r = C.pickSession(null, { vu: VALID_VU, vc: CODE_A, vx: 2000, initData: '', now: 1000 });
  assert.equal(r.action, 'exchange');
  assert.equal(r.kind, 'tg_link');
  assert.equal(r.credential, CODE_A);
  assert.equal(r.deleteStored, false);
  assert.equal(r.currentRef, REF_A);
});

test('pickSession: reuses stored session only when bound to same vu+ref and >5 min left', () => {
  const storedA = { vu: VALID_VU, ref: REF_A, session: 's1.tokenA', expires_at: 2000 };
  // 301 s left (> 5 min): reuse even if vc expired
  const ok = C.pickSession(storedA, { vu: VALID_VU, vc: CODE_A, vx: 900, initData: '', now: 1699 });
  assert.equal(ok.action, 'use');
  assert.deepEqual(ok.session, storedA);
  assert.equal(ok.deleteStored, false);

  // Exactly 300 s left (not > 5 min): do not reuse; exchange fresh vc
  const refresh = C.pickSession(storedA, { vu: VALID_VU, vc: CODE_A, vx: 2500, initData: '', now: 1700 });
  assert.equal(refresh.action, 'exchange');
  assert.equal(refresh.kind, 'tg_link');
  assert.equal(refresh.deleteStored, true);

  // Expired stored + expired code -> disabled, deletes stored
  const expired = C.pickSession(storedA, { vu: VALID_VU, vc: CODE_A, vx: 1500, initData: '', now: 2000 });
  assert.equal(expired.action, 'disabled');
  assert.equal(expired.reason, 'auth_expired');
  assert.equal(expired.message, 'Envie /app para renovar a voz.');
  assert.equal(expired.deleteStored, true);
});

test('pickSession: account B on the same device deletes A, handles valid/expired B, and back to A', () => {
  const storedA = { vu: VALID_VU, ref: REF_A, session: 's1.tokenA', expires_at: 5000 };

  // 1. Account B opens with a valid code -> delete A, exchange B
  const bValid = C.pickSession(storedA, { vu: VALID_VU, vc: CODE_B, vx: 2000, initData: '', now: 1000 });
  assert.equal(bValid.action, 'exchange');
  assert.equal(bValid.kind, 'tg_link');
  assert.equal(bValid.credential, CODE_B);
  assert.equal(bValid.deleteStored, true);
  assert.equal(bValid.currentRef, REF_B);

  // 2. Account B opens with an expired code while A's valid session is stored -> delete A, disabled; A never sent
  const bExpired = C.pickSession(storedA, { vu: VALID_VU, vc: CODE_B, vx: 900, initData: '', now: 1000 });
  assert.equal(bExpired.action, 'disabled');
  assert.equal(bExpired.reason, 'auth_expired');
  assert.equal(bExpired.message, 'Envie /app para renovar a voz.');
  assert.equal(bExpired.deleteStored, true);
  assert.notEqual(bExpired.action, 'use');

  // 3. Back to A with A's old expired code while B's session is stored -> delete B, disabled; B never used for A
  const storedB = { vu: VALID_VU, ref: REF_B, session: 's1.tokenB', expires_at: 5000 };
  const backAExpired = C.pickSession(storedB, { vu: VALID_VU, vc: CODE_A, vx: 900, initData: '', now: 1000 });
  assert.equal(backAExpired.action, 'disabled');
  assert.equal(backAExpired.reason, 'auth_expired');
  assert.equal(backAExpired.deleteStored, true);

  // 4. Back to A with fresh code while B's session is stored -> delete B, exchange A
  const backAValid = C.pickSession(storedB, { vu: VALID_VU, vc: CODE_A, vx: 2000, initData: '', now: 1000 });
  assert.equal(backAValid.action, 'exchange');
  assert.equal(backAValid.credential, CODE_A);
  assert.equal(backAValid.deleteStored, true);
  assert.equal(backAValid.currentRef, REF_A);
});

test('pickSession: different vu deletes stored; initData deletes stored and exchanges tg_init_data', () => {
  const storedA = { vu: VALID_VU, ref: REF_A, session: 's1.tokenA', expires_at: 5000 };

  const diffVu = C.pickSession(storedA, { vu: 'https://other.example.com', vc: CODE_A, vx: 2000, initData: '', now: 1000 });
  assert.equal(diffVu.deleteStored, true);
  assert.equal(diffVu.action, 'exchange');

  const withInit = C.pickSession(storedA, { vu: VALID_VU, vc: '', vx: null, initData: 'query_id=1&user=%7B%7D&hash=abc', now: 1000 });
  assert.equal(withInit.deleteStored, true);
  assert.equal(withInit.action, 'exchange');
  assert.equal(withInit.kind, 'tg_init_data');
  assert.equal(withInit.credential, 'query_id=1&user=%7B%7D&hash=abc');
  assert.equal(withInit.currentRef, null);

  const noVu = C.pickSession(storedA, { vu: '', vc: '', vx: null, initData: '', now: 1000 });
  assert.equal(noVu.action, 'disabled');
  assert.equal(noVu.reason, 'unavailable');
});

test('acceptExchange checks ref match on keyboard launch and allows null currentRef for initData', () => {
  const okResp = { v: 1, session: 's1.tok', expires_at: 5000, scopes: ['voice'], ref: REF_A };
  const acc = C.acceptExchange(okResp, REF_A, VALID_VU);
  assert.equal(acc.ok, true);
  assert.deepEqual(acc.session, { vu: VALID_VU, ref: REF_A, session: 's1.tok', expires_at: 5000 });

  // Response ref differs -> discard and disable
  const mismatch = C.acceptExchange({ ...okResp, ref: REF_B }, REF_A, VALID_VU);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'ref_mismatch');
  assert.equal(mismatch.message, 'Envie /app para renovar a voz.');

  // initData launch (currentRef === null)
  const initAcc = C.acceptExchange(okResp, null, VALID_VU);
  assert.equal(initAcc.ok, true);

  // Invalid response shapes
  for (const bad of [null, {}, { ...okResp, v: 2 }, { ...okResp, scopes: [] }, { ...okResp, session: '' }, { ...okResp, expires_at: 0 }]) {
    assert.equal(C.acceptExchange(bad, REF_A, VALID_VU).ok, false);
  }
});

/* §7.3 pickVoiceMime & voiceAvailable --------------------------------------------------------- */

test('pickVoiceMime selects the first supported format in spec order', () => {
  assert.equal(C.pickVoiceMime((m) => m === 'audio/mp4' || m === 'audio/ogg;codecs=opus'), 'audio/ogg;codecs=opus');
  assert.equal(C.pickVoiceMime(() => true), 'audio/webm;codecs=opus');
  assert.equal(C.pickVoiceMime((m) => m === 'audio/mp4'), 'audio/mp4');
  assert.equal(C.pickVoiceMime(() => false), null);
  assert.equal(C.pickVoiceMime(() => { throw new Error('boom'); }), null);
  assert.equal(C.pickVoiceMime(null), null);
});

test('voiceAvailable distinguishes hidden, plan B (unsupported device / expired auth) and ready', () => {
  assert.equal(C.voiceAvailable({ vu: '', preview: false }).showButton, false);

  const noMic = C.voiceAvailable({
    vu: VALID_VU, hasSession: true, hasGetUserMedia: false, hasMediaRecorder: true, isTypeSupported: () => true,
  });
  assert.equal(noMic.showButton, true);
  assert.equal(noMic.canRecord, false);
  assert.equal(noMic.planB, true);
  assert.equal(noMic.message, 'Este aparelho não grava aqui.');

  const noMime = C.voiceAvailable({
    vu: VALID_VU, hasSession: true, hasGetUserMedia: true, hasMediaRecorder: true, isTypeSupported: () => false,
  });
  assert.equal(noMime.showButton, true);
  assert.equal(noMime.canRecord, false);
  assert.equal(noMime.planB, true);

  const expired = C.voiceAvailable({
    vu: VALID_VU, hasSession: false, canExchange: false, hasGetUserMedia: true, hasMediaRecorder: true, isTypeSupported: () => true,
  });
  assert.equal(expired.showButton, true);
  assert.equal(expired.canRecord, false);
  assert.equal(expired.disabled, true);
  assert.equal(expired.planB, true);
  assert.equal(expired.message, 'Envie /app para renovar a voz.');

  const ready = C.voiceAvailable({
    vu: VALID_VU, hasSession: true, hasGetUserMedia: true, hasMediaRecorder: true, isTypeSupported: (m) => m === 'audio/mp4',
  });
  assert.equal(ready.showButton, true);
  assert.equal(ready.canRecord, true);
  assert.equal(ready.planB, false);
  assert.equal(ready.mime, 'audio/mp4');

  const preview = C.voiceAvailable({
    vu: '', preview: true, hasGetUserMedia: true, hasMediaRecorder: true, isTypeSupported: () => true,
  });
  assert.equal(preview.showButton, true);
  assert.equal(preview.canRecord, true);
});

/* §7.5 voiceError ------------------------------------------------------------------------------ */

test('voiceError maps every row of spec §7.5', () => {
  const e1 = C.voiceError({ name: 'NotAllowedError' });
  assert.equal(e1.message, 'Sem permissão para o microfone.');
  assert.deepEqual(e1.actions, ['retry_permission', 'plan_b']);
  assert.equal(e1.canRetry, false);

  const e1b = C.voiceError('SecurityError');
  assert.equal(e1b.message, 'Sem permissão para o microfone.');
  assert.deepEqual(e1b.actions, ['retry_permission', 'plan_b']);

  for (const c of ['NotFoundError', 'no_supported_format', 'api_missing']) {
    const e = C.voiceError(c);
    assert.equal(e.message, 'Este aparelho não grava aqui.');
    assert.deepEqual(e.actions, ['plan_b']);
    assert.equal(e.canRetry, false);
  }

  for (const c of ['network_error', 'timeout', 'transcription_failed', 'rate_limited']) {
    const e = C.voiceError({ code: c, message: 'raw' });
    assert.equal(e.message, 'Não consegui entender agora.');
    assert.deepEqual(e.actions, ['retry', 'plan_b']);
    assert.equal(e.canRetry, true);
  }

  for (const c of ['auth_expired', 'unauthenticated', 'credential_used']) {
    const e = C.voiceError(c);
    assert.equal(e.message, 'Envie /app para renovar a voz.');
    assert.deepEqual(e.actions, ['plan_b']);
    assert.equal(e.canRetry, false);
    assert.equal(e.clearSession, c !== 'credential_used');
  }

  const e5 = C.voiceError('no_speech');
  assert.equal(e5.message, 'Não ouvi nada. Fale mais perto do microfone.');
  assert.deepEqual(e5.actions, ['rerecord']);
  assert.equal(e5.canRetry, false);

  for (const c of ['too_long', 'too_large']) {
    const e = C.voiceError(c);
    assert.equal(e.message, 'Passou de 1min30. Grave um trecho mais curto.');
    assert.deepEqual(e.actions, ['rerecord']);
    assert.equal(e.canRetry, false);
  }

  const e7 = C.voiceError('unsupported_format');
  assert.equal(e7.message, 'Este formato não funciona aqui.');
  assert.deepEqual(e7.actions, ['plan_b']);
  assert.equal(e7.canRetry, false);

  for (const c of ['budget_exhausted', 'forbidden', 'disabled', 'internal']) {
    const e = C.voiceError({ v: 1, error: { code: c, message: `Mensagem do servidor (${c})`, retry: false } });
    assert.equal(e.message, `Mensagem do servidor (${c})`);
    assert.deepEqual(e.actions, ['plan_b']);
    assert.equal(e.canRetry, false);
  }
});

/* §7.4 voiceReducer ---------------------------------------------------------------------------- */

test('voiceReducer: consent flow and cancellation', () => {
  let s = C.initialVoiceState();
  assert.equal(s.status, 'idle');

  s = C.voiceReducer(s, { type: 'START', consented: false });
  assert.equal(s.status, 'consent');

  s = C.voiceReducer(s, { type: 'CONSENT_DECLINE' });
  assert.equal(s.status, 'idle');

  s = C.voiceReducer(s, { type: 'START', consented: false });
  assert.equal(s.status, 'consent');
  s = C.voiceReducer(s, { type: 'CONSENT_ACCEPT' });
  assert.equal(s.status, 'asking_permission');
  assert.equal(s.generation, 1);
  assert.equal(s.mascot, 'listening');
  assert.ok(s.effects.some((e) => e.type === 'save_consent'));
  assert.ok(s.effects.some((e) => e.type === 'request_mic' && e.generation === 1));
});

test('voiceReducer: permission result arriving after Cancelar stops tracks and stays idle', () => {
  let s = C.initialVoiceState();
  s = C.voiceReducer(s, { type: 'START', consented: true });
  assert.equal(s.status, 'asking_permission');
  const gen = s.generation;

  s = C.voiceReducer(s, { type: 'CANCEL' });
  assert.equal(s.status, 'idle');
  assert.equal(s.generation, gen + 1);

  const late = C.voiceReducer(s, { type: 'PERMISSION_GRANTED', generation: gen, now: 1000 });
  assert.equal(late.status, 'idle');
  assert.deepEqual(late.effects, [{ type: 'stop_tracks' }]);
});

test('voiceReducer: stale permission from first attempt while second attempt is pending stops tracks without starting', () => {
  let s = C.voiceReducer(C.initialVoiceState(), { type: 'START', consented: true }); // gen 1
  s = C.voiceReducer(s, { type: 'CANCEL' }); // gen 2, idle
  s = C.voiceReducer(s, { type: 'START', consented: true }); // gen 3, asking_permission
  const stale = C.voiceReducer(s, { type: 'PERMISSION_GRANTED', generation: 1, now: 1000 });
  assert.equal(stale.status, 'asking_permission');
  assert.equal(stale.generation, 3);
  assert.deepEqual(stale.effects, [{ type: 'stop_tracks' }]);
});

test('voiceReducer: full happy path listening -> sending -> transcribed -> edit -> sendData and rerecord', () => {
  let s = C.voiceReducer(C.initialVoiceState(), { type: 'START', consented: true });
  s = C.voiceReducer(s, { type: 'PERMISSION_GRANTED', generation: s.generation, now: 1000 });
  assert.equal(s.status, 'listening');
  assert.equal(s.mascot, 'listening');

  // Under 0.7 s -> error too_short, never sent
  const shortStop = C.voiceReducer(s, { type: 'STOP', durationMs: 699, now: 1699 });
  assert.equal(shortStop.status, 'error');
  assert.equal(shortStop.mascot, 'alert');
  assert.equal(shortStop.error.message, 'Muito curto. Segure e fale.');
  assert.ok(shortStop.effects.some((e) => e.type === 'drop_blob'));
  assert.ok(!shortStop.effects.some((e) => e.type === 'upload'));

  // >= 0.7 s -> sending
  s = C.voiceReducer(s, { type: 'STOP', durationMs: 700, now: 1700, idempotencyKey: 'k1' });
  assert.equal(s.status, 'sending');
  assert.equal(s.mascot, 'thinking');
  assert.equal(s.idempotencyKey, 'k1');
  assert.ok(s.effects.some((e) => e.type === 'stop_recorder'));
  assert.ok(s.effects.some((e) => e.type === 'stop_tracks'));
  assert.ok(s.effects.some((e) => e.type === 'upload' && e.idempotencyKey === 'k1'));

  // 200 -> transcribed, drops blob
  s = C.voiceReducer(s, { type: 'TRANSCRIBE_OK', generation: s.generation, text: 'arroz e frango' });
  assert.equal(s.status, 'transcribed');
  assert.equal(s.text, 'arroz e frango');
  assert.ok(s.effects.some((e) => e.type === 'drop_blob'));

  // Edit text
  s = C.voiceReducer(s, { type: 'EDIT_TEXT', text: 'arroz 150 g e frango 120 g' });
  assert.equal(s.status, 'transcribed');
  assert.equal(s.text, 'arroz 150 g e frango 120 g');

  // Rerecord from transcribed -> asking_permission
  const re = C.voiceReducer(s, { type: 'RERECORD' });
  assert.equal(re.status, 'asking_permission');
  assert.equal(re.mascot, 'listening');
  assert.ok(re.effects.some((e) => e.type === 'request_mic'));

  // Send from transcribed -> idle with send_data
  const sent = C.voiceReducer(s, { type: 'SEND', submissionId: '0123456789abcdef0123456789abcdef' });
  assert.equal(sent.status, 'idle');
  assert.ok(sent.effects.some((e) => e.type === 'send_data'));
});

test('voiceReducer: sending cancel aborts fetch; error retry reuses same key within 120 s and refuses past 120 s', () => {
  let s = C.voiceReducer(C.initialVoiceState(), { type: 'START', consented: true });
  s = C.voiceReducer(s, { type: 'PERMISSION_GRANTED', generation: s.generation, now: 1000 });
  s = C.voiceReducer(s, { type: 'STOP', durationMs: 2000, now: 3000, idempotencyKey: 'same-key' });

  // Cancel during sending -> abort fetch, drop blob, idle
  const cancelled = C.voiceReducer(s, { type: 'CANCEL' });
  assert.equal(cancelled.status, 'idle');
  assert.ok(cancelled.effects.some((e) => e.type === 'abort_fetch'));
  assert.ok(cancelled.effects.some((e) => e.type === 'drop_blob'));

  // Stale TRANSCRIBE_OK after cancel is ignored
  const staleOk = C.voiceReducer(cancelled, { type: 'TRANSCRIBE_OK', generation: s.generation, text: 'tarde' });
  assert.equal(staleOk.status, 'idle');
  assert.equal(staleOk.changed, false);

  // Retryable error keeps key + failedAt
  let errState = C.voiceReducer(s, { type: 'TRANSCRIBE_ERROR', generation: s.generation, error: 'timeout', now: 10000 });
  assert.equal(errState.status, 'error');
  assert.equal(errState.mascot, 'alert');
  assert.equal(errState.idempotencyKey, 'same-key');
  assert.equal(errState.failedAt, 10000);
  assert.ok(!errState.effects.some((e) => e.type === 'drop_blob'));

  // Retry within 120 s (at 130000 ms = +120 s) -> sending with same key
  const retried = C.voiceReducer(errState, { type: 'RETRY', now: 130000 });
  assert.equal(retried.status, 'sending');
  assert.equal(retried.idempotencyKey, 'same-key');
  assert.ok(retried.effects.some((e) => e.type === 'upload' && e.idempotencyKey === 'same-key'));

  // Second failure still inside 120 s keeps the first failedAt; past 120 s drops blob
  const secondFailInWindow = C.voiceReducer(retried, { type: 'TRANSCRIBE_ERROR', generation: retried.generation, error: 'timeout', now: 50000 });
  assert.equal(secondFailInWindow.failedAt, 10000);
  assert.equal(secondFailInWindow.error.canRetry, true);
  const secondFailPastWindow = C.voiceReducer(retried, { type: 'TRANSCRIBE_ERROR', generation: retried.generation, error: 'timeout', now: 130001 });
  assert.equal(secondFailPastWindow.error.canRetry, false);
  assert.ok(secondFailPastWindow.effects.some((e) => e.type === 'drop_blob'));

  // Retry past 120 s (at 130001 ms = +120.001 s) -> refused, drops blob, disables retry
  const expired = C.voiceReducer(errState, { type: 'RETRY', now: 130001 });
  assert.equal(expired.status, 'error');
  assert.equal(expired.error.canRetry, false);
  assert.equal(expired.idempotencyKey, null);
  assert.ok(expired.effects.some((e) => e.type === 'drop_blob'));
  assert.ok(!expired.effects.some((e) => e.type === 'upload'));

  // Non-retryable error drops blob and refuses RETRY; auth_expired clears session
  const authErr = C.voiceReducer(s, { type: 'TRANSCRIBE_ERROR', generation: s.generation, error: 'auth_expired', now: 10000 });
  assert.equal(authErr.status, 'error');
  assert.ok(authErr.effects.some((e) => e.type === 'drop_blob'));
  assert.ok(authErr.effects.some((e) => e.type === 'delete_session'));
  const badRetry = C.voiceReducer(authErr, { type: 'RETRY', now: 10500 });
  assert.equal(badRetry.status, 'error');
  assert.equal(badRetry.changed, false);

  // Leaving error via PLAN_B or CANCEL or RERECORD drops blob
  assert.ok(C.voiceReducer(errState, { type: 'PLAN_B' }).effects.some((e) => e.type === 'drop_blob'));
  assert.ok(C.voiceReducer(errState, { type: 'CANCEL' }).effects.some((e) => e.type === 'drop_blob'));
  assert.ok(C.voiceReducer(errState, { type: 'RERECORD' }).effects.some((e) => e.type === 'drop_blob'));
});

test('voiceReducer: hide/collapse during listening discards recording and stops tracks', () => {
  let s = C.voiceReducer(C.initialVoiceState(), { type: 'START', consented: true });
  s = C.voiceReducer(s, { type: 'PERMISSION_GRANTED', generation: s.generation, now: 1000 });
  const hidden = C.voiceReducer(s, { type: 'HIDE' });
  assert.equal(hidden.status, 'idle');
  assert.ok(hidden.effects.some((e) => e.type === 'stop_recorder'));
  assert.ok(hidden.effects.some((e) => e.type === 'stop_tracks'));
  assert.ok(hidden.effects.some((e) => e.type === 'drop_blob'));
});

test('voiceReducer: invalid transitions are refused without state change or action effects', () => {
  const idle = C.initialVoiceState();
  for (const ev of [
    { type: 'STOP', durationMs: 2000 },
    { type: 'TRANSCRIBE_OK', text: 'x' },
    { type: 'RETRY', now: 1000 },
    { type: 'CONSENT_ACCEPT' },
    { type: 'SEND' },
    { type: 'RERECORD' },
  ]) {
    const next = C.voiceReducer(idle, ev);
    assert.equal(next.status, 'idle', ev.type);
    assert.equal(next.changed, false, ev.type);
    assert.deepEqual(next.effects, [], ev.type);
  }

  const listening = C.voiceReducer(
    C.voiceReducer(C.voiceReducer(idle, { type: 'START', consented: true }), { type: 'PERMISSION_GRANTED', generation: 1, now: 100 }),
    { type: 'EDIT_TEXT', text: 'nope' }
  );
  assert.equal(listening.status, 'listening');
  assert.equal(listening.changed, false);
});

/* §7.4 keepBlob retention rule ----------------------------------------------------------------- */

test('keepBlob keeps only while sendable/retryable within 120 s and drops in every §7.4 case', () => {
  const retryErrState = { status: 'error', error: C.voiceError('timeout'), failedAt: 1000 };
  const nonRetryErrState = { status: 'error', error: C.voiceError('no_speech'), failedAt: 1000 };
  const sendingState = { status: 'sending' };

  // Kept
  assert.equal(C.keepBlob({ type: 'STOP', durationMs: 700 }, { status: 'listening' }, 1000), true);
  assert.equal(C.keepBlob({ type: 'TICK' }, sendingState, 2000), true);
  assert.equal(C.keepBlob({ type: 'TRANSCRIBE_ERROR', error: 'network_error' }, sendingState, 1000), true);
  assert.equal(C.keepBlob({ type: 'TICK' }, retryErrState, 121000), true); // exactly 120 s
  assert.equal(C.keepBlob({ type: 'RETRY' }, retryErrState, 121000), true);

  // Dropped
  assert.equal(C.keepBlob({ type: 'STOP', durationMs: 699 }, { status: 'listening' }, 1000), false);
  assert.equal(C.keepBlob({ type: 'TRANSCRIBE_OK' }, sendingState, 2000), false);
  assert.equal(C.keepBlob({ type: 'CANCEL' }, sendingState, 2000), false);
  assert.equal(C.keepBlob({ type: 'CANCEL' }, retryErrState, 2000), false);
  assert.equal(C.keepBlob({ type: 'RERECORD' }, retryErrState, 2000), false);
  assert.equal(C.keepBlob({ type: 'PLAN_B' }, retryErrState, 2000), false);
  assert.equal(C.keepBlob({ type: 'CLOSE' }, retryErrState, 2000), false);
  assert.equal(C.keepBlob({ type: 'HIDE' }, sendingState, 2000), false);
  assert.equal(C.keepBlob({ type: 'HIDE' }, retryErrState, 2000), false);
  assert.equal(C.keepBlob({ type: 'COLLAPSE' }, retryErrState, 2000), false);
  assert.equal(C.keepBlob({ type: 'TRANSCRIBE_ERROR', error: 'no_speech' }, sendingState, 1000), false);
  assert.equal(C.keepBlob({ type: 'TICK' }, nonRetryErrState, 2000), false);
  assert.equal(C.keepBlob({ type: 'TICK' }, retryErrState, 121001), false); // > 120 s
  assert.equal(C.keepBlob({ type: 'RETRY' }, retryErrState, 121001), false); // > 120 s
  assert.equal(C.keepBlob({ type: 'TICK' }, { status: 'idle' }, 2000), false);
  assert.equal(C.keepBlob({ type: 'TICK' }, { status: 'transcribed' }, 2000), false);
});

/* §4.2 textPayload ----------------------------------------------------------------------------- */

test('textPayload builds exact v1 text payload and enforces trimming, chars, control chars and 4096 bytes', () => {
  const id = '0123456789abcdef0123456789abcdef';
  const ok = C.textPayload('  almoço\n150 g de arroz  ', id);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.payload, {
    v: 1,
    t: 'text',
    id,
    src: 'voice',
    text: 'almoço\n150 g de arroz',
  });
  assert.deepEqual(Object.keys(JSON.parse(ok.json)), ['v', 't', 'id', 'src', 'text']);
  assert.equal(ok.bytes, Buffer.byteLength(ok.json, 'utf8'));

  // 2000 ASCII chars fits 4096 bytes
  assert.equal(C.textPayload('a'.repeat(2000), id).ok, true);

  // Over 2000 chars refused
  assert.equal(C.textPayload('a'.repeat(2001), id).ok, false);

  // Empty / whitespace only refused
  assert.equal(C.textPayload('   \n  ', id).ok, false);

  // Control characters other than \n refused
  for (const bad of ['oi\x00', 'oi\tla', 'oi\r\nla', 'oi\x7fla', 'oi\x1bla']) {
    assert.equal(C.textPayload(bad, id).ok, false, JSON.stringify(bad));
  }

  // Over 4096 UTF-8 bytes (<= 2000 chars, e.g. 1400 3-byte symbols = 4200 bytes) refused
  const big = '✅'.repeat(1400);
  assert.ok(big.length <= 2000);
  const tooBig = C.textPayload(big, id);
  assert.equal(tooBig.ok, false);
  assert.ok(tooBig.bytes > 4096);
  assert.match(tooBig.error, /curto|encurte|longo/i);

  // Invalid id or src refused
  assert.equal(C.textPayload('ok', 'NOT-HEX').ok, false);
  assert.equal(C.textPayload('ok', id, 'other').ok, false);
});
