/**
 * Shaping, the coach avatar: ONE swappable component. Everything about the artwork lives here:
 * the smoked liquid-glass Ember Orb SVG, faceted Lentes Ember optical cores, integrated 12-tick
 * progress ring, context forms, concentric voice waves, top progress bar, first-open intro and
 * spring-physics fluid gliding (`perch`). Classic script; exposes browser global `ShapeAvatar`
 * (and `module.exports` under Node for unit tests).
 *
 * Motion uses `transform` and `opacity` only and stops completely under
 * `prefers-reduced-motion: reduce` or `data-motion="off"`.
 *
 * API
 *   ShapeAvatar.NAME                     'Shaping' (single source of truth for the mascot name)
 *   ShapeAvatar.MOODS                    ['idle', 'focused', 'happy', 'alert', 'thinking']
 *   ShapeAvatar.STATES                   MOODS + ['listening', 'understood', 'oops', 'record', 'dozing']
 *   ShapeAvatar.FORMS                    ['base', 'treino', 'refeicao', 'agua', 'revisao', 'descanso']
 *   ShapeAvatar.FORM_MS                  340 (morph duration in ms; OUT_MS = 140, IN_DELAY = 90)
 *   ShapeAvatar.TICKS                    12 (logical progress steps for ring & pulse feedback)
 *   ShapeAvatar.mount(host, bubbleText)  draw into `host` (header avatar), bind speech-bubble text,
 *                                        sync `.bubble-name` / button label, and insert `.pl-bar`
 *   ShapeAvatar.setMood(state)           switch the header avatar's mood/state (`MOODS` or `STATES`)
 *   ShapeAvatar.mood()                   the header avatar's current state (`data-state`)
 *   ShapeAvatar.setForm(form)            morph the avatar's context form (340 ms, instant if reduced)
 *   ShapeAvatar.form()                   the header avatar's current form (`data-form`)
 *   ShapeAvatar.setLevel(v)              voice input level in 0..1 while `listening`
 *   ShapeAvatar.setProgress(p)           fill the orb ring & top bar (`0..1`, clamped; junk -> 0)
 *   ShapeAvatar.progress()               current progress value (`0..1`)
 *   ShapeAvatar.pulse(kind)              one-shot reaction preserving mood: 'nod', 'tick', 'full',
 *                                        'no', 'celebrate' (returns false when not animated)
 *   ShapeAvatar.say(text)                replace the speech-bubble text (with a short fade)
 *   ShapeAvatar.glance(fieldOrNull)      shift gaze up to 3 SVG units toward field (0 if reduced)
 *   ShapeAvatar.perch(targetOrNull, o)   smoothly glide the orb to a visible card/stage or home
 *   ShapeAvatar.setDozing(bool)          dim ember slits, zz and slow breathing; preserves mood
 *   ShapeAvatar.dozing()                 whether the header avatar is dozing
 *   ShapeAvatar.intro(text)              first-open centred orb that FLIP-glides into the header
 *   ShapeAvatar.create(mood, prog, form) independent decorative orb element (`aria-hidden="true"`)
 *   ShapeAvatar.clampProgress(p)         pure: `p` clamped to `0..1`
 *   ShapeAvatar.litTicks(p, n)           pure: how many of `n` steps are lit for `p`
 *   ShapeAvatar.flip(from, to)           pure: centre-to-centre translate/scale from `from` to `to`
 *   ShapeAvatar.formFor(ctx)             pure: context `{ view, screen, dozing, intro }` -> form
 *   ShapeAvatar.morphPlan(from, to, red) pure: `{ to, ms, squash }` plan for a form transition
 */
(function (root) {
  'use strict';

  var NAME = 'Shaping';
  var MOODS = ['idle', 'focused', 'happy', 'alert', 'thinking'];
  var STATES = MOODS.concat(['listening', 'understood', 'oops', 'record', 'dozing']);
  var FORMS = ['base', 'treino', 'refeicao', 'agua', 'revisao', 'descanso'];
  var FORM_MS = 340;
  var OUT_MS = 140;
  var IN_DELAY = 90;
  var IN_MS = FORM_MS - IN_DELAY;
  var TICKS = 12;
  var INTRO_HOLD = 750;
  var INTRO_MS = 450;

  /* ---------------- pure helpers ---------------- */

  /** p as a number in 0..1; anything that is not a finite number reads as 0. */
  function clampProgress(p) {
    if (typeof p !== 'number' && (typeof p !== 'string' || !p.trim())) return 0;
    var n = Number(p);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n >= 1 ? 1 : n;
  }

  /** Lit steps for p: none at 0, at least one as soon as there is any progress, all only at 1. */
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

  /**
   * Pure: which form a context asks for. ctx = { view, screen, dozing, intro }.
   * Priority: dozing > review/sent screen > intro > view > base.
   */
  function formFor(ctx) {
    var c = ctx || {};
    if (c.dozing) return 'descanso';
    if (c.screen === 'review' || c.screen === 'sent') return 'revisao';
    if (c.intro) return 'base';
    if (c.view === 'workout') return 'treino';
    if (c.view === 'food') return 'refeicao';
    if (c.view === 'water') return 'agua';
    return 'base';
  }

  /** Pure: how a change from `from` to `to` plays. Reduced motion or no change: instant. */
  function morphPlan(from, to, reduced) {
    var target = FORMS.indexOf(to) >= 0 ? to : 'base';
    var moving = !reduced && from !== target;
    return { to: target, ms: moving ? FORM_MS : 0, squash: moving };
  }

  /* ---------------- Ember Orb geometry (100-unit grid) ---------------- */

  var CX = 50, CY = 50, ORB_R = 35, RING_R = 45.5;
  var RING_CIRC = Math.round(2 * Math.PI * RING_R * 100) / 100; // 285.88
  var EYE_L = 40.5, EYE_R = 59.5, EYE_Y = 50.5;
  var CAUSTIC_FOOT = 'M28 77.5Q50 89.5 72 77.5Q50 83.2 28 77.5Z';

  function round2(n) { return Math.round(n * 100) / 100; }

  /** Faceted diamond-lens core path (Lentes Ember signature, sleek optical feel). */
  function lensPath(cx, cy, rx, ry) {
    var tx = round2(cx), ty = round2(cy - ry);
    var rx1 = round2(cx + rx * 1.12), rx2 = round2(cx + rx);
    var lx1 = round2(cx - rx * 1.12), lx2 = round2(cx - rx);
    var uy = round2(cy - ry * 0.35), dy = round2(cy + ry * 0.35);
    var by = round2(cy + ry);
    return 'M' + tx + ' ' + ty +
      'Q' + rx1 + ' ' + uy + ' ' + rx2 + ' ' + round2(cy) +
      'Q' + rx1 + ' ' + dy + ' ' + tx + ' ' + by +
      'Q' + lx1 + ' ' + dy + ' ' + lx2 + ' ' + round2(cy) +
      'Q' + lx1 + ' ' + uy + ' ' + tx + ' ' + ty + 'Z';
  }

  function emberPair(bloomId, dx, dy, rx, ry) {
    var lx = round2(EYE_L + dx), rrx = round2(EYE_R + dx), y = round2(EYE_Y + dy);
    var brx = round2(rx * 2.3), bry = round2(ry * 2.15);
    var irx = round2(rx * 1.32), iry = round2(ry * 1.18);
    return '<g class="dt-eyes">' +
      '<ellipse class="orb-bloom" cx="' + lx + '" cy="' + y + '" rx="' + brx + '" ry="' + bry + '" fill="url(#' + bloomId + ')"/>' +
      '<ellipse class="orb-bloom" cx="' + rrx + '" cy="' + y + '" rx="' + brx + '" ry="' + bry + '" fill="url(#' + bloomId + ')"/>' +
      '<path class="dt-ink" d="' + lensPath(lx, y, rx, ry) + '"/>' +
      '<path class="dt-ink" d="' + lensPath(rrx, y, rx, ry) + '"/>' +
      '<ellipse class="orb-iris" cx="' + lx + '" cy="' + y + '" rx="' + irx + '" ry="' + iry + '"/>' +
      '<ellipse class="orb-iris" cx="' + rrx + '" cy="' + y + '" rx="' + irx + '" ry="' + iry + '"/>' +
      '</g>';
  }

  function happyArcs(bloomId, lift, width) {
    var y = round2(52 - (lift || 0));
    var peak = round2(44.2 - (lift || 0));
    var sw = width || 3.8;
    return '<g class="dt-eyes">' +
      '<ellipse class="orb-bloom" cx="' + EYE_L + '" cy="' + round2(y - 2) + '" rx="9" ry="7.5" fill="url(#' + bloomId + ')"/>' +
      '<ellipse class="orb-bloom" cx="' + EYE_R + '" cy="' + round2(y - 2) + '" rx="9" ry="7.5" fill="url(#' + bloomId + ')"/>' +
      '<path class="dt-stroke" stroke-width="' + sw + '" d="M34.8 ' + y + 'Q' + EYE_L + ' ' + peak + ' 46.2 ' + y + 'M53.8 ' + y + 'Q' + EYE_R + ' ' + peak + ' 65.2 ' + y + '"/>' +
      '</g>';
  }

  function facesFor(bloomId) {
    return {
      idle: emberPair(bloomId, 0, 0, 4.1, 6.0),
      focused: emberPair(bloomId, 0, 0.5, 4.5, 4.2),
      happy: happyArcs(bloomId, 0, 3.8),
      alert: emberPair(bloomId, 0, -0.5, 4.8, 6.9) +
        '<g class="dt-mouth"><circle class="dt-ink" cx="50" cy="63.5" r="2.2"/></g>',
      thinking: '<g class="dt-mouth dt-typing">' +
        '<ellipse class="orb-bloom" cx="40.5" cy="50.5" rx="8.5" ry="8.5" fill="url(#' + bloomId + ')"/>' +
        '<ellipse class="orb-bloom" cx="59.5" cy="50.5" rx="8.5" ry="8.5" fill="url(#' + bloomId + ')"/>' +
        '<circle class="dt-ink dt-dot" cx="38.5" cy="50.5" r="3.4"/>' +
        '<circle class="dt-ink dt-dot" cx="50" cy="50.5" r="3.0"/>' +
        '<circle class="dt-ink dt-dot" cx="61.5" cy="50.5" r="3.4"/></g>',
      listening: emberPair(bloomId, 0, -0.4, 4.7, 6.6),
      understood: happyArcs(bloomId, 1.8, 3.8) +
        '<g class="dt-mouth dt-check"><path class="dt-stroke" stroke-width="3.6" d="M44.4 61.2L48.8 65.4L56.6 56.8"/></g>',
      oops: '<g class="dt-eyes">' +
        '<ellipse class="orb-bloom" cx="' + EYE_R + '" cy="' + EYE_Y + '" rx="9.2" ry="12.5" fill="url(#' + bloomId + ')"/>' +
        '<path class="dt-stroke" stroke-width="3.6" d="M36 47.2L43.6 50.5L36 53.8"/>' +
        '<path class="dt-ink" d="' + lensPath(EYE_R, EYE_Y, 4.1, 6.0) + '"/>' +
        '</g>',
      record: happyArcs(bloomId, 1.0, 4.1),
      dozing: '<g class="dt-eyes orb-doze-eyes">' +
        '<path class="dt-stroke" stroke-width="3.0" d="M35.4 51.2Q40.5 54.6 45.6 51.2M54.4 51.2Q59.5 54.6 64.6 51.2"/>' +
        '</g>',
    };
  }

  function tickMarksSvg() {
    var out = '<g class="orb-ticks">';
    for (var i = 0; i < TICKS; i++) {
      var a = -Math.PI / 2 + (Math.PI * 2 * i) / TICKS;
      var tx = round2(CX + Math.cos(a) * RING_R);
      var ty = round2(CY + Math.sin(a) * RING_R);
      out += '<circle class="orb-tick" data-tick="' + (i + 1) + '" cx="' + tx + '" cy="' + ty + '" r="1.15"/>';
    }
    return out + '</g>';
  }
  var TICK_MARKS = tickMarksSvg();

  var spark = function (x, y, r, i) {
    return '<path class="dt-spark dt-sp' + i + '" d="M' + x + ' ' + (y - r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y +
      'Q' + x + ' ' + y + ' ' + x + ' ' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x - r) + ' ' + y + 'Q' + x + ' ' + y + ' ' + x + ' ' + (y - r) + 'Z"/>';
  };
  var DROP = 'M0 -5.6C3.8 -1 4.2 3.4 0 4.2C-4.2 3.4 -3.8 -1 0 -5.6Z';

  var FRONT =
    '<g class="dt-waves">' +
      '<circle class="orb-wave dt-w1" cx="50" cy="50" r="41.5"/>' +
      '<circle class="orb-wave dt-w2" cx="50" cy="50" r="47.5"/>' +
    '</g>' +
    '<g class="dt-sparks">' + spark(13, 16, 5.4, 1) + spark(88, 14, 4.8, 2) + spark(89, 76, 3.6, 3) + '</g>' +
    '<g class="dt-zz"><path class="dt-line" stroke-width="2.8" d="M77 15h6l-6 6.8h6"/><path class="dt-line" stroke-width="2.3" d="M87 7.5h4.4l-4.4 5h4.4"/></g>' +
    '<g class="dt-oopsdrop"><path class="dt-water" transform="translate(84 20)" d="' + DROP + '"/></g>' +
    '<g class="pf-part pf-treino">' +
      '<path class="orb-kinetic" d="M12.5 39A39.5 39.5 0 0 1 18.5 26.5"/>' +
      '<path class="orb-kinetic" d="M87.5 61A39.5 39.5 0 0 1 81.5 73.5"/>' +
    '</g>';

  function svg(id) {
    var clipId = 'orb-cp-' + id;
    var baseId = 'orb-bs-' + id;
    var lobeId = 'orb-lb-' + id;
    var dimId = 'orb-dm-' + id;
    var haloId = 'orb-hl-' + id;
    var specId = 'orb-sp-' + id;
    var bloomId = 'orb-bl-' + id;
    var ringId = 'orb-rg-' + id;
    var faces = facesFor(bloomId);

    return '<svg class="dt-svg" viewBox="0 0 100 100" focusable="false" aria-hidden="true">' +
      '<defs>' +
        '<clipPath id="' + clipId + '"><circle cx="50" cy="50" r="' + ORB_R + '"/></clipPath>' +
        '<radialGradient id="' + haloId + '" cx="50%" cy="50%" r="50%">' +
          '<stop offset="0%" class="orb-hl0"/><stop offset="100%" class="orb-hl1"/>' +
        '</radialGradient>' +
        '<radialGradient id="' + baseId + '" cx="34%" cy="30%" r="74%">' +
          '<stop offset="0%" class="orb-c0"/><stop offset="54%" class="orb-c1"/><stop offset="100%" class="orb-c2"/>' +
        '</radialGradient>' +
        '<radialGradient id="' + lobeId + '" cx="50%" cy="50%" r="50%">' +
          '<stop offset="0%" class="orb-lb0"/><stop offset="46%" class="orb-lb1"/><stop offset="100%" class="orb-lb2"/>' +
        '</radialGradient>' +
        '<radialGradient id="' + dimId + '" cx="50%" cy="56%" r="52%">' +
          '<stop offset="0%" stop-color="#0d0604" stop-opacity="0.46"/><stop offset="100%" stop-color="#0d0604" stop-opacity="0"/>' +
        '</radialGradient>' +
        '<radialGradient id="' + bloomId + '" cx="50%" cy="50%" r="50%">' +
          '<stop offset="0%" stop-color="#fffaf4" stop-opacity="0.92"/><stop offset="38%" stop-color="#ffcba3" stop-opacity="0.42"/><stop offset="100%" stop-color="#ff823c" stop-opacity="0"/>' +
        '</radialGradient>' +
        '<radialGradient id="' + specId + '" cx="34%" cy="24%" r="64%">' +
          '<stop offset="0%" stop-color="#ffffff" stop-opacity="0.64"/><stop offset="38%" stop-color="#ffffff" stop-opacity="0.16"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>' +
        '</radialGradient>' +
        '<linearGradient id="' + ringId + '" x1="0" y1="0" x2="1" y2="1">' +
          '<stop offset="0%" class="orb-rg0"/><stop offset="100%" class="orb-rg1"/>' +
        '</linearGradient>' +
      '</defs>' +
      '<circle class="orb-halo" cx="50" cy="54" r="45" fill="url(#' + haloId + ')"/>' +
      '<ellipse class="dt-ground" cx="50" cy="95.5" rx="22" ry="2.4"/>' +
      '<g class="orb-ring">' +
        '<circle class="orb-ring-track" cx="50" cy="50" r="' + RING_R + '"/>' +
        TICK_MARKS +
        '<circle class="orb-ring-arc" cx="50" cy="50" r="' + RING_R + '" transform="rotate(-90 50 50)" stroke="url(#' + ringId + ')" stroke-dasharray="' + RING_CIRC + '" stroke-dashoffset="' + RING_CIRC + '"/>' +
        '<g class="orb-ring-tip-wrap"><circle class="orb-ring-tip" cx="50" cy="4.5" r="2.2"/></g>' +
      '</g>' +
      '<g class="pf-shell"><g class="dt-pose"><g class="dt-anim"><g class="dt-breath">' +
        '<g class="dt-footpose"><g class="dt-foot"><path class="orb-caustic" d="' + CAUSTIC_FOOT + '"/></g></g>' +
        '<g clip-path="url(#' + clipId + ')">' +
          '<circle class="orb-body" cx="50" cy="50" r="' + ORB_R + '" fill="url(#' + baseId + ')"/>' +
          '<circle class="orb-lobe" cx="44" cy="44" r="26" fill="url(#' + lobeId + ')"/>' +
          '<circle cx="50" cy="55" r="29" fill="url(#' + dimId + ')"/>' +
          '<path class="orb-equator" d="M23 53Q50 66 77 53"/>' +
          '<g class="pf-part pf-agua dt-waterbox"><g class="dt-wave">' +
            '<path class="dt-water2" d="M-50 61Q-37.5 56.5 -25 61T0 61T25 61T50 61T75 61T100 61T125 61T150 61V96H-50Z"/>' +
            '<path class="dt-water" d="M-50 65Q-37.5 60.5 -25 65T0 65T25 65T50 65T75 65T100 65T125 65T150 65V96H-50Z"/>' +
          '</g><circle class="dt-bubble b1" cx="38" cy="72" r="1.7"/><circle class="dt-bubble b2" cx="63" cy="69" r="1.3"/></g>' +
          '<g class="dt-scan"><g class="dt-gaze">' +
            STATES.map(function (s) { return '<g class="dt-f f-' + s + '">' + faces[s] + '</g>'; }).join('') +
          '</g></g>' +
          '<ellipse cx="40" cy="34" rx="18" ry="9.5" transform="rotate(-26 40 34)" fill="url(#' + specId + ')"/>' +
          '<circle class="orb-rim" cx="50" cy="50" r="33.8"/>' +
        '</g>' +
        '<circle class="orb-hairline" cx="50" cy="50" r="' + ORB_R + '"/>' +
      '</g></g></g>' +
      FRONT +
      '</g></svg>';
  }

  function iconSvg(variant) {
    var coral = variant === 'coral';
    var bg = coral ? '#C9410C' : '#161517';
    var ring = coral ? '#FFFBF7' : '#FF7A3D';
    var core = coral ? '#220E0A' : '#FF6A2B';
    var eye = '#FFFDF9';
    return '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="100" height="100" fill="' + bg + '"/>' +
      '<circle cx="50" cy="50" r="40" fill="none" stroke="' + ring + '" stroke-opacity="0.45" stroke-width="3"/>' +
      '<circle cx="50" cy="50" r="31" fill="' + core + '"/>' +
      '<path fill="' + eye + '" d="' + lensPath(41.5, 50.5, 4.1, 6.0) + '"/>' +
      '<path fill="' + eye + '" d="' + lensPath(58.5, 50.5, 4.1, 6.0) + '"/>' +
      '</svg>';
  }

  function monoSvg() {
    var m = 'dt-mono-' + (++uid);
    return '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><mask id="' + m + '">' +
      '<rect x="-10" y="-10" width="120" height="120" fill="#fff"/>' +
      '<path fill="#000" d="' + lensPath(40.5, 50.5, 4.6, 6.6) + '"/>' +
      '<path fill="#000" d="' + lensPath(59.5, 50.5, 4.6, 6.6) + '"/>' +
      '</mask></defs>' +
      '<circle cx="50" cy="50" r="44" fill="none" stroke="currentColor" stroke-width="4" stroke-dasharray="196 80" stroke-linecap="round" transform="rotate(-90 50 50)"/>' +
      '<circle cx="50" cy="50" r="34" fill="currentColor" mask="url(#' + m + ')"/></svg>';
  }

  /* ---------------- CSS ---------------- */

  var EASE_POP = 'cubic-bezier(0.34, 1.4, 0.5, 1)';
  var CSS = ':root {\n' +
    '  --dt-skin: #B93708; --dt-shade: #260F09; --dt-light: #FFFFFF; --dt-ink: #FFFDF9; --dt-glint: #FFFBF7;\n' +
    '  --dt-cheek: #FF9A7E; --dt-tongue: #FF8C78; --dt-water: #2F95E8; --dt-water2: #7CC0F5;\n' +
    '  --dt-line: #2A1914; --dt-spark: #F59E0B; --dt-ground: #2A1914;\n' +
    '  --orb-core: #FF6A2B; --orb-mid: var(--dt-skin); --orb-deep: #260F09;\n' +
    '  --orb-rim: #FFDECC; --orb-halo: rgba(201, 65, 12, 0.28); --orb-hairline: rgba(28, 25, 23, 0.2);\n' +
    '  --orb-ring-track: rgba(28, 25, 23, 0.13); --orb-tick: rgba(28, 25, 23, 0.22); --orb-tick-lit: rgba(255, 255, 255, 0.9);\n' +
    '  --pl-focused: #C9410C; --pl-happy: #15803D; --pl-alert: #D97706; --pl-bar-track: rgba(28, 25, 23, 0.1);\n' +
    '}\n' +
    ':root[data-scheme="dark"] {\n' +
    '  --dt-skin: #C43D0E; --dt-shade: #1E0B08; --dt-cheek: #FFB29F; --dt-tongue: #FF9B88;\n' +
    '  --dt-water: #4BA9F5; --dt-water2: #8FCBF8; --dt-line: #F2EDE8; --dt-ground: #000000;\n' +
    '  --orb-core: #FF7A3D; --orb-mid: var(--dt-skin); --orb-deep: #1E0B08;\n' +
    '  --orb-rim: #FFD6C2; --orb-halo: rgba(255, 106, 43, 0.44); --orb-hairline: rgba(255, 255, 255, 0.17);\n' +
    '  --orb-ring-track: rgba(255, 255, 255, 0.12); --orb-tick: rgba(255, 255, 255, 0.22); --orb-tick-lit: rgba(255, 255, 255, 0.78);\n' +
    '  --pl-focused: #FF6A2B; --pl-happy: #4ADE80; --pl-alert: #FBBF24; --pl-bar-track: rgba(255, 255, 255, 0.1);\n' +
    '}\n' +
    /* context & state plasma palettes */
    '.shape[data-form="refeicao"] { --orb-core: #FBBF24; --orb-mid: #D95416; --orb-deep: #240F07; --orb-rim: #FEE6BE; --orb-halo: rgba(251, 191, 36, 0.34); }\n' +
    '.shape[data-form="agua"] { --orb-core: #60A5FA; --orb-mid: #1D4ED8; --orb-deep: #08152E; --orb-rim: #BFDBFE; --orb-halo: rgba(91, 155, 240, 0.38); }\n' +
    '.shape[data-form="revisao"] { --orb-core: #FF8A4C; --orb-mid: #C9410C; --orb-deep: #210C08; --orb-rim: #FFE4D2; }\n' +
    '.shape[data-form="descanso"], .shape[data-dozing="true"] { --orb-core: #D9693A; --orb-mid: #7C2D12; --orb-deep: #160A08; --orb-halo: rgba(217, 105, 58, 0.22); }\n' +
    '.shape[data-state="happy"], .shape[data-state="understood"], .shape[data-state="record"], .shape[data-reaction="celebrate"] {\n' +
    '  --orb-core: #4ADE80; --orb-mid: #15803D; --orb-deep: #062013; --orb-rim: #BBF7D0; --orb-halo: rgba(74, 222, 128, 0.42);\n' +
    '}\n' +
    '.shape[data-state="alert"], .shape[data-state="oops"] {\n' +
    '  --orb-core: #FBBF24; --orb-mid: #DC2626; --orb-deep: #2B0C08; --orb-rim: #FEF08A; --orb-halo: rgba(248, 113, 113, 0.42);\n' +
    '}\n' +
    '.shape { position: relative; }\n' +
    '.shape .dt-svg { display: block; width: 100%; height: 100%; overflow: visible; transition: opacity 160ms ease-out; }\n' +
    '.shape .dt-svg * { transform-box: view-box; }\n' +
    '.shape[data-vacant="true"] .dt-svg { opacity: 0; }\n' +
    '.shape[data-vacant="true"]::after {\n' +
    '  content: ""; position: absolute; inset: 4px; border-radius: 50%;\n' +
    '  border: 1.5px dashed var(--orb-ring-track); pointer-events: none;\n' +
    '}\n' +
    /* gradient stops & glass layers */
    '.orb-c0 { stop-color: var(--orb-core); } .orb-c1 { stop-color: var(--orb-mid); } .orb-c2 { stop-color: var(--orb-deep); }\n' +
    '.orb-lb0 { stop-color: #FFE4CC; stop-opacity: .56; } .orb-lb1 { stop-color: var(--orb-core); stop-opacity: .42; } .orb-lb2 { stop-color: var(--orb-core); stop-opacity: 0; }\n' +
    '.orb-hl0 { stop-color: var(--orb-core); stop-opacity: .38; } .orb-hl1 { stop-color: var(--orb-core); stop-opacity: 0; }\n' +
    '.orb-rg0 { stop-color: var(--orb-core); } .orb-rg1 { stop-color: var(--orb-rim); }\n' +
    '.shape[data-progress="1"] .orb-rg1 { stop-color: var(--pl-happy); }\n' +
    '.orb-halo { transform-origin: 50px 54px; opacity: .88; }\n' +
    '.orb-lobe { transform-origin: 50px 50px; }\n' +
    '.orb-equator { fill: none; stroke: rgba(255, 232, 214, 0.16); stroke-width: 1.2; stroke-linecap: round; }\n' +
    '.orb-rim { fill: none; stroke: var(--orb-rim); stroke-width: 2.2; opacity: .48; }\n' +
    '.orb-hairline { fill: none; stroke: var(--orb-hairline); stroke-width: 1.1; }\n' +
    '.orb-caustic { fill: var(--orb-core); opacity: .28; }\n' +
    '.orb-kinetic { fill: none; stroke: var(--orb-core); stroke-width: 2.4; stroke-linecap: round; opacity: .75; }\n' +
    /* integrated progress ring */
    '.orb-ring-track { fill: none; stroke: var(--orb-ring-track); stroke-width: 3.1; }\n' +
    '.orb-ring-arc { fill: none; stroke-width: 3.2; stroke-linecap: round; opacity: 0; transition: stroke-dashoffset 420ms cubic-bezier(0.22, 1, 0.36, 1), opacity 220ms ease; }\n' +
    '.orb-ring[data-has-progress="true"] .orb-ring-arc { opacity: 1; }\n' +
    '.orb-tick { fill: var(--orb-tick); transition: opacity 200ms ease; opacity: .55; }\n' +
    '.orb-tick[data-lit="true"] { fill: var(--orb-tick-lit); opacity: .9; }\n' +
    '.orb-ring-tip-wrap { transform-origin: 50px 50px; opacity: 0; transition: transform 420ms cubic-bezier(0.22, 1, 0.36, 1), opacity 200ms ease; }\n' +
    '.orb-ring[data-has-progress="true"] .orb-ring-tip-wrap { opacity: 1; }\n' +
    '.orb-ring-tip { fill: #FFFFFF; }\n' +
    /* optical lenses & strokes */
    '.dt-ink { fill: var(--dt-ink); }\n' +
    '.dt-glint { fill: var(--dt-glint); }\n' +
    '.dt-stroke { fill: none; stroke: var(--dt-ink); stroke-linecap: round; stroke-linejoin: round; }\n' +
    '.dt-line { fill: none; stroke: var(--dt-line); stroke-linecap: round; stroke-linejoin: round; }\n' +
    '.orb-iris { fill: none; stroke: rgba(255, 205, 165, 0.56); stroke-width: 1; }\n' +
    '.orb-doze-eyes { opacity: .76; }\n' +
    '.dt-water { fill: var(--dt-water); opacity: .55; } .dt-water2 { fill: var(--dt-water2); opacity: .42; }\n' +
    '.dt-bubble { fill: var(--dt-glint); opacity: .72; }\n' +
    '.dt-spark { fill: var(--dt-spark); }\n' +
    '.dt-ground { fill: var(--dt-ground); opacity: .12; }\n' +
    '.orb-wave { fill: none; stroke: var(--orb-core); stroke-width: 2.2; transform-origin: 50px 50px; }\n' +
    /* transform origins & transitions */
    '.dt-pose, .dt-anim, .dt-breath { transform-origin: 50px 50px; }\n' +
    '.dt-footpose, .dt-foot { transform-origin: 50px 78px; }\n' +
    '.dt-eyes { transform-origin: 50px 50.5px; }\n' +
    '.dt-mouth { transform-origin: 50px 56px; }\n' +
    '.dt-gaze, .dt-scan { transition: transform 220ms ease-out; }\n' +
    '.dt-pose { transition: transform 260ms ' + EASE_POP + '; }\n' +
    '.dt-breath { transition: transform 90ms linear; }\n' +
    '.dt-ground { transform-origin: 50px 95.5px; transition: transform 260ms ease-out, opacity 260ms ease-out; }\n' +
    /* face cross-fade */
    '.shape .dt-f { opacity: 0; transition: opacity 150ms ease-out; }\n' +
    '.shape[data-state="idle"] .f-idle, .shape[data-state="focused"] .f-focused, .shape[data-state="happy"] .f-happy,\n' +
    '.shape[data-state="alert"] .f-alert, .shape[data-state="thinking"] .f-thinking, .shape[data-state="listening"] .f-listening,\n' +
    '.shape[data-state="understood"] .f-understood, .shape[data-state="oops"] .f-oops, .shape[data-state="record"] .f-record,\n' +
    '.shape[data-state="dozing"] .f-dozing { opacity: 1; }\n' +
    '.shape[data-state][data-reaction="celebrate"] .dt-f { opacity: 0; }\n' +
    '.shape[data-state][data-reaction="celebrate"] .f-record { opacity: 1; }\n' +
    '.shape[data-dozing="true"] .dt-f { opacity: 0; }\n' +
    '.shape[data-dozing="true"] .dt-f.f-dozing { opacity: 1; }\n' +
    /* static poses per state */
    '.shape[data-state="focused"] .dt-pose { transform: translateY(-0.5px) scale(1.02); }\n' +
    '.shape[data-state="alert"] .dt-pose { transform: translateY(-1.5px) scale(1.03); }\n' +
    '.shape[data-state="listening"] .dt-pose { transform: scale(1.03); }\n' +
    '.shape[data-state="oops"] .dt-pose { transform: rotate(-4deg); }\n' +
    '.shape[data-state="dozing"] .dt-pose, .shape[data-dozing="true"] .dt-pose { transform: translateY(2px) scale(0.96); }\n' +
    /* front decorations (opacity + transform only) */
    '.dt-waves, .dt-sparks, .dt-zz, .dt-oopsdrop { opacity: 0; transition: opacity 160ms ease-out; }\n' +
    '.shape[data-state="listening"] .dt-waves { opacity: 1; }\n' +
    '.shape[data-state="record"] .dt-sparks, .shape[data-state][data-reaction="celebrate"] .dt-sparks { opacity: 1; }\n' +
    '.shape[data-state="dozing"] .dt-zz, .shape[data-dozing="true"] .dt-zz { opacity: 1; }\n' +
    '.shape[data-state="oops"] .dt-oopsdrop { opacity: 1; }\n' +
    '.shape[data-dozing="true"] .dt-waves, .shape[data-dozing="true"] .dt-sparks { opacity: 0; }\n' +
    /* context forms */
    '.shape .pf-shell { transform-origin: 50px 50px; transition: transform ' + FORM_MS + 'ms ' + EASE_POP + '; }\n' +
    '.shape[data-form="treino"] .pf-shell { transform: scale(1.02); }\n' +
    '.shape[data-form="revisao"] .pf-shell { transform: scale(1.01); }\n' +
    '.shape[data-form="descanso"] .pf-shell { transform: translateY(2px) scale(0.96); }\n' +
    '.dt-footpose { transition: transform ' + FORM_MS + 'ms ' + EASE_POP + '; }\n' +
    '.shape .pf-part { opacity: 0; transition: opacity ' + OUT_MS + 'ms ease-in, transform ' + OUT_MS + 'ms ease-in; }\n' +
    '.shape .pf-treino { transform-origin: 50px 50px; transform: scale(.86); }\n' +
    '.shape .dt-waterbox { transform: translateY(42px); }\n' +
    '.shape[data-form="treino"] .pf-treino, .shape[data-form="agua"] .pf-agua {\n' +
    '  opacity: 1; transform: none;\n' +
    '  transition: opacity ' + Math.round(IN_MS * 0.6) + 'ms ease-out ' + IN_DELAY + 'ms, transform ' + IN_MS + 'ms ' + EASE_POP + ' ' + IN_DELAY + 'ms;\n' +
    '}\n' +
    /* floating spring-glider overlay layer (progressive enhancement) */
    '.orb-flight-layer { position: fixed; inset: 0; z-index: 16; pointer-events: none; overflow: hidden; }\n' +
    '.orb-glider { position: fixed; left: 0; top: 0; width: 44px; height: 44px; margin: 0; pointer-events: none; will-change: transform; transform-origin: center center; }\n' +
    '.orb-trail {\n' +
    '  position: fixed; left: 0; top: 0; width: 26px; height: 26px; border-radius: 50%;\n' +
    '  background: radial-gradient(circle, var(--orb-core, #FF6A2B), transparent 72%);\n' +
    '  opacity: 0; pointer-events: none; will-change: transform, opacity;\n' +
    '}\n' +
    /* top progress bar (in the header) */
    '.pl-bar {\n' +
    '  position: absolute; left: var(--pad, 16px); right: var(--pad, 16px);\n' +
    '  top: calc(var(--safe-top, 0px) + 3px); height: 3px; border-radius: 2px;\n' +
    '  background: var(--pl-bar-track); overflow: hidden; pointer-events: none;\n' +
    '}\n' +
    '.pl-bar i {\n' +
    '  display: block; height: 100%; background: var(--pl-focused);\n' +
    '  transform-origin: 0 50%; transform: scaleX(0); transition: transform 0.45s cubic-bezier(0.2, 0.8, 0.2, 1);\n' +
    '}\n' +
    '.pl-bar[data-state="happy"] i, .pl-bar[data-state="understood"] i, .pl-bar[data-state="record"] i { background: var(--pl-happy); }\n' +
    '.pl-bar[data-state="alert"] i, .pl-bar[data-state="oops"] i { background: var(--pl-alert); }\n' +
    /* thinking dots after the bubble text */
    '.pl-dots { display: none; gap: 3px; margin-left: 4px; vertical-align: middle; }\n' +
    '.pl-dots i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: 0.3; animation: pl-dot 1.1s ease-in-out infinite; }\n' +
    '.pl-dots i:nth-child(2) { animation-delay: 0.15s; }\n' +
    '.pl-dots i:nth-child(3) { animation-delay: 0.3s; }\n' +
    '.shape[data-state="thinking"] ~ .bubble .pl-dots, .pl-intro .pl-dots { display: inline-flex; }\n' +
    /* first-open intro: Shaping orb large and centred, then it glides into the header */
    '.pl-intro {\n' +
    '  position: fixed; inset: 0; z-index: 60; pointer-events: none;\n' +
    '  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;\n' +
    '  padding-bottom: 14vh;\n' +
    '}\n' +
    '.pl-intro-bg { position: absolute; inset: 0; background: var(--bg, #f5f4f1); }\n' +
    '.pl-intro .shape { position: relative; flex: none; width: 112px; height: 112px; margin: 0; }\n' +
    '.pl-intro-text { position: relative; margin: 0; color: var(--hint, #635d58); font-size: 15px; }\n' +
    /* animations (strictly transform + opacity only) */
    '@media (prefers-reduced-motion: no-preference) {\n' +
    '  .shape:not([data-motion="off"]) .dt-anim { animation: dt-breathe 4.2s ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"]) .orb-lobe { animation: orb-plasma 6.4s ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"]) .dt-eyes { animation: dt-blink 5.2s linear infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="focused"] .dt-eyes { animation-duration: 6.5s; }\n' +
    '  .shape:not([data-motion="off"])[data-state="happy"] .dt-anim { animation: dt-pop 320ms ' + EASE_POP + ' 1, dt-breathe 4.2s ease-in-out 320ms infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="alert"] .dt-anim { animation: dt-startle 300ms ease-out 1; }\n' +
    '  .shape:not([data-motion="off"])[data-state="understood"] .dt-anim { animation: dt-hop 380ms ease-out 1; }\n' +
    '  .shape:not([data-motion="off"])[data-state="understood"] .dt-check { animation: dt-checkin 300ms ' + EASE_POP + ' 80ms 1 both; }\n' +
    '  .shape:not([data-motion="off"])[data-state="record"] .dt-anim { animation: dt-bighop 400ms ease-out 1, dt-breathe 4.2s ease-in-out 400ms infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="record"] .dt-spark { transform-box: fill-box; transform-origin: center; animation: dt-sparkin 360ms ' + EASE_POP + ' 1 both, dt-twinkle 1.6s ease-in-out 360ms infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="record"] .dt-sp2 { animation-delay: 60ms, 420ms; }\n' +
    '  .shape:not([data-motion="off"])[data-state="record"] .dt-sp3 { animation-delay: 120ms, 480ms; }\n' +
    '  .shape:not([data-motion="off"])[data-state="oops"] .dt-anim { animation: dt-shrug 360ms ease-out 1; }\n' +
    '  .shape:not([data-motion="off"])[data-state="oops"] .dt-oopsdrop { animation: dt-dropin 400ms ease-out 1 both; }\n' +
    '  .shape:not([data-motion="off"])[data-state="thinking"] .dt-dot { transform-box: fill-box; transform-origin: center; animation: dt-type 1.05s ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="thinking"] .dt-dot:nth-child(4) { animation-delay: .16s; }\n' +
    '  .shape:not([data-motion="off"])[data-state="thinking"] .dt-dot:nth-child(5) { animation-delay: .32s; }\n' +
    '  .shape:not([data-motion="off"])[data-state="thinking"] .dt-foot { animation: dt-tap 1.2s ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="listening"]:not([data-level]) .dt-w1 { animation: dt-wave 1.1s ease-out infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="listening"]:not([data-level]) .dt-w2 { animation: dt-wave 1.1s ease-out 360ms infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="dozing"] .dt-anim, .shape:not([data-motion="off"])[data-dozing="true"] .dt-anim { animation: dt-sleep 6s ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="dozing"] .dt-zz, .shape:not([data-motion="off"])[data-dozing="true"] .dt-zz { animation: dt-zz 2.6s ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-form="agua"] .dt-wave { animation: dt-flow 2.4s linear infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-form="agua"] .dt-bubble { transform-box: fill-box; animation: dt-rise 2.2s ease-in infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-form="agua"] .dt-bubble.b2 { animation-delay: 1.1s; }\n' +
    '  .shape:not([data-motion="off"])[data-form="revisao"] .dt-scan { animation: dt-scan 2.4s ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-form="descanso"] .dt-anim { animation: dt-sleep 6s ease-in-out infinite; }\n' +
    '}\n' +
    '@keyframes dt-breathe { 0%, 100% { transform: translateY(0) scale(1); } 50% { transform: translateY(-1.8px) scale(1.022); } }\n' +
    '@keyframes orb-plasma { 0%, 100% { transform: translate(-2px, -2px) scale(1); } 50% { transform: translate(4px, 3px) scale(1.08); } }\n' +
    '@keyframes dt-blink { 0%, 96.2%, 100% { transform: scaleY(1); } 97.9% { transform: scaleY(.08); } }\n' +
    '@keyframes dt-pop { 0% { transform: scale(1, 1); } 40% { transform: scale(1.08, .93); } 100% { transform: scale(1, 1); } }\n' +
    '@keyframes dt-startle { 0% { transform: translateY(0); } 35% { transform: translateY(-4px) scale(.96, 1.05); } 100% { transform: translateY(0); } }\n' +
    '@keyframes dt-hop { 0% { transform: translateY(0) scale(1, 1); } 22% { transform: translateY(0) scale(1.06, .92); }\n' +
    '  55% { transform: translateY(-7px) scale(.97, 1.04); } 82% { transform: translateY(0) scale(1.04, .96); } 100% { transform: translateY(0) scale(1, 1); } }\n' +
    '@keyframes dt-bighop { 0% { transform: translateY(0) scale(1, 1); } 20% { transform: translateY(0) scale(1.08, .9); }\n' +
    '  50% { transform: translateY(-10px) scale(.95, 1.06); } 80% { transform: translateY(0) scale(1.05, .95); } 100% { transform: scale(1, 1); } }\n' +
    '@keyframes dt-checkin { 0% { opacity: 0; transform: scale(.3); } 100% { opacity: 1; transform: scale(1); } }\n' +
    '@keyframes dt-sparkin { 0% { opacity: 0; transform: scale(0) rotate(-40deg); } 100% { opacity: 1; transform: scale(1) rotate(0); } }\n' +
    '@keyframes dt-twinkle { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(.7); opacity: .55; } }\n' +
    '@keyframes dt-shrug { 0% { transform: translateY(0); } 40% { transform: translateY(-2px) scale(1.04, .96); } 100% { transform: translateY(0); } }\n' +
    '@keyframes dt-dropin { 0% { opacity: 0; transform: translateY(-5px); } 100% { opacity: 1; transform: translateY(0); } }\n' +
    '@keyframes dt-type { 0%, 60%, 100% { transform: translateY(0) scale(.92); opacity: .55; } 30% { transform: translateY(-3.2px) scale(1.12); opacity: 1; } }\n' +
    '@keyframes dt-tap { 0%, 55%, 100% { transform: scaleX(1); opacity: .28; } 25% { transform: scaleX(1.18); opacity: .55; } }\n' +
    '@keyframes dt-wave { 0% { opacity: .65; transform: scale(.96); } 100% { opacity: 0; transform: scale(1.22); } }\n' +
    '@keyframes dt-sleep { 0%, 100% { transform: scale(1); } 50% { transform: scale(1.025); } }\n' +
    '@keyframes dt-zz { 0% { opacity: 0; transform: translate(-2px, 4px); } 30%, 70% { opacity: 1; } 100% { opacity: 0; transform: translate(2px, -4px); } }\n' +
    '@keyframes dt-flow { from { transform: translateX(0); } to { transform: translateX(-50px); } }\n' +
    '@keyframes dt-rise { 0% { opacity: 0; transform: translateY(0); } 25% { opacity: .8; } 100% { opacity: 0; transform: translateY(-14px); } }\n' +
    '@keyframes dt-scan { 0%, 100% { transform: translateX(-2.2px); } 50% { transform: translateX(2.2px); } }\n' +
    '@keyframes pl-dot { 0%, 100% { opacity: 0.3; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }\n' +
    '.shape[data-motion="off"] *, .shape[data-motion="off"] { transition: none !important; animation: none !important; }\n' +
    '@media (prefers-reduced-motion: reduce) {\n' +
    '  .shape *, .shape, .pl-bar i, .pl-dots i { animation: none !important; transition: none !important; }\n' +
    '  .pl-dots i { opacity: 0.7; }\n' +
    '}\n';

  /* ---------------- state & DOM behaviour ---------------- */

  var host = null;
  var textEl = null;
  var bar = null;
  var dots = null;
  var lastText = '';
  var hostProgress = 0;
  var uid = 0;
  var introState = null;
  var reactionTimer = null;
  var pulsing = [];
  var morphing = [];
  var mediaBound = false;

  /* ---------------- fluid spring-glider state (progressive enhancement) ---------------- */

  var flight = {
    layer: null,
    glider: null,
    trails: [],
    raf: 0,
    target: null,
    mode: 'home', // 'home' | 'card' | 'stage'
    x: 0, y: 0, vx: 0, vy: 0,
    size: 44, vs: 0,
    history: [],
    scrollBound: false,
    doc: null,
  };

  function docOf(el) {
    if (el && el.ownerDocument) return el.ownerDocument;
    return typeof document !== 'undefined' ? document : null;
  }

  function winOf(doc) {
    if (doc && doc.defaultView) return doc.defaultView;
    return root;
  }

  function reducedMotion(el) {
    if (el && el.getAttribute && el.getAttribute('data-motion') === 'off') return true;
    var w = winOf(docOf(el));
    try { return !!(w && w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  function cancelActiveAnimations() {
    while (pulsing.length) { var p = pulsing.pop(); if (p && p.cancel) p.cancel(); }
    while (morphing.length) { var m = morphing.pop(); if (m && m.cancel) m.cancel(); }
  }

  function injectStyle(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.createElement) return;
    var head = d.head || (d.querySelector && d.querySelector('head')) || d.documentElement;
    if (!head) return;
    if (d.getElementById && d.getElementById('shape-avatar-style')) return;
    var st = d.createElement('style');
    st.setAttribute('id', 'shape-avatar-style');
    st.textContent = CSS;
    head.appendChild(st);
    var w = winOf(d);
    if (!mediaBound && w && w.matchMedia) {
      var preference = w.matchMedia('(prefers-reduced-motion: reduce)');
      var stop = function (e) {
        if (!e || !e.matches) return;
        cancelActiveAnimations();
        teardownFlight();
        if (host) api.glance(null);
        if (introState) finishIntro(introState);
      };
      if (preference && preference.addEventListener) { preference.addEventListener('change', stop); mediaBound = true; }
      else if (preference && preference.addListener) { preference.addListener(stop); mediaBound = true; }
    }
  }

  function makeDots(doc) {
    var d = doc.createElement('span');
    d.className = 'pl-dots';
    d.setAttribute('aria-hidden', 'true');
    d.appendChild(doc.createElement('i'));
    d.appendChild(doc.createElement('i'));
    d.appendChild(doc.createElement('i'));
    return d;
  }

  function paintProgress(el, p) {
    var v = clampProgress(p);
    var rounded = Math.round(v * 100) / 100;
    el.setAttribute('data-progress', String(rounded));
    if (!el.querySelector) return;
    var ring = el.querySelector('.orb-ring');
    if (ring) ring.setAttribute('data-has-progress', v > 0 ? 'true' : 'false');
    var arc = el.querySelector('.orb-ring-arc');
    if (arc && arc.setAttribute) {
      var offset = round2(RING_CIRC * (1 - v));
      arc.setAttribute('stroke-dashoffset', String(offset));
    }
    var tipWrap = el.querySelector('.orb-ring-tip-wrap');
    if (tipWrap && tipWrap.style) {
      tipWrap.style.transform = 'rotate(' + round2(v * 360) + 'deg)';
    }
    if (el.querySelectorAll) {
      var lit = litTicks(v, TICKS);
      var ticks = el.querySelectorAll('.orb-tick');
      for (var i = 0; i < ticks.length; i++) {
        ticks[i].setAttribute('data-lit', i < lit ? 'true' : 'false');
      }
    }
  }

  function paintBar() {
    if (!bar || !bar.firstChild) return;
    bar.firstChild.style.transform = 'scaleX(' + hostProgress + ')';
    if (host) bar.setAttribute('data-state', host.getAttribute('data-state'));
  }

  function draw(el, state, progress, form) {
    el.classList.add('shape');
    el.setAttribute('data-state', STATES.indexOf(state) >= 0 ? state : 'idle');
    el.setAttribute('data-form', FORMS.indexOf(form) >= 0 ? form : 'base');
    if (el.tagName !== 'BUTTON') el.setAttribute('aria-hidden', 'true');
    el.innerHTML = svg(++uid); // constant markup, never user text
    paintProgress(el, progress);
    return el;
  }

  function syncGliderFromHost() {
    if (!host || !flight.glider) return;
    var g = flight.glider;
    var attrs = ['data-state', 'data-form', 'data-dozing', 'data-reaction', 'data-level'];
    for (var i = 0; i < attrs.length; i++) {
      var k = attrs[i];
      if (host.hasAttribute(k)) g.setAttribute(k, host.getAttribute(k));
      else g.removeAttribute(k);
    }
    paintProgress(g, hostProgress);
  }

  function teardownFlight() {
    var w = winOf(flight.doc || docOf(host));
    if (flight.raf && w && typeof w.cancelAnimationFrame === 'function') {
      w.cancelAnimationFrame(flight.raf);
    }
    flight.raf = 0;
    if (flight.target && flight.target.style && flight.mode === 'stage') {
      flight.target.style.opacity = '';
    }
    flight.target = null;
    flight.mode = 'home';
    flight.history = [];
    if (host) host.removeAttribute('data-vacant');
    if (flight.layer && flight.layer.parentNode) {
      flight.layer.parentNode.removeChild(flight.layer);
    }
    flight.layer = null;
    flight.glider = null;
    flight.trails = [];
  }

  function ensureFlightLayer(doc) {
    if (flight.layer && flight.layer.parentNode) return true;
    if (!doc || !doc.body || !doc.createElement) return false;
    var layer = doc.createElement('div');
    layer.className = 'orb-flight-layer';
    layer.setAttribute('aria-hidden', 'true');
    var trails = [];
    for (var i = 0; i < 3; i++) {
      var tr = doc.createElement('div');
      tr.className = 'orb-trail';
      layer.appendChild(tr);
      trails.push(tr);
    }
    var glider = draw(doc.createElement('div'), host.getAttribute('data-state'), hostProgress, host.getAttribute('data-form'));
    glider.classList.add('orb-glider');
    layer.appendChild(glider);
    doc.body.appendChild(layer);
    flight.layer = layer;
    flight.glider = glider;
    flight.trails = trails;
    flight.doc = doc;
    syncGliderFromHost();
    return true;
  }

  function measureAnchor(el, mode) {
    if (!el || !el.getBoundingClientRect) return null;
    var r = el.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return null;
    if (mode === 'card') {
      var coach = host && host.parentNode && host.parentNode.getBoundingClientRect ? host.parentNode.getBoundingClientRect() : null;
      var minTop = coach ? coach.bottom + 8 : 56;
      var w = winOf(docOf(el));
      var vh = (w && w.innerHeight) ? w.innerHeight : 800;
      if (r.top < minTop || r.top > vh - 56) return null;
      return { x: r.right - 22, y: r.top - 2, size: 32 };
    }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, size: Math.max(24, Math.min(r.width, r.height)) };
  }

  function stepFlight() {
    flight.raf = 0;
    if (!host || !flight.glider || reducedMotion(host)) { teardownFlight(); return; }
    var home = measureAnchor(host, 'home');
    if (!home) { teardownFlight(); return; }
    var goal = (flight.target && flight.mode !== 'home') ? measureAnchor(flight.target, flight.mode) : null;
    var returning = !goal;
    if (!goal) goal = home;

    var k = 0.14, damp = 0.75;
    flight.vx = (flight.vx + (goal.x - flight.x) * k) * damp;
    flight.vy = (flight.vy + (goal.y - flight.y) * k) * damp;
    flight.vs = (flight.vs + (goal.size - flight.size) * 0.16) * 0.72;
    flight.x += flight.vx;
    flight.y += flight.vy;
    flight.size += flight.vs;

    var speed = Math.sqrt(flight.vx * flight.vx + flight.vy * flight.vy);
    var dist = Math.sqrt((goal.x - flight.x) * (goal.x - flight.x) + (goal.y - flight.y) * (goal.y - flight.y));
    var sizeDiff = Math.abs(goal.size - flight.size);

    // Velocity-aligned squash & stretch
    var stretch = Math.min(0.18, speed * 0.011);
    var scale = flight.size / 44;
    var gx = round2(flight.x - 22), gy = round2(flight.y - 22);
    var angle = speed > 0.4 ? Math.atan2(flight.vy, flight.vx) : 0;
    var deg = round2(angle * 180 / Math.PI);
    flight.glider.style.transform =
      'translate3d(' + gx + 'px,' + gy + 'px,0) ' +
      'rotate(' + deg + 'deg) ' +
      'scale(' + round2(scale * (1 + stretch)) + ',' + round2(scale * (1 - stretch * 0.58)) + ') ' +
      'rotate(' + round2(-deg) + 'deg)';

    // Subtle ember trail when gliding fast
    flight.history.unshift({ x: flight.x, y: flight.y, s: scale });
    if (flight.history.length > 9) flight.history.pop();
    for (var i = 0; i < flight.trails.length; i++) {
      var h = flight.history[(i + 1) * 2];
      var tr = flight.trails[i];
      if (h && speed > 1.6) {
        var op = Math.min(0.32, (speed / 24) * (0.34 - i * 0.09));
        tr.style.opacity = String(round2(op));
        tr.style.transform = 'translate3d(' + round2(h.x - 13) + 'px,' + round2(h.y - 13) + 'px,0) scale(' + round2(h.s * (0.86 - i * 0.14)) + ')';
      } else {
        tr.style.opacity = '0';
      }
    }

    // Settle condition: stop rAF cleanly when landed so idle battery drain is zero
    if (dist < 0.7 && speed < 0.18 && sizeDiff < 0.5) {
      if (returning) {
        teardownFlight();
        return;
      }
      if (flight.mode === 'stage' && flight.target && flight.target.style) {
        flight.target.style.opacity = '';
        if (flight.layer && flight.layer.parentNode) flight.layer.parentNode.removeChild(flight.layer);
        flight.layer = null;
        flight.glider = null;
        flight.trails = [];
        return;
      }
      // Card perch settled: snap crisp & wait for scroll/next move
      flight.glider.style.transform = 'translate3d(' + round2(goal.x - 22) + 'px,' + round2(goal.y - 22) + 'px,0) scale(' + round2(goal.size / 44) + ')';
      for (var j = 0; j < flight.trails.length; j++) flight.trails[j].style.opacity = '0';
      return;
    }

    var w = winOf(flight.doc || docOf(host));
    if (w && typeof w.requestAnimationFrame === 'function') {
      flight.raf = w.requestAnimationFrame(stepFlight);
    }
  }

  function kickFlight() {
    var w = winOf(flight.doc || docOf(host));
    if (!w || typeof w.requestAnimationFrame !== 'function') return;
    if (!flight.raf) flight.raf = w.requestAnimationFrame(stepFlight);
  }

  function bindFlightScroll(doc) {
    if (flight.scrollBound || !doc || !doc.addEventListener) return;
    flight.scrollBound = true;
    var onMove = function () {
      if (!flight.target || flight.mode !== 'card' || !flight.glider) return;
      kickFlight();
    };
    doc.addEventListener('scroll', onMove, true);
    var w = winOf(doc);
    if (w && w.addEventListener) {
      w.addEventListener('resize', onMove);
      w.addEventListener('pagehide', teardownFlight);
    }
  }

  function perch(targetEl, opts) {
    if (!host) return false;
    var doc = docOf(host);
    var w = winOf(doc);
    var canGlide = !!(w && typeof w.requestAnimationFrame === 'function' && doc && doc.body && !reducedMotion(host) && !introState);
    if (!canGlide) {
      teardownFlight();
      return false;
    }

    var mode = (opts && opts.mode) || (targetEl && targetEl.classList && targetEl.classList.contains('shape') ? 'stage' : 'card');
    if (!targetEl || targetEl === host) {
      if (!flight.target && !flight.glider) return false;
      var fromAnchor = (flight.mode === 'stage' && flight.target) ? measureAnchor(flight.target, 'stage') : null;
      if (flight.mode === 'stage' && flight.target && flight.target.style) flight.target.style.opacity = '';
      if (!flight.glider && fromAnchor && ensureFlightLayer(doc)) {
        flight.x = fromAnchor.x; flight.y = fromAnchor.y; flight.size = fromAnchor.size;
        flight.vx = 0; flight.vy = 0; flight.vs = 0;
      }
      flight.target = null;
      flight.mode = 'home';
      if (flight.glider) kickFlight();
      else teardownFlight();
      return true;
    }

    var goal = measureAnchor(targetEl, mode);
    var home = measureAnchor(host, 'home');
    if (!goal || !home) return false;

    if (flight.target && flight.target !== targetEl && flight.mode === 'stage' && flight.target.style) {
      flight.target.style.opacity = '';
    }
    var hadGlider = !!flight.glider;
    if (!ensureFlightLayer(doc)) return false;
    bindFlightScroll(doc);
    if (!hadGlider) {
      flight.x = home.x; flight.y = home.y; flight.size = home.size;
      flight.vx = 0; flight.vy = 0; flight.vs = 0;
      flight.history = [];
    }
    flight.target = targetEl;
    flight.mode = mode;
    host.setAttribute('data-vacant', 'true');
    if (mode === 'stage' && targetEl.style) targetEl.style.opacity = '0';
    syncGliderFromHost();
    kickFlight();
    return true;
  }

  var MOTION_PARTS = ['.dt-anim', '.dt-check', '.dt-oopsdrop'];
  function restartMotion(el) {
    var parts = [];
    for (var i = 0; i < MOTION_PARTS.length; i++) {
      var found = el.querySelector ? el.querySelector(MOTION_PARTS[i]) : null;
      if (found) parts.push(found);
    }
    if (el.querySelectorAll) {
      var sparks = el.querySelectorAll('.dt-spark');
      for (var k = 0; k < sparks.length; k++) parts.push(sparks[k]);
    }
    for (var a = 0; a < parts.length; a++) if (parts[a].style) parts[a].style.animation = 'none';
    if (el.getBoundingClientRect) void el.getBoundingClientRect();
    for (var b = 0; b < parts.length; b++) if (parts[b].style) parts[b].style.animation = '';
  }

  function clearLevel(el) {
    if (!el || !el.hasAttribute || !el.hasAttribute('data-level')) return;
    el.removeAttribute('data-level');
    var b = el.querySelector('.dt-breath'), w1 = el.querySelector('.dt-w1'), w2 = el.querySelector('.dt-w2');
    if (b && b.style) b.style.transform = '';
    if (w1 && w1.style) { w1.style.transform = ''; w1.style.opacity = ''; }
    if (w2 && w2.style) { w2.style.transform = ''; w2.style.opacity = ''; }
  }

  function applyLevel(el, v) {
    if (!el) return clampProgress(v);
    if (v === null || v === undefined) { clearLevel(el); return 0; }
    var x = clampProgress(v);
    el.setAttribute('data-level', String(Math.round(x * 100) / 100));
    var still = reducedMotion(el);
    var b = el.querySelector('.dt-breath'), w1 = el.querySelector('.dt-w1'), w2 = el.querySelector('.dt-w2');
    if (b && b.style) b.style.transform = still ? '' : 'scale(' + round2(1 + 0.045 * x) + ', ' + round2(1 + 0.06 * x) + ')';
    if (w1 && w1.style) {
      w1.style.opacity = String(round2(0.3 + 0.7 * Math.min(1, x * 2)));
      w1.style.transform = still ? '' : 'scale(' + round2(0.94 + 0.18 * x) + ')';
    }
    if (w2 && w2.style) {
      w2.style.opacity = String(round2(x > 0.4 ? 0.3 + 0.7 * (x - 0.4) / 0.6 : 0.15));
      w2.style.transform = still ? '' : 'scale(' + round2(0.92 + 0.24 * x) + ')';
    }
    if (el === host && flight.glider) applyLevel(flight.glider, x);
    return x;
  }

  function squash(el, ms) {
    var shell = el && el.querySelector && el.querySelector('.dt-anim');
    if (!shell || !shell.animate) return;
    while (morphing.length) { var prev = morphing.pop(); if (prev && prev.cancel) prev.cancel(); }
    var anim = shell.animate([
      { transform: 'scale(1, 1)' },
      { transform: 'scale(1.07, .93)', offset: 0.3 },
      { transform: 'scale(.97, 1.03)', offset: 0.65 },
      { transform: 'scale(1, 1)' },
    ], { duration: ms, easing: 'ease-out' });
    if (anim) morphing.push(anim);
  }

  function applyForm(el, form) {
    if (!el) return morphPlan('base', form, true);
    var from = el.getAttribute('data-form') || 'base';
    var plan = morphPlan(from, form, reducedMotion(el));
    if (plan.to === from && el.hasAttribute('data-form')) return plan;
    el.setAttribute('data-form', plan.to);
    if (plan.squash) squash(el, plan.ms);
    if (el === host) syncGliderFromHost();
    return plan;
  }

  var PULSES = {
    nod: [[{ transform: 'translateY(0)' }, { transform: 'translateY(3px) scale(1.02, .97)' }, { transform: 'translateY(0)' }], 240],
    tick: [[{ transform: 'scale(1, 1)' }, { transform: 'scale(1.06, .94)' }, { transform: 'scale(1, 1)' }], 260],
    full: [[
      { transform: 'translateY(0) scale(1, 1)' },
      { transform: 'translateY(0) scale(1.08, .9)', offset: 0.2 },
      { transform: 'translateY(-10px) scale(.95, 1.06)', offset: 0.5 },
      { transform: 'translateY(0) scale(1.04, .96)', offset: 0.8 },
      { transform: 'translateY(0) scale(1, 1)' },
    ], 400],
    no: [[
      { transform: 'translateX(0)' },
      { transform: 'translateX(-2.4px) rotate(-2deg)' },
      { transform: 'translateX(2.2px) rotate(2deg)' },
      { transform: 'translateX(-1.2px)' },
      { transform: 'translateX(0)' },
    ], 320],
  };

  function pulse(kind) {
    var spec = PULSES[kind === 'celebrate' ? 'full' : kind];
    if (!host || !spec) return false;
    clearTimeout(reactionTimer);
    host.removeAttribute('data-reaction');
    if (kind === 'celebrate') {
      host.setAttribute('data-reaction', 'celebrate');
      var target = host;
      reactionTimer = setTimeout(function () {
        target.removeAttribute('data-reaction');
        syncGliderFromHost();
      }, 900);
    }
    syncGliderFromHost();
    while (pulsing.length) { var prev = pulsing.pop(); if (prev && prev.cancel) prev.cancel(); }
    if (reducedMotion(host)) return false;
    var part = host.querySelector && host.querySelector('.dt-pose');
    if (part && part.animate) {
      var anim = part.animate(spec[0], { duration: spec[1], easing: 'ease-out', composite: 'add' });
      if (anim) pulsing.push(anim);
    }
    if (flight.glider) {
      var gPart = flight.glider.querySelector && flight.glider.querySelector('.dt-pose');
      if (gPart && gPart.animate) gPart.animate(spec[0], { duration: spec[1], easing: 'ease-out', composite: 'add' });
    }
    return pulsing.length > 0;
  }

  /* ---------------- intro (FLIP shared-element glide) ---------------- */

  function startIntro(text) {
    var doc = docOf(host);
    if (!host || introState || reducedMotion(host) || !doc || !doc.body) return false;
    teardownFlight();
    var layer = doc.createElement('div');
    layer.className = 'pl-intro';
    layer.setAttribute('aria-hidden', 'true');
    var bg = doc.createElement('div');
    bg.className = 'pl-intro-bg';
    var big = draw(doc.createElement('div'), 'thinking', hostProgress, 'base');
    var line = doc.createElement('p');
    line.className = 'pl-intro-text';
    line.textContent = text || 'Abrindo sua ficha';
    line.appendChild(makeDots(doc));
    layer.appendChild(bg);
    layer.appendChild(big);
    layer.appendChild(line);
    doc.body.appendChild(layer);
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
    (s.animations || []).forEach(function (a) { if (a && a.cancel) a.cancel(); });
    if (host && host.style) host.style.opacity = '';
    if (s.layer.parentNode) s.layer.parentNode.removeChild(s.layer);
  }

  function land() {
    var s = introState;
    if (!s || s.landing) return;
    s.landing = true;
    clearTimeout(s.fallback);
    s.landingTimer = setTimeout(function () {
      if (!host) { finishIntro(s); return; }
      s.big.setAttribute('data-state', host.getAttribute('data-state'));
      s.big.setAttribute('data-form', host.getAttribute('data-form') || 'base');
      paintProgress(s.big, hostProgress);
      var m = flip(s.big.getBoundingClientRect(), host.getBoundingClientRect());
      var done = function () { finishIntro(s); };
      if (!s.big.animate || reducedMotion(host)) { done(); return; }
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

  var ONE_SHOT_STATES = ['happy', 'alert', 'understood', 'oops', 'record'];

  var api = {
    NAME: NAME,
    MOODS: MOODS,
    STATES: STATES,
    FORMS: FORMS,
    FORM_MS: FORM_MS,
    OUT_MS: OUT_MS,
    IN_DELAY: IN_DELAY,
    TICKS: TICKS,
    CSS: CSS,
    clampProgress: clampProgress,
    litTicks: litTicks,
    flip: flip,
    formFor: formFor,
    morphPlan: morphPlan,
    svg: svg,
    iconSvg: iconSvg,
    monoSvg: monoSvg,

    mount: function (el, bubbleText) {
      var doc = docOf(el);
      injectStyle(doc);
      if (introState) finishIntro(introState);
      teardownFlight();
      clearTimeout(reactionTimer);
      cancelActiveAnimations();
      lastText = '';
      var initialState = el.getAttribute('data-state') || 'idle';
      var initialForm = el.getAttribute('data-form') || 'base';
      host = draw(el, initialState, hostProgress, initialForm);
      if (host.tagName === 'BUTTON') {
        var label = host.getAttribute('aria-label');
        if (label && /: /.test(label)) {
          host.setAttribute('aria-label', NAME + ': ' + label.replace(/^[^:]+:\s*/, ''));
        }
      }
      textEl = bubbleText || null;
      dots = null;
      if (textEl && doc) {
        dots = makeDots(doc);
        textEl.appendChild(dots);
      }
      var parent = host.parentNode;
      bar = null;
      if (parent && doc) {
        var existingName = parent.querySelector ? parent.querySelector('.bubble-name') : null;
        if (existingName) existingName.textContent = NAME;
        var existingBar = parent.querySelector ? parent.querySelector('.pl-bar') : null;
        if (existingBar) {
          bar = existingBar;
        } else {
          bar = doc.createElement('div');
          bar.className = 'pl-bar';
          bar.setAttribute('aria-hidden', 'true');
          bar.appendChild(doc.createElement('i'));
          if (parent.insertBefore) parent.insertBefore(bar, parent.firstChild);
          else parent.appendChild(bar);
        }
      }
      paintBar();
      return host;
    },

    setMood: function (mood) {
      if (!host || STATES.indexOf(mood) < 0) return;
      if (mood !== 'listening') clearLevel(host);
      var current = host.getAttribute('data-state');
      if (current === mood) {
        if (ONE_SHOT_STATES.indexOf(mood) >= 0) restartMotion(host);
        return;
      }
      host.setAttribute('data-state', mood);
      restartMotion(host);
      paintBar();
      syncGliderFromHost();
    },

    mood: function () { return host ? host.getAttribute('data-state') : null; },

    setForm: function (formOrEl, maybeForm) {
      if (formOrEl && typeof formOrEl === 'object' && formOrEl.setAttribute) {
        return applyForm(formOrEl, maybeForm);
      }
      return applyForm(host, formOrEl);
    },

    form: function () { return host ? (host.getAttribute('data-form') || 'base') : null; },

    setLevel: function (levelOrEl, maybeLevel) {
      if (levelOrEl && typeof levelOrEl === 'object' && levelOrEl.setAttribute) {
        return applyLevel(levelOrEl, maybeLevel);
      }
      return applyLevel(host, levelOrEl);
    },

    setProgress: function (p) {
      var v = clampProgress(p);
      if (v === hostProgress && host && host.hasAttribute('data-progress')) return v;
      var gained = litTicks(v) > litTicks(hostProgress);
      hostProgress = v;
      if (host) paintProgress(host, v);
      paintBar();
      syncGliderFromHost();
      if (gained) pulse(v === 1 ? 'full' : 'tick');
      return v;
    },

    progress: function () { return hostProgress; },

    pulse: pulse,

    perch: perch,

    glance: function (field) {
      if (!host || !host.querySelector) return;
      var gaze = host.querySelector('.dt-gaze');
      if (!gaze || !gaze.style) return;
      var x = 0, y = 0;
      if (field && field.getBoundingClientRect && !reducedMotion(host)) {
        var from = host.getBoundingClientRect(), to = field.getBoundingClientRect();
        var dx = to.left + to.width / 2 - from.left - from.width / 2;
        var dy = to.top + to.height / 2 - from.top - from.height / 2;
        var length = Math.sqrt(dx * dx + dy * dy);
        if (length > 0) {
          x = Math.round(dx / length * 3 * 100) / 100;
          y = Math.round(dy / length * 3 * 100) / 100;
        }
      }
      var tf = 'translate(' + x + 'px, ' + y + 'px)';
      gaze.style.transform = tf;
      if (flight.glider && flight.glider.querySelector) {
        var gg = flight.glider.querySelector('.dt-gaze');
        if (gg && gg.style) gg.style.transform = tf;
      }
    },

    setDozing: function (value) {
      if (!host) return;
      host.setAttribute('data-dozing', String(!!value));
      if (value) {
        api.glance(null);
        perch(null);
      }
      syncGliderFromHost();
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

    create: function (mood, progressOrForm, maybeForm) {
      var doc = typeof document !== 'undefined' ? document : docOf(host);
      injectStyle(doc);
      var defaultProgress = (mood === 'happy' || mood === 'understood' || mood === 'record') ? 1 : 0;
      var p, f;
      if (typeof progressOrForm === 'string' && FORMS.indexOf(progressOrForm) >= 0) {
        f = progressOrForm;
        p = defaultProgress;
      } else if (progressOrForm && typeof progressOrForm === 'object') {
        p = progressOrForm.progress === undefined ? defaultProgress : progressOrForm.progress;
        f = progressOrForm.form;
      } else {
        p = progressOrForm === undefined ? defaultProgress : progressOrForm;
        f = maybeForm;
      }
      return draw(doc.createElement('div'), mood, p, f);
    },
  };

  root.ShapeAvatar = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
