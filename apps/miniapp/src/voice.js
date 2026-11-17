/**
 * Shape mini app voice glue: storage, session exchange, and (in later C6b steps) recorder/DOM.
 * Classic script (no import/export, ES5 syntax) matching core.js so `node --check`, Node tests,
 * and older Telegram WebViews all run it directly. Pure decisions stay in ShapeCore.
 *
 * Contract: docs/specs/2026-11-14-voice-input-design.md §6.7, §7.2, §7.5.
 */
(function (root) {
  'use strict';

  var C = (typeof module !== 'undefined' && module.exports && typeof require === 'function')
    ? require('./core.js')
    : root.ShapeCore;

  function getDefaultStorage() {
    try { return root && root.localStorage ? root.localStorage : null; } catch (e) { return null; }
  }

  function pickStorage(opts) {
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'storage')) return opts.storage || null;
    return getDefaultStorage();
  }

  function pickFetch(opts) {
    if (opts && Object.prototype.hasOwnProperty.call(opts, 'fetch')) return opts.fetch || null;
    if (root && typeof root.fetch === 'function') return root.fetch.bind(root);
    if (typeof fetch === 'function') return fetch;
    return null;
  }

  function pickClock(opts) {
    if (opts && typeof opts.clock === 'function') return opts.clock;
    if (opts && typeof opts.now === 'function') return opts.now;
    if (opts && typeof opts.now === 'number' && Number.isFinite(opts.now)) {
      var fixed = opts.now;
      return function () { return fixed; };
    }
    return function () { return Date.now(); };
  }

  function nowSeconds(clockFn) {
    return Math.floor(clockFn() / 1000);
  }

  /* session storage (§7.2) ------------------------------------------------------------------- */

  function readSession(storage) {
    if (!storage || typeof storage.getItem !== 'function') return null;
    try {
      var raw = storage.getItem(C.VOICE_SESSION_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) {
      try { if (typeof storage.removeItem === 'function') storage.removeItem(C.VOICE_SESSION_KEY); } catch (ignore) { /* ignore */ }
      return null;
    }
  }

  function writeSession(storage, session) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    try {
      storage.setItem(C.VOICE_SESSION_KEY, JSON.stringify(session));
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearSession(storage) {
    if (!storage || typeof storage.removeItem !== 'function') return false;
    try {
      storage.removeItem(C.VOICE_SESSION_KEY);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* session exchange (§6.7, §7.2) ------------------------------------------------------------ */

  function readResponseJson(res) {
    if (!res) return Promise.resolve(null);
    if (typeof res.json === 'function') {
      return Promise.resolve().then(function () { return res.json(); }).catch(function () { return null; });
    }
    if (typeof res.text === 'function') {
      return Promise.resolve().then(function () { return res.text(); }).then(function (text) {
        return JSON.parse(text);
      }).catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  function httpStatusCode(status) {
    if (status === 400) return 'bad_request';
    if (status === 401) return 'unauthenticated';
    if (status === 403) return 'forbidden';
    if (status === 413) return 'too_large';
    if (status === 415) return 'unsupported_format';
    if (status === 429) return 'rate_limited';
    if (status === 502) return 'transcription_failed';
    if (status === 503) return 'disabled';
    if (status === 504) return 'timeout';
    if (status >= 500) return 'internal';
    return 'network_error';
  }

  function disabledResult(opts) {
    return {
      ok: false,
      status: 'disabled',
      session: null,
      source: opts.source || 'none',
      reason: opts.reason || 'unavailable',
      message: opts.message || '',
      error: opts.error || null,
      persisted: false,
      showButton: !!opts.showButton,
      canRecord: false,
    };
  }

  function exchangeSession(params, opts) {
    var p = params || {};
    var storage = pickStorage(opts);
    var fetchFn = pickFetch(opts);
    if (typeof fetchFn !== 'function') {
      var noFetchErr = C.voiceError('network_error');
      return Promise.resolve(disabledResult({
        source: 'exchange',
        reason: noFetchErr.code,
        message: noFetchErr.message,
        error: noFetchErr,
        showButton: true,
      }));
    }

    var reqInit = {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        v: 1,
        kind: p.kind,
        credential: p.credential,
      }),
    };
    if (opts && opts.signal) reqInit.signal = opts.signal;

    return Promise.resolve().then(function () {
      return fetchFn(p.vu + '/v1/auth/sessions', reqInit);
    }).then(function (res) {
      return readResponseJson(res).then(function (body) {
        if (!res || !res.ok) {
          var errInput = (body && typeof body === 'object' && body.error && typeof body.error === 'object')
            ? body
            : (body && typeof body === 'object' && typeof body.code === 'string'
              ? body
              : httpStatusCode(res ? res.status : 0));
          var mapped = C.voiceError(errInput);
          if (mapped.clearSession) clearSession(storage);
          return disabledResult({
            source: 'exchange',
            reason: mapped.code,
            message: mapped.message,
            error: mapped,
            showButton: true,
          });
        }

        var accepted = C.acceptExchange(body, p.currentRef, p.vu);
        if (!accepted.ok) {
          clearSession(storage);
          return disabledResult({
            source: 'exchange',
            reason: accepted.reason,
            message: accepted.message,
            error: C.voiceError('unauthenticated'),
            showButton: true,
          });
        }

        var persisted = writeSession(storage, accepted.session);
        return {
          ok: true,
          status: 'ready',
          session: accepted.session,
          source: 'exchange',
          reason: '',
          message: '',
          error: null,
          persisted: persisted,
          showButton: true,
          canRecord: true,
        };
      });
    }, function (err) {
      var code = err && err.name === 'AbortError' ? 'timeout' : 'network_error';
      var mapped = C.voiceError(code);
      return disabledResult({
        source: 'exchange',
        reason: mapped.code,
        message: mapped.message,
        error: mapped,
        showButton: true,
      });
    });
  }

  /**
   * §7.2 start-up session resolution: reads stored session, delegates decision to ShapeCore.pickSession
   * (with clock in seconds), clears stale/mismatched storage before exchanging, and persists valid exchange.
   */
  function resolveSession(launch, opts) {
    var storage = pickStorage(opts);
    var clockFn = pickClock(opts);
    var nowSec = nowSeconds(clockFn);
    var stored = readSession(storage);
    var decision = C.pickSession(stored, launch, nowSec);

    if (decision.deleteStored) {
      clearSession(storage);
    }

    if (decision.action === 'use') {
      return Promise.resolve({
        ok: true,
        status: 'ready',
        session: decision.session,
        source: 'stored',
        reason: '',
        message: '',
        error: null,
        persisted: true,
        showButton: true,
        canRecord: true,
      });
    }

    if (decision.action === 'disabled') {
      return Promise.resolve(disabledResult({
        source: 'none',
        reason: decision.reason,
        message: decision.message,
        error: decision.reason === 'unavailable' ? null : C.voiceError(decision.reason),
        showButton: decision.reason !== 'unavailable',
      }));
    }

    return exchangeSession({
      vu: launch.vu,
      kind: decision.kind,
      credential: decision.credential,
      currentRef: decision.currentRef,
    }, Object.assign({}, opts, { storage: storage }));
  }

  var api = {
    readSession: readSession,
    writeSession: writeSession,
    clearSession: clearSession,
    exchangeSession: exchangeSession,
    resolveSession: resolveSession,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShapeVoice = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
