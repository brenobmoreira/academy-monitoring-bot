/**
 * Pulso, the coach avatar: ONE swappable component. Everything about the artwork lives here:
 * the SVG, its colours, the styling of each mood, the top progress bar and the intro.
 * A new design drops in by replacing this file (keep the API below). Classic script; exposes
 * the browser global `ShapeAvatar` (and module.exports under Node, for the pure helpers' tests).
 *
 * Pulso is a flat, dark disc with an ember core, eyes, eyebrows and a mouth, inside a ring of 12
 * plate marks. The ring is also a plate-loading meter: setProgress(0..1) lights the marks one by
 * one, and a thin bar at the top of the header follows the same value.
 *
 * API
 *   ShapeAvatar.MOODS                    ['idle', 'focused', 'happy', 'alert', 'thinking']
 *   ShapeAvatar.TICKS                    12, the marks on the ring
 *   ShapeAvatar.mount(host, bubbleText)  draw into `host` (the header avatar), remember the element
 *                                        whose text `say` replaces, and add the top progress bar
 *                                        to host's parent
 *   ShapeAvatar.setMood(mood)            switch the header avatar's mood (restarts its one-shot motion);
 *                                        'thinking' also shows animated dots after the bubble text
 *   ShapeAvatar.mood()                   the header avatar's mood
 *   ShapeAvatar.setProgress(p)           fill the ring and the top bar, p in 0..1 (clamped; junk reads as 0)
 *   ShapeAvatar.progress()               the current value (0..1)
 *   ShapeAvatar.pulse(kind)              a one-shot reaction that keeps the mood: 'nod' (noted),
 *                                        'tick' (progress gained), 'full' (ring complete), 'no' (needs a
 *                                        fix), 'celebrate' (a brief smile/pop, visible even with reduced
 *                                        motion). setProgress plays 'tick'/'full' itself when the ring gains
 *                                        a mark. Returns false when it did not play (no host, unknown
 *                                        kind, prefers-reduced-motion).
 *   ShapeAvatar.say(text)              replace the speech-bubble text (with a short fade)
 *   ShapeAvatar.glance(fieldOrNull)      look toward a field's centre (up to 3 SVG units); null centres
 *                                        the eyes. Call again if the field moves (scroll/resize).
 *   ShapeAvatar.setDozing(bool)          closed eyes and slow breathing; preserves the current mood
 *   ShapeAvatar.dozing()                 whether the header avatar is dozing
 *   ShapeAvatar.intro(text)              first-open intro: a large Pulso centred on the page; on the
 *                                        next say() (after a short hold) it glides and shrinks into
 *                                        the header slot. Returns false (and does nothing) under
 *                                        prefers-reduced-motion.
 *   ShapeAvatar.create(mood, progress)   a new, independent avatar element (for empty/success
 *                                        scenes); progress defaults to 1 when happy, else 0
 *   ShapeAvatar.clampProgress(p)         pure: p as a number in 0..1
 *   ShapeAvatar.litTicks(p, n)           pure: how many of n marks are lit for p
 *   ShapeAvatar.flip(from, to)           pure: the translate/scale that moves rect `from` onto `to`
 *
 * Contract for a replacement design
 *   - the root element of each avatar carries class "shape" and attribute data-state="<mood>";
 *   - all moods must read at 32-40 px; motion uses transform and opacity only and stops under
 *     prefers-reduced-motion (states and progress stay visible); the page sizes the ".shape" box.
 *   - colours may use the page tokens (--accent, --alert, --text...) and data-scheme="dark".
 *   - mount preserves a button host's name/semantics; create returns decorative, aria-hidden art.
 *     The page owns the button, tip selection, idle timer and live speech bubble.
 */
(function (root) {
  'use strict';

  var MOODS = ['idle', 'focused', 'happy', 'alert', 'thinking'];
  var TICKS = 12;
  var INTRO_HOLD = 750;
  var INTRO_MS = 450;

  /** p as a number in 0..1; anything that is not a finite number reads as 0. */
  function clampProgress(p) {
    if (typeof p !== 'number' && (typeof p !== 'string' || !p.trim())) return 0;
    var n = Number(p);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n >= 1 ? 1 : n;
  }

  /** Lit marks for p: none at 0, at least one as soon as there is any progress, all only at 1. */
  function litTicks(p, n) {
    var total = n === undefined ? TICKS : n;
    var v = clampProgress(p);
    if (v === 0) return 0;
    if (v === 1) return total;
    return Math.min(total - 1, Math.max(1, Math.round(v * total)));
  }

  /** FLIP: the transform (centre to centre, uniform scale by width) that lays `from` over `to`. */
  function flip(from, to) {
    var s = from.width ? to.width / from.width : 1;
    return {
      x: (to.left + to.width / 2) - (from.left + from.width / 2),
      y: (to.top + to.height / 2) - (from.top + from.height / 2),
      s: s,
    };
  }

  function ticks(cls) {
    var out = '';
    for (var i = 0; i < TICKS; i++) {
      out += '<rect class="' + cls + '" x="47" y="5" width="6" height="10" rx="2.4" transform="rotate(' + (i * 360 / TICKS) + ' 50 50)"/>';
    }
    return out;
  }
  var BASE_TICKS = ticks('pl-tb');
  var LIT_TICKS = ticks('pl-t');

  function svg(id) {
    return '<svg viewBox="0 0 100 100" focusable="false" aria-hidden="true">' +
      '<defs>' +
        // a centred core light: a flat ember glow, not a lit sphere
        '<radialGradient id="pl-o-' + id + '" cx="50%" cy="50%" r="50%">' +
          '<stop offset="0" class="pl-s0"/><stop offset=".62" class="pl-s1"/><stop offset="1" class="pl-s2"/>' +
        '</radialGradient>' +
      '</defs>' +
      '<g class="pl-body">' +
        '<circle class="pl-disk" cx="50" cy="50" r="48"/>' +
        // the ring: plate marks; the lit layer is the progress meter
        '<g class="pl-ring"><g class="pl-base">' + BASE_TICKS + '</g><g class="pl-lit">' + LIT_TICKS + '</g></g>' +
        '<circle class="pl-sweep" cx="50" cy="50" r="40" pathLength="100"/>' +
        '<circle class="pl-flash" cx="50" cy="50" r="40"/>' +
        '<g class="pl-orb">' +
          '<circle class="pl-core-base" cx="50" cy="50" r="28"/>' +
          '<circle class="pl-core" cx="50" cy="50" r="28" fill="url(#pl-o-' + id + ')"/>' +
          '<circle class="pl-core-rim" cx="50" cy="50" r="28"/>' +
          '<g class="pl-gaze"><g class="pl-eyes">' +
            '<path class="pl-eye pl-dot st st-idle" d="M42 49.5h.01M58 49.5h.01"/>' +
            '<path class="pl-eye pl-dot st st-focused" d="M42 50.5h.01M58 50.5h.01"/>' +
            '<path class="pl-eye st st-happy" d="M38.5 53Q42.5 46.5 46.5 53M53.5 53Q57.5 46.5 61.5 53"/>' +
            '<path class="pl-eye st st-alert" d="M43 46.5V52M57 46.5V52"/>' +
            '<path class="pl-eye pl-dot st st-thinking" d="M44.5 47.5h.01M60.5 47.5h.01"/>' +
          '</g>' +
          '<path class="pl-eye pl-sleep" d="M37 51Q42 54 47 51M53 51Q58 54 63 51"/>' +
          '</g>' +
          '<g class="pl-face st st-idle"><path class="pl-mouth" d="M45 60Q50 63.5 55 60"/></g>' +
          '<g class="pl-face st st-focused"><path class="pl-brow" d="M37 41L46 43.5M63 41L54 43.5"/><path class="pl-mouth" d="M46 61Q51 63.5 56 60"/></g>' +
          '<g class="pl-face st st-happy"><path class="pl-mouth pl-open" d="M43 58.5Q50 70 57 58.5Z"/></g>' +
          '<g class="pl-face st st-alert"><path class="pl-brow" d="M37 39.5L45.5 37.5M54.5 37.5L63 39.5"/><ellipse class="pl-mouth" cx="50" cy="63" rx="3" ry="4"/></g>' +
          '<g class="pl-face st st-thinking"><path class="pl-brow" d="M55.5 40Q60 37.5 64.5 40"/><path class="pl-mouth" d="M47 62H54"/></g>' +
        '</g>' +
      '</g>' +
    '</svg>';
  }

  var CSS = `:root {
  --pl-disk: #1c1917;
  --pl-edge: rgba(28, 25, 23, 0);
  --pl-track: #4a4441;
  --pl-deep: #1c1917;
  --pl-eye: #fafaf9;
  --pl-idle: #a8a29e;
  --pl-focused: #e04e14;
  --pl-happy: #22a355;
  --pl-alert: #f59e0b;
  --pl-bar-track: rgba(28, 25, 23, 0.1);
}
:root[data-scheme="dark"] {
  --pl-disk: #1f1b19;
  --pl-edge: rgba(255, 255, 255, 0.14);
  --pl-track: #4d4744;
  --pl-deep: #1f1b19;
  --pl-idle: #b5afab;
  --pl-focused: #ff6a2b;
  --pl-happy: #4ade80;
  --pl-alert: #fbbf24;
  --pl-bar-track: rgba(255, 255, 255, 0.1);
}
/* Pulso: flat vector. The mood sets one colour (--pl-c) for the lit marks, the core and the bar. */
.shape { --pl-c: var(--pl-idle); }
.shape[data-state="focused"], .shape[data-state="thinking"] { --pl-c: var(--pl-focused); }
.shape[data-state="happy"] { --pl-c: var(--pl-happy); }
.shape[data-state="alert"] { --pl-c: var(--pl-alert); }

.shape svg * { transform-box: view-box; }
.pl-disk { fill: var(--pl-disk); stroke: var(--pl-edge); stroke-width: 1.2; }
.pl-tb { fill: var(--pl-track); }
.pl-t { fill: var(--pl-c); opacity: 0; transition: opacity 0.3s ease-out; }
.pl-t.on { opacity: 1; }
/* plate loading: marks light one after another */
.pl-t:nth-child(2) { transition-delay: 0.03s; } .pl-t:nth-child(3) { transition-delay: 0.06s; }
.pl-t:nth-child(4) { transition-delay: 0.09s; } .pl-t:nth-child(5) { transition-delay: 0.12s; }
.pl-t:nth-child(6) { transition-delay: 0.15s; } .pl-t:nth-child(7) { transition-delay: 0.18s; }
.pl-t:nth-child(8) { transition-delay: 0.21s; } .pl-t:nth-child(9) { transition-delay: 0.24s; }
.pl-t:nth-child(10) { transition-delay: 0.27s; } .pl-t:nth-child(11) { transition-delay: 0.3s; }
.pl-t:nth-child(12) { transition-delay: 0.33s; }

.pl-core-base { fill: var(--pl-deep); }
.pl-s0 { stop-color: var(--pl-c); stop-opacity: 1; }
.pl-s1 { stop-color: var(--pl-c); stop-opacity: 0.5; }
.pl-s2 { stop-color: var(--pl-c); stop-opacity: 0.12; }
.pl-core { opacity: 0.8; }
.pl-core-rim { fill: none; stroke: var(--pl-c); stroke-opacity: 0.55; stroke-width: 1.6; }
.pl-sweep { fill: none; stroke: var(--pl-c); stroke-width: 10; stroke-dasharray: 16 84; opacity: 0; transform-origin: 50px 50px; }
.pl-flash { fill: none; stroke: var(--pl-c); stroke-width: 3; opacity: 0; transform-origin: 50px 50px; }
.pl-eye { fill: none; stroke: var(--pl-eye); stroke-width: 4.6; stroke-linecap: round; stroke-linejoin: round; }
.pl-eye.pl-dot { stroke-width: 7.4; }
.pl-brow, .pl-mouth { fill: none; stroke: var(--pl-eye); stroke-linecap: round; stroke-linejoin: round; }
.pl-brow { stroke-width: 3; }
.pl-mouth { stroke-width: 3.6; }
.pl-mouth.pl-open { fill: var(--pl-eye); stroke-width: 2.4; }
.pl-sleep { display: none; }
.pl-gaze { transition: transform 0.2s ease-out; }
.shape[data-state][data-reaction="celebrate"] .st { display: none; }
.shape[data-state][data-reaction="celebrate"] .st-happy { display: inline; }
.shape[data-state][data-dozing="true"] .pl-eyes { opacity: 0; animation: none; }
.shape[data-state][data-dozing="true"] .pl-sleep { display: inline; }
.shape[data-state][data-dozing="true"] .pl-orb { animation: pl-breathe 7s ease-in-out infinite; }
.shape[data-state][data-dozing="true"] .pl-core { animation: pl-glow 7s ease-in-out infinite; }
.shape[data-state][data-dozing="true"] .pl-ring { animation: none; }
.shape[data-state][data-dozing="true"] .pl-face { display: none; }
.shape[data-state][data-dozing="true"] .pl-face.st-idle { display: inline; }

.shape .st { display: none; }
.shape[data-state="idle"] .st-idle,
.shape[data-state="focused"] .st-focused,
.shape[data-state="happy"] .st-happy,
.shape[data-state="alert"] .st-alert,
.shape[data-state="thinking"] .st-thinking { display: inline; }

.pl-body, .pl-orb, .pl-ring, .pl-eyes { transform-origin: 50px 50px; }
.pl-eyes { transition: transform 0.25s ease-out; }

/* idle: a slow breathing glow and an occasional blink */
.shape[data-state="idle"] .pl-core { animation: pl-glow 4.8s ease-in-out infinite; }
.shape[data-state="idle"] .pl-orb { animation: pl-breathe 4.8s ease-in-out infinite; }
.shape[data-state="idle"] .pl-eyes,
.shape[data-state="focused"] .pl-eyes { animation: pl-blink 6s ease-in-out infinite; }
/* focused: the ring ticks round like a clock, the eyes narrow */
.shape[data-state="focused"] .pl-ring { animation: pl-tick 12s steps(12, end) infinite; }
.shape[data-state="focused"] .pl-eyes { transform: scaleY(0.72); }
.shape[data-state="focused"] .pl-core { opacity: 1; }
/* happy: one contained burst (ring flash and a scale pop), then a lively glow */
.shape[data-state="happy"] .pl-flash { animation: pl-flash 0.7s ease-out 1; }
.shape[data-state="happy"] .pl-orb { animation: pl-pop 0.55s cubic-bezier(0.3, 1.6, 0.5, 1) 1, pl-breathe 3s ease-in-out 0.55s infinite; }
.shape[data-state="happy"] .pl-core { animation: pl-glow 3s ease-in-out infinite; }
.shape[data-state="happy"] .pl-t.on { animation: pl-lit 0.7s ease-out 1; }
/* alert: an amber broken ring and one short shake */
.shape[data-state="alert"] .pl-tb { fill: var(--pl-c); opacity: 0.32; }
.shape[data-state="alert"] .pl-tb:nth-child(even),
.shape[data-state="alert"] .pl-t:nth-child(even) { opacity: 0; }
.shape[data-state="alert"] .pl-body { animation: pl-shake 0.5s ease-in-out 1; }
.shape[data-state="alert"] .pl-core { animation: pl-glow 1.4s ease-in-out infinite; }
/* thinking: a bright arc sweeps the ring, the lit marks dim, the eyes look up */
.shape[data-state="thinking"] .pl-sweep { opacity: 0.9; animation: pl-tick 1.1s linear infinite; }
.shape[data-state="thinking"] .pl-t.on { opacity: 0.35; }
.shape[data-state="thinking"] .pl-core { animation: pl-glow 1.1s ease-in-out infinite; }

/* top progress bar (in the header), same value as the ring */
.pl-bar {
  position: absolute; left: var(--pad, 16px); right: var(--pad, 16px);
  top: calc(var(--safe-top, 0px) + 3px); height: 3px; border-radius: 2px;
  background: var(--pl-bar-track); overflow: hidden; pointer-events: none;
}
.pl-bar i {
  display: block; height: 100%; background: var(--pl-focused);
  transform-origin: 0 50%; transform: scaleX(0); transition: transform 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.pl-bar[data-state="happy"] i { background: var(--pl-happy); }
.pl-bar[data-state="alert"] i { background: var(--pl-alert); }

/* thinking dots after the bubble text */
.pl-dots { display: none; gap: 3px; margin-left: 4px; vertical-align: middle; }
.pl-dots i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: 0.3; animation: pl-dot 1.1s ease-in-out infinite; }
.pl-dots i:nth-child(2) { animation-delay: 0.15s; }
.pl-dots i:nth-child(3) { animation-delay: 0.3s; }
.shape[data-state="thinking"] ~ .bubble .pl-dots, .pl-intro .pl-dots { display: inline-flex; }

/* first-open intro: Pulso large and centred, then it glides into the header */
.pl-intro {
  position: fixed; inset: 0; z-index: 60; pointer-events: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;
  padding-bottom: 14vh;
}
.pl-intro-bg { position: absolute; inset: 0; background: var(--bg, #f5f4f1); }
.pl-intro .shape { position: relative; flex: none; width: 112px; height: 112px; margin: 0; }
.pl-intro-text { position: relative; margin: 0; color: var(--hint, #78716c); font-size: 15px; }

@keyframes pl-glow { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@keyframes pl-breathe { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.03); } }
@keyframes pl-blink { 0%, 94%, 100% { opacity: 1; } 96.5% { opacity: 0; } }
@keyframes pl-tick { to { transform: rotate(360deg); } }
@keyframes pl-flash { 0% { opacity: 0.95; transform: scale(0.94); } 100% { opacity: 0; transform: scale(1.16); } }
@keyframes pl-pop { 0% { transform: scale(1); } 45% { transform: scale(1.1); } 100% { transform: scale(1); } }
@keyframes pl-lit { 0%, 100% { opacity: 1; } 30% { opacity: 0.35; } }
@keyframes pl-dot { 0%, 100% { opacity: 0.3; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
@keyframes pl-shake {
  0%, 100% { transform: translateX(0); } 20% { transform: translateX(-2.6px); } 40% { transform: translateX(2.4px); }
  60% { transform: translateX(-1.6px); } 80% { transform: translateX(1px); }
}
@media (prefers-reduced-motion: reduce) {
  .shape *, .shape, .pl-bar i, .pl-dots i { animation: none !important; transition: none !important; }
  .pl-dots i { opacity: 0.7; }
}
`;

  var host = null;
  var textEl = null;
  var bar = null;
  var dots = null;
  var lastText = '';
  var hostProgress = 0;
  var uid = 0;
  var introState = null;
  var reactionTimer = null;

  function reducedMotion() {
    try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  function injectStyle() {
    if (document.getElementById('shape-avatar-style')) return;
    var st = document.createElement('style');
    st.id = 'shape-avatar-style';
    st.textContent = CSS;
    document.head.appendChild(st);
    // CSS stops its own animations; stop Web Animations too when the preference changes live.
    var preference = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)');
    var stop = function (e) {
      if (!e.matches) return;
      while (pulsing.length) pulsing.pop().cancel();
      if (introState) finishIntro(introState);
    };
    if (preference && preference.addEventListener) preference.addEventListener('change', stop);
    else if (preference && preference.addListener) preference.addListener(stop);
  }

  function makeDots() {
    var d = document.createElement('span');
    d.className = 'pl-dots';
    d.setAttribute('aria-hidden', 'true');
    d.appendChild(document.createElement('i'));
    d.appendChild(document.createElement('i'));
    d.appendChild(document.createElement('i'));
    return d;
  }

  function paintProgress(el, p) {
    var lit = litTicks(p);
    var marks = el.querySelectorAll('.pl-t');
    for (var i = 0; i < marks.length; i++) marks[i].classList.toggle('on', i < lit);
    el.setAttribute('data-progress', String(Math.round(clampProgress(p) * 100) / 100));
  }

  function paintBar() {
    if (!bar) return;
    bar.firstChild.style.transform = 'scaleX(' + hostProgress + ')';
    if (host) bar.setAttribute('data-state', host.getAttribute('data-state'));
  }

  function draw(el, mood, progress) {
    el.classList.add('shape');
    el.setAttribute('data-state', MOODS.indexOf(mood) >= 0 ? mood : 'idle');
    if (el.tagName !== 'BUTTON') el.setAttribute('aria-hidden', 'true');
    el.innerHTML = svg(++uid); // constant markup, never user text
    paintProgress(el, progress);
    return el;
  }

  /** Restart the one-shot motions (burst, shake) when the mood changes. */
  function restartMotion(el) {
    var parts = el.querySelectorAll('.pl-body, .pl-orb, .pl-flash, .pl-t');
    for (var i = 0; i < parts.length; i++) parts[i].style.animation = 'none';
    void el.getBoundingClientRect();
    for (var j = 0; j < parts.length; j++) parts[j].style.animation = '';
  }

  /* one-shot reactions: [part, keyframes, ms, easing]; they sit on top of the mood's own motion */
  var SOFT = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
  var FLASH = ['.pl-flash', [{ opacity: 0.95, transform: 'scale(0.94)' }, { opacity: 0, transform: 'scale(1.16)' }], 420, 'ease-out'];
  var PULSES = {
    nod: [['.pl-orb', [{ transform: 'translateY(0)' }, { transform: 'translateY(3.5px)' }, { transform: 'translateY(0)' }], 260, 'ease-in-out']],
    tick: [['.pl-orb', [{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], 300, SOFT], FLASH],
    full: [['.pl-ring', [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], 700, SOFT],
      ['.pl-orb', [{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], 520, SOFT],
      ['.pl-flash', FLASH[1], 700, 'ease-out']],
    no: [['.pl-body', [{ transform: 'translateX(0)' }, { transform: 'translateX(-2.6px)' }, { transform: 'translateX(2.4px)' },
      { transform: 'translateX(-1.6px)' }, { transform: 'translateX(0)' }], 320, 'ease-in-out']],
  };
  var pulsing = [];

  function pulse(kind) {
    var steps = PULSES[kind === 'celebrate' ? 'full' : kind];
    if (!host || !steps) return false;
    clearTimeout(reactionTimer);
    host.removeAttribute('data-reaction');
    if (kind === 'celebrate') {
      host.setAttribute('data-reaction', kind);
      reactionTimer = setTimeout(function () { host.removeAttribute('data-reaction'); }, 900);
    }
    while (pulsing.length) pulsing.pop().cancel(); // the newest reaction wins
    if (reducedMotion()) return false;
    for (var i = 0; i < steps.length; i++) {
      var part = host.querySelector(steps[i][0]);
      if (part && part.animate) pulsing.push(part.animate(steps[i][1], { duration: steps[i][2], easing: steps[i][3] }));
    }
    return pulsing.length > 0;
  }

  /* intro: shared-element glide from the centre into the header slot (FLIP, transform only) */
  function startIntro(text) {
    if (!host || introState || reducedMotion() || !document.body) return false;
    var layer = document.createElement('div');
    layer.className = 'pl-intro';
    layer.setAttribute('aria-hidden', 'true');
    var bg = document.createElement('div');
    bg.className = 'pl-intro-bg';
    var big = draw(document.createElement('div'), 'thinking', hostProgress);
    var line = document.createElement('p');
    line.className = 'pl-intro-text';
    line.textContent = text || 'Abrindo sua ficha';
    line.appendChild(makeDots());
    layer.appendChild(bg);
    layer.appendChild(big);
    layer.appendChild(line);
    document.body.appendChild(layer);
    host.style.opacity = '0';
    introState = { layer: layer, bg: bg, big: big, line: line, t0: Date.now(), landing: false };
    introState.fallback = setTimeout(land, 5000);
    return true;
  }

  function finishIntro(s) {
    if (s !== introState) return;
    introState = null;
    clearTimeout(s.fallback);
    clearTimeout(s.landingTimer);
    (s.animations || []).forEach(function (a) { a.cancel(); });
    host.style.opacity = '';
    if (s.layer.parentNode) s.layer.parentNode.removeChild(s.layer);
  }

  function land() {
    var s = introState;
    if (!s || s.landing) return;
    s.landing = true;
    clearTimeout(s.fallback);
    s.landingTimer = setTimeout(function () {
      s.big.setAttribute('data-state', host.getAttribute('data-state'));
      paintProgress(s.big, hostProgress);
      var m = flip(s.big.getBoundingClientRect(), host.getBoundingClientRect());
      var done = function () {
        finishIntro(s);
      };
      if (!s.big.animate || reducedMotion()) { done(); return; }
      var ease = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
      var fly = s.big.animate(
        [{ transform: 'translate(0, 0) scale(1)' }, { transform: 'translate(' + m.x + 'px, ' + m.y + 'px) scale(' + m.s + ')' }],
        { duration: INTRO_MS, easing: ease, fill: 'forwards', id: 'pl-intro' });
      var bgAnimation = s.bg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: INTRO_MS, easing: 'ease-out', fill: 'forwards', id: 'pl-intro-bg' });
      var lineAnimation = s.line.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(6px)' }],
        { duration: INTRO_MS * 0.6, easing: 'ease-out', fill: 'forwards', id: 'pl-intro-text' });
      s.animations = [fly, bgAnimation, lineAnimation];
      fly.onfinish = done;
      fly.oncancel = done;
    }, Math.max(0, INTRO_HOLD - (Date.now() - s.t0)));
  }

  var api = {
    MOODS: MOODS,
    TICKS: TICKS,
    clampProgress: clampProgress,
    litTicks: litTicks,
    flip: flip,
    mount: function (el, bubbleText) {
      injectStyle();
      host = draw(el, el.getAttribute('data-state') || 'idle', hostProgress);
      textEl = bubbleText || null;
      if (textEl && !dots) { dots = makeDots(); textEl.appendChild(dots); }
      var parent = host.parentNode;
      if (parent && !bar) {
        bar = document.createElement('div');
        bar.className = 'pl-bar';
        bar.setAttribute('aria-hidden', 'true');
        bar.appendChild(document.createElement('i'));
        parent.insertBefore(bar, parent.firstChild);
      }
      paintBar();
      return host;
    },
    setMood: function (mood) {
      if (!host || MOODS.indexOf(mood) < 0 || host.getAttribute('data-state') === mood) return;
      host.setAttribute('data-state', mood);
      restartMotion(host);
      paintBar();
    },
    mood: function () { return host ? host.getAttribute('data-state') : null; },
    setProgress: function (p) {
      var v = clampProgress(p);
      if (v === hostProgress && host && host.hasAttribute('data-progress')) return v;
      var gained = litTicks(v) > litTicks(hostProgress);
      hostProgress = v;
      if (host) paintProgress(host, v);
      paintBar();
      if (gained) pulse(v === 1 ? 'full' : 'tick');
      return v;
    },
    progress: function () { return hostProgress; },
    pulse: pulse,
    glance: function (field) {
      if (!host) return;
      var gaze = host.querySelector('.pl-gaze');
      if (!gaze) return;
      var x = 0, y = 0;
      if (field && field.getBoundingClientRect) {
        var from = host.getBoundingClientRect(), to = field.getBoundingClientRect();
        var dx = to.left + to.width / 2 - from.left - from.width / 2;
        var dy = to.top + to.height / 2 - from.top - from.height / 2;
        var length = Math.sqrt(dx * dx + dy * dy) || 1;
        x = Math.round(dx / length * 3 * 100) / 100;
        y = Math.round(dy / length * 3 * 100) / 100;
      }
      gaze.style.transform = 'translate(' + x + 'px, ' + y + 'px)';
    },
    setDozing: function (value) {
      if (!host) return;
      host.setAttribute('data-dozing', String(!!value));
      if (value) api.glance(null);
    },
    dozing: function () { return !!host && host.getAttribute('data-dozing') === 'true'; },
    say: function (text) {
      if (introState) land();
      if (!textEl || !text || text === lastText) return;
      lastText = text;
      textEl.textContent = text;
      if (dots) textEl.appendChild(dots);
      textEl.classList.remove('swap');
      void textEl.offsetWidth;
      textEl.classList.add('swap');
    },
    intro: startIntro,
    create: function (mood, progress) {
      injectStyle();
      var p = progress === undefined ? (mood === 'happy' ? 1 : 0) : progress;
      return draw(document.createElement('div'), mood, p);
    },
  };

  root.ShapeAvatar = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
