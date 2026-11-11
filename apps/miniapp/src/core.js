/**
 * Shape mini app: pure logic, no DOM. Classic script (no import/export) so `node --check` and the
 * browser both load it as is: in the browser it becomes the global `ShapeCore`; in Node it is a
 * CommonJS module (see the last line).
 *
 * Contract: docs/specs/2026-11-09-miniapp-design.md (catalog_v1 in the URL fragment, payload v1
 * through Telegram.WebApp.sendData). Limits mirror apps/sheet4/src/api_validator.js; the page is
 * a convenience gate only, the bot and the sheet validate again.
 */
(function (root) {
  'use strict';

  var LIMITS = {
    PAYLOAD_BYTES: 4096,
    MAX_EXERCISES: 15,
    MAX_WORK_SETS: 2,
    MAX_FOOD_ITEMS: 20,
    KG_MIN: 0, KG_MAX: 1000,
    REPS_MIN: 1, REPS_MAX: 100,
    RIR_MIN: 0, RIR_MAX: 10,
    PAIN_MIN: 0, PAIN_MAX: 10,
    NOTE_MAX: 200,
    MEAL_MAX: 60,
    UNIT_MAX: 20,
    DESCRIPTION_MAX: 200,
    QTY_MIN: 0.001, QTY_MAX: 100000,
    PORTIONS_MIN: 0.01, PORTIONS_MAX: 50,
  };
  var MEASURES = ['Pesada', 'Rótulo', 'Estimada'];
  /** FoodLog.MEALS of the sheet; used only when the catalog has no `meals`. */
  var DEFAULT_MEALS = ['Café da manhã', 'Lanche da manhã', 'Almoço', 'Lanche', 'Pré-treino', 'Pós-treino', 'Jantar', 'Ceia', 'Outro'];
  /** Units the sheet converts (Units in food_units.js); used only when the catalog has no `units`. */
  var DEFAULT_UNITS = ['g', 'mg', 'kg', 'ml', 'l', 'un', 'fatia', 'colher', 'porção'];
  var DEFAULT_TZ = 'America/Sao_Paulo';

  /* text --------------------------------------------------------------------------------------- */

  /** Lowercase, no accents, single spaces: the key used for search and name comparison. */
  function fold(text) {
    return String(text === null || text === undefined ? '' : text)
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function sameName(a, b) {
    return fold(a) === fold(b);
  }

  /**
   * Accent- and case-insensitive search. Every word of the query must appear; exact match first,
   * then prefix, then word start, then anywhere; ties keep the list order.
   * `key` extracts the text of an item (default: the item itself).
   */
  function search(query, list, limit, key) {
    var get = key || function (x) { return x; };
    var max = limit === undefined ? Infinity : limit;
    var q = fold(query);
    if (!q) return list.slice(0, max);
    var words = q.split(' ');
    var hits = [];
    list.forEach(function (item, i) {
      var f = fold(get(item));
      if (!words.every(function (w) { return f.indexOf(w) >= 0; })) return;
      var score = f === q ? 0 : f.indexOf(q) === 0 ? 1 : (' ' + f).indexOf(' ' + words[0]) >= 0 ? 2 : 3;
      hits.push({ item: item, score: score, i: i });
    });
    hits.sort(function (a, b) { return a.score - b.score || a.i - b.i; });
    return hits.slice(0, max).map(function (h) { return h.item; });
  }

  /** UTF-8 byte length (Telegram's sendData limit is in bytes). */
  function utf8Bytes(str) {
    var s = String(str);
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    var n = 0;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }

  /* numbers ------------------------------------------------------------------------------------ */

  /**
   * Brazilian or plain decimal input → number. "82,5" → 82.5, "80" → 80, " 7.5 " → 7.5.
   * Empty → null; anything else (letters, "1,2,3", "82,", "1 5") → NaN. Only the ends are trimmed:
   * a space inside ("8 0") is refused instead of silently becoming 80. Never guesses thousands.
   */
  function parseDecimal(input) {
    if (typeof input === 'number') return Number.isFinite(input) ? input : NaN;
    if (input === null || input === undefined) return null;
    var s = String(input).trim();
    if (!s) return null;
    if (/\s/.test(s)) return NaN;
    if (!/^\+?(\d+([.,]\d+)?|[.,]\d+)$/.test(s)) return NaN;
    return Number(s.replace(',', '.'));
  }

  function round(n, places) {
    var f = Math.pow(10, places === undefined ? 3 : places);
    return Math.round(n * f) / f;
  }

  /** 82.5 → "82,5"; integers stay plain; at most 3 decimals. */
  function formatBR(n) {
    if (n === null || n === undefined || n === '' || !Number.isFinite(Number(n))) return '';
    return String(round(Number(n), 3)).replace('.', ',');
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  /**
   * One stepper tap. `value` is the field text; `start` is the suggested value (e.g. last work)
   * used when the field is empty: the first tap fills it in instead of stepping past it.
   * Returns the new field text (Brazilian format).
   */
  function stepValue(value, delta, min, max, start) {
    var v = parseDecimal(value);
    var hasStart = start !== null && start !== undefined && Number.isFinite(Number(start));
    var next;
    if (v === null || Number.isNaN(v)) next = hasStart ? Number(start) : (delta > 0 ? Math.max(min, delta) : min);
    else next = v + delta;
    return formatBR(round(clamp(next, min, max), 2));
  }

  /* dates -------------------------------------------------------------------------------------- */

  function isDateKey(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    var p = s.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.getUTCFullYear() === p[0] && d.getUTCMonth() === p[1] - 1 && d.getUTCDate() === p[2] && p[0] >= 2000;
  }

  function validTimeZone(tz) {
    if (typeof tz !== 'string' || !tz) return false;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
  }

  /** Today's yyyy-MM-dd in `tz` (falls back to America/Sao_Paulo). */
  function todayIn(tz, now) {
    var zone = validTimeZone(tz) ? tz : DEFAULT_TZ;
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now || new Date());
    var get = function (t) { return parts.filter(function (p) { return p.type === t; })[0].value; };
    return get('year') + '-' + get('month') + '-' + get('day');
  }

  function addDays(key, n) {
    var p = key.split('-').map(Number);
    var d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
    var mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    var dd = String(d.getUTCDate()).padStart(2, '0');
    return d.getUTCFullYear() + '-' + mm + '-' + dd;
  }

  /** "2026-11-09" → "09/11". */
  function shortDate(key) {
    return key.slice(8, 10) + '/' + key.slice(5, 7);
  }

  var WEEKDAYS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  function weekday(key) {
    var p = key.split('-').map(Number);
    return WEEKDAYS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
  }

  /** The dates the page offers: today and yesterday in the client's time zone. */
  function dateOptions(tz, now) {
    var today = todayIn(tz, now);
    return [{ key: today, label: 'Hoje' }, { key: addDays(today, -1), label: 'Ontem' }];
  }

  /* catalog decode ----------------------------------------------------------------------------- */

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  /** base64url without padding (as Python's urlsafe_b64encode(...).rstrip(b"=")) → bytes. */
  function base64UrlToBytes(text) {
    var s = String(text).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    if (s.length % 4 === 1) throw new Error('base64url: tamanho inválido');
    var out = new Uint8Array(Math.floor(s.length * 3 / 4));
    var buf = 0, bits = 0, o = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B64.indexOf(s.charAt(i));
      if (v < 0) throw new Error('base64url: caractere inválido');
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[o++] = (buf >> bits) & 0xff;
      }
    }
    return out.subarray(0, o);
  }

  /* Raw DEFLATE (RFC 1951) decoder, used when the browser has no DecompressionStream("deflate-raw")
     (older iOS/Android webviews). Small, canonical-Huffman decoder in the style of zlib's puff.c. */
  var LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
  var LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
  var DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
  var DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
  var CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

  function huffman(lengths) {
    var count = new Uint16Array(16);
    var symbol = new Uint16Array(lengths.length);
    var offs = new Uint16Array(16);
    var i;
    for (i = 0; i < lengths.length; i++) count[lengths[i]]++;
    count[0] = 0;
    for (i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
    for (i = 0; i < lengths.length; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
    return { count: count, symbol: symbol };
  }

  function inflateRaw(src, maxOut) {
    var limit = maxOut || 1 << 20;
    var out = [];
    var pos = 0, bitbuf = 0, bitcnt = 0;

    function bits(n) {
      while (bitcnt < n) {
        if (pos >= src.length) throw new Error('inflate: dados truncados');
        bitbuf |= src[pos++] << bitcnt;
        bitcnt += 8;
      }
      var v = bitbuf & ((1 << n) - 1);
      bitbuf >>>= n;
      bitcnt -= n;
      return v;
    }

    function decode(h) {
      var code = 0, first = 0, index = 0;
      for (var len = 1; len < 16; len++) {
        code |= bits(1);
        var c = h.count[len];
        if (code - c < first) return h.symbol[index + (code - first)];
        index += c;
        first = (first + c) << 1;
        code <<= 1;
      }
      throw new Error('inflate: código inválido');
    }

    function codes(lit, dist) {
      for (;;) {
        var sym = decode(lit);
        if (sym < 256) out.push(sym);
        else if (sym === 256) return;
        else {
          sym -= 257;
          if (sym >= 29) throw new Error('inflate: comprimento inválido');
          var len = LBASE[sym] + bits(LEXT[sym]);
          var ds = decode(dist);
          if (ds >= 30) throw new Error('inflate: distância inválida');
          var d = DBASE[ds] + bits(DEXT[ds]);
          if (d > out.length) throw new Error('inflate: distância antes do início');
          for (var k = 0; k < len; k++) out.push(out[out.length - d]);
        }
        if (out.length > limit) throw new Error('inflate: saída grande demais');
      }
    }

    var fixedLit = null, fixedDist = null;
    var last;
    do {
      last = bits(1);
      var type = bits(2);
      if (type === 0) {
        bitbuf = 0; bitcnt = 0;
        if (pos + 4 > src.length) throw new Error('inflate: dados truncados');
        var len = src[pos] | (src[pos + 1] << 8);
        var nlen = src[pos + 2] | (src[pos + 3] << 8);
        pos += 4;
        if (len !== (~nlen & 0xffff)) throw new Error('inflate: bloco armazenado corrompido');
        if (pos + len > src.length) throw new Error('inflate: dados truncados');
        for (var j = 0; j < len; j++) out.push(src[pos++]);
      } else if (type === 1) {
        if (!fixedLit) {
          var l = new Uint8Array(288);
          for (var a = 0; a < 288; a++) l[a] = a < 144 ? 8 : a < 256 ? 9 : a < 280 ? 7 : 8;
          var dl = new Uint8Array(30).fill(5);
          fixedLit = huffman(l);
          fixedDist = huffman(dl);
        }
        codes(fixedLit, fixedDist);
      } else if (type === 2) {
        var nlit = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4;
        var cl = new Uint8Array(19);
        for (var b = 0; b < ncode; b++) cl[CLEN_ORDER[b]] = bits(3);
        var clh = huffman(cl);
        var lengths = new Uint8Array(nlit + ndist);
        var idx = 0;
        while (idx < nlit + ndist) {
          var sym = decode(clh);
          if (sym < 16) { lengths[idx++] = sym; continue; }
          var rep, val = 0;
          if (sym === 16) {
            if (idx === 0) throw new Error('inflate: repetição sem anterior');
            val = lengths[idx - 1];
            rep = 3 + bits(2);
          } else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (idx + rep > nlit + ndist) throw new Error('inflate: comprimentos demais');
          while (rep--) lengths[idx++] = val;
        }
        codes(huffman(lengths.subarray(0, nlit)), huffman(lengths.subarray(nlit)));
      } else {
        throw new Error('inflate: tipo de bloco inválido');
      }
    } while (!last);
    return Uint8Array.from(out);
  }

  function utf8Decode(bytes) {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  /** Browser inflate: DecompressionStream("deflate-raw") when present, the JS decoder otherwise. */
  function inflateRawBrowser(bytes) {
    if (typeof DecompressionStream === 'undefined' || typeof Response === 'undefined') {
      return Promise.resolve(inflateRaw(bytes));
    }
    var ds;
    try { ds = new DecompressionStream('deflate-raw'); } catch (e) { return Promise.resolve(inflateRaw(bytes)); }
    var stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Response(stream).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  /**
   * blob = base64url_nopad(raw_deflate(utf8(json))) → normalized catalog.
   * `inflate(bytes)` may return bytes or a Promise of bytes (default: inflateRawBrowser).
   */
  function decodeCatalog(blob, inflate) {
    var fn = inflate || inflateRawBrowser;
    return Promise.resolve().then(function () {
      return fn(base64UrlToBytes(blob));
    }).then(function (bytes) {
      return normalizeCatalog(JSON.parse(utf8Decode(bytes)));
    });
  }

  function strList(a) {
    if (!Array.isArray(a)) return [];
    var out = [];
    a.forEach(function (x) {
      if (typeof x !== 'string' || !x.trim()) return;
      var t = x.trim();
      if (!out.some(function (y) { return y === t; })) out.push(t);
    });
    return out;
  }

  function str(x) {
    return typeof x === 'string' ? x.trim() : '';
  }

  /**
   * Entries for the body map ([{group, sets}]): `items` ([{name, sets}]) resolved to the group the
   * catalogue gives each exercise, after the last 7 days' sets when `withWeek`. An exercise
   * without a group, or with no sets, adds nothing.
   */
  function muscleEntries(catalog, items, withWeek) {
    var out = withWeek ? catalog.week.slice() : [];
    (items || []).forEach(function (it) {
      if (!it || !(it.sets > 0)) return;
      var hit = catalog.ex.filter(function (e) { return sameName(e.name, it.name); })[0];
      if (hit && hit.group) out.push({ group: hit.group, sets: it.sets });
    });
    return out;
  }

  /** `wk` ([[group, work sets]], the last 7 days) → [{group, sets}]; malformed rows are dropped. */
  function weekList(raw) {
    return (Array.isArray(raw) ? raw : []).filter(function (x) {
      return Array.isArray(x) && str(x[0]) && typeof x[1] === 'number' && isFinite(x[1]) && x[1] > 0;
    }).map(function (x) { return { group: str(x[0]), sets: x[1] }; });
  }

  /**
   * catalog_v1 (short keys) → the shape the page uses. Unknown keys are ignored; missing lists
   * become []. `foods` stays null when absent: the bot dropped it to fit the URL, so the page
   * accepts free food names (the sheet still validates them).
   */
  function normalizeCatalog(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('catálogo inválido');
    if (raw.v !== 1) throw new Error('catálogo de versão desconhecida (v=' + raw.v + ')');
    var plan = Array.isArray(raw.plan) ? raw.plan.filter(function (r) {
      return r && typeof r === 'object' && str(r.s) && str(r.e);
    }).map(function (r) {
      return { s: str(r.s), e: str(r.e), g: str(r.g), p: str(r.p), l: str(r.l) };
    }) : [];

    var sessions = strList(raw.sessions);
    plan.forEach(function (r) { if (sessions.indexOf(r.s) < 0) sessions.push(r.s); });
    var next = str(raw.next);
    if (next && sessions.indexOf(next) < 0) sessions.unshift(next);
    if (!next) next = sessions[0] || '';

    var ex = [];
    var addEx = function (name, group) {
      if (!name) return;
      var have = ex.filter(function (e) { return sameName(e.name, name); })[0];
      // The catalogue's group wins; a plan row only fills one the catalogue left empty.
      if (have) { if (!have.group && group) have.group = group; return; }
      ex.push({ name: name, group: group || '' });
    };
    (Array.isArray(raw.ex) ? raw.ex : []).forEach(function (x) {
      if (Array.isArray(x)) addEx(str(x[0]), str(x[1]));
      else if (typeof x === 'string') addEx(str(x), '');
    });
    plan.forEach(function (r) { addEx(r.e, r.g); });

    var meals = strList(raw.meals);
    var units = strList(raw.units);
    return {
      v: 1,
      today: isDateKey(raw.today) ? raw.today : '',
      tz: validTimeZone(raw.tz) ? raw.tz : DEFAULT_TZ,
      client: str(raw.client),
      next: next,
      sessions: sessions,
      plan: plan,
      ex: ex,
      week: weekList(raw.wk),
      foods: Array.isArray(raw.foods) ? strList(raw.foods) : null,
      fav: strList(raw.fav),
      meals: meals.length ? meals : DEFAULT_MEALS.slice(),
      units: units.length ? units : DEFAULT_UNITS.slice(),
    };
  }

  /**
   * Launch params → {view, blob, telegram}. Telegram appends its own params to the fragment, with
   * "&" or "?" ("#v=food&c=XYZ&tgWebAppVersion=8.0" or "#v=food&c=XYZ?tgWebAppVersion=8.0"), so
   * both are separators; the first `v=` and `c=` win (the base64url blob has no ? & =).
   * `search` (location.search) is a fallback for v/c. `telegram` = a tgWebApp* param was seen.
   */
  function parseHash(hash, search) {
    var found = {};
    var telegram = false;
    [hash, search].forEach(function (src) {
      String(src || '').replace(/^[#?]/, '').split(/[?&]/).forEach(function (pair) {
        if (!pair) return;
        var i = pair.indexOf('=');
        var k = i < 0 ? pair : pair.slice(0, i);
        var v = i < 0 ? '' : pair.slice(i + 1);
        if (k.indexOf('tgWebApp') === 0) telegram = true;
        if ((k === 'v' || k === 'c') && !(k in found)) found[k] = v;
      });
    });
    var view = found.v === 'food' ? 'food' : 'workout';
    var blob = /^[A-Za-z0-9_-]+$/.test(found.c || '') ? found.c : '';
    return { view: view, blob: blob, telegram: telegram };
  }

  /* last work ---------------------------------------------------------------------------------- */

  var SET_RE = /^(\d+(?:[.,]\d+)?)\s*(?:kg)?\s*[x×X*]\s*(\d+)\s*(?:\(?\s*(?:RIR|@)\s*(\d+(?:[.,]\d+)?)\s*\)?)?$/i;

  /**
   * Last-work text → up to 2 work sets, or null when any part is not understood (never guesses).
   * Accepts "80×8, 80×7", "82,5x8; 80x7" and the sheet's "80 kg × 8 (RIR 1) · 80 kg × 7".
   */
  function parseLastWork(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    var parts = text.trim().split(/\s*[·;|]\s*|,\s+|\s+\/\s+/).filter(function (p) { return p; });
    if (!parts.length) return null;
    var sets = [];
    for (var i = 0; i < parts.length; i++) {
      var m = SET_RE.exec(parts[i]);
      if (!m) return null;
      var kg = parseDecimal(m[1]);
      var reps = Number(m[2]);
      var set = { kg: kg, reps: reps };
      if (m[3] !== undefined) {
        var rir = parseDecimal(m[3]);
        if (rir >= LIMITS.RIR_MIN && rir <= LIMITS.RIR_MAX) set.rir = rir;
      }
      if (!(kg >= LIMITS.KG_MIN && kg <= LIMITS.KG_MAX) || !(reps >= LIMITS.REPS_MIN && reps <= LIMITS.REPS_MAX)) return null;
      sets.push(set);
    }
    return sets.slice(0, LIMITS.MAX_WORK_SETS);
  }

  /** {kg, reps, rir?} → "80 kg × 8, RIR 1". */
  function describeSet(set) {
    var s = formatBR(set.kg) + ' kg × ' + set.reps;
    if (set.rir !== undefined && set.rir !== null) s += ', RIR ' + formatBR(set.rir);
    return s;
  }

  /* workout model ------------------------------------------------------------------------------ */

  function blank(v) {
    return v === null || v === undefined || String(v).trim() === '';
  }

  function newSet() {
    return { kg: '', reps: '', rir: '' };
  }

  function newCard(name, group, planRow) {
    return {
      name: name,
      group: group || '',
      fromPlan: !!planRow,
      p: planRow ? planRow.p : '',
      l: planRow ? planRow.l : '',
      sets: [newSet()],
      warmup: null,
      feeder: null,
      pain: '',
      note: '',
    };
  }

  /** Cards of a session from the plan, in plan order. */
  function planCards(catalog, session) {
    return catalog.plan.filter(function (r) { return r.s === session; })
      .map(function (r) { return newCard(r.e, r.g, r); });
  }

  /** Last-work sets as field texts, ready to fill a card's sets ("repetir última"). */
  function repeatSets(lastText) {
    var sets = parseLastWork(lastText);
    if (!sets) return null;
    return sets.map(function (s) {
      return { kg: formatBR(s.kg), reps: String(s.reps), rir: s.rir === undefined ? '' : formatBR(s.rir) };
    });
  }

  function setBlank(s) {
    return !s || (blank(s.kg) && blank(s.reps) && blank(s.rir));
  }

  function cardIsEmpty(card) {
    return card.sets.every(setBlank) && setBlank(card.warmup) && setBlank(card.feeder) &&
      blank(card.pain) && blank(card.note);
  }

  /** Work sets that have something typed. */
  function filledSets(card) {
    return card.sets.filter(function (s) { return !setBlank(s); });
  }

  function exerciseNames(catalog) {
    return catalog.ex.map(function (e) { return e.name; });
  }

  function numberField(errors, raw, path, label, opts) {
    var v = parseDecimal(raw);
    if (v === null) {
      if (opts.required) errors.push({ path: path, message: label + ': obrigatório' });
      return undefined;
    }
    if (Number.isNaN(v) && /\s/.test(String(raw).trim())) {
      errors.push({ path: path, message: label + ': tire o espaço de dentro do número ("' + String(raw).trim().replace(/\s+/g, ' ') + '")' });
      return undefined;
    }
    if (Number.isNaN(v)) {
      errors.push({ path: path, message: label + ': "' + String(raw).trim() + '" não é um número' });
      return undefined;
    }
    if (opts.integer && !Number.isInteger(v)) {
      errors.push({ path: path, message: label + ': use um número inteiro' });
      return undefined;
    }
    if (v < opts.min || v > opts.max) {
      errors.push({ path: path, message: label + ': entre ' + formatBR(opts.min) + ' e ' + formatBR(opts.max) });
      return undefined;
    }
    return v;
  }

  /**
   * Free text the bot refuses: starting with = + - or @ (after trimming) could be read as a
   * spreadsheet formula. Returns the PT-BR message, or '' when the text is fine.
   */
  function formulaProblem(text) {
    var t = typeof text === 'string' ? text.trim() : '';
    return /^[=+\-@]/.test(t) ? 'não pode começar com = + - ou @' : '';
  }

  function textField(errors, raw, path, label, max, required, freeText) {
    var t = typeof raw === 'string' ? raw.trim() : '';
    if (!t) {
      if (required) errors.push({ path: path, message: label + ': obrigatório' });
      return undefined;
    }
    if (freeText && formulaProblem(t)) {
      errors.push({ path: path, message: label + ': ' + formulaProblem(t) });
      return undefined;
    }
    if (t.length > max) {
      errors.push({ path: path, message: label + ': máximo ' + max + ' caracteres (tem ' + t.length + ')' });
      return undefined;
    }
    return t;
  }

  function checkDate(errors, date, today) {
    if (!isDateKey(date)) errors.push({ path: 'date', message: 'Data inválida' });
    else if (today && date > today) errors.push({ path: 'date', message: 'Data no futuro' });
  }

  function buildSet(errors, s, path, work) {
    var out = {};
    var kg = numberField(errors, s.kg, path + '.kg', 'kg', { required: true, min: LIMITS.KG_MIN, max: LIMITS.KG_MAX });
    var reps = numberField(errors, s.reps, path + '.reps', 'reps', { required: true, integer: true, min: LIMITS.REPS_MIN, max: LIMITS.REPS_MAX });
    if (kg !== undefined) out.kg = kg;
    if (reps !== undefined) out.reps = reps;
    if (work) {
      // The sheet takes RIR as a number 0..10 (decimals allowed), optional.
      var rir = numberField(errors, s.rir, path + '.rir', 'RIR', { min: LIMITS.RIR_MIN, max: LIMITS.RIR_MAX });
      if (rir !== undefined) out.rir = rir;
    }
    return out;
  }

  /**
   * Workout state → workout.upsert args. State: {date, session, complete, cards}.
   * Empty cards are skipped. Errors carry `card` (index in state.cards) and a short PT-BR message.
   * opts.today: the client's today (dates after it are refused).
   */
  function buildWorkout(state, catalog, opts) {
    var errors = [];
    var today = opts && opts.today;
    checkDate(errors, state.date, today);
    if (!state.session || catalog.sessions.indexOf(state.session) < 0) {
      errors.push({ path: 'session', message: 'Escolha uma sessão da ficha' });
    }
    var names = exerciseNames(catalog);
    var exercises = [];
    var seen = [];
    (state.cards || []).forEach(function (card, i) {
      if (cardIsEmpty(card)) return;
      var e = [];
      var label = card.name || 'Exercício';
      if (names.indexOf(card.name) < 0) e.push({ path: 'name', message: 'não está no catálogo de exercícios' });
      if (seen.some(function (s) { return sameName(s, card.name); })) e.push({ path: 'name', message: 'repetido; junte as séries num só card' });
      seen.push(card.name);
      var ex = { name: card.name, work: [] };
      var sets = filledSets(card);
      if (!sets.length) e.push({ path: 'work', message: 'registre ao menos uma série de trabalho' });
      if (sets.length > LIMITS.MAX_WORK_SETS) e.push({ path: 'work', message: 'no máximo ' + LIMITS.MAX_WORK_SETS + ' séries de trabalho' });
      card.sets.forEach(function (s, j) {
        if (setBlank(s)) return;
        var se = [];
        var built = buildSet(se, s, 'work[' + j + ']', true);
        se.forEach(function (x) { x.message = 'série ' + (j + 1) + ', ' + x.message; e.push(x); });
        ex.work.push(built);
      });
      ['warmup', 'feeder'].forEach(function (k) {
        if (setBlank(card[k])) return;
        var se = [];
        var built = buildSet(se, card[k], k, false);
        var name = k === 'warmup' ? 'aquecimento' : 'feeder';
        se.forEach(function (x) { x.message = name + ', ' + x.message; e.push(x); });
        ex[k] = built;
      });
      var pain = numberField(e, card.pain, 'pain', 'dor', { integer: true, min: LIMITS.PAIN_MIN, max: LIMITS.PAIN_MAX });
      if (pain !== undefined) ex.pain = pain;
      var note = textField(e, card.note, 'note', 'nota', LIMITS.NOTE_MAX, false, true);
      if (note !== undefined) ex.note = note;
      e.forEach(function (x) {
        errors.push({ card: i, path: 'exercises[' + exercises.length + '].' + x.path, message: label + ': ' + x.message });
      });
      exercises.push(ex);
    });
    var complete = state.complete === true;
    if (!exercises.length && !complete) {
      errors.push({ path: 'exercises', message: 'Preencha ao menos um exercício (ou marque a sessão como concluída)' });
    }
    if (exercises.length > LIMITS.MAX_EXERCISES) {
      errors.push({ path: 'exercises', message: 'No máximo ' + LIMITS.MAX_EXERCISES + ' exercícios por envio' });
    }
    var args = { date: state.date, session: state.session, complete: complete, exercises: exercises };
    return { args: errors.length ? null : args, errors: errors };
  }

  /* food model --------------------------------------------------------------------------------- */

  /**
   * One food item draft (field texts) → Sheet API item. Drafts:
   *   {kind:'food', food, qty, unit?, measure?}  {kind:'favorite', favorite, portions?}
   *   {kind:'description', description, qty?, unit?}
   */
  function buildFoodItem(item, catalog) {
    var e = [];
    var out = {};
    if (!item || ['food', 'favorite', 'description'].indexOf(item.kind) < 0) {
      return { value: null, errors: [{ path: '', message: 'item sem tipo' }] };
    }
    if (item.kind === 'food') {
      var name = typeof item.food === 'string' ? item.food.trim() : '';
      if (!name) e.push({ path: 'food', message: 'alimento: obrigatório' });
      else if (catalog.foods && catalog.foods.indexOf(name) < 0) e.push({ path: 'food', message: 'alimento fora do catálogo; use "sem cálculo"' });
      else if (name.length > LIMITS.DESCRIPTION_MAX) e.push({ path: 'food', message: 'alimento: nome longo demais' });
      out.food = name;
      var qty = numberField(e, item.qty, 'qty', 'quantidade', { required: true, min: LIMITS.QTY_MIN, max: LIMITS.QTY_MAX });
      if (qty !== undefined) out.qty = qty;
      var unit = textField(e, item.unit, 'unit', 'unidade', LIMITS.UNIT_MAX, false);
      if (unit !== undefined) out.unit = unit;
      if (!blank(item.measure)) {
        if (MEASURES.indexOf(item.measure) < 0) e.push({ path: 'measure', message: 'medição: use ' + MEASURES.join(', ') });
        else out.measure = item.measure;
      }
    } else if (item.kind === 'favorite') {
      if (catalog.fav.indexOf(item.favorite) < 0) e.push({ path: 'favorite', message: 'favorita fora do catálogo' });
      out.favorite = item.favorite;
      var portions = numberField(e, item.portions, 'portions', 'porções', { min: LIMITS.PORTIONS_MIN, max: LIMITS.PORTIONS_MAX });
      if (portions !== undefined) out.portions = portions;
    } else {
      var d = textField(e, item.description, 'description', 'descrição', LIMITS.DESCRIPTION_MAX, true, true);
      if (d !== undefined) out.description = d;
      var q = numberField(e, item.qty, 'qty', 'quantidade', { min: LIMITS.QTY_MIN, max: LIMITS.QTY_MAX });
      if (q !== undefined) out.qty = q;
      var u = textField(e, item.unit, 'unit', 'unidade', LIMITS.UNIT_MAX, false);
      if (u !== undefined) out.unit = u;
    }
    return { value: e.length ? null : out, errors: e };
  }

  /** Food state {date, meal, items} → food.add args. Errors carry `item` (index). */
  function buildFood(state, catalog, opts) {
    var errors = [];
    checkDate(errors, state.date, opts && opts.today);
    var meal;
    if (blank(state.meal)) errors.push({ path: 'meal', message: 'Escolha a refeição' });
    else meal = textField(errors, state.meal, 'meal', 'Refeição', LIMITS.MEAL_MAX, true, true);
    var items = [];
    var list = state.items || [];
    if (!list.length) errors.push({ path: 'items', message: 'Adicione ao menos um item' });
    if (list.length > LIMITS.MAX_FOOD_ITEMS) errors.push({ path: 'items', message: 'No máximo ' + LIMITS.MAX_FOOD_ITEMS + ' itens por refeição' });
    list.forEach(function (it, i) {
      var r = buildFoodItem(it, catalog);
      r.errors.forEach(function (x) {
        errors.push({ item: i, path: 'items[' + i + ']' + (x.path ? '.' + x.path : ''), message: 'Item ' + (i + 1) + ': ' + x.message });
      });
      if (r.value) items.push(r.value);
    });
    var args = { date: state.date, meal: meal, items: items };
    return { args: errors.length ? null : args, errors: errors };
  }

  /* payload ------------------------------------------------------------------------------------ */

  var SUBMISSION_ID_RE = /^[0-9a-f]{32}$/;

  /**
   * A draft's submission id: 128 random bits as 32 lowercase hex characters. It stays with the
   * draft and with its "last sent" entry, so a restored resend reaches the sheet under the same
   * request id (the bot builds it from chat + this id + the args) and cannot be written twice.
   */
  function newSubmissionId(randomBytes) {
    var bytes = new Uint8Array(16);
    var c = typeof crypto !== 'undefined' ? crypto : null;
    if (randomBytes) randomBytes(bytes);
    else if (c && c.getRandomValues) c.getRandomValues(bytes);
    else for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    var out = '';
    for (var j = 0; j < 16; j++) out += (bytes[j] < 16 ? '0' : '') + bytes[j].toString(16);
    return out;
  }
  function isSubmissionId(id) { return typeof id === 'string' && SUBMISSION_ID_RE.test(id); }

  /** {v:1, t, id, args} → compact JSON + its UTF-8 size; ok when within Telegram's 4096 bytes. */
  function serializePayload(t, args, id) {
    var json = JSON.stringify({ v: 1, t: t, id: id, args: args });
    var bytes = utf8Bytes(json);
    return { json: json, bytes: bytes, ok: bytes <= LIMITS.PAYLOAD_BYTES };
  }

  /* drafts and the "last sent" history ---------------------------------------------------- */

  var DRAFT_PREFIX = 'shape-miniapp:v2:';
  var SENT_MAX = 5;

  function workoutFormEmpty(form) {
    return !form || (!form.complete && (form.cards || []).every(cardIsEmpty));
  }
  function foodFormEmpty(form) {
    return !form || (!(form.items && form.items.length) && !form.meal);
  }

  /** Newest first, at most `max` entries. */
  function pushSent(list, entry, max) {
    return [entry].concat(Array.isArray(list) ? list : []).slice(0, max || SENT_MAX);
  }

  /**
   * Drafts kept per form, so sending one never wipes another:
   *   workout: one key per (date, session); food: one key; sent: the last 5 payloads sent.
   * `storage` is localStorage-like (getItem/setItem/removeItem/key/length) or null; every access
   * is guarded because private windows and some WebViews throw on storage.
   */
  function draftStore(storage, client) {
    var c = encodeURIComponent(client || '');
    var wPrefix = DRAFT_PREFIX + 'w:' + c + ':';
    var fKey = DRAFT_PREFIX + 'f:' + c;
    var sKey = DRAFT_PREFIX + 'sent:' + c;
    var wKey = function (date, session) { return wPrefix + date + ':' + encodeURIComponent(session); };
    function get(k) { try { return storage ? JSON.parse(storage.getItem(k) || 'null') : null; } catch (e) { return null; } }
    function set(k, v) { try { if (storage) storage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
    function del(k) { try { if (storage) storage.removeItem(k); } catch (e) { /* ignore */ } }
    function keys() {
      var out = [];
      try { for (var i = 0; storage && i < storage.length; i++) out.push(storage.key(i)); } catch (e) { /* ignore */ }
      return out;
    }
    function fresh(date, today) { return date === today || date === addDays(today, -1); }

    return {
      workoutKey: wKey,
      foodKey: fKey,
      sentKey: sKey,
      /** form = {date, session, complete, cards}; an empty form removes its key. */
      saveWorkout: function (form) {
        if (workoutFormEmpty(form)) { del(wKey(form.date, form.session)); return; }
        set(wKey(form.date, form.session), { v: 1, savedAt: form.savedAt || Date.now(), id: form.id, date: form.date, session: form.session, complete: !!form.complete, cards: form.cards });
      },
      /** Drafts still on an offered date (today or yesterday); stale ones are deleted. */
      loadWorkouts: function (today) {
        var out = [];
        keys().filter(function (k) { return k && k.indexOf(wPrefix) === 0; }).forEach(function (k) {
          var d = get(k);
          if (d && d.v === 1 && isDateKey(d.date) && fresh(d.date, today) && Array.isArray(d.cards)) out.push(d);
          else del(k);
        });
        return out;
      },
      clearWorkout: function (date, session) { del(wKey(date, session)); },
      saveFood: function (form) {
        if (foodFormEmpty(form)) { del(fKey); return; }
        set(fKey, { v: 1, savedAt: Date.now(), id: form.id, date: form.date, meal: form.meal || '', items: form.items || [] });
      },
      loadFood: function (today) {
        var d = get(fKey);
        if (d && d.v === 1 && isDateKey(d.date) && fresh(d.date, today) && Array.isArray(d.items)) return d;
        if (d) del(fKey);
        return null;
      },
      clearFood: function () { del(fKey); },
      /** entry = {t, label, json, form}; stamped with `at`. Returns the new list (newest first). */
      recordSent: function (entry, now) {
        var list = pushSent(get(sKey), Object.assign({ at: now || Date.now() }, entry), SENT_MAX);
        set(sKey, list);
        return list;
      },
      sent: function (t) {
        var list = get(sKey);
        return (Array.isArray(list) ? list : []).filter(function (e) { return e && (!t || e.t === t); });
      },
    };
  }

  /** A saved draft is reused only while its date is still offered (today or yesterday). */
  function draftUsable(draft, today) {
    if (!draft || draft.v !== 1) return false;
    var allowed = [today, addDays(today, -1)];
    var dates = [];
    if (draft.workout && draft.workout.date) dates.push(draft.workout.date);
    if (draft.food && draft.food.date) dates.push(draft.food.date);
    return dates.length > 0 && dates.every(function (d) { return allowed.indexOf(d) >= 0; });
  }

  var api = {
    LIMITS: LIMITS,
    MEASURES: MEASURES,
    DEFAULT_MEALS: DEFAULT_MEALS,
    DEFAULT_UNITS: DEFAULT_UNITS,
    fold: fold,
    sameName: sameName,
    search: search,
    utf8Bytes: utf8Bytes,
    parseDecimal: parseDecimal,
    formatBR: formatBR,
    stepValue: stepValue,
    isDateKey: isDateKey,
    todayIn: todayIn,
    addDays: addDays,
    shortDate: shortDate,
    weekday: weekday,
    dateOptions: dateOptions,
    base64UrlToBytes: base64UrlToBytes,
    inflateRaw: inflateRaw,
    inflateRawBrowser: inflateRawBrowser,
    decodeCatalog: decodeCatalog,
    normalizeCatalog: normalizeCatalog,
    muscleEntries: muscleEntries,
    parseHash: parseHash,
    parseLastWork: parseLastWork,
    describeSet: describeSet,
    newSet: newSet,
    newCard: newCard,
    planCards: planCards,
    repeatSets: repeatSets,
    setBlank: setBlank,
    cardIsEmpty: cardIsEmpty,
    filledSets: filledSets,
    buildWorkout: buildWorkout,
    buildFoodItem: buildFoodItem,
    buildFood: buildFood,
    serializePayload: serializePayload,
    newSubmissionId: newSubmissionId,
    isSubmissionId: isSubmissionId,
    draftUsable: draftUsable,
    formulaProblem: formulaProblem,
    workoutFormEmpty: workoutFormEmpty,
    foodFormEmpty: foodFormEmpty,
    pushSent: pushSent,
    draftStore: draftStore,
    SENT_MAX: SENT_MAX,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShapeCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
