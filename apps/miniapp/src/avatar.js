/**
 * Muscle, the coach avatar: ONE swappable component. Everything about the artwork lives here:
 * the SVG, its coral speech-bubble silhouette, expressions, context forms, voice waves, top
 * progress bar and first-open intro. Classic script; exposes browser global `ShapeAvatar`
 * (and `module.exports` under Node for unit tests).
 *
 * Muscle is a warm coral squircle speech-bubble (`k = 0.82`) with an animated tail-foot, capsule
 * eyes with glints, expressive mouths/cheeks, context forms (`base`, `treino`, `refeicao`, `agua`,
 * `revisao`, `descanso`) and rich voice/celebration states (`listening`, `understood`, `oops`,
 * `record`, `dozing`). Motion uses `transform` and `opacity` only and stops completely under
 * `prefers-reduced-motion: reduce` or `data-motion="off"`.
 *
 * API
 *   ShapeAvatar.NAME                     'Muscle' (single source of truth for the mascot name)
 *   ShapeAvatar.MOODS                    ['idle', 'focused', 'happy', 'alert', 'thinking']
 *   ShapeAvatar.STATES                   MOODS + ['listening', 'understood', 'oops', 'record', 'dozing']
 *   ShapeAvatar.FORMS                    ['base', 'treino', 'refeicao', 'agua', 'revisao', 'descanso']
 *   ShapeAvatar.FORM_MS                  340 (morph duration in ms; OUT_MS = 140, IN_DELAY = 90)
 *   ShapeAvatar.TICKS                    12 (logical progress steps for pulse feedback)
 *   ShapeAvatar.mount(host, bubbleText)  draw into `host` (header avatar), bind speech-bubble text,
 *                                        sync `.bubble-name` / button label, and insert `.pl-bar`
 *   ShapeAvatar.setMood(state)           switch the header avatar's mood/state (`MOODS` or `STATES`)
 *   ShapeAvatar.mood()                   the header avatar's current state (`data-state`)
 *   ShapeAvatar.setForm(form)            morph the avatar's context form (340 ms, instant if reduced)
 *   ShapeAvatar.form()                   the header avatar's current form (`data-form`)
 *   ShapeAvatar.setLevel(v)              voice input level in 0..1 while `listening`
 *   ShapeAvatar.setProgress(p)           fill the top bar (`0..1`, clamped; junk reads as 0)
 *   ShapeAvatar.progress()               current progress value (`0..1`)
 *   ShapeAvatar.pulse(kind)              one-shot reaction preserving mood: 'nod', 'tick', 'full',
 *                                        'no', 'celebrate' (returns false when not animated)
 *   ShapeAvatar.say(text)                replace the speech-bubble text (with a short fade)
 *   ShapeAvatar.glance(fieldOrNull)      shift gaze up to 3 SVG units toward field (0 if reduced)
 *   ShapeAvatar.setDozing(bool)          closed eyes, zz and slow breathing; preserves current mood
 *   ShapeAvatar.dozing()                 whether the header avatar is dozing
 *   ShapeAvatar.intro(text)              first-open centred avatar that FLIP-glides into the header
 *   ShapeAvatar.create(mood, prog, form) independent decorative avatar element (`aria-hidden="true"`)
 *   ShapeAvatar.clampProgress(p)         pure: `p` clamped to `0..1`
 *   ShapeAvatar.litTicks(p, n)           pure: how many of `n` steps are lit for `p`
 *   ShapeAvatar.flip(from, to)           pure: centre-to-centre translate/scale from `from` to `to`
 *   ShapeAvatar.formFor(ctx)             pure: context `{ view, screen, dozing, intro }` -> form
 *   ShapeAvatar.morphPlan(from, to, red) pure: `{ to, ms, squash }` plan for a form transition
 */
(function (root) {
  'use strict';

  var NAME = 'Muscle';
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

  /* ---------------- artwork geometry (100-unit grid) ---------------- */

  var GRID = { cx: 52, cy: 44, rx: 38, ry: 30.5, k: 0.82 };
  function squircle(cx, cy, rx, ry, k) {
    var f = function (n) { return Math.round(n * 100) / 100; };
    var kx = rx * k, ky = ry * k;
    return 'M' + f(cx) + ' ' + f(cy - ry) +
      'C' + f(cx + kx) + ' ' + f(cy - ry) + ' ' + f(cx + rx) + ' ' + f(cy - ky) + ' ' + f(cx + rx) + ' ' + f(cy) +
      'C' + f(cx + rx) + ' ' + f(cy + ky) + ' ' + f(cx + kx) + ' ' + f(cy + ry) + ' ' + f(cx) + ' ' + f(cy + ry) +
      'C' + f(cx - kx) + ' ' + f(cy + ry) + ' ' + f(cx - rx) + ' ' + f(cy + ky) + ' ' + f(cx - rx) + ' ' + f(cy) +
      'C' + f(cx - rx) + ' ' + f(cy - ky) + ' ' + f(cx - kx) + ' ' + f(cy - ry) + ' ' + f(cx) + ' ' + f(cy - ry) + 'Z';
  }
  var BODY = squircle(GRID.cx, GRID.cy, GRID.rx, GRID.ry, GRID.k);
  var FOOT = 'M27 60C29.6 71 27.6 79.6 21.6 85.2C16.8 89.4 18 93.4 23.6 93.1C34.6 92.5 42.6 84.6 47 69.5Z';
  var EYE_L = 41, EYE_R = 63, EYE_Y = 42;

  function pills(dx, dy, ry) {
    var h = ry || 7.6;
    return '<g class="dt-eyes">' +
      '<ellipse class="dt-ink" cx="' + (EYE_L + dx) + '" cy="' + (EYE_Y + dy) + '" rx="5.2" ry="' + h + '"/>' +
      '<ellipse class="dt-ink" cx="' + (EYE_R + dx) + '" cy="' + (EYE_Y + dy) + '" rx="5.2" ry="' + h + '"/>' +
      '<circle class="dt-glint" cx="' + (EYE_L + dx + 1.7) + '" cy="' + (EYE_Y + dy - h * 0.42) + '" r="1.9"/>' +
      '<circle class="dt-glint" cx="' + (EYE_R + dx + 1.7) + '" cy="' + (EYE_Y + dy - h * 0.42) + '" r="1.9"/>' +
      '</g>';
  }
  function rounds(dx, dy, r) {
    return '<g class="dt-eyes">' +
      '<circle class="dt-ink" cx="' + (EYE_L + dx) + '" cy="' + (EYE_Y + dy) + '" r="' + r + '"/>' +
      '<circle class="dt-ink" cx="' + (EYE_R + dx) + '" cy="' + (EYE_Y + dy) + '" r="' + r + '"/>' +
      '<circle class="dt-glint" cx="' + (EYE_L + dx + 2.1) + '" cy="' + (EYE_Y + dy - 2.3) + '" r="2.1"/>' +
      '<circle class="dt-glint" cx="' + (EYE_R + dx + 2.1) + '" cy="' + (EYE_Y + dy - 2.3) + '" r="2.1"/>' +
      '</g>';
  }
  var ARCS = '<path class="dt-stroke" stroke-width="4.4" d="M35.6 45Q41 37.4 46.4 45M57.6 45Q63 37.4 68.4 45"/>';
  var SMILE = '<path class="dt-stroke" stroke-width="3.6" d="M47 55Q52 59.4 57 55"/>';

  var FACES = {
    idle: pills(0, 0) + '<g class="dt-mouth">' + SMILE + '</g>',
    focused: pills(0, 1, 5.4) + '<g class="dt-mouth"><path class="dt-stroke" stroke-width="3.6" d="M48 57H56"/></g>',
    happy: ARCS + '<g class="dt-mouth"><path class="dt-ink" d="M45 52.6H59Q59 63 52 63Q45 63 45 52.6Z"/>' +
      '<path class="dt-tongue" d="M48.4 60.2Q52 57.2 55.6 60.2Q54 62.8 52 62.8Q50 62.8 48.4 60.2Z"/></g>',
    alert: rounds(0, 0.5, 6.4) + '<g class="dt-mouth"><ellipse class="dt-ink" cx="52" cy="58" rx="2.9" ry="3.5"/></g>',
    thinking: pills(-2.4, -3) + '<g class="dt-mouth dt-typing">' +
      '<circle class="dt-ink dt-dot" cx="45" cy="57" r="3.2"/><circle class="dt-ink dt-dot" cx="52" cy="57" r="3.2"/>' +
      '<circle class="dt-ink dt-dot" cx="59" cy="57" r="3.2"/></g>',
    listening: rounds(1.6, -0.5, 6.2) + '<g class="dt-mouth"><path class="dt-stroke" stroke-width="3.4" d="M49 56.6Q52 58.6 55 56.6"/></g>',
    understood: '<path class="dt-stroke" stroke-width="4.8" d="M35.6 44.2Q41 37.8 46.4 44.2M57.6 44.2Q63 37.8 68.4 44.2"/>' +
      '<g class="dt-mouth dt-check"><path class="dt-stroke" stroke-width="4" d="M45.6 55.2L50.2 59.6L59 50.6"/></g>',
    oops: '<g class="dt-eyes"><path class="dt-stroke" stroke-width="4.2" d="M36.4 38.8L45 42.4L36.4 46"/>' +
      '<ellipse class="dt-ink" cx="63" cy="42" rx="5.2" ry="7.6"/><circle class="dt-glint" cx="64.7" cy="38.8" r="1.9"/></g>' +
      '<g class="dt-mouth"><path class="dt-stroke" stroke-width="3.6" d="M46.5 57.4Q53 60.2 58.4 54.6"/></g>',
    record: ARCS + '<g class="dt-mouth"><path class="dt-ink" d="M44 52H60Q60 65 52 65Q44 65 44 52Z"/>' +
      '<path class="dt-tongue" d="M47.8 61.6Q52 58 56.2 61.6Q54.4 64.8 52 64.8Q49.6 64.8 47.8 61.6Z"/></g>',
    dozing: '<path class="dt-stroke" stroke-width="3.8" d="M36 44Q41 47.8 46 44M58 44Q63 47.8 68 44"/>' +
      '<g class="dt-mouth"><path class="dt-stroke" stroke-width="3.2" d="M50 57Q52 58.6 54 57"/></g>',
  };

  var spark = function (x, y, r, i) {
    return '<path class="dt-spark dt-sp' + i + '" d="M' + x + ' ' + (y - r) + 'Q' + x + ' ' + y + ' ' + (x + r) + ' ' + y +
      'Q' + x + ' ' + y + ' ' + x + ' ' + (y + r) + 'Q' + x + ' ' + y + ' ' + (x - r) + ' ' + y + 'Q' + x + ' ' + y + ' ' + x + ' ' + (y - r) + 'Z"/>';
  };
  var DROP = 'M0 -6.4C4.4 -1.2 4.8 3.8 0 4.6C-4.8 3.8 -4.4 -1.2 0 -6.4Z';
  var FRONT =
    '<g class="dt-waves"><path class="dt-line dt-w1" stroke-width="3.6" d="M93 36Q97 44 93 52"/>' +
    '<path class="dt-line dt-w2" stroke-width="3.6" d="M98.4 30.5Q104.6 44 98.4 57.5"/></g>' +
    '<g class="dt-sparks">' + spark(12, 14, 6, 1) + spark(92, 10, 5, 2) + spark(97, 58, 3.6, 3) + '</g>' +
    '<g class="dt-zz"><path class="dt-line" stroke-width="3" d="M80 13h6.4l-6.4 7.2h6.4"/><path class="dt-line" stroke-width="2.5" d="M90 5h4.6l-4.6 5.2h4.6"/></g>' +
    '<g class="dt-oopsdrop"><path class="dt-water" transform="translate(88 18)" d="' + DROP + '"/></g>' +
    '<g class="pf-part pf-treino"><path class="dt-water" transform="translate(89 17) scale(1.1)" d="' + DROP + '"/>' +
    '<path class="dt-line" stroke-width="3.2" d="M3 34h7M1 44h9M4 54h6"/></g>';

  function svg(id) {
    var cb = 'dt-cb-' + id, cf = 'dt-cf-' + id, gs = 'dt-gs-' + id, gl = 'dt-gl-' + id;
    return '<svg class="dt-svg" viewBox="0 0 100 100" focusable="false" aria-hidden="true">' +
      '<defs><clipPath id="' + cb + '"><path d="' + BODY + '"/></clipPath><clipPath id="' + cf + '"><path d="' + FOOT + '"/></clipPath>' +
        '<linearGradient id="' + gs + '" x1="0" y1="0" x2="0" y2="1"><stop offset=".5" class="dt-gs0"/><stop offset="1" class="dt-gs1"/></linearGradient>' +
        '<radialGradient id="' + gl + '" cx=".22" cy=".06" r=".75"><stop offset="0" class="dt-gl0"/><stop offset="1" class="dt-gl1"/></radialGradient>' +
      '</defs>' +
      '<ellipse class="dt-ground" cx="47" cy="95.4" rx="27" ry="2.8"/>' +
      '<g class="pf-shell"><g class="dt-pose"><g class="dt-anim"><g class="dt-breath">' +
        '<g class="dt-footpose"><g class="dt-foot"><path class="dt-skin" d="' + FOOT + '"/>' +
          '<g clip-path="url(#' + cf + ')"><rect x="10" y="58" width="40" height="38" fill="url(#' + gs + ')"/>' +
          '<g class="pf-part pf-agua dt-waterbox"><rect class="dt-water" x="10" y="54" width="40" height="44"/></g></g>' +
        '</g></g>' +
        '<path class="dt-skin" d="' + BODY + '"/>' +
        '<g clip-path="url(#' + cb + ')">' +
          '<rect x="14" y="13.5" width="76" height="61" fill="url(#' + gs + ')"/>' +
          '<rect x="14" y="13.5" width="76" height="61" fill="url(#' + gl + ')"/>' +
          '<g class="pf-part pf-agua dt-waterbox"><g class="dt-wave">' +
            '<path class="dt-water2" d="M-60 58Q-47.5 53 -35 58T-10 58T15 58T40 58T65 58T90 58T115 58T140 58T165 58V100H-60Z"/>' +
            '<path class="dt-water" d="M-60 62Q-47.5 57.5 -35 62T-10 62T15 62T40 62T65 62T90 62T115 62T140 62T165 62V100H-60Z"/>' +
          '</g><circle class="dt-bubble b1" cx="34" cy="70" r="1.8"/><circle class="dt-bubble b2" cx="70" cy="67" r="1.4"/></g>' +
        '</g>' +
        '<g class="dt-cheeks"><ellipse cx="30.5" cy="53" rx="5" ry="3.3"/><ellipse cx="73.5" cy="53" rx="5" ry="3.3"/></g>' +
        '<g class="dt-scan"><g class="dt-gaze">' +
          STATES.map(function (s) { return '<g class="dt-f f-' + s + '">' + FACES[s] + '</g>'; }).join('') +
        '</g></g>' +
      '</g></g></g>' +
      FRONT +
      '</g></svg>';
  }

  function iconSvg(variant) {
    var coral = variant === 'coral';
    var bg = coral ? '#F45A3B' : '#2A1914';
    var skin = coral ? '#FFFBF7' : '#F45A3B';
    var ink = '#2A1914';
    var t = 'translate(10.5 9) scale(.79)';
    return '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
      '<rect width="100" height="100" fill="' + bg + '"/>' +
      '<g transform="' + t + '"><path fill="' + skin + '" d="' + FOOT + '"/><path fill="' + skin + '" d="' + BODY + '"/>' +
      '<ellipse fill="' + ink + '" cx="41" cy="42" rx="5.6" ry="8"/><ellipse fill="' + ink + '" cx="63" cy="42" rx="5.6" ry="8"/>' +
      '<circle fill="#FFFBF7" cx="42.8" cy="38.6" r="1.9"/><circle fill="#FFFBF7" cx="64.8" cy="38.6" r="1.9"/>' +
      '<path fill="none" stroke="' + ink + '" stroke-width="3.8" stroke-linecap="round" d="M47 55Q52 59.4 57 55"/></g></svg>';
  }

  function monoSvg() {
    var m = 'dt-mono-' + (++uid);
    return '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><mask id="' + m + '">' +
      '<rect x="-10" y="-10" width="120" height="120" fill="#fff"/>' +
      '<ellipse cx="41" cy="42" rx="5.6" ry="8"/><ellipse cx="63" cy="42" rx="5.6" ry="8"/>' +
      '<path fill="none" stroke="#000" stroke-width="3.8" stroke-linecap="round" d="M47 55Q52 59.4 57 55"/></mask></defs>' +
      '<g mask="url(#' + m + ')" fill="currentColor" transform="translate(2 2) scale(.96)"><path d="' + FOOT + '"/><path d="' + BODY + '"/></g></svg>';
  }

  /* ---------------- CSS ---------------- */

  var EASE_POP = 'cubic-bezier(0.34, 1.4, 0.5, 1)';
  var CSS = ':root {\n' +
    '  --dt-skin: #F45A3B; --dt-shade: #D9432A; --dt-light: #FFFFFF; --dt-ink: #2A1914; --dt-glint: #FFFBF7;\n' +
    '  --dt-cheek: #FF9A7E; --dt-tongue: #FF8C78; --dt-water: #2F95E8; --dt-water2: #7CC0F5;\n' +
    '  --dt-line: #2A1914; --dt-spark: #FFB224; --dt-ground: #2A1914;\n' +
    '  --pl-focused: #F45A3B; --pl-happy: #22a355; --pl-alert: #f59e0b; --pl-bar-track: rgba(28, 25, 23, 0.1);\n' +
    '}\n' +
    ':root[data-scheme="dark"] {\n' +
    '  --dt-skin: #FF7B5F; --dt-shade: #EA5D41; --dt-cheek: #FFB29F; --dt-tongue: #FF9B88;\n' +
    '  --dt-water: #4BA9F5; --dt-water2: #8FCBF8; --dt-line: #F2EDE8; --dt-ground: #000000;\n' +
    '  --pl-focused: #FF7B5F; --pl-happy: #4ade80; --pl-alert: #fbbf24; --pl-bar-track: rgba(255, 255, 255, 0.1);\n' +
    '}\n' +
    '.shape .dt-svg { display: block; width: 100%; height: 100%; overflow: visible; }\n' +
    '.shape .dt-svg * { transform-box: view-box; }\n' +
    '.dt-skin { fill: var(--dt-skin); }\n' +
    '.dt-gs0 { stop-color: var(--dt-shade); stop-opacity: 0; } .dt-gs1 { stop-color: var(--dt-shade); stop-opacity: .7; }\n' +
    '.dt-gl0 { stop-color: var(--dt-light); stop-opacity: .24; } .dt-gl1 { stop-color: var(--dt-light); stop-opacity: 0; }\n' +
    '.dt-ink { fill: var(--dt-ink); }\n' +
    '.dt-glint { fill: var(--dt-glint); }\n' +
    '.dt-tongue { fill: var(--dt-tongue); }\n' +
    '.dt-stroke { fill: none; stroke: var(--dt-ink); stroke-linecap: round; stroke-linejoin: round; }\n' +
    '.dt-line { fill: none; stroke: var(--dt-line); stroke-linecap: round; stroke-linejoin: round; }\n' +
    '.dt-water { fill: var(--dt-water); } .dt-water2 { fill: var(--dt-water2); }\n' +
    '.dt-bubble { fill: var(--dt-glint); opacity: .7; }\n' +
    '.dt-spark { fill: var(--dt-spark); }\n' +
    '.dt-ground { fill: var(--dt-ground); opacity: .1; }\n' +
    '.dt-cheeks ellipse { fill: var(--dt-cheek); }\n' +
    '.dt-pose, .dt-anim, .dt-breath { transform-origin: 47px 92px; }\n' +
    '.dt-footpose, .dt-foot { transform-origin: 37px 68px; }\n' +
    '.dt-eyes { transform-origin: 52px 42px; }\n' +
    '.dt-mouth { transform-origin: 52px 56px; }\n' +
    '.dt-cheeks { transform-origin: 52px 53px; opacity: 0; transition: opacity 200ms ease-out, transform ' + FORM_MS + 'ms ' + EASE_POP + '; }\n' +
    '.dt-gaze, .dt-scan { transition: transform 220ms ease-out; }\n' +
    '.dt-pose { transition: transform 260ms ' + EASE_POP + '; }\n' +
    '.dt-breath { transition: transform 90ms linear; }\n' +
    '.dt-ground { transform-origin: 47px 95px; transition: transform 260ms ease-out, opacity 260ms ease-out; }\n' +
    /* face cross-fade */
    '.shape .dt-f { opacity: 0; transition: opacity 140ms ease-out; }\n' +
    '.shape[data-state="idle"] .f-idle, .shape[data-state="focused"] .f-focused, .shape[data-state="happy"] .f-happy,\n' +
    '.shape[data-state="alert"] .f-alert, .shape[data-state="thinking"] .f-thinking, .shape[data-state="listening"] .f-listening,\n' +
    '.shape[data-state="understood"] .f-understood, .shape[data-state="oops"] .f-oops, .shape[data-state="record"] .f-record,\n' +
    '.shape[data-state="dozing"] .f-dozing { opacity: 1; }\n' +
    '.shape[data-state][data-reaction="celebrate"] .dt-f { opacity: 0; }\n' +
    '.shape[data-state][data-reaction="celebrate"] .f-record { opacity: 1; }\n' +
    '.shape[data-dozing="true"] .dt-f { opacity: 0; }\n' +
    '.shape[data-dozing="true"] .dt-f.f-dozing { opacity: 1; }\n' +
    /* static poses per state */
    '.shape[data-state="focused"] .dt-pose { transform: rotate(-2.5deg); }\n' +
    '.shape[data-state="alert"] .dt-pose { transform: rotate(3deg) translateY(-1px); }\n' +
    '.shape[data-state="listening"] .dt-pose { transform: rotate(5deg); }\n' +
    '.shape[data-state="oops"] .dt-pose { transform: rotate(-5deg); }\n' +
    '.shape[data-state="dozing"] .dt-pose, .shape[data-dozing="true"] .dt-pose { transform: rotate(-4deg) translateY(1.5px); }\n' +
    '.shape[data-state="happy"] .dt-cheeks, .shape[data-state="understood"] .dt-cheeks,\n' +
    '.shape[data-state="record"] .dt-cheeks, .shape[data-state="oops"] .dt-cheeks,\n' +
    '.shape[data-state][data-reaction="celebrate"] .dt-cheeks { opacity: .85; }\n' +
    /* front decorations (opacity + transform only) */
    '.dt-waves, .dt-sparks, .dt-zz, .dt-oopsdrop { opacity: 0; transition: opacity 160ms ease-out; }\n' +
    '.dt-waves path { transform-origin: 88px 44px; }\n' +
    '.shape[data-state="listening"] .dt-waves { opacity: 1; }\n' +
    '.shape[data-state="record"] .dt-sparks, .shape[data-state][data-reaction="celebrate"] .dt-sparks { opacity: 1; }\n' +
    '.shape[data-state="dozing"] .dt-zz, .shape[data-dozing="true"] .dt-zz { opacity: 1; }\n' +
    '.shape[data-state="oops"] .dt-oopsdrop { opacity: 1; }\n' +
    '.shape[data-dozing="true"] .dt-waves, .shape[data-dozing="true"] .dt-sparks { opacity: 0; }\n' +
    /* context forms */
    '.shape .pf-shell { transform-origin: 47px 92px; transition: transform ' + FORM_MS + 'ms ' + EASE_POP + '; }\n' +
    '.shape[data-form="treino"] .pf-shell { transform: scale(1.03, .95); }\n' +
    '.shape[data-form="treino"] .dt-cheeks { opacity: .9; }\n' +
    '.shape[data-form="refeicao"] .dt-cheeks { opacity: 1; transform: scale(1.12, 1.2); }\n' +
    '.shape[data-form="agua"] .dt-cheeks { opacity: 0; }\n' +
    '.shape[data-form="revisao"] .pf-shell { transform: rotate(3deg); }\n' +
    '.shape[data-form="descanso"] .pf-shell { transform: rotate(-9deg) translate(2px, 3px); }\n' +
    '.shape[data-form="descanso"] .dt-footpose { transform: rotate(38deg); }\n' +
    '.dt-footpose { transition: transform ' + FORM_MS + 'ms ' + EASE_POP + '; }\n' +
    '.shape .pf-part { opacity: 0; transition: opacity ' + OUT_MS + 'ms ease-in, transform ' + OUT_MS + 'ms ease-in; }\n' +
    '.shape .pf-treino { transform-origin: 50px 40px; transform: scale(.6); }\n' +
    '.shape .dt-waterbox { transform: translateY(46px); }\n' +
    '.shape[data-form="treino"] .pf-treino, .shape[data-form="agua"] .pf-agua {\n' +
    '  opacity: 1; transform: none;\n' +
    '  transition: opacity ' + Math.round(IN_MS * 0.6) + 'ms ease-out ' + IN_DELAY + 'ms, transform ' + IN_MS + 'ms ' + EASE_POP + ' ' + IN_DELAY + 'ms;\n' +
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
    /* first-open intro: Muscle large and centred, then it glides into the header */
    '.pl-intro {\n' +
    '  position: fixed; inset: 0; z-index: 60; pointer-events: none;\n' +
    '  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px;\n' +
    '  padding-bottom: 14vh;\n' +
    '}\n' +
    '.pl-intro-bg { position: absolute; inset: 0; background: var(--bg, #f5f4f1); }\n' +
    '.pl-intro .shape { position: relative; flex: none; width: 112px; height: 112px; margin: 0; }\n' +
    '.pl-intro-text { position: relative; margin: 0; color: var(--hint, #635d58); font-size: 15px; }\n' +
    /* animations (transform + opacity only) */
    '@media (prefers-reduced-motion: no-preference) {\n' +
    '  .shape:not([data-motion="off"]) .dt-anim { animation: dt-breathe 4.6s ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"]) .dt-eyes { animation: dt-blink 5s linear infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="focused"] .dt-eyes { animation-duration: 6.5s; }\n' +
    '  .shape:not([data-motion="off"])[data-state="happy"] .dt-anim { animation: dt-pop 320ms ' + EASE_POP + ' 1, dt-breathe 4.6s ease-in-out 320ms infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="alert"] .dt-anim { animation: dt-startle 300ms ease-out 1; }\n' +
    '  .shape:not([data-motion="off"])[data-state="understood"] .dt-anim { animation: dt-hop 380ms ease-out 1; }\n' +
    '  .shape:not([data-motion="off"])[data-state="understood"] .dt-check { animation: dt-checkin 300ms ' + EASE_POP + ' 80ms 1 both; }\n' +
    '  .shape:not([data-motion="off"])[data-state="record"] .dt-anim { animation: dt-bighop 400ms ease-out 1, dt-breathe 4.6s ease-in-out 400ms infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="record"] .dt-spark { transform-box: fill-box; transform-origin: center; animation: dt-sparkin 360ms ' + EASE_POP + ' 1 both, dt-twinkle 1.6s ease-in-out 360ms infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="record"] .dt-sp2 { animation-delay: 60ms, 420ms; }\n' +
    '  .shape:not([data-motion="off"])[data-state="record"] .dt-sp3 { animation-delay: 120ms, 480ms; }\n' +
    '  .shape:not([data-motion="off"])[data-state="oops"] .dt-anim { animation: dt-shrug 360ms ease-out 1; }\n' +
    '  .shape:not([data-motion="off"])[data-state="oops"] .dt-oopsdrop { animation: dt-dropin 400ms ease-out 1 both; }\n' +
    '  .shape:not([data-motion="off"])[data-state="thinking"] .dt-dot { transform-box: fill-box; transform-origin: center; animation: dt-type 1.05s ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="thinking"] .dt-dot:nth-child(2) { animation-delay: .15s; }\n' +
    '  .shape:not([data-motion="off"])[data-state="thinking"] .dt-dot:nth-child(3) { animation-delay: .3s; }\n' +
    '  .shape:not([data-motion="off"])[data-state="thinking"] .dt-foot { animation: dt-tap 1.05s ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="listening"]:not([data-level]) .dt-w1 { animation: dt-wave 900ms ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="listening"]:not([data-level]) .dt-w2 { animation: dt-wave 900ms ease-in-out 150ms infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="dozing"] .dt-anim, .shape:not([data-motion="off"])[data-dozing="true"] .dt-anim { animation: dt-sleep 6s ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-state="dozing"] .dt-zz, .shape:not([data-motion="off"])[data-dozing="true"] .dt-zz { animation: dt-zz 2.6s ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-form="agua"] .dt-wave { animation: dt-flow 2.4s linear infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-form="agua"] .dt-bubble { transform-box: fill-box; animation: dt-rise 2.2s ease-in infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-form="agua"] .dt-bubble.b2 { animation-delay: 1.1s; }\n' +
    '  .shape:not([data-motion="off"])[data-form="refeicao"] .dt-mouth { animation: dt-chew 700ms ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-form="revisao"] .dt-scan { animation: dt-scan 2.2s ease-in-out infinite; }\n' +
    '  .shape:not([data-motion="off"])[data-form="descanso"] .dt-anim { animation: dt-sleep 6s ease-in-out infinite; }\n' +
    '}\n' +
    '@keyframes dt-breathe { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.012, 1.022); } }\n' +
    '@keyframes dt-blink { 0%, 96.4%, 100% { transform: scaleY(1); } 97.9% { transform: scaleY(.1); } }\n' +
    '@keyframes dt-pop { 0% { transform: scale(1, 1); } 40% { transform: scale(1.07, .93); } 100% { transform: scale(1, 1); } }\n' +
    '@keyframes dt-startle { 0% { transform: translateY(0); } 35% { transform: translateY(-4px) scale(.97, 1.04); } 100% { transform: translateY(0); } }\n' +
    '@keyframes dt-hop { 0% { transform: translateY(0) scale(1, 1); } 22% { transform: translateY(0) scale(1.06, .92); }\n' +
    '  55% { transform: translateY(-7px) scale(.97, 1.04); } 82% { transform: translateY(0) scale(1.04, .96); } 100% { transform: translateY(0) scale(1, 1); } }\n' +
    '@keyframes dt-bighop { 0% { transform: translateY(0) scale(1, 1); } 20% { transform: translateY(0) scale(1.08, .9); }\n' +
    '  50% { transform: translateY(-11px) scale(.95, 1.06) rotate(-3deg); } 80% { transform: translateY(0) scale(1.05, .95); } 100% { transform: scale(1, 1); } }\n' +
    '@keyframes dt-checkin { 0% { opacity: 0; transform: scale(.3); } 100% { opacity: 1; transform: scale(1); } }\n' +
    '@keyframes dt-sparkin { 0% { opacity: 0; transform: scale(0) rotate(-40deg); } 100% { opacity: 1; transform: scale(1) rotate(0); } }\n' +
    '@keyframes dt-twinkle { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(.7); opacity: .6; } }\n' +
    '@keyframes dt-shrug { 0% { transform: translateY(0); } 40% { transform: translateY(-2px) scale(1.03, .97); } 100% { transform: translateY(0); } }\n' +
    '@keyframes dt-dropin { 0% { opacity: 0; transform: translateY(-5px); } 100% { opacity: 1; transform: translateY(0); } }\n' +
    '@keyframes dt-type { 0%, 60%, 100% { transform: translateY(0); opacity: .45; } 30% { transform: translateY(-2.4px); opacity: 1; } }\n' +
    '@keyframes dt-tap { 0%, 55%, 100% { transform: rotate(0); } 25% { transform: rotate(-9deg); } }\n' +
    '@keyframes dt-wave { 0%, 100% { opacity: .35; transform: scale(.92); } 50% { opacity: 1; transform: scale(1.06); } }\n' +
    '@keyframes dt-sleep { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.02, 1.045); } }\n' +
    '@keyframes dt-zz { 0% { opacity: 0; transform: translate(-2px, 4px); } 30%, 70% { opacity: 1; } 100% { opacity: 0; transform: translate(2px, -4px); } }\n' +
    '@keyframes dt-flow { from { transform: translateX(0); } to { transform: translateX(-50px); } }\n' +
    '@keyframes dt-rise { 0% { opacity: 0; transform: translateY(0); } 25% { opacity: .8; } 100% { opacity: 0; transform: translateY(-14px); } }\n' +
    '@keyframes dt-chew { 0%, 100% { transform: scale(1, 1); } 50% { transform: scale(1.08, .7); } }\n' +
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
    el.setAttribute('data-progress', String(Math.round(clampProgress(p) * 100) / 100));
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
    if (b && b.style) b.style.transform = still ? '' : 'scale(' + (1 + 0.035 * x) + ', ' + (1 + 0.06 * x) + ')';
    if (w1 && w1.style) {
      w1.style.opacity = String(0.3 + 0.7 * Math.min(1, x * 2));
      w1.style.transform = still ? '' : 'scale(' + (0.9 + 0.2 * x) + ')';
    }
    if (w2 && w2.style) {
      w2.style.opacity = String(x > 0.4 ? 0.3 + 0.7 * (x - 0.4) / 0.6 : 0.15);
      w2.style.transform = still ? '' : 'scale(' + (0.88 + 0.24 * x) + ')';
    }
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
      reactionTimer = setTimeout(function () { target.removeAttribute('data-reaction'); }, 900);
    }
    while (pulsing.length) { var prev = pulsing.pop(); if (prev && prev.cancel) prev.cancel(); }
    if (reducedMotion(host)) return false;
    var part = host.querySelector && host.querySelector('.dt-pose');
    if (part && part.animate) {
      var anim = part.animate(spec[0], { duration: spec[1], easing: 'ease-out', composite: 'add' });
      if (anim) pulsing.push(anim);
    }
    return pulsing.length > 0;
  }

  /* ---------------- intro (FLIP shared-element glide) ---------------- */

  function startIntro(text) {
    var doc = docOf(host);
    if (!host || introState || reducedMotion(host) || !doc || !doc.body) return false;
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
      if (gained) pulse(v === 1 ? 'full' : 'tick');
      return v;
    },

    progress: function () { return hostProgress; },

    pulse: pulse,

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

    create: function (mood, progressOrForm, maybeForm) {
      var doc = typeof document !== 'undefined' ? document : docOf(host);
      injectStyle(doc);
      var p, f;
      if (typeof progressOrForm === 'string' && FORMS.indexOf(progressOrForm) >= 0) {
        f = progressOrForm;
        p = (mood === 'happy' || mood === 'understood' || mood === 'record') ? 1 : 0;
      } else if (progressOrForm && typeof progressOrForm === 'object') {
        p = progressOrForm.progress === undefined ? (mood === 'happy' ? 1 : 0) : progressOrForm.progress;
        f = progressOrForm.form;
      } else {
        p = progressOrForm === undefined ? (mood === 'happy' ? 1 : 0) : progressOrForm;
        f = maybeForm;
      }
      return draw(doc.createElement('div'), mood, p, f);
    },
  };

  root.ShapeAvatar = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
