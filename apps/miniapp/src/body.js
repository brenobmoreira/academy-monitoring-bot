/**
 * ShapeBody: a self-contained, flat muscle map for the Telegram Mini App.
 * Classic script, no dependencies. Loading under Node never needs a DOM.
 *
 * API
 *   MUSCLES / LABELS       canonical keys in display order / Portuguese labels
 *   keysOf(label)          pure: spreadsheet label -> a fresh array of muscle keys
 *   levels(entries)        pure: [{ group, sets }] -> relative integer levels 1..3
 *   describe(levels)       pure: Portuguese summary, highest level first
 *   create(levels, opts)   new div.shape-body with front/back SVGs; opts.title is
 *                         an optional accessible title, retained across updates
 *   update(el, levels)     replace all highlights and the accessible summary
 *
 * Artwork is original path data. Each view draws one anatomical half twice,
 * mirrored about the spine. Neutral joints are never muscle targets. A surface
 * underlay keeps translucent theme tokens from accumulating over the silhouette.
 * Only opacity animates: 240 ms plus a 0..390 ms stagger; reduced motion disables it.
 */
(function (root) {
  'use strict';

  var MUSCLES = ['peito', 'costas', 'ombros', 'biceps', 'triceps', 'antebracos', 'abdomen', 'trapezio', 'lombar', 'quadriceps', 'posteriores', 'gluteos', 'adutores', 'panturrilhas'];
  var LABELS = {
    peito: 'Peito', costas: 'Costas', ombros: 'Ombros', biceps: 'Bíceps', triceps: 'Tríceps',
    antebracos: 'Antebraços', abdomen: 'Abdômen', trapezio: 'Trapézio', lombar: 'Lombar',
    quadriceps: 'Quadríceps', posteriores: 'Posteriores', gluteos: 'Glúteos',
    adutores: 'Adutores', panturrilhas: 'Panturrilhas'
  };
  var ALIASES = {
    peito: ['peito', 'peitos', 'peitoral', 'peitorais'],
    costas: ['costa', 'costas', 'dorsal', 'dorsais'],
    ombros: ['ombro', 'ombros', 'deltoide', 'deltoides'],
    biceps: ['bicep', 'biceps'], triceps: ['tricep', 'triceps'],
    antebracos: ['antebraco', 'antebracos'],
    abdomen: ['abdomen', 'abdomens', 'abdominal', 'abdominais', 'core'],
    trapezio: ['trapezio', 'trapezios'], lombar: ['lombar', 'lombares'],
    quadriceps: ['quadricep', 'quadriceps'],
    posteriores: ['posterior', 'posteriores', 'posterior de coxa', 'posterior de coxas', 'posteriores de coxa', 'posteriores de coxas', 'isquiotibial', 'isquiotibiais'],
    gluteos: ['gluteo', 'gluteos'], adutores: ['adutor', 'adutores'],
    panturrilhas: ['panturrilha', 'panturrilhas', 'gemeo', 'gemeos']
  };

  function keysOf(label) {
    if (typeof label !== 'string') return [];
    var s = label.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
    if (s === 'perna' || s === 'pernas') return ['quadriceps', 'posteriores', 'gluteos'];
    if (s === 'braco' || s === 'bracos') return ['biceps', 'triceps'];
    if (s === 'coxa' || s === 'coxas') return ['quadriceps', 'posteriores'];
    for (var i = 0; i < MUSCLES.length; i++) {
      if (ALIASES[MUSCLES[i]].indexOf(s) !== -1) return [MUSCLES[i]];
    }
    return [];
  }

  function levels(entries) {
    if (!Array.isArray(entries)) return {};
    var valid = [];
    var scale = 0;
    var i;
    for (i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!entry || typeof entry.sets !== 'number' || !isFinite(entry.sets) || entry.sets <= 0) continue;
      var keys = keysOf(entry.group);
      if (!keys.length) continue;
      valid.push({ keys: keys, sets: entry.sets });
      scale = Math.max(scale, entry.sets);
    }
    var totals = {};
    var max = 0;
    // Scaling before addition preserves ratios even for repeated Number.MAX_VALUE.
    for (i = 0; i < valid.length; i++) {
      for (var j = 0; j < valid[i].keys.length; j++) {
        var key = valid[i].keys[j];
        totals[key] = (totals[key] || 0) + valid[i].sets / scale;
        max = Math.max(max, totals[key]);
      }
    }
    var out = {};
    for (i = 0; i < MUSCLES.length; i++) {
      var k = MUSCLES[i];
      if (!Object.prototype.hasOwnProperty.call(totals, k)) continue;
      var ratio = totals[k] / max;
      out[k] = ratio > 2 / 3 ? 3 : ratio > 1 / 3 ? 2 : 1;
    }
    return out;
  }

  function levelOf(map, key) {
    if (!map || !Object.prototype.hasOwnProperty.call(map, key)) return 0;
    var n = map[key];
    return n === 1 || n === 2 || n === 3 ? n : 0;
  }

  function describe(map) {
    var names = [];
    for (var n = 3; n >= 1; n--) {
      for (var i = 0; i < MUSCLES.length; i++) {
        var k = MUSCLES[i];
        if (levelOf(map, k) === n) names.push(LABELS[k].toLowerCase());
      }
    }
    if (!names.length) return 'Nenhum músculo marcado.';
    var last = names.pop();
    return 'Músculos trabalhados: ' + (names.length ? names.join(', ') + ' e ' : '') + last + '.';
  }

  /* Right half, x = distance from centre. Head height ~42; full height ~315.
   * Shoulder, elbow, wrist, hip, knee, ankle: y = 71, 130, 179, 157, 239, 307.
   * Front pecs fan toward the humerus; quads have separate outer/inner teardrops.
   * Back traps form a kite above broad lats, with distinct lumbar and glute plates.
   */
  var OUTLINE = 'M0 49 L8 49 L9 57 Q17 61 28 63 Q39 64 44 76 L49 102 Q54 113 53 127 L56 136 Q63 150 64 163 L65 178 L69 188 L70 198 Q68 204 65 201 L60 195 L57 183 L54 178 Q48 161 46 148 L43 136 L40 130 Q35 119 34 108 L30 96 Q26 108 24 122 L23 137 Q28 150 29 168 Q34 191 30 214 L26 232 Q28 241 26 249 Q30 270 23 288 L20 307 L23 313 Q29 317 28 323 L7 323 Q4 320 7 313 L9 306 L8 286 Q4 270 9 251 L10 242 L8 232 Q3 215 3 195 L3 178 Q0 173 0 173 Z';
  var FRONT = [
    ['trapezio', 'M9 58 L25 63 L15 67 L1 63 L1 56 Z'],
    ['ombros', 'M29 64 Q40 65 43 77 L46 91 Q38 91 32 84 L27 73 Z'],
    ['peito', 'M1 66 Q13 66 25 69 L30 84 Q22 99 3 98 L1 95 Z'],
    ['biceps', 'M34 88 Q41 94 47 95 Q52 111 49 124 L43 130 Q37 120 36 108 Z'],
    ['antebracos', 'M48 134 L53 133 Q61 150 62 164 L63 177 L56 179 Q49 164 48 151 L45 140 Z'],
    ['abdomen', 'M3 102 L14 102 L13 113 L2 113 Z'],
    ['abdomen', 'M2 116 L13 116 L12 127 L2 127 Z'],
    ['abdomen', 'M2 130 L12 130 L12 140 L2 147 Z'],
    ['abdomen', 'M17 103 L26 99 L23 120 L21 134 L15 143 L15 126 Z'],
    ['adutores', 'M3 159 L12 163 Q17 177 12 193 L5 210 L5 190 L4 177 L1 173 Z'],
    ['quadriceps', 'M16 153 Q27 155 28 174 Q33 196 27 217 L23 231 Q16 227 16 217 L18 191 Q20 175 14 166 Z'],
    ['quadriceps', 'M15 191 L14 216 Q19 227 17 233 L12 234 Q8 224 7 214 Z'],
    ['panturrilhas', 'M12 251 L21 251 Q26 265 21 282 L17 302 L13 304 L13 283 Q10 268 12 251 Z']
  ];
  var BACK = [
    ['trapezio', 'M1 56 L8 57 L26 64 L17 78 L2 98 L1 96 Z'],
    ['ombros', 'M29 64 Q39 64 43 76 L46 91 Q36 91 30 84 L23 77 Z'],
    ['costas', 'M2 101 L19 81 L28 87 L26 103 Q23 120 21 132 L12 137 L3 121 Z'],
    ['triceps', 'M33 89 L45 95 Q51 105 50 119 L46 130 L40 128 Q36 117 35 107 Z'],
    ['antebracos', 'M46 135 L53 134 Q61 151 62 164 L63 177 L56 179 Q49 164 47 152 L44 142 Z'],
    ['lombar', 'M2 125 L10 138 L21 136 L24 149 L14 154 L2 149 Z'],
    ['gluteos', 'M3 154 Q16 151 25 154 Q31 166 29 178 Q20 187 5 180 L2 173 Z'],
    ['posteriores', 'M6 185 Q17 190 28 183 Q32 200 28 215 L24 234 L17 231 L16 209 L11 232 L7 232 Q3 213 6 185 Z'],
    ['panturrilhas', 'M12 250 L18 252 L17 276 L13 289 Q7 281 9 266 Z'],
    ['panturrilhas', 'M20 250 L24 250 Q30 268 23 282 L18 292 L18 278 Z']
  ];

  function half(regions) {
    var out = '<path class="shape-body-base" d="' + OUTLINE + '"/>';
    for (var i = 0; i < regions.length; i++) {
      var key = regions[i][0];
      var path = regions[i][1];
      out += '<path class="shape-body-underlay" d="' + path + '"/>' +
        '<path class="shape-body-muscle" data-muscle="' + key + '" style="animation-delay:' + (MUSCLES.indexOf(key) * 30) + 'ms" d="' + path + '"/>';
    }
    return out;
  }

  function svg(regions) {
    var side = half(regions);
    return '<svg class="shape-body-svg" viewBox="0 0 180 334" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">' +
      '<g class="shape-body-anatomy" stroke-linejoin="round">' +
        '<path class="shape-body-base" d="M76 24 Q76 8 90 8 Q104 8 104 24 L102 37 Q100 47 90 49 Q80 47 78 37 Z"/>' +
        '<g transform="translate(90 0)">' + side + '</g>' +
        '<g transform="translate(90 0) scale(-1 1)">' + side + '</g>' +
      '</g></svg>';
  }

  var CSS = '.shape-body{display:flex;justify-content:center;gap:16px;width:100%;max-width:320px;margin:0 auto;color:var(--text,#1c1917)}' +
    '.shape-body .shape-body-figure{flex:1 1 0;min-width:0;max-width:144px;margin:0;text-align:center}' +
    '.shape-body .shape-body-svg{display:block;width:100%;height:202px;overflow:hidden}' +
    '.shape-body .shape-body-caption{margin:4px 0 0;font-size:11px;line-height:14px;color:var(--hint,#78716c);font-weight:400}' +
    '.shape-body .shape-body-base,.shape-body .shape-body-muscle{fill:var(--fill-strong,#dedbd8);stroke:var(--surface,#fff);stroke-width:1.2}' +
    '.shape-body .shape-body-underlay{fill:var(--surface,#fff);stroke:var(--surface,#fff);stroke-width:1.2}' +
    '.shape-body .shape-body-muscle[data-level]{fill:var(--accent,#e04e14);animation:shape-body-reveal 240ms ease-out backwards}' +
    '.shape-body .shape-body-muscle[data-level="1"]{fill-opacity:.35}' +
    '.shape-body .shape-body-muscle[data-level="2"]{fill-opacity:.65}' +
    '.shape-body .shape-body-muscle[data-level="3"]{fill-opacity:1}' +
    '@keyframes shape-body-reveal{from{opacity:0}to{opacity:1}}' +
    '@media(prefers-reduced-motion:reduce){.shape-body .shape-body-muscle{animation:none!important;transition:none!important}}';

  function injectStyle() {
    if (document.getElementById('shape-body-style')) return;
    var style = document.createElement('style');
    style.id = 'shape-body-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  function update(el, map) {
    var regions = el.querySelectorAll('[data-muscle]');
    for (var i = 0; i < regions.length; i++) {
      var n = levelOf(map, regions[i].getAttribute('data-muscle'));
      if (n) regions[i].setAttribute('data-level', String(n));
      else regions[i].removeAttribute('data-level');
    }
    var title = el.getAttribute('data-shape-body-title');
    el.setAttribute('aria-label', (title ? title + '. ' : '') + describe(map));
    return el;
  }

  function create(map, opts) {
    injectStyle();
    var el = document.createElement('div');
    el.className = 'shape-body';
    el.setAttribute('role', 'img');
    if (opts && typeof opts.title === 'string' && opts.title.trim()) {
      el.setAttribute('data-shape-body-title', opts.title.trim().replace(/[.!?]+$/, ''));
    }
    el.innerHTML = '<figure class="shape-body-figure">' + svg(FRONT) + '<figcaption class="shape-body-caption">Frente</figcaption></figure>' +
      '<figure class="shape-body-figure">' + svg(BACK) + '<figcaption class="shape-body-caption">Costas</figcaption></figure>';
    return update(el, map);
  }

  var api = { MUSCLES: MUSCLES, LABELS: LABELS, keysOf: keysOf, levels: levels, describe: describe, create: create, update: update };
  root.ShapeBody = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
