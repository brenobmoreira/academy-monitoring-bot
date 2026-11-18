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
    if (opts && opts.storage !== undefined) return opts.storage || null;
    return getDefaultStorage();
  }

  function pickFetch(opts) {
    if (opts && opts.fetch !== undefined) return opts.fetch || null;
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
    if (status === 409) return 'idempotency_conflict';
    if (status === 413) return 'too_large';
    if (status === 415) return 'unsupported_format';
    if (status === 422) return 'no_speech';
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

  /* consent (§9.2) & media stream helpers (§7.4) ------------------------------------------- */

  function hasConsent(storage) {
    if (!storage || typeof storage.getItem !== 'function') return false;
    try {
      var val = storage.getItem(C.VOICE_CONSENT_KEY);
      return val === '1' || val === 'true';
    } catch (e) {
      return false;
    }
  }

  function saveConsent(storage) {
    if (!storage || typeof storage.setItem !== 'function') return false;
    try {
      storage.setItem(C.VOICE_CONSENT_KEY, '1');
      return true;
    } catch (e) {
      return false;
    }
  }

  function stopStreamTracks(stream) {
    if (!stream) return false;
    var tracks = [];
    try {
      if (typeof stream.getTracks === 'function') tracks = stream.getTracks() || [];
      else if (typeof stream.getAudioTracks === 'function') tracks = stream.getAudioTracks() || [];
    } catch (e) {
      return false;
    }
    for (var i = 0; i < tracks.length; i++) {
      try {
        if (tracks[i] && typeof tracks[i].stop === 'function') tracks[i].stop();
      } catch (e) {
        /* ignore broken track */
      }
    }
    return tracks.length > 0;
  }

  function pickGetUserMedia(opts) {
    if (opts && opts.getUserMedia !== undefined) return opts.getUserMedia || null;
    try {
      var md = root && root.navigator && root.navigator.mediaDevices;
      if (md && typeof md.getUserMedia === 'function') return md.getUserMedia.bind(md);
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function pickMediaRecorder(opts) {
    if (opts && opts.MediaRecorder !== undefined) return opts.MediaRecorder || null;
    try {
      if (root && typeof root.MediaRecorder === 'function') return root.MediaRecorder;
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function pickTimer(opts, name, fallback) {
    if (opts && typeof opts[name] === 'function') return opts[name];
    return fallback;
  }

  function buildAudioBlob(opts, chunks, mime) {
    var BlobCtor = (opts && opts.Blob !== undefined)
      ? opts.Blob
      : (root && typeof root.Blob === 'function' ? root.Blob : (typeof Blob === 'function' ? Blob : null));
    if (typeof BlobCtor === 'function') return new BlobCtor(chunks, { type: mime || '' });
    return { chunks: chunks.slice(), type: mime || '' };
  }

  function pickAbortController(opts) {
    if (opts && opts.AbortController !== undefined) return opts.AbortController || null;
    if (root && typeof root.AbortController === 'function') return root.AbortController;
    if (typeof AbortController === 'function') return AbortController;
    return null;
  }

  function createAbortController(AbortCtor) {
    if (typeof AbortCtor === 'function') return new AbortCtor();
    var listeners = [];
    var signal = {
      aborted: false,
      onabort: null,
      addEventListener: function (type, fn) {
        if (type === 'abort' && typeof fn === 'function') listeners.push(fn);
      },
      removeEventListener: function (type, fn) {
        if (type !== 'abort') return;
        listeners = listeners.filter(function (l) { return l !== fn; });
      },
    };
    return {
      signal: signal,
      abort: function () {
        if (signal.aborted) return;
        signal.aborted = true;
        if (typeof signal.onabort === 'function') {
          try { signal.onabort(); } catch (e) { /* ignore */ }
        }
        var list = listeners.slice();
        for (var i = 0; i < list.length; i++) {
          try { list[i](); } catch (e) { /* ignore */ }
        }
      },
    };
  }

  function extractErrorInput(res, body) {
    if (body && typeof body === 'object' && body.error && typeof body.error === 'object') return body;
    if (body && typeof body === 'object' && typeof body.code === 'string') return body;
    return httpStatusCode(res ? res.status : 0);
  }

  /**
   * §7.4 / §9.2 stateful voice controller: executes ShapeCore.voiceReducer effects
   * (`save_consent`, `request_mic`, `start_recorder`, `stop_recorder`, `stop_tracks`, `drop_blob`,
   * `delete_session`, `send_data`, `open_plan_b`, `upload`, `abort_fetch`) using injected media/clock/fetch/storage.
   */
  function createVoiceController(opts) {
    var o = opts || {};
    var storage = pickStorage(o);
    var clockFn = pickClock(o);
    var fetchFn = pickFetch(o);
    var AbortCtor = pickAbortController(o);
    var getUserMedia = pickGetUserMedia(o);
    var MediaRecorderCtor = pickMediaRecorder(o);
    var setTimer = pickTimer(o, 'setTimeout', setTimeout);
    var clearTimer = pickTimer(o, 'clearTimeout', clearTimeout);
    var hasUploadConfig = Boolean(
      o.fetch !== undefined ||
      o.vu ||
      o.session !== undefined ||
      typeof o.getSession === 'function'
    );

    var state = C.initialVoiceState();
    var activeSession = o.session !== undefined ? o.session : null;
    var activeStream = null;
    var activeRecorder = null;
    var activeRecording = null;
    var autoStopTimer = null;
    var retryExpiryTimer = null;
    var activeUpload = null;
    var startedAtMs = 0;
    var currentMime = '';
    var currentBlob = null;
    var pendingUpload = null;
    var lastDurationMs = 0;

    function reducerNow() {
      return clockFn();
    }

    function currentSessionInfo() {
      var s = typeof o.getSession === 'function' ? o.getSession() : activeSession;
      var vu = '';
      var token = '';
      if (typeof s === 'string') {
        token = s;
        vu = typeof o.vu === 'string' ? o.vu : '';
      } else if (s && typeof s === 'object') {
        token = typeof s.session === 'string' ? s.session : '';
        vu = typeof s.vu === 'string' ? s.vu : (typeof o.vu === 'string' ? o.vu : '');
      } else if (typeof o.vu === 'string') {
        vu = o.vu;
      }
      return { vu: vu, token: token };
    }

    function clearAutoStop() {
      if (autoStopTimer !== null) {
        try { clearTimer(autoStopTimer); } catch (e) { /* ignore */ }
        autoStopTimer = null;
      }
    }

    function clearRetryExpiry() {
      if (retryExpiryTimer !== null) {
        try { clearTimer(retryExpiryTimer); } catch (e) { /* ignore */ }
        retryExpiryTimer = null;
      }
    }

    function syncRetryExpiry() {
      clearRetryExpiry();
      if (state.status !== 'error' || !state.error || !state.error.canRetry ||
          typeof state.failedAt !== 'number' || !Number.isFinite(state.failedAt)) {
        return;
      }
      var remaining = (state.failedAt + C.VOICE_LIMITS.RETRY_WINDOW_MS) - reducerNow();
      var delay = remaining > 0 ? remaining : 0;
      retryExpiryTimer = setTimer(function () {
        retryExpiryTimer = null;
        if (state.status !== 'error' || !state.error || !state.error.canRetry) return;
        dispatch({ type: 'RETRY_EXPIRED' });
      }, delay);
    }

    function abortActiveUpload(reason) {
      if (!activeUpload) return;
      var up = activeUpload;
      activeUpload = null;
      up.abortedBy = reason || 'cancel';
      if (up.timeoutId !== null) {
        try { clearTimer(up.timeoutId); } catch (e) { /* ignore */ }
        up.timeoutId = null;
      }
      if (up.controller && typeof up.controller.abort === 'function') {
        try { up.controller.abort(); } catch (e) { /* ignore */ }
      }
    }

    function dropBlobState() {
      if (activeRecording) {
        activeRecording.discarded = true;
        activeRecording.chunks = [];
        activeRecording = null;
      }
      pendingUpload = null;
      currentBlob = null;
      currentMime = '';
    }

    function uploadTranscription(meta) {
      abortActiveUpload('superseded');
      var info = currentSessionInfo();
      var blobToSend = currentBlob;
      if (!info.vu || !info.token) {
        Promise.resolve().then(function () {
          dispatch({
            type: 'TRANSCRIBE_ERROR',
            generation: meta.generation,
            error: 'unauthenticated',
            now: reducerNow(),
          });
        });
        return;
      }
      if (typeof fetchFn !== 'function' || !blobToSend) {
        Promise.resolve().then(function () {
          dispatch({
            type: 'TRANSCRIBE_ERROR',
            generation: meta.generation,
            error: 'network_error',
            now: reducerNow(),
          });
        });
        return;
      }

      var controller = createAbortController(AbortCtor);
      var uploadObj = {
        generation: meta.generation,
        controller: controller,
        timeoutId: null,
        abortedBy: '',
      };
      activeUpload = uploadObj;

      var headers = {
        Authorization: 'Bearer ' + info.token,
        'Content-Type': currentMime || (blobToSend && blobToSend.type) || 'application/octet-stream',
        'Idempotency-Key': meta.idempotencyKey,
      };
      if (typeof lastDurationMs === 'number' && Number.isFinite(lastDurationMs) && lastDurationMs > 0) {
        headers['X-Audio-Duration-Ms'] = String(Math.round(lastDurationMs));
      }

      var reqInit = {
        method: 'POST',
        credentials: 'omit',
        headers: headers,
        body: blobToSend,
        signal: controller.signal,
      };

      function clearUploadState() {
        if (uploadObj.timeoutId !== null) {
          try { clearTimer(uploadObj.timeoutId); } catch (e) { /* ignore */ }
          uploadObj.timeoutId = null;
        }
        if (activeUpload === uploadObj) activeUpload = null;
      }

      uploadObj.timeoutId = setTimer(function () {
        uploadObj.timeoutId = null;
        if (activeUpload !== uploadObj) return;
        activeUpload = null;
        uploadObj.abortedBy = 'timeout';
        if (controller && typeof controller.abort === 'function') {
          try { controller.abort(); } catch (e) { /* ignore */ }
        }
        dispatch({
          type: 'TRANSCRIBE_ERROR',
          generation: meta.generation,
          error: 'timeout',
          now: reducerNow(),
        });
      }, C.VOICE_LIMITS.UPLOAD_TIMEOUT_MS);

      var fetchPromise;
      try {
        fetchPromise = Promise.resolve(fetchFn(info.vu + '/v1/voice/transcriptions', reqInit));
      } catch (syncErr) {
        fetchPromise = Promise.reject(syncErr);
      }

      fetchPromise.then(function (res) {
        if (uploadObj.abortedBy) {
          clearUploadState();
          return;
        }

        return readResponseJson(res).then(function (body) {
          clearUploadState();
          if (uploadObj.abortedBy) return;
          if (!res || !res.ok) {
            dispatch({
              type: 'TRANSCRIBE_ERROR',
              generation: meta.generation,
              error: extractErrorInput(res, body),
              now: reducerNow(),
            });
            return;
          }
          if (!body || typeof body !== 'object' || Array.isArray(body) ||
              (body.v !== undefined && body.v !== 1) || typeof body.text !== 'string') {
            dispatch({
              type: 'TRANSCRIBE_ERROR',
              generation: meta.generation,
              error: 'transcription_failed',
              now: reducerNow(),
            });
            return;
          }
          dispatch({
            type: 'TRANSCRIBE_OK',
            generation: meta.generation,
            text: body.text,
          });
        });
      }).then(null, function (err) {
        clearUploadState();
        if (uploadObj.abortedBy) return;
        var code = err && err.name === 'AbortError' ? 'timeout' : 'network_error';
        dispatch({
          type: 'TRANSCRIBE_ERROR',
          generation: meta.generation,
          error: code,
          now: reducerNow(),
        });
      });
    }

    function deliverUpload(meta) {
      if (typeof o.onUpload === 'function') {
        o.onUpload({
          generation: meta.generation,
          idempotencyKey: meta.idempotencyKey,
          blob: currentBlob,
          mimeType: currentMime,
          durationMs: lastDurationMs,
        });
      }
      if (typeof o.onUpload !== 'function' || hasUploadConfig) {
        uploadTranscription(meta);
      }
    }

    function stopRecorderOnly() {
      clearAutoStop();
      var rec = activeRecorder;
      activeRecorder = null;
      if (!rec) return;
      try {
        if (rec.state !== 'inactive' && typeof rec.stop === 'function') rec.stop();
      } catch (e) {
        /* ignore broken WebView recorder */
      }
    }

    function startRecorder(generation) {
      if (generation !== state.generation) return;
      var stream = activeStream;
      if (!stream || typeof MediaRecorderCtor !== 'function') {
        dispatch({ type: 'RECORDER_ERROR', error: 'no_supported_format' });
        return;
      }
      var mime = o.mime || C.pickVoiceMime(
        typeof MediaRecorderCtor.isTypeSupported === 'function'
          ? function (m) { return MediaRecorderCtor.isTypeSupported(m); }
          : null
      );
      if (!mime) {
        dispatch({ type: 'RECORDER_ERROR', error: 'no_supported_format' });
        return;
      }

      var rec;
      try {
        rec = new MediaRecorderCtor(stream, {
          mimeType: mime,
          audioBitsPerSecond: C.VOICE_LIMITS.AUDIO_BPS,
        });
      } catch (err) {
        dispatch({ type: 'RECORDER_ERROR', error: err || 'recorder_error' });
        return;
      }

      var recCtx = {
        generation: generation,
        mime: mime,
        chunks: [],
        discarded: false,
        stopped: false,
        rec: rec,
      };

      activeRecorder = rec;
      activeRecording = recCtx;
      currentBlob = null;
      currentMime = '';
      pendingUpload = null;
      startedAtMs = clockFn();
      lastDurationMs = 0;

      rec.ondataavailable = function (e) {
        if (recCtx.discarded || recCtx.stopped || recCtx.generation !== state.generation || activeRecording !== recCtx) {
          return;
        }
        if (e && e.data && (e.data.size === undefined || e.data.size > 0)) {
          recCtx.chunks.push(e.data);
        }
      };

      rec.onerror = function (e) {
        if (recCtx.discarded || recCtx.stopped || recCtx.generation !== state.generation || activeRecording !== recCtx || activeRecorder !== rec) {
          return;
        }
        recCtx.discarded = true;
        recCtx.chunks = [];
        if (activeRecording === recCtx) activeRecording = null;
        dispatch({ type: 'RECORDER_ERROR', error: (e && e.error) || e || 'recorder_error' });
      };

      rec.onstop = function () {
        if (recCtx.stopped) return;
        recCtx.stopped = true;
        var shouldKeep = !recCtx.discarded &&
          recCtx.generation === state.generation &&
          activeRecording === recCtx &&
          state.status === 'sending';
        var builtChunks = recCtx.chunks;
        recCtx.chunks = [];
        if (!shouldKeep) {
          if (activeRecording === recCtx) activeRecording = null;
          return;
        }
        currentBlob = buildAudioBlob(o, builtChunks, recCtx.mime);
        currentMime = recCtx.mime;
        if (activeRecording === recCtx) activeRecording = null;
        if (pendingUpload && pendingUpload.generation === recCtx.generation && state.generation === pendingUpload.generation) {
          var meta = pendingUpload;
          pendingUpload = null;
          deliverUpload(meta);
        }
      };

      clearAutoStop();
      autoStopTimer = setTimer(function () {
        autoStopTimer = null;
        if (state.status !== 'listening' || activeRecorder !== rec || recCtx.generation !== state.generation) return;
        lastDurationMs = Math.max(0, clockFn() - startedAtMs);
        dispatch({ type: 'AUTO_STOP', durationMs: lastDurationMs });
      }, C.VOICE_LIMITS.MAX_SECONDS * 1000);

      try {
        rec.start();
      } catch (startErr) {
        recCtx.discarded = true;
        recCtx.chunks = [];
        if (activeRecording === recCtx) activeRecording = null;
        clearAutoStop();
        activeRecorder = null;
        dispatch({ type: 'RECORDER_ERROR', error: startErr || 'recorder_error' });
      }
    }

    function requestMic(generation) {
      if (typeof getUserMedia !== 'function') {
        Promise.resolve().then(function () {
          dispatch({ type: 'PERMISSION_DENIED', generation: generation, error: 'api_missing' });
        });
        return;
      }

      var gumPromise;
      try {
        gumPromise = Promise.resolve(getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
          },
        }));
      } catch (syncErr) {
        gumPromise = Promise.reject(syncErr);
      }

      gumPromise.then(function (stream) {
        dispatch({ type: 'PERMISSION_GRANTED', generation: generation }, { grantedStream: stream });
      }, function (err) {
        dispatch({ type: 'PERMISSION_DENIED', generation: generation, error: err || 'NotAllowedError' });
      });
    }

    function runEffect(ef, ctx) {
      if (!ef || typeof ef.type !== 'string') return;
      if (ef.type === 'save_consent') {
        saveConsent(storage);
      } else if (ef.type === 'request_mic') {
        requestMic(ef.generation);
      } else if (ef.type === 'start_recorder') {
        if (ctx && ctx.grantedStream) {
          activeStream = ctx.grantedStream;
          if (typeof o.onStream === 'function') {
            try { o.onStream(activeStream); } catch (e) { /* ignore */ }
          }
        }
        startRecorder(ef.generation);
      } else if (ef.type === 'stop_recorder') {
        stopRecorderOnly();
      } else if (ef.type === 'stop_tracks') {
        if (ctx && ctx.grantedStream) {
          stopStreamTracks(ctx.grantedStream);
          if (typeof o.onStream === 'function') {
            try { o.onStream(null); } catch (e) { /* ignore */ }
          }
        } else {
          stopStreamTracks(activeStream);
          if (typeof o.onStream === 'function') {
            try { o.onStream(null); } catch (e) { /* ignore */ }
          }
          activeStream = null;
        }
      } else if (ef.type === 'drop_blob') {
        dropBlobState();
      } else if (ef.type === 'delete_session') {
        clearSession(storage);
        activeSession = null;
        if (typeof o.onDeleteSession === 'function') o.onDeleteSession();
      } else if (ef.type === 'upload') {
        if (currentBlob) {
          deliverUpload({ generation: ef.generation, idempotencyKey: ef.idempotencyKey });
        } else {
          pendingUpload = { generation: ef.generation, idempotencyKey: ef.idempotencyKey };
        }
      } else if (ef.type === 'abort_fetch') {
        abortActiveUpload('cancel');
        if (typeof o.onAbortFetch === 'function') o.onAbortFetch();
      } else if (ef.type === 'send_data') {
        if (typeof o.onSendData === 'function') o.onSendData({ json: ef.json, payload: ef.payload });
      } else if (ef.type === 'open_plan_b') {
        if (typeof o.onPlanB === 'function') o.onPlanB();
      }
    }

    function dispatch(event, ctx) {
      var prev = state;
      var ev = event || {};
      var nowMs = reducerNow();
      if ((ev.type === 'RETRY' || ev.type === 'TRANSCRIBE_ERROR') && ev.now === undefined) {
        ev = Object.assign({}, ev, { now: nowMs });
      }
      state = C.voiceReducer(state, ev);
      if (state.changed && !C.keepBlob(ev, ev.type === 'RETRY' ? prev : state, nowMs)) {
        dropBlobState();
      }
      syncRetryExpiry();
      if (state.changed && typeof o.onState === 'function') {
        try { o.onState(state, prev); } catch (e) { /* ignore UI error */ }
      }
      var effects = state.effects || [];
      for (var i = 0; i < effects.length; i++) {
        runEffect(effects[i], ctx);
      }
      return state;
    }

    return {
      state: function () { return state; },
      hasConsent: function () { return hasConsent(storage); },
      blob: function () { return currentBlob; },
      setSession: function (s) { activeSession = s || null; },
      dispatch: function (ev) { return dispatch(ev); },
      start: function () {
        return dispatch({ type: 'START', consented: hasConsent(storage) });
      },
      acceptConsent: function () {
        return dispatch({ type: 'CONSENT_ACCEPT' });
      },
      declineConsent: function () {
        return dispatch({ type: 'CONSENT_DECLINE' });
      },
      stop: function () {
        lastDurationMs = state.status === 'listening' ? Math.max(0, clockFn() - startedAtMs) : 0;
        return dispatch({ type: 'STOP', durationMs: lastDurationMs });
      },
      cancel: function () {
        return dispatch({ type: 'CANCEL' });
      },
      hide: function () {
        return dispatch({ type: 'HIDE' });
      },
      collapse: function () {
        return dispatch({ type: 'COLLAPSE' });
      },
      editText: function (text) {
        return dispatch({ type: 'EDIT_TEXT', text: text });
      },
      send: function (submissionId) {
        return dispatch({ type: 'SEND', submissionId: submissionId });
      },
      rerecord: function () {
        return dispatch({ type: 'RERECORD' });
      },
      retryPermission: function () {
        return dispatch({ type: 'RETRY_PERMISSION' });
      },
      retry: function () {
        return dispatch({ type: 'RETRY', now: reducerNow() });
      },
      planB: function () {
        return dispatch({ type: 'PLAN_B' });
      },
      close: function () {
        return dispatch({ type: 'CLOSE' });
      },
    };
  }

  var api = {
    readSession: readSession,
    writeSession: writeSession,
    clearSession: clearSession,
    exchangeSession: exchangeSession,
    resolveSession: resolveSession,
    hasConsent: hasConsent,
    saveConsent: saveConsent,
    stopStreamTracks: stopStreamTracks,
    createVoiceController: createVoiceController,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShapeVoice = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
