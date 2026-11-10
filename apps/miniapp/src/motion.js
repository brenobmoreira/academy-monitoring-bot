/**
 * Motion layer of the Shape mini app. Decoration only: every function here animates elements that
 * are ALREADY in their final state, so the form never waits for an animation and nothing here can
 * block a tap. Classic script; exposes the browser global `ShapeMotion` (module.exports under Node
 * for the pure helper's tests). The app works unchanged without this file.
 *
 * Rules
 *   - transform and opacity only, through the Web Animations API; no layout is animated. Things that
 *     must "make room" or "close a gap" are moved with FLIP (one measurement, then a transform).
 *   - prefers-reduced-motion (or a WebView without Element.animate): every call is a no-op and the
 *     state change is instant.
 *   - no fill: 'forwards' except `handoff` and `out`, which the caller ends explicitly.
 *
 * API (all return quickly and never throw)
 *   viewIn(el, dir)        el's children enter, staggered: dir 1/-1 from the right/left (sibling
 *                          views), 0 rising (a deeper step, e.g. the review)
 *   settle(el)             el fades back in from 98.5% (coming back from a deeper step)
 *   stagger(list)          a list of blocks rises in one after another (cards of a session)
 *   enter(el)              one new block arrives
 *   review(el)             viewIn(el, 0) plus the avatar pop and the size meter filling
 *   pop(el)                a selected chip / filled status disc snaps into place
 *   roll(el, sign)         a number changed: it rolls in from below (+1) or above (-1); 0 = it hit
 *                          the limit and only nudges sideways
 *   fill(el)               roll every filled number inside el (values copied in at once)
 *   shake(elOrList)        "this needs a fix"
 *   snapshot(old, leave)   before replacing a card by its re-render; returns after(fresh, root):
 *                          blocks that stayed glide to their new place, new ones fade in, `leave`
 *                          (a block of the old card) fades out as a ghost, the cards below glide
 *   leave(el, root)        before a re-render that drops `el`; returns after(): a ghost of el fades
 *                          out where it was and what was below glides up
 *   out(el, done)          el fades out and then done() runs (true); false = not animating, the
 *                          caller hides el itself. keep(el) aborts it (el is needed again).
 *   handoff(el)            el lifts and dims while the payload is handed to Telegram; returns the
 *                          Animation (cancel() puts el back) or null
 *   match(o, n, ordered)   pure: pairs two lists of block signatures (see below)
 *
 * It also listens (passively, on document) for clicks on steppers and choice chips to roll the
 * number / pop the chosen chip after the app has handled the click.
 */
(function (root) {
  'use strict';

  var OUT = 'cubic-bezier(0.2, 0.8, 0.2, 1)';    // decelerate: things arriving (same curve as the avatar bar)
  var IN = 'cubic-bezier(0.4, 0, 1, 1)';         // accelerate: things leaving
  var SPRING = 'cubic-bezier(0.3, 1.5, 0.5, 1)'; // a small overshoot, for pops only
  var MS = { quick: 150, exit: 180, base: 220, pop: 240, shake: 300 };
  var STILL = 'none';

  function reduced() {
    try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return true; }
  }
  function on() {
    return typeof Element !== 'undefined' && !!Element.prototype.animate && !reduced();
  }
  function play(el, frames, opts) {
    if (!el || !el.animate || !on()) return null;
    try { return el.animate(frames, opts); } catch (e) { return null; }
  }
  /** Wrap a public function: decoration must never break the app. */
  function safe(fn, fallback) {
    return function () {
      try { return fn.apply(null, arguments); } catch (e) { return fallback; }
    };
  }
  function visible(el) { var r = el.getBoundingClientRect(); return r.width > 0 || r.height > 0; }
  function glide(el, dy) {
    if (Math.abs(dy) < 1) return;
    play(el, [{ transform: 'translateY(' + dy + 'px)' }, { transform: STILL }], { duration: MS.base, easing: OUT });
  }

  /* entrances -------------------------------------------------------------------------------- */

  function viewIn(el, dir) {
    if (!el || !on()) return;
    var from = dir ? 'translateX(' + (dir * 22) + 'px)' : 'translateY(12px)';
    var kids = el.children;
    for (var i = 0; i < kids.length; i++) {
      play(kids[i], [{ opacity: 0, transform: from }, { opacity: 1, transform: STILL }],
        { duration: MS.base, delay: Math.min(i, 5) * 20, easing: OUT, fill: 'backwards' });
    }
  }
  function settle(el) {
    play(el, [{ opacity: 0, transform: 'scale(0.985)' }, { opacity: 1, transform: STILL }], { duration: 200, easing: OUT });
  }
  function stagger(list) {
    if (!list || !on()) return;
    for (var i = 0; i < list.length; i++) {
      play(list[i], [{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: STILL }],
        { duration: MS.base, delay: Math.min(i, 6) * 30, easing: OUT, fill: 'backwards' });
    }
  }
  function enter(el) {
    play(el, [{ opacity: 0, transform: 'translateY(10px) scale(0.97)' }, { opacity: 1, transform: STILL }], { duration: 260, easing: OUT });
  }
  function review(el) {
    if (!el || !on()) return;
    viewIn(el, 0);
    play(el.querySelector('.mascot-scene .shape'), [{ transform: 'scale(0.8)' }, { transform: STILL }], { duration: 320, easing: SPRING });
    var bar = el.querySelector('.meter-bar i');
    if (bar) {
      bar.style.transformOrigin = '0 50%';
      play(bar, [{ transform: 'scaleX(0)' }, { transform: STILL }], { duration: 420, delay: 120, easing: OUT, fill: 'backwards' });
    }
  }

  /* touch feedback --------------------------------------------------------------------------- */

  function pop(el) {
    play(el, [{ transform: 'scale(0.9)' }, { transform: STILL }], { duration: MS.pop, easing: SPRING });
  }
  function roll(el, sign) {
    if (!sign) {
      play(el, [{ transform: STILL }, { transform: 'translateX(-4px)' }, { transform: 'translateX(3px)' }, { transform: STILL }], { duration: MS.exit, easing: 'ease-out' });
      return;
    }
    play(el, [{ opacity: 0.15, transform: 'translateY(' + (sign * 9) + 'px)' }, { opacity: 1, transform: STILL }], { duration: MS.quick, easing: OUT });
  }
  function fill(el) {
    if (!el || !on()) return;
    var inputs = el.querySelectorAll('.step-input');
    var n = 0;
    for (var i = 0; i < inputs.length; i++) {
      if (!inputs[i].value) continue;
      play(inputs[i], [{ opacity: 0, transform: 'translateY(9px)' }, { opacity: 1, transform: STILL }],
        { duration: MS.base, delay: Math.min(n++, 8) * 25, easing: OUT, fill: 'backwards' });
    }
  }
  function shake(target) {
    if (!target || !on()) return;
    var list = target.nodeType ? [target] : target;
    for (var i = 0; i < list.length; i++) {
      play(list[i], [{ transform: STILL }, { transform: 'translateX(-6px)' }, { transform: 'translateX(5px)' },
        { transform: 'translateX(-3px)' }, { transform: 'translateX(2px)' }, { transform: STILL }], { duration: MS.shake, easing: 'ease-in-out' });
    }
  }

  /* leaving: a ghost fades out where the element was ------------------------------------------- */

  function ghost(el) {
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height || !document.body) return;
    var g = el.cloneNode(true);
    var ids = g.querySelectorAll('[id]');
    for (var i = 0; i < ids.length; i++) ids[i].removeAttribute('id');
    g.removeAttribute('id');
    g.setAttribute('aria-hidden', 'true');
    g.setAttribute('inert', '');
    var bare = /rgba\(.*,\s*0\)|transparent/.test(getComputedStyle(el).backgroundColor);
    g.style.cssText += ';position:absolute;margin:0;box-sizing:border-box;pointer-events:none;z-index:4;' +
      'left:' + (r.left + root.pageXOffset) + 'px;top:' + (r.top + root.pageYOffset) + 'px;' +
      'width:' + r.width + 'px;height:' + r.height + 'px;' + (bare ? 'background:var(--surface);' : '');
    document.body.appendChild(g);
    var drop = function () { if (g.parentNode) g.parentNode.removeChild(g); };
    var a = play(g, [{ opacity: 1, transform: STILL }, { opacity: 0, transform: 'scale(0.96)' }], { duration: MS.exit, easing: IN, fill: 'forwards' });
    if (!a) { drop(); return; }
    a.onfinish = drop;
    a.oncancel = drop;
    setTimeout(drop, MS.exit + 250);
  }

  /** Elements of `node` that start at or below page-Y `y` (descending only into what straddles it). */
  function below(node, y, out) {
    var kids = node.children;
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      if (!r.width && !r.height) continue;
      var top = r.top + root.pageYOffset;
      if (top >= y - 1) out.push(kids[i]);
      else if (top + r.height > y + 1) below(kids[i], y, out);
    }
    return out;
  }

  function leave(el, container) {
    if (!el || !container || !on() || !visible(el)) return null;
    var r = el.getBoundingClientRect();
    var next = el.nextElementSibling, prev = el.previousElementSibling;
    var gap = next ? next.getBoundingClientRect().top - r.bottom : prev ? r.top - prev.getBoundingClientRect().bottom : 0;
    var y = r.top + root.pageYOffset;
    var h0 = container.getBoundingClientRect().height;
    ghost(el);
    return safe(function () {
      // Only close the gap if the content really got shorter (an empty state may be taller).
      if (container.getBoundingClientRect().height > h0 - 1) return;
      var list = below(container, y, []);
      for (var i = 0; i < list.length; i++) glide(list[i], r.height + Math.max(0, gap));
    });
  }

  /* a card replaced by its re-render ----------------------------------------------------------- */

  function sig(el) {
    var label = el.querySelector('.set-label, .field-label > span, .card-name');
    return el.className + '|' + (label ? label.textContent : '');
  }
  /** The blocks of a card: its head and each visible child of its body. */
  function blocks(card, skip) {
    var out = [];
    var head = card.firstElementChild;
    if (!head) return out;
    out.push(head);
    var body = head.nextElementSibling;
    var kids = body ? body.children : [];
    for (var i = 0; i < kids.length; i++) if (kids[i] !== skip && visible(kids[i])) out.push(kids[i]);
    return out;
  }

  /**
   * Pair the blocks before (signatures `o`) and after (`n`) a re-render. Returns, for each index of
   * `n`, the index in `o` it came from, or -1 for a block that is new; null when it cannot tell.
   * `ordered`: the caller already took the removed block out of `o`, so equal lengths pair in order
   * even if labels were renumbered ("Série 2" became "Série 1").
   */
  function match(o, n, ordered) {
    var map = [], i, k;
    if (n.length === o.length) {
      for (i = 0; i < n.length; i++) {
        if (!ordered && n[i] !== o[i]) return null;
        map.push(i);
      }
      return map;
    }
    if (n.length > o.length) {
      var extra = n.length - o.length;
      for (i = 0, k = 0; i < n.length; i++) {
        if (extra > 0 && o.indexOf(n[i]) < 0) { map.push(-1); extra--; } else map.push(k++);
      }
      return extra === 0 && k === o.length ? map : null;
    }
    var gone = o.length - n.length;
    for (i = 0, k = 0; i < o.length && k < n.length; i++) {
      if (gone > 0 && n.indexOf(o[i]) < 0) { gone--; continue; }
      map.push(i);
      k++;
    }
    gone -= o.length - i;
    return gone === 0 && map.length === n.length ? map : null;
  }

  function snapshot(old, leaving) {
    if (!old || !on() || !visible(old)) return null;
    var box = old.getBoundingClientRect();
    var list = blocks(old, leaving);
    var before = list.map(function (b) { return { sig: sig(b), top: b.getBoundingClientRect().top - box.top }; });
    var head = old.firstElementChild;
    var wasOpen = head ? head.getAttribute('aria-expanded') : null;
    if (leaving && visible(leaving)) ghost(leaving);
    return safe(function (fresh, container) {
      var now = fresh.getBoundingClientRect();
      var fl = blocks(fresh, null);
      var tops = fl.map(function (b) { return b.getBoundingClientRect().top - now.top; });
      var map = match(before.map(function (b) { return b.sig; }), fl.map(sig), !!leaving);
      for (var i = 0; i < fl.length; i++) {
        if (!map) { if (i) play(fl[i], [{ opacity: 0 }, { opacity: 1 }], { duration: MS.quick, easing: 'ease-out' }); continue; }
        if (map[i] < 0) play(fl[i], [{ opacity: 0, transform: 'translateY(-6px)' }, { opacity: 1, transform: STILL }], { duration: MS.base, easing: OUT });
        else glide(fl[i], before[map[i]].top - tops[i]);
      }
      var nowHead = fresh.firstElementChild;
      var open = nowHead ? nowHead.getAttribute('aria-expanded') : null;
      if (open !== wasOpen && nowHead) {
        play(nowHead.querySelector('.chev'), [{ transform: 'rotate(' + (open === 'true' ? 0 : 180) + 'deg)' }, { transform: 'rotate(' + (open === 'true' ? 180 : 0) + 'deg)' }],
          { duration: MS.base, easing: OUT });
      }
      // Everything after the card, up to the container, follows its new height.
      var dy = box.height - now.height;
      for (var n = fresh; n && n !== container; n = n.parentNode) {
        for (var s = n.nextElementSibling; s; s = s.nextElementSibling) glide(s, dy);
      }
    });
  }

  /* sheet / hand-off --------------------------------------------------------------------------- */

  function out(el, done) {
    if (!el || !on()) return false;
    if (el._out) return true;
    var a = play(el, [{ opacity: 1, transform: STILL }, { opacity: 0, transform: el.classList.contains('sheet') ? 'translateY(48px)' : STILL }],
      { duration: MS.exit, easing: IN, fill: 'forwards' });
    if (!a) return false;
    el._out = a;
    el.style.pointerEvents = 'none'; // what is leaving never catches a tap
    a.onfinish = function () {
      if (el._out !== a) return;
      el._out = null;
      done();
      a.cancel();
      el.style.pointerEvents = '';
    };
    return true;
  }
  function keep(el) {
    if (!el || !el._out) return;
    var a = el._out;
    el._out = null;
    a.cancel();
    el.style.pointerEvents = '';
  }
  function handoff(el) {
    return play(el, [{ opacity: 1, transform: STILL }, { opacity: 0.35, transform: 'translateY(-10px)' }], { duration: 260, easing: IN, fill: 'forwards' });
  }

  /* passive listeners: steppers roll, the chosen chip pops ------------------------------------- */

  function read(el) { return 'value' in el && el.tagName !== 'OUTPUT' ? el.value : el.textContent; }
  function isOn(el) {
    return el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true';
  }
  function wire() {
    var CHOICE = '.chip, .date-chip, .seg button';
    var pending = null;
    // iOS only applies :active (the press feedback in styles.css) when a touch listener exists.
    document.addEventListener('touchstart', function () {}, { passive: true });
    document.addEventListener('click', function (e) {
      pending = null;
      var t = e.target;
      if (!t || !t.closest || !on()) return;
      var step = t.closest('.step-btn, .mini-step button');
      if (step) {
        var holder = step.parentNode;
        var field = holder.querySelector('input, output');
        if (field) pending = { field: field, before: read(field), sign: step === holder.firstElementChild ? -1 : 1 };
        return;
      }
      var choice = t.closest(CHOICE);
      if (choice && !isOn(choice)) pending = { choice: choice.className + '|' + choice.textContent };
    }, true);
    document.addEventListener('click', safe(function () {
      var p = pending;
      pending = null;
      if (!p) return;
      if (p.field) { roll(p.field, read(p.field) === p.before ? 0 : p.sign); return; }
      // The app re-rendered: the chosen chip is a new element with the same class and text.
      var all = document.querySelectorAll(CHOICE);
      for (var i = 0; i < all.length; i++) {
        if (isOn(all[i]) && all[i].className + '|' + all[i].textContent === p.choice) { pop(all[i]); return; }
      }
    }));
  }

  var api = {
    viewIn: safe(viewIn), settle: safe(settle), stagger: safe(stagger), enter: safe(enter), review: safe(review),
    pop: safe(pop), roll: safe(roll), fill: safe(fill), shake: safe(shake),
    snapshot: safe(snapshot, null), leave: safe(leave, null),
    out: safe(out, false), keep: safe(keep), handoff: safe(handoff, null),
    match: match, enabled: on,
  };

  if (typeof document !== 'undefined' && document.addEventListener) { try { wire(); } catch (e) { /* decoration only */ } }
  root.ShapeMotion = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
