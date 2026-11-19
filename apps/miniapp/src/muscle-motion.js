/**
 * MuscleMotion — Core physics, secondary follow-through, micro-life, 60fps Web Audio
 * envelope reactivity, spatial FLIP stage travel, and proactive guiding choreography
 * for Muscle (`ShapeAvatar`, with `DitoArt` fallback).
 *
 * Pure browser classic script + CommonJS export for `node --test`. Zero external deps.
 * Strictly honors `prefers-reduced-motion: reduce` and `[data-motion="off"]`.
 */
(function (global) {
  'use strict';

  /* ── §1.1 Physics & Easing Curves ── */
  var SPRING = 'cubic-bezier(0.34, 1.56, 0.64, 1)';
  var SPRING_POP = SPRING;
  var SPRING_SOFT = 'cubic-bezier(0.25, 1.25, 0.50, 1)';
  var ANTICIPATE = 'cubic-bezier(0.42, 0, 1, 1)';
  var SETTLE = 'cubic-bezier(0.16, 1, 0.3, 1)';
  var EASE_DECEL = SETTLE;
  var EASE_ACCEL = 'cubic-bezier(0.55, 0, 1, 0.45)';
  var EASE_BREATH = 'cubic-bezier(0.45, 0, 0.55, 1)';

  var MORPH_TIMING = {
    anticipateMs: 70,
    overshootMs: 210,
    settleMs: 90,
    totalMs: 370,
    gazeDelayMs: 35,
    gazeMs: 240,
    footDelayMs: 50,
    footMs: 250,
  };

  /* Deterministic 8-step organic blink cadence (all in 2500..8000ms, zero Math.random) */
  var BLINK_SEQUENCE = [3800, 5200, 4100, 6400, 3200, 5800, 4600, 7000];
  var blinkIndex = 0;

  var SLOTS = {
    header: 'header',
    empty: 'empty',
    review: 'review',
    voice: 'voice',
  };

  function noop() {}

  /* ── Environment & Avatar Resolution ── */

  function isElementLike(x) {
    return !!(
      x &&
      typeof x === 'object' &&
      (typeof x.setAttribute === 'function' ||
        typeof x.querySelector === 'function' ||
        typeof x.appendChild === 'function' ||
        typeof x.nodeType === 'number')
    );
  }

  function docOf(el) {
    if (el && el.ownerDocument) return el.ownerDocument;
    return typeof document !== 'undefined' ? document : null;
  }

  function winOf(el, opts) {
    if (opts && opts.window) return opts.window;
    var doc = docOf(el);
    if (doc && doc.defaultView) return doc.defaultView;
    return global;
  }

  function resolveAvatar(el, opts) {
    if (opts && opts.avatar) return opts.avatar;
    var win = winOf(el, opts);
    if (win && win.ShapeAvatar) return win.ShapeAvatar;
    if (global && global.ShapeAvatar) return global.ShapeAvatar;
    if (win && win.DitoArt) return win.DitoArt;
    if (global && global.DitoArt) return global.DitoArt;
    return null;
  }

  function reducedMotion(el, opts) {
    for (var node = el; node; node = node.parentNode) {
      if (node.getAttribute && node.getAttribute('data-motion') === 'off') {
        return true;
      }
    }
    var win = winOf(el, opts);
    try {
      return !!(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function query(el, selector) {
    if (!el || typeof el.querySelector !== 'function') return null;
    try {
      return el.querySelector(selector);
    } catch (e) {
      return null;
    }
  }

  function setTimer(win, fn, ms) {
    var s = (win && typeof win.setTimeout === 'function') ? win.setTimeout : setTimeout;
    return s(fn, ms);
  }

  function clearTimer(win, id) {
    var c = (win && typeof win.clearTimeout === 'function') ? win.clearTimeout : clearTimeout;
    c(id);
  }

  function clamp01(v) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
    return v >= 1 ? 1 : v;
  }

  function cancelNodeAnimations(node) {
    if (!node) return;
    if (typeof node.getAnimations === 'function') {
      var live = null;
      try { live = node.getAnimations(); } catch (e) { live = null; }
      if (live) {
        for (var i = 0; i < live.length; i++) {
          if (live[i] && typeof live[i].cancel === 'function') {
            try { live[i].cancel(); } catch (e) { /* ignore */ }
          }
        }
      }
      return;
    }
    if (Array.isArray(node._animations)) {
      for (var j = 0; j < node._animations.length; j++) {
        var a = node._animations[j];
        if (a && a.playState === 'running' && typeof a.cancel === 'function') {
          try { a.cancel(); } catch (e) { /* ignore */ }
        }
      }
    }
  }

  function applyAvatarForm(el, form, opts) {
    if (!el || !form) return;
    var win = winOf(el, opts);
    var avatar = resolveAvatar(el, opts);
    var isShapeAvatar = !!(
      avatar &&
      ((win && avatar === win.ShapeAvatar) ||
        (global && avatar === global.ShapeAvatar) ||
        Array.isArray(avatar.FORMS))
    );
    if (isShapeAvatar) {
      var validForms = Array.isArray(avatar.FORMS) && avatar.FORMS.length > 0 ? avatar.FORMS : null;
      var next = validForms
        ? (validForms.indexOf(form) >= 0
          ? form
          : (validForms.indexOf('idle') >= 0 ? 'idle' : validForms[0]))
        : String(form || 'idle');
      if (el.setAttribute) el.setAttribute('data-form', next);
      return;
    }
    if (avatar && typeof avatar.setForm === 'function') {
      if (avatar.setForm.length >= 2) {
        avatar.setForm(el, form);
      } else {
        avatar.setForm(form);
      }
      if (el.setAttribute && el.getAttribute('data-form') !== form) {
        el.setAttribute('data-form', form);
      }
      return;
    }
    if (el.setAttribute) el.setAttribute('data-form', form);
  }

  function applyAvatarState(el, state, opts) {
    if (!el || !state) return;
    var avatar = resolveAvatar(el, opts);
    if (avatar) {
      if (typeof avatar.setState === 'function') {
        avatar.setState(el, state);
      } else if (typeof avatar.setMood === 'function') {
        if (avatar.setMood.length >= 2) {
          avatar.setMood(el, state);
        } else {
          avatar.setMood(state);
        }
      }
      if (el.setAttribute && el.getAttribute('data-state') !== state) {
        if (!avatar.STATES || avatar.STATES.indexOf(state) >= 0) {
          el.setAttribute('data-state', state);
        }
      }
      return;
    }
    if (el.setAttribute) el.setAttribute('data-state', state);
  }

  function applyAvatarLevel(el, level, opts) {
    var v = clamp01(level);
    if (!el) return v;
    var avatar = resolveAvatar(el, opts);
    if (avatar && typeof avatar.setLevel === 'function') {
      avatar.setLevel(el, v);
      return v;
    }
    if (el.setAttribute) {
      el.setAttribute('data-level', String(Math.round(v * 100) / 100));
    }
    return v;
  }

  /* ── Per-Element Lifecycle Registry (zero leaks) ── */

  var elementRecords = typeof WeakMap === 'function' ? new WeakMap() : null;
  var trackedElements = new Set();
  var detachedCleanups = new Set();

  function recordFor(el) {
    if (!el || typeof el !== 'object') return null;
    trackedElements.add(el);
    if (elementRecords) {
      var rec = elementRecords.get(el);
      if (!rec) {
        rec = {
          animations: new Set(),
          timers: new Set(),
          cleanups: new Set(),
          morphAbort: null,
          travelAbort: null,
          validationAbort: null,
          guideAbort: null,
        };
        elementRecords.set(el, rec);
      }
      return rec;
    }
    return null;
  }

  function trackAnim(el, anim) {
    if (!anim) return null;
    var rec = recordFor(el);
    if (!rec) return anim;
    rec.animations.add(anim);
    var prevFinish = anim.onfinish;
    var prevCancel = anim.oncancel;
    anim.onfinish = function () {
      rec.animations.delete(anim);
      if (typeof prevFinish === 'function') prevFinish.apply(this, arguments);
    };
    anim.oncancel = function () {
      rec.animations.delete(anim);
      if (typeof prevCancel === 'function') prevCancel.apply(this, arguments);
    };
    return anim;
  }

  function registerCleanup(el, fn) {
    if (typeof fn !== 'function') return noop;
    var rec = recordFor(el);
    var active = true;
    function wrapped() {
      if (!active) return;
      active = false;
      if (rec) rec.cleanups.delete(wrapped);
      detachedCleanups.delete(wrapped);
      fn();
    }
    wrapped.cancel = wrapped;
    wrapped.stop = wrapped;
    wrapped.destroy = wrapped;
    if (rec) rec.cleanups.add(wrapped);
    else detachedCleanups.add(wrapped);
    return wrapped;
  }

  /* ── §1.2 Morph: Anticipation (70ms) -> setForm -> Overshoot (210ms) -> Settle (90ms) ── */

  function morph(el, newForm, opts) {
    if (!el) return null;
    var rec = recordFor(el);
    if (rec && rec.morphAbort) {
      rec.morphAbort();
      rec.morphAbort = null;
    }

    if (reducedMotion(el, opts)) {
      applyAvatarForm(el, newForm, opts);
      if (opts && typeof opts.onFinish === 'function') opts.onFinish(el, newForm);
      return null;
    }

    var body = query(el, '.dt-anim') || query(el, '.dt-body-group') || query(el, '.dt-pose');
    var eyes = query(el, '.dt-gaze') || query(el, '.dt-scan');
    var foot = query(el, '.dt-foot') || query(el, '.dt-limbs');

    if (!body || typeof body.animate !== 'function') {
      applyAvatarForm(el, newForm, opts);
      if (opts && typeof opts.onFinish === 'function') opts.onFinish(el, newForm);
      return null;
    }

    var cancelled = false;
    var activeMorphAnims = [];

    function pushMorphAnim(a) {
      if (a) {
        activeMorphAnims.push(a);
        if (rec) rec.animations.add(a);
      }
      return a;
    }

    function cancelMorph() {
      if (cancelled) return;
      cancelled = true;
      if (rec && rec.morphAbort === cancelMorph) rec.morphAbort = null;
      while (activeMorphAnims.length) {
        var a = activeMorphAnims.pop();
        if (rec) rec.animations.delete(a);
        if (a && typeof a.cancel === 'function') {
          try { a.cancel(); } catch (e) { /* ignore */ }
        }
      }
      cancelNodeAnimations(query(el, '.dt-anim'));
    }

    if (rec) rec.morphAbort = cancelMorph;

    // Phase 1: Anticipation crouch (70ms)
    var anticipation = pushMorphAnim(body.animate([
      { transform: 'scale(1, 1)', offset: 0 },
      { transform: 'scale(1.05, 0.93)', offset: 1 },
    ], {
      duration: MORPH_TIMING.anticipateMs,
      easing: ANTICIPATE,
      fill: 'forwards',
      composite: 'add',
    }));

    if (!anticipation) {
      if (rec) rec.morphAbort = null;
      applyAvatarForm(el, newForm, opts);
      if (opts && typeof opts.onFinish === 'function') opts.onFinish(el, newForm);
      return null;
    }

    anticipation.onfinish = function () {
      if (rec) rec.animations.delete(anticipation);
      if (cancelled) return;
      if (typeof anticipation.cancel === 'function') {
        try { anticipation.cancel(); } catch (e) { /* ignore */ }
      }

      // Apply context form switch right at peak compression
      applyAvatarForm(el, newForm, opts);

      // Phase 2: Spring overshoot (210ms)
      var overshoot = pushMorphAnim(body.animate([
        { transform: 'scale(1.05, 0.93)', offset: 0 },
        { transform: 'scale(0.93, 1.09)', offset: 0.55 },
        { transform: 'scale(1.02, 0.98)', offset: 1 },
      ], {
        duration: MORPH_TIMING.overshootMs,
        easing: SPRING,
        fill: 'forwards',
        composite: 'add',
      }));

      if (overshoot) {
        overshoot.onfinish = function () {
          if (rec) rec.animations.delete(overshoot);
          if (cancelled) return;
          if (typeof overshoot.cancel === 'function') {
            try { overshoot.cancel(); } catch (e) { /* ignore */ }
          }

          // Phase 3: Settle to rest (90ms -> 70 + 210 + 90 = 370ms total)
          var settleAnim = pushMorphAnim(body.animate([
            { transform: 'scale(1.02, 0.98)', offset: 0 },
            { transform: 'scale(1, 1)', offset: 1 },
          ], {
            duration: MORPH_TIMING.settleMs,
            easing: SETTLE,
            composite: 'add',
          }));

          if (settleAnim) {
            settleAnim.onfinish = function () {
              if (rec) {
                rec.animations.delete(settleAnim);
                if (rec.morphAbort === cancelMorph) rec.morphAbort = null;
              }
              if (!cancelled && opts && typeof opts.onFinish === 'function') {
                opts.onFinish(el, newForm);
              }
            };
          } else if (opts && typeof opts.onFinish === 'function') {
            opts.onFinish(el, newForm);
          }
        };
      }

      // Secondary follow-through: gaze/eyes (+35ms lag, 240ms -> completes at 345ms <= 370ms)
      if (eyes && typeof eyes.animate === 'function') {
        var gazeAnim = pushMorphAnim(eyes.animate([
          { transform: 'translateY(2px)', offset: 0 },
          { transform: 'translateY(-1.2px)', offset: 0.5 },
          { transform: 'translateY(0)', offset: 1 },
        ], {
          duration: MORPH_TIMING.gazeMs,
          delay: MORPH_TIMING.gazeDelayMs,
          easing: SPRING_SOFT,
          composite: 'add',
        }));
        if (gazeAnim) {
          gazeAnim.onfinish = function () {
            if (rec) rec.animations.delete(gazeAnim);
          };
        }
      }

      // Secondary follow-through: heavy tail-foot (+50ms lag, 250ms -> completes at 370ms)
      if (foot && typeof foot.animate === 'function') {
        var footAnim = pushMorphAnim(foot.animate([
          { transform: 'rotate(3deg)', offset: 0 },
          { transform: 'rotate(-1.5deg)', offset: 0.55 },
          { transform: 'rotate(0deg)', offset: 1 },
        ], {
          duration: MORPH_TIMING.footMs,
          delay: MORPH_TIMING.footDelayMs,
          easing: SETTLE,
          composite: 'add',
        }));
        if (footAnim) {
          footAnim.onfinish = function () {
            if (rec) rec.animations.delete(footAnim);
          };
        }
      }
    };

    return {
      anticipation: anticipation,
      totalMs: MORPH_TIMING.totalMs,
      cancel: cancelMorph,
    };
  }

  /* ── §1.3 Micro-Life: Deterministic Blinks, Gaze/Tilt, Idle Breath, Foot Tap ── */

  function nextBlinkDelay() {
    var delay = BLINK_SEQUENCE[blinkIndex % BLINK_SEQUENCE.length];
    blinkIndex += 1;
    return delay;
  }

  function resetBlinkSequence() {
    blinkIndex = 0;
  }

  function blink(el, opts) {
    if (!el || reducedMotion(el, opts)) return null;
    var state = (el.getAttribute && el.getAttribute('data-state')) || '';
    var eyes = (state ? query(el, '.f-' + state + ' .dt-eyes') : null) || query(el, '.dt-eyes');
    if (!eyes || typeof eyes.animate !== 'function') return null;

    var anim = eyes.animate([
      { transform: 'scaleY(1)', offset: 0 },
      { transform: 'scaleY(0.08)', offset: 0.30 },
      { transform: 'scaleY(0.08)', offset: 0.50 },
      { transform: 'scaleY(1)', offset: 1 },
    ], {
      duration: 200,
      easing: 'ease-in-out',
    });
    return trackAnim(el, anim);
  }

  function startBlink(el, opts) {
    if (!el || reducedMotion(el, opts)) return noop;
    var win = winOf(el, opts);
    var rec = recordFor(el);
    var timerId = null;
    var activeBlink = null;
    var cancelled = false;

    function schedule() {
      if (cancelled || reducedMotion(el, opts)) return;
      timerId = setTimer(win, tick, nextBlinkDelay());
      if (rec) rec.timers.add(timerId);
    }

    function tick() {
      if (rec && timerId !== null) rec.timers.delete(timerId);
      timerId = null;
      if (cancelled || reducedMotion(el, opts)) return;
      activeBlink = blink(el, opts);
      if (activeBlink) {
        var prevFinish = activeBlink.onfinish;
        activeBlink.onfinish = function () {
          if (typeof prevFinish === 'function') prevFinish.apply(this, arguments);
          activeBlink = null;
          schedule();
        };
      } else {
        schedule();
      }
    }

    schedule();

    return registerCleanup(el, function () {
      cancelled = true;
      if (timerId !== null) {
        if (rec) rec.timers.delete(timerId);
        clearTimer(win, timerId);
        timerId = null;
      }
      if (activeBlink && typeof activeBlink.cancel === 'function') {
        try { activeBlink.cancel(); } catch (e) { /* ignore */ }
        activeBlink = null;
      }
    });
  }

  var startBlinkLoop = startBlink;

  function glance(el, targetEl, opts) {
    if (!el) return;
    var gaze = query(el, '.dt-gaze') || query(el, '.dt-scan');
    var pose = query(el, '.dt-pose');
    if (!gaze || !gaze.style) return;

    var isReduced = reducedMotion(el, opts);

    if (!targetEl || typeof targetEl.getBoundingClientRect !== 'function' || typeof el.getBoundingClientRect !== 'function') {
      gaze.style.transform = '';
      if (pose && pose.style) {
        if (!isReduced) pose.style.transition = 'transform 0.25s ease-out';
        pose.style.transform = '';
      }
      return;
    }

    if (isReduced) {
      gaze.style.transform = '';
      if (pose && pose.style) pose.style.transform = '';
      return;
    }

    var from = el.getBoundingClientRect();
    var to = targetEl.getBoundingClientRect();
    var dx = (to.left + to.width / 2) - (from.left + from.width / 2);
    var dy = (to.top + to.height / 2) - (from.top + from.height / 2);
    var len = Math.sqrt(dx * dx + dy * dy);
    if (!(len > 0)) {
      gaze.style.transform = '';
      if (pose && pose.style) pose.style.transform = '';
      return;
    }

    var maxShift = (opts && typeof opts.maxShift === 'number') ? opts.maxShift : 3;
    var eyeX = Math.round((dx / len) * maxShift * 100) / 100;
    var eyeY = Math.round((dy / len) * maxShift * 100) / 100;
    gaze.style.transition = 'transform 0.2s ease-out';
    gaze.style.transform = 'translate(' + eyeX + 'px, ' + eyeY + 'px)';

    if (pose && pose.style) {
      var tiltDeg = Math.round((dx / len) * 3 * 10) / 10;
      pose.style.transition = 'transform 0.3s ease-out';
      pose.style.transform = 'rotate(' + tiltDeg + 'deg)';
    }
  }

  function startIdleBreath(el, opts) {
    if (!el || reducedMotion(el, opts)) return null;
    var breath = query(el, '.dt-breath') || query(el, '.dt-body-group');
    if (!breath || typeof breath.animate !== 'function') return null;

    var anim = breath.animate([
      { transform: 'scale(1, 1)', offset: 0 },
      { transform: 'scale(1.008, 1.018)', offset: 0.5 },
      { transform: 'scale(1, 1)', offset: 1 },
    ], {
      duration: 3600,
      easing: EASE_BREATH,
      iterations: Infinity,
    });
    if (!anim) return null;
    trackAnim(el, anim);

    return registerCleanup(el, function () {
      if (anim && typeof anim.cancel === 'function') {
        try { anim.cancel(); } catch (e) { /* ignore */ }
      }
      anim = null;
    });
  }

  function startFootTap(el, opts) {
    if (!el || reducedMotion(el, opts)) return noop;
    var foot = query(el, '.dt-foot') || query(el, '.dt-limbs');
    if (!foot || typeof foot.animate !== 'function') return noop;

    var rec = recordFor(el);
    var anim = null;
    var cancelled = false;

    function tap() {
      if (cancelled || reducedMotion(el, opts)) return;
      anim = foot.animate([
        { transform: 'rotate(0deg)', offset: 0 },
        { transform: 'rotate(-6deg)', offset: 0.35 },
        { transform: 'rotate(0deg)', offset: 0.55 },
        { transform: 'rotate(0deg)', offset: 1 },
      ], {
        duration: 600,
        easing: 'ease-in-out',
        composite: 'add',
      });
      if (!anim) return;
      if (rec) rec.animations.add(anim);
      anim.onfinish = function () {
        if (rec) rec.animations.delete(anim);
        if (!cancelled) tap();
      };
      anim.oncancel = function () {
        if (rec) rec.animations.delete(anim);
      };
    }

    tap();

    return registerCleanup(el, function () {
      cancelled = true;
      if (anim) {
        if (rec) rec.animations.delete(anim);
        if (typeof anim.cancel === 'function') {
          try { anim.cancel(); } catch (e) { /* ignore */ }
        }
        anim = null;
      }
    });
  }

  /* ── §1.4 & §2 Rich Reactions ── */

  var REACTIONS = {
    nod: {
      pose: [
        { transform: 'translateY(0)', offset: 0 },
        { transform: 'translateY(3.5px) scale(1.015, 0.985)', offset: 0.45 },
        { transform: 'translateY(-1px)', offset: 0.75 },
        { transform: 'translateY(0)', offset: 1 },
      ],
      poseMs: 280,
      poseEasing: 'ease-out',
      gaze: [
        { transform: 'translateY(0)', offset: 0 },
        { transform: 'translateY(2px)', offset: 0.50 },
        { transform: 'translateY(0)', offset: 1 },
      ],
      gazeMs: 260,
      gazeDelay: 25,
    },

    tick: {
      pose: [
        { transform: 'scale(1, 1)', offset: 0 },
        { transform: 'scale(1.07, 0.93)', offset: 0.35 },
        { transform: 'scale(0.98, 1.02)', offset: 0.65 },
        { transform: 'scale(1, 1)', offset: 1 },
      ],
      poseMs: 300,
      poseEasing: SPRING_SOFT,
      gaze: null,
      gazeMs: 0,
      gazeDelay: 0,
    },

    full: {
      pose: [
        { transform: 'translateY(0) scale(1, 1)', offset: 0 },
        { transform: 'translateY(0) scale(1.05, 0.90)', offset: 0.15 },
        { transform: 'translateY(-10px) scale(0.95, 1.06)', offset: 0.45 },
        { transform: 'translateY(0) scale(1.04, 0.96)', offset: 0.75 },
        { transform: 'translateY(0) scale(1, 1)', offset: 1 },
      ],
      poseMs: 440,
      poseEasing: SPRING_SOFT,
      gaze: [
        { transform: 'translateY(0)', offset: 0 },
        { transform: 'translateY(-2px)', offset: 0.45 },
        { transform: 'translateY(1px)', offset: 0.80 },
        { transform: 'translateY(0)', offset: 1 },
      ],
      gazeMs: 400,
      gazeDelay: 30,
    },

    celebrate: {
      pose: [
        { transform: 'translateY(0) scale(1, 1)', offset: 0 },
        { transform: 'translateY(0) scale(1.06, 0.88)', offset: 0.12 },
        { transform: 'translateY(-16px) scale(0.94, 1.08)', offset: 0.42 },
        { transform: 'translateY(-18px) scale(0.96, 1.04)', offset: 0.52 },
        { transform: 'translateY(0) scale(1.08, 0.90)', offset: 0.78 },
        { transform: 'translateY(0) scale(0.97, 1.03)', offset: 0.90 },
        { transform: 'translateY(0) scale(1, 1)', offset: 1 },
      ],
      poseMs: 520,
      poseEasing: SETTLE,
      gaze: [
        { transform: 'translateY(0)', offset: 0 },
        { transform: 'translateY(3px)', offset: 0.15 },
        { transform: 'translateY(-4px)', offset: 0.50 },
        { transform: 'translateY(1px)', offset: 0.80 },
        { transform: 'translateY(0)', offset: 1 },
      ],
      gazeMs: 480,
      gazeDelay: 35,
      foot: [
        { transform: 'rotate(0deg)', offset: 0 },
        { transform: 'rotate(5deg)', offset: 0.15 },
        { transform: 'rotate(-8deg)', offset: 0.50 },
        { transform: 'rotate(3deg)', offset: 0.80 },
        { transform: 'rotate(0deg)', offset: 1 },
      ],
      footMs: 500,
      footDelay: 40,
      setState: 'record',
    },

    pr: {
      pose: [
        { transform: 'translateY(0) scale(1, 1) rotate(0deg)', offset: 0 },
        { transform: 'translateY(0) scale(1.08, 0.86) rotate(0deg)', offset: 0.12 },
        { transform: 'translateY(-20px) scale(0.92, 1.10) rotate(-3deg)', offset: 0.44 },
        { transform: 'translateY(-21px) scale(0.95, 1.06) rotate(2deg)', offset: 0.54 },
        { transform: 'translateY(0) scale(1.09, 0.89) rotate(0deg)', offset: 0.78 },
        { transform: 'translateY(0) scale(0.97, 1.03) rotate(0deg)', offset: 0.90 },
        { transform: 'translateY(0) scale(1, 1) rotate(0deg)', offset: 1 },
      ],
      poseMs: 560,
      poseEasing: SPRING,
      gaze: [
        { transform: 'translateY(0)', offset: 0 },
        { transform: 'translateY(3px)', offset: 0.15 },
        { transform: 'translateY(-4.5px)', offset: 0.50 },
        { transform: 'translateY(1px)', offset: 0.80 },
        { transform: 'translateY(0)', offset: 1 },
      ],
      gazeMs: 500,
      gazeDelay: 35,
      foot: [
        { transform: 'rotate(0deg)', offset: 0 },
        { transform: 'rotate(6deg)', offset: 0.15 },
        { transform: 'rotate(-10deg)', offset: 0.50 },
        { transform: 'rotate(4deg)', offset: 0.80 },
        { transform: 'rotate(0deg)', offset: 1 },
      ],
      footMs: 520,
      footDelay: 40,
      setState: 'record',
    },

    no: {
      pose: [
        { transform: 'translateX(0)', offset: 0 },
        { transform: 'translateX(-3px) rotate(-2deg)', offset: 0.20 },
        { transform: 'translateX(2.5px) rotate(1.5deg)', offset: 0.40 },
        { transform: 'translateX(-1.5px) rotate(-1deg)', offset: 0.60 },
        { transform: 'translateX(0.8px)', offset: 0.80 },
        { transform: 'translateX(0)', offset: 1 },
      ],
      poseMs: 360,
      poseEasing: 'ease-in-out',
      gaze: [
        { transform: 'translateX(0)', offset: 0 },
        { transform: 'translateX(-2px)', offset: 0.25 },
        { transform: 'translateX(1.5px)', offset: 0.50 },
        { transform: 'translateX(0)', offset: 1 },
      ],
      gazeMs: 340,
      gazeDelay: 40,
    },
  };

  function react(el, kind, opts) {
    var spec = REACTIONS[kind];
    if (!el || !spec || reducedMotion(el, opts)) return false;

    var pose = query(el, '.dt-pose') || query(el, '.dt-body-group');
    var gaze = query(el, '.dt-gaze') || query(el, '.dt-scan');
    var foot = query(el, '.dt-foot') || query(el, '.dt-limbs');

    if (!pose || typeof pose.animate !== 'function') return false;

    if (spec.setState && (!opts || opts.applyState !== false)) {
      applyAvatarState(el, spec.setState, opts);
    }

    var poseAnim = trackAnim(el, pose.animate(spec.pose, {
      duration: spec.poseMs,
      easing: spec.poseEasing,
      composite: 'add',
    }));
    if (!poseAnim) return false;

    if (spec.gaze && gaze && typeof gaze.animate === 'function') {
      trackAnim(el, gaze.animate(spec.gaze, {
        duration: spec.gazeMs,
        delay: spec.gazeDelay,
        easing: 'ease-out',
        composite: 'add',
      }));
    }

    if (spec.foot && foot && typeof foot.animate === 'function') {
      trackAnim(el, foot.animate(spec.foot, {
        duration: spec.footMs,
        delay: spec.footDelay,
        easing: 'ease-out',
        composite: 'add',
      }));
    }

    return true;
  }

  /* ── §3 Live 60fps Audio Envelope Reactivity ── */

  var VOICE_ATTACK = 0.45;
  var VOICE_RELEASE = 0.18;

  function computeRms(samples) {
    if (!samples || !samples.length) return 0;
    var isByte = samples instanceof Uint8Array;
    var sum = 0;
    for (var i = 0; i < samples.length; i++) {
      var s = isByte ? (samples[i] - 128) / 128 : samples[i];
      sum += s * s;
    }
    return Math.sqrt(sum / samples.length);
  }

  function smoothEnvelope(current, target, attack, release) {
    var a = typeof attack === 'number' ? attack : VOICE_ATTACK;
    var r = typeof release === 'number' ? release : VOICE_RELEASE;
    var raw = clamp01(target);
    var coeff = raw > current ? a : r;
    return clamp01(current + (raw - current) * coeff);
  }

  /**
   * Supports both `(stream, el, opts)` and `(stream, opts)` where `opts.el` may be passed.
   */
  function createVoiceMeter(stream, elOrOpts, maybeOpts) {
    var el = null;
    var opts = {};
    if (isElementLike(elOrOpts)) {
      el = elOrOpts;
      opts = maybeOpts || {};
    } else if (elOrOpts && typeof elOrOpts === 'object') {
      opts = elOrOpts;
      el = opts.el || null;
    }

    var fallback = {
      stop: noop,
      level: function () { return 0; },
    };

    if (!stream) return fallback;

    var win = winOf(el, opts);
    var AudioCtx =
      opts.AudioContext ||
      (win && (win.AudioContext || win.webkitAudioContext)) ||
      (typeof AudioContext !== 'undefined'
        ? AudioContext
        : (typeof webkitAudioContext !== 'undefined' ? webkitAudioContext : null));

    if (typeof AudioCtx !== 'function') return fallback;

    var ctx = null;
    var analyser = null;
    var source = null;

    try {
      ctx = new AudioCtx();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0;
      source = ctx.createMediaStreamSource(stream);
      source.connect(analyser);
    } catch (e) {
      if (ctx && typeof ctx.close === 'function') {
        try {
          var p = ctx.close();
          if (p && typeof p.catch === 'function') p.catch(noop);
        } catch (err) { /* ignore */ }
      }
      return fallback;
    }

    var binCount = (analyser && analyser.frequencyBinCount) ? analyser.frequencyBinCount : 128;
    var buffer = new Uint8Array(binCount);
    var attack = typeof opts.attack === 'number' ? opts.attack : VOICE_ATTACK;
    var release = typeof opts.release === 'number' ? opts.release : VOICE_RELEASE;
    var gain = typeof opts.gain === 'number' ? opts.gain : 4;
    var currentLevel = 0;
    var rafId = null;
    var usingTimerFallback = false;
    var stopped = false;

    var raf =
      opts.requestAnimationFrame ||
      (win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null) ||
      (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);

    var caf =
      opts.cancelAnimationFrame ||
      (win && typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : null) ||
      (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null);

    function scheduleNext(fn) {
      if (raf) {
        usingTimerFallback = false;
        return raf(fn);
      }
      usingTimerFallback = true;
      return setTimer(win, fn, 16);
    }

    function cancelNext(id) {
      if (id === null || id === undefined) return;
      if (!usingTimerFallback && caf) {
        caf(id);
      } else {
        clearTimer(win, id);
      }
    }

    function tick() {
      if (stopped || !analyser) return;
      analyser.getByteTimeDomainData(buffer);
      var rms = computeRms(buffer);
      var raw = clamp01(rms * gain);
      currentLevel = smoothEnvelope(currentLevel, raw, attack, release);

      if (el) applyAvatarLevel(el, currentLevel, opts);
      if (typeof opts.onLevel === 'function') opts.onLevel(currentLevel);

      if (!stopped) {
        rafId = scheduleNext(tick);
      }
    }

    rafId = scheduleNext(tick);

    var unregister = registerCleanup(el, stopMeter);

    function stopMeter() {
      if (stopped) return;
      stopped = true;
      if (rafId !== null) {
        cancelNext(rafId);
        rafId = null;
      }
      currentLevel = 0;

      if (el) applyAvatarLevel(el, 0, opts);
      if (typeof opts.onLevel === 'function') opts.onLevel(0);

      try { if (source && typeof source.disconnect === 'function') source.disconnect(); } catch (e) { /* ignore */ }
      try { if (analyser && typeof analyser.disconnect === 'function') analyser.disconnect(); } catch (e) { /* ignore */ }

      try {
        if (ctx && ctx.state !== 'closed' && typeof ctx.close === 'function') {
          var closeRes = ctx.close();
          if (closeRes && typeof closeRes.catch === 'function') closeRes.catch(noop);
        }
      } catch (e) { /* ignore */ }

      source = null;
      analyser = null;
      ctx = null;
    }

    return {
      level: function () { return currentLevel; },
      stop: function () {
        unregister();
      },
    };
  }

  function connectVoice(el, stream, opts) {
    if (!isElementLike(el) && isElementLike(stream)) {
      return createVoiceMeter(el, stream, opts);
    }
    return createVoiceMeter(stream, el, opts);
  }

  function createSineSimulator(el, periodMs, opts) {
    if (!el) return { stop: noop };
    var win = winOf(el, opts);
    var raf =
      (opts && opts.requestAnimationFrame) ||
      (win && typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : null) ||
      (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null);
    var caf =
      (opts && opts.cancelAnimationFrame) ||
      (win && typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame.bind(win) : null) ||
      (typeof cancelAnimationFrame === 'function' ? cancelAnimationFrame : null);

    var nowFn = (win && win.performance && typeof win.performance.now === 'function')
      ? function () { return win.performance.now(); }
      : Date.now;

    var t0 = nowFn();
    var period = periodMs > 0 ? periodMs : 2000;
    var rafId = null;
    var usingTimer = false;
    var stopped = false;

    function nextFrame(fn) {
      if (raf) {
        usingTimer = false;
        return raf(fn);
      }
      usingTimer = true;
      return setTimer(win, function () { fn(nowFn()); }, 16);
    }

    function tick(now) {
      if (stopped) return;
      var t = typeof now === 'number' ? now : nowFn();
      var phase = ((t - t0) % period) / period;
      var v = Math.sin(phase * Math.PI * 2) * 0.5 + 0.5;
      applyAvatarLevel(el, v, opts);
      rafId = nextFrame(tick);
    }

    rafId = nextFrame(tick);

    var unregister = registerCleanup(el, function () {
      if (stopped) return;
      stopped = true;
      if (rafId !== null) {
        if (!usingTimer && caf) caf(rafId);
        else clearTimer(win, rafId);
        rafId = null;
      }
      applyAvatarLevel(el, 0, opts);
    });

    return { stop: unregister };
  }

  /* ── §4 Spatial FLIP & Single-Instance Stage Presence ── */

  /**
   * Pure FLIP inversion math anchored at `transformOrigin: 'top left'`.
   * Maps `lastRect` back onto `firstRect` safely even when width/height === 0.
   */
  function flip(firstRect, lastRect) {
    var f = firstRect || {};
    var l = lastRect || {};
    var fLeft = Number.isFinite(f.left) ? f.left : 0;
    var fTop = Number.isFinite(f.top) ? f.top : 0;
    var lLeft = Number.isFinite(l.left) ? l.left : 0;
    var lTop = Number.isFinite(l.top) ? l.top : 0;
    var fWidth = Number.isFinite(f.width) && f.width > 0 ? f.width : 0;
    var fHeight = Number.isFinite(f.height) && f.height > 0 ? f.height : 0;
    var lWidth = Number.isFinite(l.width) && l.width > 0 ? l.width : 0;
    var lHeight = Number.isFinite(l.height) && l.height > 0 ? l.height : 0;

    var dx = fLeft - lLeft;
    var dy = fTop - lTop;
    var sx = (fWidth > 0 && lWidth > 0) ? fWidth / lWidth : 1;
    var sy = (fHeight > 0 && lHeight > 0) ? fHeight / lHeight : 1;

    return {
      dx: dx === 0 ? 0 : dx,
      dy: dy === 0 ? 0 : dy,
      sx: sx,
      sy: sy,
      scale: sx,
    };
  }

  function ensureA11y(muscleEl, slot, opts) {
    if (!muscleEl || typeof muscleEl.setAttribute !== 'function' || !slot) return;
    var avatar = resolveAvatar(muscleEl, opts);
    var name = (avatar && typeof avatar.NAME === 'string' && avatar.NAME) ? avatar.NAME : 'Shaping';
    if (slot === SLOTS.header) {
      muscleEl.setAttribute('aria-label', name + ': toque para uma dica');
    } else if (slot === SLOTS.voice) {
      muscleEl.setAttribute('aria-label', name + ' ouvindo sua voz');
    } else if (slot === SLOTS.review) {
      muscleEl.setAttribute('aria-label', name + ': revisão pronta');
    } else {
      muscleEl.setAttribute('aria-label', name);
    }
  }

  function travelTo(muscleEl, targetSlot, options) {
    var opts = options || {};
    if (!muscleEl || !targetSlot || typeof targetSlot.appendChild !== 'function') return null;

    var rec = recordFor(muscleEl);
    if (rec && rec.travelAbort) {
      rec.travelAbort();
      rec.travelAbort = null;
    }

    var slotName =
      opts.slot ||
      (targetSlot.getAttribute &&
        (targetSlot.getAttribute('data-stage') || targetSlot.getAttribute('data-slot'))) ||
      null;

    if (
      reducedMotion(muscleEl, opts) ||
      typeof muscleEl.getBoundingClientRect !== 'function' ||
      typeof muscleEl.animate !== 'function'
    ) {
      if (muscleEl.parentNode !== targetSlot) {
        targetSlot.appendChild(muscleEl);
      }
      if (opts.form) applyAvatarForm(muscleEl, opts.form, opts);
      if (opts.state) applyAvatarState(muscleEl, opts.state, opts);
      if (slotName) ensureA11y(muscleEl, slotName, opts);
      if (typeof opts.onArrive === 'function') opts.onArrive(muscleEl, targetSlot);
      return null;
    }

    // F(irst): measure before DOM reparent
    var first = muscleEl.getBoundingClientRect();

    // L(ast): reparent the single Muscle instance into targetSlot
    if (muscleEl.parentNode !== targetSlot) {
      targetSlot.appendChild(muscleEl);
    }
    if (opts.form) applyAvatarForm(muscleEl, opts.form, opts);
    if (opts.state) applyAvatarState(muscleEl, opts.state, opts);
    if (slotName) ensureA11y(muscleEl, slotName, opts);

    var last = muscleEl.getBoundingClientRect();

    // I(nvert): compute top-left transform inversion
    var inv = flip(first, last);

    if (
      Math.abs(inv.dx) < 0.5 &&
      Math.abs(inv.dy) < 0.5 &&
      Math.abs(inv.sx - 1) < 0.01 &&
      Math.abs(inv.sy - 1) < 0.01
    ) {
      if (typeof opts.onArrive === 'function') opts.onArrive(muscleEl, targetSlot);
      return null;
    }

    // Subtle parabolic arc midpoint (upward lift proportional to travel distance)
    var dist = Math.sqrt(inv.dx * inv.dx + inv.dy * inv.dy);
    var arcLift = Math.min(24, Math.max(6, Math.round(dist * 0.12 * 100) / 100));
    var midX = Math.round(inv.dx * 0.5 * 100) / 100;
    var midY = Math.round((inv.dy * 0.5 - arcLift) * 100) / 100;
    var midSx = Math.round((1 + (inv.sx - 1) * 0.5) * 1000) / 1000;
    var midSy = Math.round((1 + (inv.sy - 1) * 0.5) * 1000) / 1000;

    var prevOrigin = (muscleEl.style && muscleEl.style.transformOrigin) || '';
    if (muscleEl.style) muscleEl.style.transformOrigin = 'top left';

    var defaultDuration = slotName === SLOTS.header ? 320 : 380;
    var duration =
      opts.duration != null && typeof opts.duration === 'number' && Number.isFinite(opts.duration)
        ? opts.duration
        : defaultDuration;
    var cancelled = false;
    var originRestored = false;

    // P(lay): WAAPI FLIP flight from inverted origin through parabolic apex to identity
    var anim = muscleEl.animate([
      {
        transform: 'translate(' + inv.dx + 'px, ' + inv.dy + 'px) scale(' + inv.sx + ', ' + inv.sy + ')',
        transformOrigin: 'top left',
        offset: 0,
      },
      {
        transform: 'translate(' + midX + 'px, ' + midY + 'px) scale(' + midSx + ', ' + midSy + ')',
        transformOrigin: 'top left',
        offset: 0.5,
      },
      {
        transform: 'translate(0px, 0px) scale(1, 1)',
        transformOrigin: 'top left',
        offset: 1,
      },
    ], {
      duration: duration,
      easing: SETTLE,
    });

    if (!anim) {
      if (muscleEl.style) muscleEl.style.transformOrigin = prevOrigin;
      if (typeof opts.onArrive === 'function') opts.onArrive(muscleEl, targetSlot);
      return null;
    }

    function restoreOrigin() {
      if (originRestored) return;
      originRestored = true;
      if (rec && rec.travelAbort && rec.travelAbort !== abortTravel) return;
      if (muscleEl.style) muscleEl.style.transformOrigin = prevOrigin;
    }

    function abortTravel() {
      if (cancelled) return;
      cancelled = true;
      if (rec && rec.travelAbort === abortTravel) rec.travelAbort = null;
      if (rec) rec.animations.delete(anim);
      restoreOrigin();
      if (typeof anim.cancel === 'function') {
        try { anim.cancel(); } catch (e) { /* ignore */ }
      }
    }

    if (rec) {
      rec.travelAbort = abortTravel;
      rec.animations.add(anim);
    }

    anim.onfinish = function () {
      if (rec) {
        rec.animations.delete(anim);
        if (rec.travelAbort === abortTravel) rec.travelAbort = null;
      }
      if (cancelled || (rec && rec.travelAbort && rec.travelAbort !== abortTravel)) return;
      restoreOrigin();

      var pose = query(muscleEl, '.dt-pose');
      if (pose && typeof pose.animate === 'function' && !reducedMotion(muscleEl, opts)) {
        trackAnim(muscleEl, pose.animate([
          { transform: 'scale(1.04, 0.96)', offset: 0 },
          { transform: 'scale(0.98, 1.02)', offset: 0.6 },
          { transform: 'scale(1, 1)', offset: 1 },
        ], {
          duration: 220,
          easing: SPRING_SOFT,
          composite: 'add',
        }));
      }

      if (typeof opts.onArrive === 'function') opts.onArrive(muscleEl, targetSlot);
    };

    anim.oncancel = function () {
      if (rec) {
        rec.animations.delete(anim);
        if (rec.travelAbort === abortTravel) rec.travelAbort = null;
      }
      if (cancelled || (rec && rec.travelAbort && rec.travelAbort !== abortTravel)) return;
      restoreOrigin();
    };

    return anim;
  }

  /* ── §5 Proactive Guiding Choreography & Lifecycle Cleanup ── */

  function findFirstActionTarget(doc, view) {
    if (!doc) return null;
    if (view === 'workout') {
      if (typeof doc.querySelectorAll === 'function') {
        var cards = doc.querySelectorAll('.card');
        for (var i = 0; i < cards.length; i++) {
          if (!cards[i].getAttribute || cards[i].getAttribute('data-status') !== 'filled') {
            return cards[i];
          }
        }
      }
      return null;
    }
    if (typeof doc.querySelector === 'function') {
      try {
        return doc.querySelector('.search-input, .dock-mic');
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function guideTo(el, targetEl, opts) {
    if (!el) return noop;
    var options = opts || {};
    var rec = recordFor(el);
    if (rec && rec.guideAbort) {
      rec.guideAbort();
      rec.guideAbort = null;
    }

    if (options.form) morph(el, options.form, options);
    if (options.state) applyAvatarState(el, options.state, options);

    var delay = typeof options.delay === 'number' ? options.delay : 0;
    if (delay <= 0 || reducedMotion(el, options)) {
      glance(el, targetEl, options);
      if (options.reaction) react(el, options.reaction, options);
      return noop;
    }

    var win = winOf(el, options);
    var timerId = setTimer(win, function () {
      if (rec) {
        rec.timers.delete(timerId);
        if (rec.guideAbort === cancelGuide) rec.guideAbort = null;
      }
      timerId = null;
      glance(el, targetEl, options);
      if (options.reaction) react(el, options.reaction, options);
    }, delay);

    if (rec) rec.timers.add(timerId);

    var cancelGuide = registerCleanup(el, function () {
      if (timerId !== null) {
        if (rec) rec.timers.delete(timerId);
        clearTimer(win, timerId);
        timerId = null;
      }
      if (rec && rec.guideAbort === cancelGuide) rec.guideAbort = null;
    });

    if (rec) rec.guideAbort = cancelGuide;
    return cancelGuide;
  }

  function introLand(muscleEl, opts) {
    if (!muscleEl) return noop;
    var options = opts || {};
    var doc = docOf(muscleEl);
    var view = options.view || 'workout';
    var delay = typeof options.delay === 'number' ? options.delay : 400;
    var win = winOf(muscleEl, options);
    var rec = recordFor(muscleEl);

    var timerId = setTimer(win, function () {
      if (rec) rec.timers.delete(timerId);
      timerId = null;
      var target = options.target || findFirstActionTarget(doc, view);
      if (target) glance(muscleEl, target, options);
    }, delay);

    if (rec) rec.timers.add(timerId);

    return registerCleanup(muscleEl, function () {
      if (timerId !== null) {
        if (rec) rec.timers.delete(timerId);
        clearTimer(win, timerId);
        timerId = null;
      }
    });
  }

  function onTabSwitch(muscleEl, newView, opts) {
    if (!muscleEl) return noop;
    var options = opts || {};
    var newForm = newView === 'workout' ? 'treino' : 'refeicao';
    morph(muscleEl, newForm, options);

    var doc = docOf(muscleEl);
    var delay = typeof options.delay === 'number' ? options.delay : 100;
    var win = winOf(muscleEl, options);
    var rec = recordFor(muscleEl);

    var timerId = setTimer(win, function () {
      if (rec) rec.timers.delete(timerId);
      timerId = null;
      var target = options.target || findFirstActionTarget(doc, newView);
      if (target) glance(muscleEl, target, options);
    }, delay);

    if (rec) rec.timers.add(timerId);

    return registerCleanup(muscleEl, function () {
      if (timerId !== null) {
        if (rec) rec.timers.delete(timerId);
        clearTimer(win, timerId);
        timerId = null;
      }
    });
  }

  function onValidationError(muscleEl, errorField, opts) {
    if (!muscleEl) return noop;
    var options = opts || {};
    var rec = recordFor(muscleEl);
    if (rec && rec.validationAbort) {
      rec.validationAbort();
      rec.validationAbort = null;
    }

    var current = (muscleEl.getAttribute && muscleEl.getAttribute('data-state')) || '';
    var restoreState = options.restoreState || (current && current !== 'oops' ? current : 'focused');

    glance(muscleEl, errorField, options);
    react(muscleEl, 'no', options);
    applyAvatarState(muscleEl, 'oops', options);

    var delay = typeof options.restoreAfterMs === 'number' ? options.restoreAfterMs : 1500;
    var win = winOf(muscleEl, options);
    var timerId = setTimer(win, function () {
      if (rec) {
        rec.timers.delete(timerId);
        if (rec.validationAbort === cancelValidation) rec.validationAbort = null;
      }
      timerId = null;
      applyAvatarState(muscleEl, restoreState, options);
    }, delay);

    if (rec) rec.timers.add(timerId);

    var cancelValidation = registerCleanup(muscleEl, function () {
      if (timerId !== null) {
        if (rec) rec.timers.delete(timerId);
        clearTimer(win, timerId);
        timerId = null;
      }
      if (rec && rec.validationAbort === cancelValidation) rec.validationAbort = null;
    });

    if (rec) rec.validationAbort = cancelValidation;
    return cancelValidation;
  }

  function attachLife(el, opts) {
    if (!el) return noop;
    var options = opts || {};
    var stopBlink = options.blink === false ? noop : startBlink(el, options);
    var stopBreath = options.breath === false ? null : startIdleBreath(el, options);

    return registerCleanup(el, function () {
      if (typeof stopBlink === 'function') stopBlink();
      if (typeof stopBreath === 'function') stopBreath();
    });
  }

  function destroyElement(el) {
    if (!el) return;
    var rec = elementRecords ? elementRecords.get(el) : null;
    if (!rec) {
      cancelNodeAnimations(query(el, '.dt-anim'));
      glance(el, null);
      return;
    }

    if (rec.morphAbort) { rec.morphAbort(); rec.morphAbort = null; }
    if (rec.travelAbort) { rec.travelAbort(); rec.travelAbort = null; }
    if (rec.validationAbort) { rec.validationAbort(); rec.validationAbort = null; }
    if (rec.guideAbort) { rec.guideAbort(); rec.guideAbort = null; }

    Array.from(rec.cleanups).forEach(function (fn) {
      try { fn(); } catch (e) { /* ignore */ }
    });
    rec.cleanups.clear();

    var win = winOf(el);
    Array.from(rec.timers).forEach(function (id) {
      clearTimer(win, id);
    });
    rec.timers.clear();

    Array.from(rec.animations).forEach(function (anim) {
      if (anim && typeof anim.cancel === 'function') {
        try { anim.cancel(); } catch (e) { /* ignore */ }
      }
    });
    rec.animations.clear();

    cancelNodeAnimations(query(el, '.dt-anim'));
    glance(el, null);
    trackedElements.delete(el);
  }

  function destroy(el) {
    if (el) {
      destroyElement(el);
      return;
    }
    Array.from(detachedCleanups).forEach(function (fn) {
      try { fn(); } catch (e) { /* ignore */ }
    });
    detachedCleanups.clear();
    Array.from(trackedElements).forEach(function (item) {
      destroyElement(item);
    });
    trackedElements.clear();
  }

  /* ── Public API ── */

  var MuscleMotion = {
    // Curves & constants (§1)
    SPRING: SPRING,
    SPRING_POP: SPRING_POP,
    SPRING_SOFT: SPRING_SOFT,
    ANTICIPATE: ANTICIPATE,
    SETTLE: SETTLE,
    EASE_DECEL: EASE_DECEL,
    EASE_ACCEL: EASE_ACCEL,
    EASE_BREATH: EASE_BREATH,
    MORPH_TIMING: MORPH_TIMING,
    BLINK_SEQUENCE: BLINK_SEQUENCE,
    REACTIONS: REACTIONS,
    SLOTS: SLOTS,

    // Core physics & reactions (§1–§2)
    morph: morph,
    react: react,
    glance: glance,

    // Micro-life (§1.3)
    blink: blink,
    startBlink: startBlink,
    startBlinkLoop: startBlinkLoop,
    nextBlinkDelay: nextBlinkDelay,
    resetBlinkSequence: resetBlinkSequence,
    startIdleBreath: startIdleBreath,
    startFootTap: startFootTap,

    // Live 60fps voice reactivity (§3)
    createVoiceMeter: createVoiceMeter,
    connectVoice: connectVoice,
    computeRms: computeRms,
    smoothEnvelope: smoothEnvelope,
    createSineSimulator: createSineSimulator,
    pendingStream: null,

    // Spatial FLIP & stage presence (§4)
    flip: flip,
    travelTo: travelTo,
    ensureA11y: ensureA11y,

    // Guiding choreography & lifecycle (§5)
    guideTo: guideTo,
    introLand: introLand,
    onTabSwitch: onTabSwitch,
    onValidationError: onValidationError,
    attachLife: attachLife,
    destroy: destroy,
    reducedMotion: reducedMotion,
  };

  global.MuscleMotion = MuscleMotion;
  if (typeof module !== 'undefined' && module.exports) module.exports = MuscleMotion;
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
