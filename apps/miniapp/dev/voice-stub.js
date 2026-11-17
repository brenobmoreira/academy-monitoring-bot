/**
 * Local preview stub for voice recording/transcription (C6b-4).
 * Classic script exposing `window.ShapeVoiceStub`. Used ONLY outside Telegram (preview) so
 * preview never calls a real voice service. Pure fake responses and optional fallback fake
 * media when browser WebViews/HTTP lack navigator.mediaDevices or MediaRecorder.
 */
(function (root) {
  'use strict';

  var PREVIEW_VU = 'https://preview.voice.invalid';

  var SAMPLES = {
    workout: 'supino reto 80 kg por 8, 80 kg por 7, RIR 1',
    food: 'almoço 150 g de arroz branco e 120 g de frango grelhado',
  };

  function makeAbortError() {
    var err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    return err;
  }

  function jsonResponse(status, body) {
    return {
      ok: status >= 200 && status < 300,
      status: status,
      json: function () { return Promise.resolve(body); },
    };
  }

  function createFetch(getView, opts) {
    var o = opts || {};
    var delayMs = typeof o.delayMs === 'number' ? o.delayMs : 250;
    return function (url, init) {
      var u = String(url || '');
      if (u.indexOf('/v1/auth/sessions') >= 0) {
        return Promise.resolve(jsonResponse(200, {
          v: 1,
          session: 's1.preview-stub',
          expires_at: Math.floor(Date.now() / 1000) + 43200,
          scopes: ['voice'],
          ref: 'preview',
        }));
      }
      if (u.indexOf('/v1/voice/transcriptions') >= 0) {
        var signal = init && init.signal;
        if (signal && signal.aborted) {
          return Promise.reject(makeAbortError());
        }
        return new Promise(function (resolve, reject) {
          var timer = null;
          var onAbort = function () {
            if (timer !== null) {
              clearTimeout(timer);
              timer = null;
            }
            reject(makeAbortError());
          };
          if (signal && typeof signal.addEventListener === 'function') {
            signal.addEventListener('abort', onAbort);
          }
          timer = setTimeout(function () {
            timer = null;
            if (signal && typeof signal.removeEventListener === 'function') {
              signal.removeEventListener('abort', onAbort);
            }
            if (signal && signal.aborted) {
              reject(makeAbortError());
              return;
            }
            var view = typeof getView === 'function' ? getView() : 'workout';
            var text = SAMPLES[view] || SAMPLES.workout;
            resolve(jsonResponse(200, {
              v: 1,
              id: '0123456789abcdef0123456789abcdef',
              text: text,
            }));
          }, delayMs);
        });
      }
      return Promise.reject(new Error('Preview voice stub blocked unexpected fetch: ' + u));
    };
  }

  function createMedia() {
    function FakeMediaRecorder(stream, opts) {
      this.stream = stream;
      this.mimeType = (opts && opts.mimeType) || 'audio/webm;codecs=opus';
      this.state = 'inactive';
      this.ondataavailable = null;
      this.onstop = null;
      this.onerror = null;
    }
    FakeMediaRecorder.isTypeSupported = function (mime) {
      return mime === 'audio/webm;codecs=opus';
    };
    FakeMediaRecorder.prototype.start = function () {
      this.state = 'recording';
    };
    FakeMediaRecorder.prototype.stop = function () {
      if (this.state === 'inactive') return;
      this.state = 'inactive';
      var self = this;
      setTimeout(function () {
        if (typeof self.ondataavailable === 'function') {
          self.ondataavailable({ data: new Uint8Array([1, 2, 3, 4]) });
        }
        if (typeof self.onstop === 'function') {
          self.onstop();
        }
      }, 0);
    };

    return {
      getUserMedia: function () {
        var track = { kind: 'audio', readyState: 'live', stop: function () { this.readyState = 'ended'; } };
        return Promise.resolve({
          getTracks: function () { return [track]; },
          getAudioTracks: function () { return [track]; },
        });
      },
      MediaRecorder: FakeMediaRecorder,
    };
  }

  var api = {
    vu: PREVIEW_VU,
    SAMPLES: SAMPLES,
    createFetch: createFetch,
    createMedia: createMedia,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShapeVoiceStub = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
