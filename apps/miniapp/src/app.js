/**
 * Shape mini app: DOM, Telegram glue and the mascot. Classic script; pure logic lives in core.js
 * (global ShapeCore). Nothing here writes anywhere: the page builds payload v1, shows it for review
 * and hands it to Telegram.WebApp.sendData. The bot's reply is the only confirmation.
 */
(function () {
  'use strict';

  // Older Android/iOS WebViews lack replaceChildren; everything else used here is older than it.
  if (!Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
      while (this.firstChild) this.removeChild(this.firstChild);
      for (var i = 0; i < arguments.length; i++) {
        var c = arguments[i];
        this.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      }
    };
  }

  var C = window.ShapeCore;
  var V = window.ShapeVoice || null;
  var VS = window.ShapeVoiceStub || null;
  var tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  var launch = C.parseHash(location.hash, location.search);
  // KeyboardButton launches (the ones sendData needs) get an EMPTY initData, so "inside Telegram"
  // comes from the platform the SDK detected or from Telegram's tgWebApp* launch params.
  var inTelegram = !!((tg && tg.platform && tg.platform !== 'unknown') || launch.telegram);
  var LEGACY_DRAFT_KEY = 'shape-miniapp:draft:v1';
  var storage = null;
  try { storage = window.localStorage; } catch (e) { storage = null; }
  var store = null; // C.draftStore, once the catalog (client) is known

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    banner: $('preview-banner'), shape: $('shape'), say: $('say'), restBar: $('rest-bar'), tabs: document.querySelectorAll('.tab'),
    tabBar: document.querySelector('.tabs'), dates: $('dates'), view: $('view'),
    voicePanel: $('voice-panel'), review: $('review'),
    dock: $('dock'), dockPrimary: $('dock-primary'), dockSecondary: $('dock-secondary'), dockMic: $('dock-mic'),
    sheet: $('sheet'), backdrop: $('sheet-backdrop'),
  };

  var S = {
    catalog: null,
    view: 'workout',
    screen: 'form',
    reviewView: '',
    today: '',
    dates: [],
    showErrors: false,
    focus: null,
    // One form per (date, session): {complete, cards}. Only the visible one is sent.
    workout: { date: '', session: '', forms: {} },
    food: { date: '', meal: '', items: [], mode: 'food', compose: null, waterAdd: 0, waterId: '' },
    sheetOpen: false,
    bodyOpen: false, // the week's muscle map on the workout form
  };

  /* helpers ---------------------------------------------------------------------------------- */

  function h(tag, attrs) {
    var el = document.createElement(tag);
    var a = attrs || {};
    Object.keys(a).forEach(function (k) {
      var v = a[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  var ICONS = {
    repeat: '<path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5"/><path d="M20 4v4.5h-4.5"/><path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5"/><path d="M4 20v-4.5h4.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4M8 21h8"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor" stroke="none"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    drop: '<path d="M12 2.7 6.3 8.4a8 8 0 1 0 11.4 0L12 2.7z"/>',
    swap: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  };
  function icon(name) {
    var span = document.createElement('span');
    span.className = 'ic';
    span.setAttribute('aria-hidden', 'true');
    // Constant markup only (never user text).
    span.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
    var svg = span.firstChild;
    if (svg && svg.setAttribute) svg.setAttribute('aria-hidden', 'true');
    return svg;
  }

  function haptic(kind) {
    if (!tg || !tg.HapticFeedback || !versionAtLeast('6.1')) return;
    try {
      if (kind === 'select') tg.HapticFeedback.selectionChanged();
      else if (kind === 'error' || kind === 'success' || kind === 'warning') tg.HapticFeedback.notificationOccurred(kind);
      else tg.HapticFeedback.impactOccurred(kind || 'light');
    } catch (e) { /* older client */ }
  }
  function versionAtLeast(v) {
    try { return !!(tg && tg.isVersionAtLeast && tg.isVersionAtLeast(v)); } catch (e) { return false; }
  }

  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  function capFirst(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
  function dateLabel(key) {
    var opt = S.dates.filter(function (d) { return d.key === key; })[0];
    return (opt ? opt.label + ', ' : '') + C.weekday(key) + ' ' + C.shortDate(key);
  }

  /* Shape (mascot) --------------------------------------------------------------------------- */

  // Artwork stays swappable; context/reaction decisions come from ShapeCore.
  var Avatar = window.ShapeAvatar;
  var MM = window.MuscleMotion || null; // progressive enhancement – absent = no-op
  var Body = window.ShapeBody || null; // the muscle map (src/body.js); the page works without it
  if (Avatar) Avatar.mount(els.shape, els.say);
  if (MM && typeof MM.attachLife === 'function') {
    try { MM.attachLife(els.shape); } catch (e) { /* ignore */ }
  }
  if (Avatar && Avatar.intro) Avatar.intro('Abrindo sua ficha'); // lands in the header on the first say()

  function nowMs() {
    return typeof window.__shapeNow === 'function' ? window.__shapeNow() : Date.now();
  }

  // Ephemeral rest timer state (never serialized into drafts or sendData payloads).
  var rest = {
    active: false, totalMs: 0, endAt: 0, label: '', warned10: false,
    timer: null, lastShownSec: -1, timeEl: null, labelEl: null,
  };

  function syncForm(extra) {
    if (!Avatar || !Avatar.setForm) return;
    var ctx = {
      view: S.view,
      screen: sending ? 'sent' : S.screen,
      dozing: !!(Avatar.dozing && Avatar.dozing()),
      resting: rest.active,
      intro: !S.catalog,
    };
    if (extra) Object.keys(extra).forEach(function (k) { ctx[k] = extra[k]; });
    var nextForm = Avatar.formFor ? Avatar.formFor(ctx)
      : (ctx.dozing ? 'descanso' : (ctx.screen === 'review' || ctx.screen === 'sent') ? 'revisao'
        : ctx.resting ? 'descanso'
          : ctx.intro ? 'base' : ctx.view === 'workout' ? 'treino' : ctx.view === 'food' ? 'refeicao'
            : ctx.view === 'water' ? 'agua' : 'base');
    var currentForm = els.shape && els.shape.getAttribute ? els.shape.getAttribute('data-form') : null;
    if (MM && typeof MM.morph === 'function' && currentForm !== nextForm) {
      try { MM.morph(els.shape, nextForm); } catch (e) { Avatar.setForm(nextForm); }
    } else {
      Avatar.setForm(nextForm);
    }
  }
  syncForm({ intro: true });

  function say(mood, text) {
    if (!Avatar) { if (text) els.say.textContent = text; return; }
    var wasDozing = Avatar.dozing && Avatar.dozing();
    if (Avatar.setDozing) Avatar.setDozing(false);
    if (wasDozing) syncForm();
    Avatar.setMood(mood);
    Avatar.say(text);
    els.say.scrollTop = 0;
  }

  var tipTap = 0, tipKey = '', focusedCard = null, gazeTarget = null, idleTimer = null;
  var observedForm = null, observedCards = [];

  function currentPlan() {
    return S.catalog ? S.catalog.plan.filter(function (row) { return row.s === S.workout.session; }) : [];
  }

  function pulsoContext() {
    if (S.reviewView === 'water') {
      return { view: 'water', waterTotal: Math.round((baseWaterL() + (S.food.waterAdd || 0)) * 100) / 100 };
    }
    var compose = S.food.compose;
    return { view: S.view, cards: S.catalog && S.workout.session ? cards() : [], cardIndex: focusedCard, plan: currentPlan(),
      items: S.food.items, compose: compose && S.food.mode === 'description'
        ? { kind: 'description', description: compose.description, qty: compose.dqty } : null };
  }

  function react(reaction) {
    if (!reaction) return;
    say(reaction.mood, reaction.line);
    if (Avatar && Avatar.pulse) Avatar.pulse(reaction.pulse);
    if (reaction.pulse === 'full') choreograph('milestone');
    else if (reaction.pulse === 'celebrate') choreograph('proud');
    else if (reaction.pulse === 'nod') choreograph('acknowledge');
  }

  function glance(target) {
    gazeTarget = target;
    if (Avatar && Avatar.glance) Avatar.glance(target);
    if (MM && typeof MM.anticipateLook === 'function' && els.shape) {
      try { MM.anticipateLook(els.shape, target); } catch (e) { /* ignore */ }
    }
  }

  function choreograph(name, target, opts) {
    if (!MM || typeof MM.playSequence !== 'function' || !els.shape) return null;
    try {
      return MM.playSequence(els.shape, name, Object.assign({ target: target || gazeTarget }, opts || {}));
    } catch (e) { return null; }
  }

  function perch(target, opts) {
    if (Avatar && typeof Avatar.perch === 'function') {
      try { Avatar.perch(target, opts); } catch (e) { /* ignore */ }
    }
  }

  function wake() {
    var wasDozing = Avatar && Avatar.dozing && Avatar.dozing();
    if (Avatar && Avatar.setDozing) Avatar.setDozing(false);
    if (wasDozing) {
      syncForm();
      if (gazeTarget && Avatar.glance) Avatar.glance(gazeTarget);
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function restIdle() {
      if (C.pulsoDozing(C.PULSO_IDLE_MS, !S.catalog || sending || reviewTimer !== null || S.sheetOpen || rest.active || isVoiceActive())) {
        if (Avatar && Avatar.setDozing) Avatar.setDozing(true);
        syncForm();
      } else idleTimer = setTimeout(restIdle, C.PULSO_IDLE_MS);
    }, C.PULSO_IDLE_MS);
  }

  els.shape.addEventListener('pointerdown', function (e) { e.preventDefault(); }); // keep the typing field focused
  els.shape.addEventListener('click', function () {
    wake();
    perch(null);
    var context = pulsoContext(), key = C.pulsoTips(context).join('\n');
    if (key !== tipKey) { tipKey = key; tipTap = 0; }
    react(C.pulsoTip(context, tipTap++));
  });
  document.addEventListener('pointerdown', wake);
  document.addEventListener('keydown', wake);
  document.addEventListener('input', wake);
  document.addEventListener('scroll', function () { if (gazeTarget) glance(gazeTarget); }, true);
  if (window.addEventListener) window.addEventListener('resize', function () { if (gazeTarget) glance(gazeTarget); });
  wake();

  /** A large Shape for empty, error and success states (its own, independent mood and form). */
  function mascot(mood, title, text, formName) {
    var f = formName || 'base';
    var box = Avatar ? Avatar.create(mood, f) : h('div', { class: 'shape' });
    if (box && box.setAttribute && !box.getAttribute('data-form')) box.setAttribute('data-form', f);
    return h('div', { class: 'mascot-scene' }, box, h('p', {}, title ? h('b', { text: title }) : null, text));
  }

  /** Motion is decoration (src/motion.js): a missing or failing call changes nothing. */
  function motion(name) {
    var M = window.ShapeMotion;
    if (!M || typeof M[name] !== 'function') return null;
    try { return M[name].apply(M, Array.prototype.slice.call(arguments, 1)); } catch (e) { return null; }
  }
  function scrollInto(el, block) {
    if (!el || typeof el.scrollIntoView !== 'function') return;
    var smooth = !!(window.ShapeMotion && typeof window.ShapeMotion.enabled === 'function' && window.ShapeMotion.enabled());
    el.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: block || 'center' });
  }
  /** Run a re-render that drops `el`: its ghost fades out and what was below closes the gap. */
  function dropping(el, fn) {
    var after = motion('leave', el, els.view);
    fn();
    if (after) after();
  }
  /** "This needs a fix": shake the target; Shape shakes too (setMood only does it on a mood change). */
  function nudge(target) {
    motion('shake', target);
    if (Avatar && Avatar.pulse && Avatar.mood() === 'alert') Avatar.pulse('no');
  }

  /** Resolve the core's first error to a visible field, without moving keyboard focus. */
  function errorTarget(error, composerOnly) {
    var container = els.view, path = error.path || '';
    if (error.card !== undefined) {
      container = cardEls[error.card] || els.view;
      path = path.replace(/^exercises\[\d+\]\./, '');
    } else if (error.item !== undefined) {
      return els.view.querySelectorAll('.plate-item')[error.item] || els.view;
    } else if (path === 'date') return els.dates;
    else if (path === 'session') return els.view.querySelector('.chip-row');
    else if (path === 'meal') return els.view.querySelector('.chip-wrap');
    if (composerOnly) container = els.view.querySelector('.panel') || els.view;
    var fields = container.querySelectorAll('input');
    var texts = container.querySelectorAll('textarea');
    var candidates = Array.prototype.slice.call(fields).concat(Array.prototype.slice.call(texts));
    return candidates.filter(function (field) { return field.getAttribute('data-error-path') === path; })[0] || container;
  }

  /** A work set that counts: kg and reps in range. */
  function setDone(s) {
    return C.workSetDone(s);
  }
  function doneSets(card) { return C.filledSets(card).filter(setDone).length; }

  /* rest timer ------------------------------------------------------------------------------- */

  function ensureRestBar() {
    if (els.restBar || !els.tabBar || !els.tabBar.parentNode) return els.restBar;
    var bar = h('div', { class: 'rest-bar', id: 'rest-bar', hidden: true });
    bar.hidden = true;
    els.tabBar.parentNode.insertBefore(bar, els.tabBar);
    els.restBar = bar;
    return bar;
  }

  function clearRestTimer() {
    if (rest.timer !== null) {
      clearTimeout(rest.timer);
      rest.timer = null;
    }
  }

  function renderRestBar() {
    var bar = ensureRestBar();
    if (!bar) return;
    if (!rest.timeEl) {
      rest.timeEl = h('b', { class: 'rest-time' });
      rest.labelEl = h('span', { class: 'rest-label' });
      bar.replaceChildren(
        h('div', { class: 'rest-bar-main' }, icon('clock'), rest.timeEl, rest.labelEl),
        h('div', { class: 'rest-actions' },
          h('button', { type: 'button', class: 'rest-btn rest-minus', 'aria-label': 'Tirar 15 segundos de descanso', text: '−15s', onclick: function () { adjustRest(-C.REST_LIMITS.STEP); } }),
          h('button', { type: 'button', class: 'rest-btn rest-plus', 'aria-label': 'Somar 15 segundos de descanso', text: '+15s', onclick: function () { adjustRest(C.REST_LIMITS.STEP); } }),
          h('button', { type: 'button', class: 'rest-btn rest-skip', text: 'Pular', onclick: function () { stopRest(false); } })));
    }
    bar.hidden = !rest.active;
    var sec = rest.active ? Math.max(0, Math.ceil((rest.endAt - nowMs()) / 1000)) : 0;
    rest.timeEl.textContent = C.formatRestClock(sec);
    rest.labelEl.textContent = rest.label || 'Descanso';
  }

  function syncRestRing(remMs) {
    if (Avatar && Avatar.setProgress) {
      Avatar.setProgress(C.restProgress(remMs, rest.totalMs));
    }
  }

  function finishRest() {
    var label = rest.label;
    clearRestTimer();
    rest.active = false;
    rest.lastShownSec = -1;
    if (els.restBar) els.restBar.hidden = true;
    syncForm();
    syncProgress();
    haptic('success');
    say('happy', 'Descanso acabou! Próxima série' + (label ? ' de ' + label : '') + '.');
    if (Avatar && Avatar.pulse) Avatar.pulse('full');
  }

  function stopRest(silent) {
    if (!rest.active && rest.timer === null) return;
    clearRestTimer();
    rest.active = false;
    rest.lastShownSec = -1;
    if (els.restBar) els.restBar.hidden = true;
    syncForm();
    syncProgress();
    if (!silent) {
      haptic('light');
      updateMood();
    }
  }

  function tickRest() {
    if (!rest.active) return;
    var remMs = rest.endAt - nowMs();
    if (remMs <= 0) {
      finishRest();
      return;
    }
    var sec = Math.ceil(remMs / 1000);
    if (sec <= 10 && !rest.warned10) {
      rest.warned10 = true;
      haptic('light');
    }
    if (sec !== rest.lastShownSec) {
      rest.lastShownSec = sec;
      if (rest.timeEl) rest.timeEl.textContent = C.formatRestClock(sec);
    }
    syncRestRing(remMs);
    rest.timer = setTimeout(tickRest, 250);
  }

  function startRest(seconds, label) {
    var parsed = Math.round(Number(seconds));
    var sec = Number.isFinite(parsed)
      ? Math.min(C.REST_LIMITS.MAX, Math.max(C.REST_LIMITS.MIN, parsed))
      : C.REST_LIMITS.DEFAULT;
    clearRestTimer();
    rest.active = true;
    rest.totalMs = sec * 1000;
    rest.endAt = nowMs() + rest.totalMs;
    rest.label = label || '';
    rest.warned10 = sec <= 10;
    rest.lastShownSec = sec;
    wake();
    perch(null);
    haptic('light');
    renderRestBar();
    syncForm();
    syncRestRing(rest.totalMs);
    say('focused', 'Descanso ' + C.formatRestClock(sec) + (rest.label ? ' · ' + rest.label : ''));
    choreograph('focus', els.restBar);
    rest.timer = setTimeout(tickRest, 250);
  }

  function adjustRest(deltaSec) {
    if (!rest.active) return;
    var now = nowMs();
    var maxMs = C.REST_LIMITS.MAX * 1000;
    var nextRem = Math.min(maxMs, (rest.endAt - now) + deltaSec * 1000);
    if (nextRem <= 0) {
      finishRest();
      return;
    }
    rest.endAt = now + nextRem;
    rest.totalMs = Math.max(rest.totalMs, nextRem);
    if (nextRem > 10000) rest.warned10 = false;
    rest.lastShownSec = Math.ceil(nextRem / 1000);
    if (rest.timeEl) rest.timeEl.textContent = C.formatRestClock(rest.lastShownSec);
    haptic('select');
    syncRestRing(nextRem);
  }

  /** Avatar ring: rest countdown while active, else explicit planned sets or exercises; meal = items / 3. */
  function syncProgress() {
    if (!S.catalog) return;
    if (S.view === 'workout' && S.workout.session) {
      observedForm = form();
      observedCards = JSON.parse(JSON.stringify(cards()));
    }
    if (rest.active && S.view === 'workout' && S.screen === 'form' && !isVoiceActive()) {
      syncRestRing(Math.max(0, rest.endAt - nowMs()));
      return;
    }
    if (!Avatar || !Avatar.setProgress) return;
    if (S.view !== 'workout') { Avatar.setProgress(Math.min(S.food.items.length / 3, 1)); return; }
    var list = cards();
    var planned = C.pulsoPlan(list, currentPlan());
    // Unknown prescriptions retain the old exercise meter; explicit plans count every set.
    var total = planned.known ? planned.total : list.length;
    var done = planned.known ? planned.done : list.filter(function (c) { return doneSets(c) > 0; }).length;
    Avatar.setProgress(total ? done / total : 0);
  }

  /** Mood from the current state: focused while typing, alert on errors shown, happy when ready. */
  function updateMood() {
    if (!S.catalog) return;
    syncForm();
    syncProgress();
    if (S.screen === 'review') {
      say('happy', 'Revise e envie. A planilha confere, e o bot confirma o que gravou.');
      return;
    }
    if (S.focus) { say('focused', S.focus); return; }
    var r = build();
    if (S.showErrors && r.errors.length) {
      var error = C.pulsoError(r.errors);
      say(error.mood, error.line);
      return;
    }
    if (S.view === 'workout') {
      var n = r.args ? r.args.exercises.length : filledCount();
      if (r.args && (n || form().complete)) say('happy', n ? plural(n, 'exercício pronto', 'exercícios prontos') + '. Pode revisar.' : 'Sessão marcada como concluída. Pode revisar.');
      else if (!S.workout.session) say('idle', 'Escolha a sessão de hoje.');
      else if (!cards().length) say('idle', S.workout.session + ' não tem exercícios na ficha. Adicione do catálogo.');
      else if (n) say('idle', n + ' de ' + plural(cards().length, 'exercício', 'exercícios') + ' com séries.');
      else say('idle', S.workout.session + ': registre série por série.');
    } else {
      var k = S.food.items.length;
      if (r.args) say('happy', S.food.meal + ', ' + plural(k, 'item', 'itens') + '. Pode revisar.');
      else if (!k && S.food.waterAdd > 0) say('happy', C.formatWaterDelta(S.food.waterAdd) + ' de água pronto para revisar.');
      else if (!S.food.meal) say('idle', 'Escolha a refeição.');
      else if (!k) say('idle', S.food.meal + ': adicione o que você comeu.');
      else say('idle', S.food.meal + ' com ' + plural(k, 'item', 'itens') + '.');
    }
  }

  document.addEventListener('focusin', function (e) {
    var t = e.target;
    wake();
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
      var cardEl = null;
      for (var parent = t; parent && parent.getAttribute; parent = parent.parentNode) {
        if (parent.hasAttribute('data-card-index')) {
          focusedCard = Number(parent.getAttribute('data-card-index'));
          cardEl = parent;
          break;
        }
      }
      glance(t);
      if (cardEl) perch(cardEl, { mode: 'card' });
      if (t.getAttribute('data-say')) { S.focus = t.getAttribute('data-say'); updateMood(); }
    }
  });
  document.addEventListener('focusout', function (e) {
    var leaving = e.target;
    setTimeout(function () {
      var a = document.activeElement;
      if (!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) {
        S.focus = null;
        // Validation may have just installed a new target while removing the old input.
        if (gazeTarget === leaving) {
          glance(null);
          perch(null);
        }
      }
    }, 0);
  });

  /* draft ------------------------------------------------------------------------------------ */

  var saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDraft, 350);
  }
  /** Every workout form (one per date+session) and the meal are saved separately. */
  function saveDraft() {
    if (!store) return;
    clearTimeout(saveTimer);
    Object.keys(S.workout.forms).forEach(function (k) {
      var f = S.workout.forms[k];
      store.saveWorkout({ id: f.id, date: f.date, session: f.session, complete: f.complete, cards: f.cards, savedAt: f.touchedAt });
    });
    store.saveFood({ id: S.food.id, date: S.food.date, meal: S.food.meal, items: S.food.items });
  }

  /** Before clearing what was sent, keep it in the "last sent" history (5 entries). */
  function recordAndClearSent(t, json) {
    if (!store) return;
    clearTimeout(saveTimer);
    if (t === 'workout') {
      var f = form();
      store.recordSent({ t: t, label: f.session + ', ' + C.weekday(f.date) + ' ' + C.shortDate(f.date), json: json,
        form: JSON.parse(JSON.stringify({ id: f.id, date: f.date, session: f.session, complete: f.complete, cards: f.cards })) });
      store.clearWorkout(f.date, f.session);
    } else if (t === 'water') {
      store.recordSent({
        t: 'water',
        label: 'Água ' + C.formatLiters(baseWaterL() + (S.food.waterAdd || 0)) + ', ' + C.weekday(S.food.date) + ' ' + C.shortDate(S.food.date),
        json: json,
        form: { id: S.food.waterId, date: S.food.date, addWaterL: S.food.waterAdd },
      });
    } else {
      store.recordSent({ t: t, label: S.food.meal + ', ' + C.weekday(S.food.date) + ' ' + C.shortDate(S.food.date), json: json,
        form: JSON.parse(JSON.stringify({ id: S.food.id, date: S.food.date, meal: S.food.meal, items: S.food.items })) });
      store.clearFood();
    }
  }

  /* Telegram buttons / dock ------------------------------------------------------------------ */

  var mainHandler = null;
  function setMain(text, handler) {
    mainHandler = handler;
    if (inTelegram && tg.MainButton) {
      var cs = getComputedStyle(document.documentElement);
      try {
        tg.MainButton.setParams({
          text: text, is_visible: true, is_active: true,
          color: cs.getPropertyValue('--accent').trim() || undefined,
          text_color: cs.getPropertyValue('--accent-ink').trim() || undefined,
        });
      } catch (e) { tg.MainButton.setText(text); tg.MainButton.show(); }
    } else {
      els.dockPrimary.hidden = false;
      els.dockPrimary.disabled = false;
      els.dockPrimary.textContent = text;
      syncVoiceDock();
    }
  }
  function hideMain() {
    mainHandler = null;
    if (inTelegram && tg.MainButton) {
      try { tg.MainButton.setParams({ is_visible: false }); }
      catch (e) { try { tg.MainButton.hide(); } catch (ignore) { /* ignore */ } }
    } else {
      els.dockPrimary.hidden = true;
      syncVoiceDock();
    }
  }
  function onMain() { if (mainHandler) mainHandler(); }
  /** Turns the main button (and its handler) off while a send is in flight, back on if it fails. */
  function setMainActive(on, handler) {
    mainHandler = on ? handler : null;
    if (inTelegram && tg.MainButton) {
      try { tg.MainButton.setParams({ is_active: on }); } catch (e) { if (on) tg.MainButton.enable(); else tg.MainButton.disable(); }
    } else {
      els.dockPrimary.disabled = !on;
    }
  }

  function setSecondary(text, handler) {
    if (inTelegram) return; // BackButton covers it inside Telegram.
    els.dockSecondary.hidden = !text;
    els.dockSecondary.textContent = text || '';
    els.dockSecondary.onclick = handler || null;
    syncVoiceDock();
  }

  function updateBack() {
    if (!inTelegram || !tg.BackButton || !versionAtLeast('6.1')) return;
    if (S.sheetOpen || S.screen === 'review') tg.BackButton.show(); else tg.BackButton.hide();
  }
  function onBack() {
    if (S.sheetOpen) closeSheet();
    else if (S.screen === 'review') showForm();
  }

  function updateMainForForm() {
    if (isVoiceActive()) return;
    var label;
    var handler = goReview;
    if (S.view === 'workout') {
      var n = filledCount();
      label = n ? 'Revisar treino (' + n + ')' : 'Revisar treino';
    } else if (!S.food.items.length && S.food.waterAdd > 0) {
      label = 'Revisar água (' + C.formatWaterDelta(S.food.waterAdd) + ')';
      handler = goWaterReview;
    } else {
      var k = S.food.items.length;
      label = k ? 'Revisar refeição (' + k + ')' : 'Revisar refeição';
    }
    setMain(label, handler);
    setSecondary(null);
    syncVoiceDock();
  }

  /* model shortcuts -------------------------------------------------------------------------- */

  function formKey(date, session) { return date + '|' + session; }
  /** The visible workout form; created from the plan the first time a (date, session) is opened. */
  function form() {
    var w = S.workout;
    var k = formKey(w.date, w.session);
    if (!w.forms[k]) w.forms[k] = { date: w.date, session: w.session, complete: false, cards: C.planCards(S.catalog, w.session) };
    return w.forms[k];
  }
  /** The submission id of a form (workout form or S.food), made when the draft is started. */
  function draftId(f) {
    if (!C.isSubmissionId(f.id)) f.id = C.newSubmissionId();
    return f.id;
  }
  function currentId() { return draftId(S.view === 'workout' ? form() : S.food); }
  function cards() {
    if (!S.workout.session) return [];
    return form().cards;
  }
  function filledCount() {
    return cards().filter(function (c) { return !C.cardIsEmpty(c); }).length;
  }
  function planRowFor(name) {
    var rows = S.catalog.plan.filter(function (r) { return C.sameName(r.e, name); });
    var mine = rows.filter(function (r) { return r.s === S.workout.session; })[0];
    return mine || rows[0] || null;
  }
  function build() {
    var opts = { today: S.today };
    if (S.view === 'workout') {
      return C.buildWorkout({ date: S.workout.date, session: S.workout.session, complete: S.workout.session ? form().complete : false, cards: cards() }, S.catalog, opts);
    }
    return C.buildFood({ date: S.food.date, meal: S.food.meal, items: S.food.items }, S.catalog, opts);
  }

  /** After any edit: draft, button label, live errors once they were shown. */
  function changed(structural, options) {
    var opts = options || {};
    opts.plan = currentPlan();
    var reaction = S.view === 'workout' && S.workout.session && observedForm === form()
      ? C.pulsoReaction(observedCards, cards(), opts.cardIndex, opts.setIndex, opts) : null;
    // A review being prepared would show what the form no longer holds; back to the form's mood.
    if (cancelReview()) structural = true;
    // Remember which workout form was edited last, so the app reopens there.
    if (S.view === 'workout' && S.workout.session && S.screen === 'form') form().touchedAt = Date.now();
    scheduleSave();
    updateMainForForm();
    if (S.showErrors) refreshErrors();
    if (reaction && !opts.quiet) { syncProgress(); react(reaction); }
    else if (!opts.quiet && (structural || S.showErrors)) updateMood(); else syncProgress();
    syncBody();
    if (S.view === 'food') syncNutrition();
  }

  /* chrome: tabs and dates ------------------------------------------------------------------- */

  function renderChrome() {
    els.tabBar.hidden = !!S.catalog.view;
    els.tabBar.setAttribute('data-view', S.view); // styles.css slides the selected pill
    Array.prototype.forEach.call(els.tabs, function (t) {
      t.setAttribute('aria-selected', String(t.getAttribute('data-view') === S.view));
    });
    var current = S.view === 'workout' ? S.workout.date : S.food.date;
    els.dates.replaceChildren.apply(els.dates, S.dates.map(function (d) {
      return h('button', {
        type: 'button', role: 'radio', class: 'date-chip', 'aria-checked': String(d.key === current),
        onclick: function () {
          if (isVoiceActive()) return;
          if (S.view === 'workout') S.workout.date = d.key;
          else { S.food.date = d.key; S.food.waterAdd = 0; S.food.waterId = ''; }
          haptic('select');
          render();
          motion('settle', els.view);
          changed(true);
        },
      }, d.label, h('small', { text: C.weekday(d.key) + ' ' + C.shortDate(d.key) }));
    }));
    if (isVoiceActive()) setFormLocked(true);
  }

  Array.prototype.forEach.call(els.tabs, function (t) {
    t.addEventListener('click', function () {
      if (isVoiceActive()) return;
      var v = t.getAttribute('data-view');
      if (v === S.view || (S.catalog.view && S.catalog.view !== v)) return;
      if (v !== 'workout') stopRest(true);
      S.view = v;
      S.showErrors = false;
      haptic('select');
      render();
      motion('viewIn', els.view, v === 'food' ? 1 : -1); // Refeição sits to the right of Treino
      scheduleSave();
    });
  });

  /* stepper ---------------------------------------------------------------------------------- */

  /**
   * opts: {value, step, min, max, start, unit, label, big, integer, say, onChange}
   * `start` (e.g. last work) shows as a ghost placeholder and is what the first tap fills in.
   */
  function stepper(opts) {
    var startText = opts.start === null || opts.start === undefined ? '' : C.formatBR(opts.start);
    var input = h('input', {
      class: 'step-input', type: 'text', inputmode: opts.integer ? 'numeric' : 'decimal',
      autocomplete: 'off', enterkeyhint: 'done', value: opts.value || '', placeholder: startText || '–',
      'aria-label': opts.label, 'data-say': opts.say, 'data-error-path': opts.path,
      oninput: function () { opts.onChange(input.value); },
      onkeydown: function (e) { if (e.key === 'Enter') input.blur(); },
    });
    function step(sign) {
      input.value = C.stepValue(input.value, sign * opts.step, opts.min, opts.max, opts.start);
      haptic('select');
      opts.onChange(input.value);
    }
    var stepText = C.formatBR(opts.step);
    var minus = h('button', { type: 'button', class: 'step-btn', 'aria-label': 'Menos ' + stepText + ' em ' + opts.label, onclick: function () { step(-1); } }, opts.big ? '−' + stepText : '−');
    var plus = h('button', { type: 'button', class: 'step-btn', 'aria-label': 'Mais ' + stepText + ' em ' + opts.label, onclick: function () { step(1); } }, opts.big ? '+' + stepText : '+');
    var field = h('label', { class: 'step-field' }, input, opts.unit ? h('span', { class: 'step-unit', text: opts.unit }) : null);
    var wrap = h('div', {}, h('div', { class: 'stepper' + (opts.big ? ' big' : '') }, minus, field, plus));
    if (opts.caption) wrap.appendChild(h('span', { class: 'step-label', text: opts.caption }));
    return wrap;
  }

  /* workout view ----------------------------------------------------------------------------- */

  var cardEls = [];

  /* body map ----------------------------------------------------------------------------------- */

  var bodyEl = null;   // the map on the workout form
  var bodyNote = null; // its sentence ("Músculos trabalhados: …")

  /** Map levels for `items` ([{name, sets}]), on top of the last 7 days when `withWeek`. */
  function bodyLevels(items, withWeek) {
    return Body.levels(C.muscleEntries(S.catalog, items, withWeek));
  }
  function draftSets() {
    return cards().map(function (c) { return { name: c.name, sets: doneSets(c) }; });
  }
  /** The week's map follows the form: a muscle lights up when its first valid set is typed. */
  function syncBody() {
    if (!bodyEl || S.view !== 'workout') return;
    var levels = bodyLevels(draftSets(), true);
    Body.update(bodyEl, levels);
    bodyNote.textContent = Body.describe(levels);
  }
  function bodyPanel() {
    bodyEl = bodyNote = null;
    if (!Body) return null;
    var levels = bodyLevels(draftSets(), true);
    bodyEl = Body.create(levels, { title: 'Músculos nos últimos 7 dias' });
    bodyNote = h('p', { class: 'body-note', text: Body.describe(levels) });
    var box = h('details', { class: 'body-panel', ontoggle: function () { S.bodyOpen = !!box.open; } },
      h('summary', { text: 'Músculos nos últimos 7 dias' }), bodyEl, bodyNote);
    box.open = S.bodyOpen;
    return box;
  }

  function renderWorkout() {
    var w = S.workout;
    var list = cards();
    var isNext = w.session && w.session === S.catalog.next;
    var head = h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: w.session || 'Treino' }),
      h('p', { class: 'view-sub', text: w.session
        ? (isNext ? 'Próxima da rotação. ' : '') + plural(S.catalog.plan.filter(function (r) { return r.s === w.session; }).length, 'exercício na ficha', 'exercícios na ficha')
        : 'Escolha a sessão.' }));

    var chips = h('div', { class: 'chip-row', role: 'radiogroup', 'aria-label': 'Sessão' }, S.catalog.sessions.map(function (s) {
      return h('button', {
        type: 'button', role: 'radio', class: 'chip', 'aria-checked': String(s === w.session),
        onclick: function () {
          if (s === w.session) return;
          w.session = s;
          focusedCard = null;
          S.focus = null;
          glance(null);
          haptic('select');
          renderWorkout();
          motion('stagger', cardEls);
          changed(true);
        },
      }, s, s === S.catalog.next ? h('span', { class: 'tag', text: 'próxima' }) : null);
    }));

    var cardsBox = h('div', { class: 'cards' });
    cardEls = [];
    if (!list.length) {
      cardsBox.appendChild(h('div', { class: 'empty-plan' }, mascot('idle', w.session ? 'Ficha vazia nesta sessão' : 'Nenhuma sessão na ficha',
        w.session ? 'Adicione exercícios do catálogo logo abaixo.' : 'Cadastre a ficha na planilha e mande /app de novo.', 'base')));
    }
    list.forEach(function (card, i) {
      var el = renderCard(card, i);
      cardEls.push(el);
      cardsBox.appendChild(el);
    });

    var addBtn = h('button', { type: 'button', class: 'btn-soft btn-block add-ex', onclick: openExercisePicker }, icon('plus'), 'Adicionar exercício');

    var sw = h('input', {
      type: 'checkbox', role: 'switch',
      onchange: function () {
        form().complete = sw.checked;
        haptic('select');
        changed(true);
        if (sw.checked) choreograph('milestone');
      },
    });
    sw.checked = w.session ? !!form().complete : false;
    var complete = h('label', { class: 'switch-row' },
      h('span', {}, h('b', { text: 'Marcar sessão como concluída' }), h('small', { text: 'Desligado, o treino entra como parcial e pode ser retomado.' })),
      h('span', { class: 'switch' }, sw, h('span', {})));

    var reset = h('div', { class: 'foot-actions' }, restoreButton('workout'), h('button', { type: 'button', class: 'btn-text', onclick: resetWorkout, text: 'Limpar este treino' }));

    els.view.replaceChildren.apply(els.view, [head, chips].concat(w.session ? [bodyPanel(), cardsBox, addBtn, complete, reset] : [cardsBox])
      .filter(function (el) { return !!el; }));
    if (!w.session) bodyEl = bodyNote = null;
    if (isVoiceActive()) setFormLocked(true);
  }

  function cardErrors(i) {
    if (!S.showErrors) return [];
    return build().errors.filter(function (e) { return e.card === i; });
  }

  function cardSummary(card) {
    var sets = C.filledSets(card);
    if (!sets.length) return '';
    return sets.map(function (s) {
      var kg = C.parseDecimal(s.kg), reps = C.parseDecimal(s.reps);
      return (Number.isFinite(kg) ? C.formatBR(kg) : '?') + '×' + (Number.isFinite(reps) ? reps : '?');
    }).join('  ');
  }

  function renderCard(card, i) {
    var errs = cardErrors(i);
    var status = errs.length ? 'error' : C.cardIsEmpty(card) ? 'empty' : 'filled';
    var bodyId = 'card-body-' + i;
    var summary = h('span', { class: 'card-summary', text: cardSummary(card) });
    var headBtn = h('button', {
      type: 'button', class: 'card-head', 'aria-expanded': String(!!card.open), 'aria-controls': bodyId,
      onclick: function () {
        focusedCard = i;
        card.open = !card.open;
        replaceCard(i);
        perch(card.open ? cardEls[i] : null, { mode: 'card' });
        if (card.open) choreograph('notice', cardEls[i]);
        scheduleSave();
      },
    },
    h('span', { class: 'dot', 'aria-hidden': 'true' }),
    h('span', {}, h('span', { class: 'card-name', text: card.name }), card.group ? h('span', { class: 'card-group', text: card.group }) : null),
    h('span', {}, summary, h('span', { class: 'chev', 'aria-hidden': 'true' }, icon('chevron'))));

    var el = h('article', { class: 'card', 'data-status': status, 'data-card-index': i }, headBtn);
    el._summary = summary;
    el._done = doneSets(card);
    if (!card.open) return el;

    var body = h('div', { class: 'card-body', id: bodyId });
    var last = C.parseLastWork(card.l) || [];
    body.appendChild(h('div', { class: 'ref' },
      h('div', { class: 'ref-box' + (card.p ? '' : ' empty') }, h('small', { text: 'Plano' }), h('b', { text: card.p || 'sem prescrição' })),
      h('div', { class: 'ref-box' + (card.l ? '' : ' empty') }, h('small', { text: 'Última' }), h('b', { text: card.l || 'sem registro' }))));

    if (C.repeatSets(card.l)) {
      body.appendChild(h('button', {
        type: 'button', class: 'btn-soft repeat',
        onclick: function () {
          card.sets = C.repeatSets(card.l);
          haptic('light');
          replaceCard(i);
          motion('fill', cardEls[i]);
          changed(true, { action: 'repeat', cardIndex: i });
        },
      }, icon('repeat'), 'Repetir última'));
    }

    card.sets.forEach(function (s, j) {
      var hint = last[j] || last[last.length - 1] || null;
      body.appendChild(h('div', { class: 'set' },
        h('div', { class: 'set-head' },
          h('span', { class: 'set-label' }, h('span', { class: 'kind-dot' }), 'Série ' + (j + 1)),
          card.sets.length > 1 ? h('button', { type: 'button', class: 'btn-x', 'aria-label': 'Remover série ' + (j + 1), text: '×', onclick: function (e) { card.sets.splice(j, 1); replaceCard(i, e.currentTarget.closest('.set')); changed(true); } }) : null),
        stepper({ value: s.kg, step: 2.5, min: C.LIMITS.KG_MIN, max: C.LIMITS.KG_MAX, start: hint ? hint.kg : null, unit: 'kg', label: 'kg da série ' + (j + 1), big: true,
          path: 'work[' + j + '].kg', say: 'Os botões andam 2,5 kg. Vírgula vale: 82,5.', onChange: function (v) { s.kg = v; liveCard(i, j); } }),
        h('div', { class: 'pair' },
          stepper({ value: s.reps, step: 1, min: C.LIMITS.REPS_MIN, max: C.LIMITS.REPS_MAX, start: hint ? hint.reps : null, label: 'reps da série ' + (j + 1), integer: true, caption: 'reps',
            path: 'work[' + j + '].reps', say: 'Reps de trabalho, sem contar aquecimento.', onChange: function (v) { s.reps = v; liveCard(i, j); } }),
          stepper({ value: s.rir, step: 1, min: C.LIMITS.RIR_MIN, max: C.LIMITS.RIR_MAX, start: hint && hint.rir !== undefined ? hint.rir : null, label: 'RIR da série ' + (j + 1), caption: 'RIR (opcional)',
            path: 'work[' + j + '].rir', say: 'RIR: quantas reps ainda sobravam.', onChange: function (v) { s.rir = v; liveCard(i); } }))));
    });

    var restInfo = C.restPresetsFor(card.p);
    body.appendChild(h('div', { class: 'rest-row' },
      h('span', { class: 'rest-row-label' }, icon('clock'), 'Descanso'),
      h('div', { class: 'rest-chips' }, restInfo.presets.map(function (sec) {
        var chipLabel = C.formatRestChip(sec);
        var cls = 'rest-chip' + (sec === restInfo.prescribed ? ' is-suggested' : '');
        return h('button', {
          type: 'button',
          class: cls,
          'aria-label': 'Descanso de ' + chipLabel + ' para ' + card.name,
          text: chipLabel,
          onclick: function () { startRest(sec, card.name); },
        });
      }))));

    [['warmup', 'Aquecimento'], ['feeder', 'Feeder']].forEach(function (pair) {
      var k = pair[0];
      var set = card[k];
      if (!set) return;
      body.appendChild(h('div', { class: 'set warm' },
        h('div', { class: 'set-head' },
          h('span', { class: 'set-label' }, h('span', { class: 'kind-dot' }), pair[1]),
          h('button', { type: 'button', class: 'btn-x', 'aria-label': 'Remover ' + pair[1].toLowerCase(), text: '×', onclick: function (e) { card[k] = null; replaceCard(i, e.currentTarget.closest('.set')); changed(true); } })),
        h('div', { class: 'pair' },
          stepper({ value: set.kg, step: 2.5, min: C.LIMITS.KG_MIN, max: C.LIMITS.KG_MAX, label: 'kg do ' + pair[1].toLowerCase(), caption: 'kg',
            path: k + '.kg', say: pair[1] + ' não conta como série de trabalho.', onChange: function (v) { set.kg = v; liveCard(i); } }),
          stepper({ value: set.reps, step: 1, min: C.LIMITS.REPS_MIN, max: C.LIMITS.REPS_MAX, label: 'reps do ' + pair[1].toLowerCase(), integer: true, caption: 'reps',
            path: k + '.reps', say: pair[1] + ' não conta como série de trabalho.', onChange: function (v) { set.reps = v; liveCard(i); } }))));
    });

    if (card.showPain || !isBlank(card.pain)) {
      body.appendChild(h('div', { class: 'field-row' },
        h('div', { class: 'field-label' }, h('span', { text: 'Dor (0 a 10)' })),
        h('div', { class: 'pain-row pair' },
          h('div', {},
            stepper({ value: card.pain, step: 1, min: C.LIMITS.PAIN_MIN, max: C.LIMITS.PAIN_MAX, start: 0, label: 'dor de 0 a 10', integer: true,
              path: 'pain', say: 'Dor: 0 é nenhuma, 10 é parar na hora.', onChange: function (v) { card.pain = v; liveCard(i); } })),
          h('p', { class: 'hint m-0', text: 'Vazio = não informado.' }))));
    }

    if (card.showNote || !isBlank(card.note)) {
      var counter = h('span', { class: 'counter', text: (card.note || '').length + '/' + C.LIMITS.NOTE_MAX });
      var ta = h('textarea', {
        class: 'textarea', rows: '2', maxlength: String(C.LIMITS.NOTE_MAX), placeholder: 'Ex.: ombro ok, pegada fechada',
        'aria-label': 'Nota do exercício', 'data-error-path': 'note', 'data-say': 'Nota curta, até 200 caracteres.', value: card.note || '',
        oninput: function () { card.note = ta.value; counter.textContent = ta.value.length + '/' + C.LIMITS.NOTE_MAX; noteErr.check(); liveCard(i); },
      });
      var noteErr = formulaHint(ta, 'A nota');
      body.appendChild(h('div', { class: 'field-row' }, h('label', { class: 'field-label' }, h('span', { text: 'Nota' }), counter), ta, noteErr));
    }

    var extras = [];
    if (card.sets.length < C.LIMITS.MAX_WORK_SETS) extras.push(['Série ' + (card.sets.length + 1), function () { card.sets.push(C.newSet()); }]);
    if (!card.warmup) extras.push(['Aquecimento', function () { card.warmup = { kg: '', reps: '' }; }]);
    if (!card.feeder) extras.push(['Feeder', function () { card.feeder = { kg: '', reps: '' }; }]);
    if (!card.showPain && isBlank(card.pain)) extras.push(['Dor', function () { card.showPain = true; }]);
    if (!card.showNote && isBlank(card.note)) extras.push(['Nota', function () { card.showNote = true; }]);
    if (extras.length) {
      body.appendChild(h('div', { class: 'extras' }, extras.map(function (x) {
        return h('button', { type: 'button', class: 'extra', text: x[0], onclick: function () { x[1](); haptic('light'); replaceCard(i); changed(true); } });
      })));
    }

    var ul = h('ul', { class: 'errors' });
    errs.forEach(function (e) { ul.appendChild(h('li', { text: capFirst(e.message.replace(card.name + ': ', '')) })); });
    ul.hidden = !errs.length;
    el._errors = ul;
    body.appendChild(ul);

    if (!card.fromPlan) {
      body.appendChild(h('div', { class: 'card-foot' }, h('button', {
        type: 'button', class: 'btn-text danger', text: 'Remover exercício',
        onclick: function () { dropping(el, function () { cards().splice(i, 1); renderWorkout(); changed(true); }); },
      })));
    }
    el.appendChild(body);
    return el;
  }

  function isBlank(v) { return v === null || v === undefined || String(v).trim() === ''; }

  /** Inline message under a free-text field that starts with = + - or @ (the bot refuses those). */
  function formulaHint(field, label) {
    var p = h('p', { class: 'field-error', role: 'alert' });
    p.check = function () {
      var m = C.formulaProblem(field.value);
      p.textContent = m ? label + ' ' + m + '.' : '';
      p.hidden = !m;
      field.classList.toggle('is-bad', !!m);
    };
    p.check();
    return p;
  }

  /** `leaving`: the block of the old card this re-render drops (it fades out instead of vanishing). */
  function replaceCard(i, leaving) {
    var old = cardEls[i];
    var fresh = renderCard(cards()[i], i);
    cardEls[i] = fresh;
    if (!old || !old.parentNode) return;
    var after = motion('snapshot', old, leaving);
    old.parentNode.replaceChild(fresh, old);
    if (after) after(fresh, els.view);
    if (isVoiceActive()) setFormLocked(true);
  }

  /** Typing inside a card: refresh its head (summary, status) without rebuilding the inputs. */
  function liveCard(i, j) {
    var card = cards()[i];
    var el = cardEls[i];
    if (el) {
      var was = el.getAttribute('data-status'), done = doneSets(card);
      el._summary.textContent = cardSummary(card);
      if (!S.showErrors) el.setAttribute('data-status', C.cardIsEmpty(card) ? 'empty' : 'filled');
      if (was === 'empty' && el.getAttribute('data-status') === 'filled') motion('pop', el.querySelector('.dot'));
      if (done > el._done) { // one more set with kg and reps: the summary and Shape acknowledge it
        motion('pop', el._summary);
        if (Avatar && Avatar.pulse) Avatar.pulse('nod');
      }
      el._done = done;
    }
    changed(false, { cardIndex: i, setIndex: j });
  }

  function refreshErrors() {
    if (S.view === 'workout') {
      var errs = build().errors;
      cards().forEach(function (card, i) {
        var el = cardEls[i];
        if (!el) return;
        var mine = errs.filter(function (e) { return e.card === i; });
        el.setAttribute('data-status', mine.length ? 'error' : C.cardIsEmpty(card) ? 'empty' : 'filled');
        if (el._errors) {
          el._errors.replaceChildren.apply(el._errors, mine.map(function (e) { return h('li', { text: capFirst(e.message.replace(card.name + ': ', '')) }); }));
          el._errors.hidden = !mine.length;
        }
      });
    } else {
      var ferrs = build().errors;
      document.querySelectorAll('.plate-item').forEach(function (li, i) {
        var mine = ferrs.filter(function (e) { return e.item === i; });
        var bad = mine.length > 0;
        li.classList.toggle('bad', bad);
        if (li._error) {
          li._error.textContent = bad ? mine.map(function (e) { return capFirst(e.message.replace('Item ' + (i + 1) + ': ', '')); }).join(' · ') : '';
          if (bad) li._error.setAttribute('role', 'alert'); else li._error.removeAttribute('role');
          li._error.hidden = !bad;
        }
      });
    }
  }

  function resetWorkout() {
    var go = function () {
      stopRest(true);
      var f = form();
      f.cards = C.planCards(S.catalog, S.workout.session);
      f.complete = false;
      f.id = C.newSubmissionId(); // a new draft: sending it again on purpose is a new write
      S.showErrors = false;
      renderWorkout();
      changed(true);
    };
    if (!filledCount()) { go(); return; }
    confirmDialog('Apagar o que foi preenchido neste treino?', go);
  }

  function confirmDialog(text, ok) {
    if (inTelegram && tg.showConfirm && versionAtLeast('6.2')) {
      tg.showConfirm(text, function (yes) { if (yes) ok(); });
    } else if (window.confirm(text)) ok();
  }

  /* exercise picker (bottom sheet) ---------------------------------------------------------- */

  var sheetOpener = null;
  var sheetFocusTimer = null;

  function isElementConnected(el) {
    if (!el) return false;
    if (typeof el.isConnected === 'boolean') return el.isConnected;
    if (typeof document.contains === 'function') return document.contains(el);
    for (var cur = el; cur; cur = cur.parentNode) {
      if (cur === document || cur === document.body || cur === document.documentElement) return true;
    }
    return false;
  }

  function isSheetElVisible(el) {
    if (!el || el.hidden) return false;
    for (var cur = el; cur && cur !== document && cur.nodeType !== 9; cur = cur.parentNode) {
      if (cur.hidden || (cur.hasAttribute && cur.hasAttribute('hidden'))) return false;
      if (cur.style && (cur.style.display === 'none' || cur.style.visibility === 'hidden')) return false;
      if (cur === els.sheet) break;
    }
    if (typeof window.getComputedStyle === 'function') {
      try {
        var cs = window.getComputedStyle(el);
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
      } catch (e) { /* ignore */ }
    }
    return true;
  }

  function isSheetFocusable(el) {
    if (!el || !el.tagName || el.disabled || (el.hasAttribute && el.hasAttribute('disabled'))) return false;
    if (!isSheetElVisible(el)) return false;
    var ti = el.getAttribute ? el.getAttribute('tabindex') : null;
    if (ti === '-1') return false;
    var tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return true;
    if (tag === 'A' && el.hasAttribute && el.hasAttribute('href')) return true;
    return ti !== null && ti !== '';
  }

  function sheetFocusables() {
    var out = [];
    function walk(node) {
      var kids = node && node.children ? node.children : [];
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (isSheetFocusable(c)) out.push(c);
        walk(c);
      }
    }
    walk(els.sheet);
    return out;
  }

  function onSheetKeydown(e) {
    if (!S.sheetOpen) return;
    if (e.key === 'Escape') {
      closeSheet();
      return;
    }
    if (e.key !== 'Tab') return;
    var list = sheetFocusables();
    if (!list.length) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      var titleEl = $('sheet-title');
      if (titleEl && typeof titleEl.focus === 'function') titleEl.focus();
      return;
    }
    var first = list[0];
    var last = list[list.length - 1];
    var idx = list.indexOf(document.activeElement);
    if (e.shiftKey) {
      if (idx <= 0) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        last.focus();
      }
    } else if (idx < 0 || idx === list.length - 1) {
      if (typeof e.preventDefault === 'function') e.preventDefault();
      first.focus();
    }
  }

  function openSheet(title, content, focusEl) {
    if (!S.sheetOpen) sheetOpener = document.activeElement || null;
    clearTimeout(sheetFocusTimer);
    sheetFocusTimer = null;
    var titleEl = h('h2', { class: 'sheet-title', id: 'sheet-title', tabindex: '-1', text: title });
    els.sheet.replaceChildren(h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }), titleEl, content);
    cancelReview();
    motion('keep', els.sheet); // reopened while it was still sliding out
    motion('keep', els.backdrop);
    els.sheet.hidden = false;
    els.backdrop.hidden = false;
    S.sheetOpen = true;
    document.removeEventListener('keydown', onSheetKeydown);
    document.addEventListener('keydown', onSheetKeydown);
    updateBack();
    syncVoiceDock();
    var target = focusEl || sheetFocusables()[0] || titleEl;
    if (target && typeof target.focus === 'function') {
      sheetFocusTimer = setTimeout(function () {
        sheetFocusTimer = null;
        if (S.sheetOpen && typeof target.focus === 'function') target.focus();
      }, 60);
    }
  }
  /** The state closes at once; the sheet and backdrop only finish sliding out (taps pass through). */
  function closeSheet() {
    clearTimeout(sheetFocusTimer);
    sheetFocusTimer = null;
    document.removeEventListener('keydown', onSheetKeydown);
    [els.sheet, els.backdrop].forEach(function (el) {
      if (el.hidden) return;
      if (!motion('out', el, function () { el.hidden = true; })) el.hidden = true;
    });
    S.sheetOpen = false;
    updateBack();
    syncVoiceDock();
    var opener = sheetOpener;
    sheetOpener = null;
    if (opener && isElementConnected(opener) && typeof opener.focus === 'function') opener.focus();
  }
  els.backdrop.addEventListener('click', closeSheet);

  function openExercisePicker() {
    var present = cards().map(function (c) { return C.fold(c.name); });
    var options = S.catalog.ex.filter(function (e) { return present.indexOf(C.fold(e.name)) < 0; });
    var list = h('ul', { class: 'results' });
    var input = h('input', {
      class: 'text-input', type: 'search', placeholder: 'Buscar no catálogo', autocomplete: 'off', enterkeyhint: 'search',
      'aria-label': 'Buscar exercício', oninput: function () { fill(); },
    });
    function fill() {
      var found = C.search(input.value, options, 60, function (e) { return e.name + ' ' + e.group; });
      list.replaceChildren.apply(list, found.length ? found.map(function (e) {
        return h('li', {}, h('button', {
          type: 'button', class: 'result',
          onclick: function () {
            var row = planRowFor(e.name);
            var card = C.newCard(e.name, e.group, row);
            card.fromPlan = false;
            card.open = true;
            cards().push(card);
            closeSheet();
            haptic('light');
            renderWorkout();
            changed(true);
            say('idle', e.name + ' entrou na lista. Preencha as séries.');
            var el = cardEls[cardEls.length - 1];
            motion('enter', el);
            scrollInto(el, 'center');
          },
        }, h('span', { text: e.name }), h('span', { class: 'tag', text: e.group })));
      }) : [h('li', { class: 'hint', text: options.length ? 'Nada com esse nome no catálogo.' : 'Todos os exercícios do catálogo já estão na lista.' })]);
    }
    fill();
    openSheet('Adicionar exercício', h('div', { class: 'sheet-col' },
      h('label', { class: 'search' }, icon('search'), input), list), input);
  }

  /* food view -------------------------------------------------------------------------------- */

  function isFoodToday() {
    return !!(S.today && S.food.date === S.today);
  }

  function baseWaterL() {
    return isFoodToday() && S.catalog && S.catalog.day && S.catalog.day.water !== null ? S.catalog.day.water : 0;
  }

  function currentWaterId() {
    if (!C.isSubmissionId(S.food.waterId)) S.food.waterId = C.newSubmissionId();
    return S.food.waterId;
  }

  function buildWaterState() {
    return C.buildWater({ date: S.food.date, baseWaterL: baseWaterL(), addWaterL: S.food.waterAdd }, { today: S.today });
  }

  function stepWater(deltaL) {
    wake();
    cancelReview();
    var base = baseWaterL();
    var maxAdd = Math.max(0, Math.round((C.WATER_LIMITS.MAX - base) * 100) / 100);
    var cur = S.food.waterAdd || 0;
    var next = Math.round(Math.max(0, Math.min(maxAdd, cur + deltaL)) * 100) / 100;
    if (next === cur) return;
    var balBefore = C.dailyBalance(S.catalog, S.food.items, { isToday: isFoodToday(), waterAddL: cur });
    S.food.waterAdd = next;
    if (!next) S.food.waterId = '';
    var balAfter = C.dailyBalance(S.catalog, S.food.items, { isToday: isFoodToday(), waterAddL: next });
    if (next > 0 && balBefore.total.water < balAfter.targets.water && balAfter.total.water >= balAfter.targets.water) {
      haptic('success');
      if (Avatar && Avatar.pulse) Avatar.pulse('full');
      choreograph('proud', $('daily-balance'));
      say('happy', 'Meta de água batida: ' + C.formatLiters(balAfter.total.water) + '!');
    } else {
      haptic('light');
      say(next > 0 ? 'happy' : 'idle',
        next > 0
          ? C.formatWaterDelta(next) + ' de água (' + C.formatLiters(balAfter.total.water) + ' no dia).'
          : 'Água zerada para este envio.');
    }
    syncDailyBalance();
    updateMainForForm();
  }

  function renderDailyBalance(box) {
    if (!box || !S.catalog) return;
    var bal = C.dailyBalance(S.catalog, S.food.items, { isToday: isFoodToday(), waterAddL: S.food.waterAdd });
    var kcalNow = Math.round(bal.total.kcal);
    var kcalText = bal.targets.kcal ? kcalNow + ' / ' + Math.round(bal.targets.kcal) + ' kcal' : kcalNow + ' kcal';
    var plateKcal = Math.round(bal.plate.kcal);
    var deltaEl = bal.isToday && bal.hasLoggedFood && plateKcal > 0
      ? h('span', { class: 'balance-delta', text: '+' + plateKcal + ' no prato' })
      : null;

    var remEl = null;
    var kcalBar = null;
    if (bal.targets.kcal) {
      var diff = Math.round(bal.targets.kcal - bal.total.kcal);
      var pct = Math.round(bal.ratio.kcal * 100);
      var okBand = bal.total.kcal >= bal.targets.kcal * 0.9 && bal.total.kcal <= bal.targets.kcal * 1.05;
      var overCap = bal.total.kcal > bal.targets.kcal * 1.05;
      var cls = overCap ? ' is-over' : okBand ? ' is-ok' : '';
      remEl = h('span', {
        class: 'balance-rem' + cls,
        text: diff >= 0 ? 'Faltam ' + diff + ' kcal' : '+' + Math.abs(diff) + ' kcal',
      });
      kcalBar = h('div', { class: 'balance-track' }, h('i', { class: 'balance-fill' + cls, style: 'width:' + pct + '%' }));
    }

    var macroSpecs = [
      ['protein', 'Proteína', ' is-protein'],
      ['carbs', 'Carbo', ''],
      ['fat', 'Gordura', ''],
    ];
    var macrosGrid = h('div', { class: 'balance-macros' }, macroSpecs.map(function (spec) {
      var key = spec[0];
      var val = C.formatBR(Math.round(bal.total[key] * 10) / 10);
      var target = bal.targets[key];
      var valText = target ? val + ' / ' + C.formatBR(target) + ' g' : val + ' g';
      var pct = target ? Math.round(bal.ratio[key] * 100) : 0;
      return h('div', { class: 'macro-cell' + spec[2] + (bal.over[key] ? ' is-over' : '') },
        h('div', { class: 'macro-head' }, h('span', { text: spec[1] })),
        h('span', { class: 'macro-val', text: valText }),
        target ? h('div', { class: 'balance-track' }, h('i', { class: 'balance-fill', style: 'width:' + pct + '%' })) : null);
    }));

    var waterPct = Math.round(bal.ratio.water * 100);
    var waterActions = [
      h('button', { type: 'button', class: 'water-chip', 'data-water-add': '0.25', text: '+250 ml', onclick: function () { stepWater(C.WATER_LIMITS.STEP_SM); } }),
      h('button', { type: 'button', class: 'water-chip', 'data-water-add': '0.5', text: '+500 ml', onclick: function () { stepWater(C.WATER_LIMITS.STEP_LG); } }),
    ];
    if (S.food.waterAdd > 0) {
      waterActions.push(
        h('button', { type: 'button', class: 'water-chip water-undo', 'aria-label': 'Tirar 250 ml', text: '−250 ml', onclick: function () { stepWater(-C.WATER_LIMITS.STEP_SM); } }),
        h('button', { type: 'button', class: 'water-send', id: 'water-send', text: 'Registrar água', onclick: goWaterReview })
      );
    }
    var waterBox = h('div', { class: 'water-box' },
      h('div', { class: 'water-head' },
        h('span', { class: 'water-title' }, icon('drop'), 'Água'),
        h('span', { class: 'water-val' },
          C.formatLiters(bal.total.water) + ' / ' + C.formatLiters(bal.targets.water),
          S.food.waterAdd > 0 ? ' ' : null,
          S.food.waterAdd > 0 ? h('span', { class: 'water-delta', text: C.formatWaterDelta(S.food.waterAdd) }) : null)),
      h('div', { class: 'water-track' }, h('i', { class: 'water-fill' + (bal.over.water ? ' is-done' : ''), style: 'width:' + waterPct + '%' })),
      h('div', { class: 'water-actions' }, waterActions));

    box.replaceChildren(
      h('div', { class: 'balance-head' },
        h('div', { class: 'balance-title-wrap' },
          h('span', { class: 'balance-title', text: bal.isToday ? 'Hoje vs. meta' : 'Nesta refeição' }),
          h('b', { class: 'balance-kcal', text: kcalText }),
          deltaEl),
        remEl),
      kcalBar,
      macrosGrid,
      waterBox
    );
  }

  function syncDailyBalance() {
    var box = $('daily-balance');
    if (box) renderDailyBalance(box);
  }

  function freshCompose() {
    return { query: '', food: '', qty: '', unit: S.catalog.units[0] || '', measure: '', description: '', dqty: '', dunit: '' };
  }

  function renderFood() {
    var f = S.food;
    if (!f.compose) f.compose = freshCompose();
    var head = h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: f.meal || 'Refeição' }),
      h('p', { class: 'view-sub', text: f.items.length ? plural(f.items.length, 'item', 'itens') + ' no prato' : 'Escolha a refeição e monte o prato.' }));
    var balanceBox = h('section', { id: 'daily-balance', class: 'balance-card', 'aria-label': 'Saldo do dia e hidratação' });

    var meals = h('div', { class: 'chip-wrap', role: 'radiogroup', 'aria-label': 'Refeição' }, S.catalog.meals.map(function (m) {
      return h('button', {
        type: 'button', role: 'radio', class: 'chip', 'aria-checked': String(m === f.meal), text: m,
        onclick: function () { f.meal = m; haptic('select'); renderFood(); changed(true); },
      });
    }));

    var modes = [['food', 'Alimento'], ['favorite', 'Favorita'], ['description', 'Sem cálculo']];
    var seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Tipo de item' }, modes.map(function (m) {
      return h('button', {
        type: 'button', 'aria-pressed': String(f.mode === m[0]), text: m[1],
        onclick: function () { f.mode = m[0]; haptic('select'); renderFood(); },
      });
    }));
    var panel = h('div', { class: 'panel' }, seg, h('div', { class: 'panel-body' }, composer()));

    var plateTitle = h('h2', { class: 'section-title' }, 'No prato', h('span', { class: 'count', text: f.items.length + '/' + C.LIMITS.MAX_FOOD_ITEMS }));
    var errs = S.showErrors ? build().errors : [];
    var plate = f.items.length ? h('ul', { class: 'plate' }, f.items.map(function (it, i) {
      return plateItem(it, i, errs.filter(function (e) { return e.item === i; }));
    })) : h('div', { class: 'empty-plate' }, mascot('idle', 'Prato vazio', 'Busque um alimento, toque numa favorita ou descreva sem cálculo.', 'base'));

    var reset = h('div', { class: 'foot-actions' }, restoreButton('food'), f.items.length ? h('button', {
      type: 'button', class: 'btn-text', text: 'Limpar prato',
      onclick: function () { confirmDialog('Tirar todos os itens do prato?', function () { f.items = []; f.id = C.newSubmissionId(); S.showErrors = false; renderFood(); changed(true); }); },
    }) : null);

    var status = S.catalog.tableStatus;
    var notice = h('p', { id: 'food-table-status', class: 'hint', role: 'status', text: status === 'loading'
      ? 'Lista completa indisponível enquanto carrega.' : status === 'unavailable' ? 'Lista completa indisponível.'
        : status === 'values_unavailable' ? 'Valores da tabela indisponíveis; soma parcial.' : '' });
    notice.hidden = !status || status === 'ready';
    var total = h('p', { id: 'meal-nutrition', class: 'meal-nutrition', 'aria-live': 'polite', 'aria-atomic': 'true' });
    els.view.replaceChildren(head, balanceBox, meals, h('h2', { class: 'section-title', text: 'Adicionar' }), notice, panel, plateTitle, plate, total, reset);
    syncNutrition();
    if (isVoiceActive()) setFormLocked(true);
  }

  function syncNutrition() {
    var line = $('meal-nutrition');
    if (line) line.textContent = S.food.items.length ? C.nutritionText(C.mealNutrition(S.food.items, S.catalog)) : 'Adicione itens para ver a soma.';
    syncDailyBalance();
  }

  function unitChips(current, onPick, optional) {
    return h('div', { class: 'chip-wrap', role: 'radiogroup', 'aria-label': 'Unidade' }, S.catalog.units.map(function (u) {
      return h('button', {
        type: 'button', role: 'radio', class: 'chip', 'aria-checked': String(u === current), text: u,
        onclick: function () { onPick(optional && u === current ? '' : u); haptic('select'); },
      });
    }));
  }

  function qtyField(value, say, onInput, unitText) {
    var parsed = h('span', { class: 'parsed', 'aria-live': 'polite' });
    var show = function (v) {
      var n = C.parseDecimal(v);
      parsed.classList.toggle('bad', Number.isNaN(n));
      parsed.textContent = n === null ? '' : Number.isNaN(n) ? (/\s/.test(String(v).trim()) ? 'sem espaço no meio' : 'número inválido') : '= ' + C.formatBR(n) + (unitText() ? ' ' + unitText() : '');
    };
    var input = h('input', {
      class: 'text-input', type: 'text', inputmode: 'decimal', autocomplete: 'off', enterkeyhint: 'done',
      placeholder: 'Quantidade', 'aria-label': 'Quantidade', 'data-error-path': 'qty', 'data-say': say, value: value,
      oninput: function () { onInput(input.value); show(input.value); },
    });
    show(value);
    var row = h('div', { class: 'qty-row' }, input, parsed);
    row._refresh = function () { show(input.value); };
    return row;
  }

  function composer() {
    var f = S.food, c = f.compose;
    if (f.mode === 'favorite') {
      if (!S.catalog.fav.length) return h('p', { class: 'hint', text: 'Nenhuma refeição favorita na planilha.' });
      return h('div', {},
        h('div', { class: 'chip-wrap' }, S.catalog.fav.map(function (name) {
          return h('button', {
            type: 'button', class: 'chip fav',
            onclick: function () { addItem({ kind: 'favorite', favorite: name, portions: '1' }); },
          }, icon('star'), name);
        })),
        h('p', { class: 'hint', text: 'Um toque põe 1 porção; ajuste as porções no prato.' }));
    }

    if (f.mode === 'description') {
      var counter = h('span', { class: 'counter', text: c.description.length + '/' + C.LIMITS.DESCRIPTION_MAX });
      var ta = h('textarea', {
        class: 'textarea', rows: '2', maxlength: String(C.LIMITS.DESCRIPTION_MAX), placeholder: 'Ex.: pastel de feira',
        'aria-label': 'Descrição do item', 'data-error-path': 'description', 'data-say': 'Sem cálculo: entra na refeição sem calorias nem macros.', value: c.description,
        oninput: function () { c.description = ta.value; counter.textContent = ta.value.length + '/' + C.LIMITS.DESCRIPTION_MAX; descErr.check(); },
      });
      var descErr = formulaHint(ta, 'A descrição');
      var dq = qtyField(c.dqty, 'Quantidade é opcional aqui.', function (v) { c.dqty = v; }, function () { return c.dunit; });
      return h('div', {},
        h('label', { class: 'field-label' }, h('span', { text: 'Descrição' }), counter), ta, descErr,
        h('p', { class: 'sub-label', text: 'Quantidade (opcional)' }), dq,
        h('div', { class: 'mt-8' }, unitChips(c.dunit, function (u) { c.dunit = u; renderFood(); }, true)),
        h('p', { class: 'hint warn', text: 'Sem cálculo: o item entra na refeição sem calorias nem macros.' }),
        h('button', {
          type: 'button', class: 'btn-primary',
          onclick: function () {
            var item = { kind: 'description', description: c.description };
            if (!isBlank(c.dqty)) item.qty = c.dqty;
            if (c.dunit) item.unit = c.dunit;
            if (addItem(item)) { c.description = ''; c.dqty = ''; c.dunit = ''; renderFood(); }
          },
        }, icon('plus'), 'Pôr no prato'));
    }

    // Catalog food (or free name when the catalog's food list did not fit in the link).
    var free = !S.catalog.foods || c.manual;
    var parts = [];
    if (!free && !c.food) {
      var results = h('ul', { class: 'results' });
      var input = h('input', {
        class: 'text-input', type: 'search', placeholder: 'Buscar alimento', autocomplete: 'off', enterkeyhint: 'search',
        'aria-label': 'Buscar alimento', 'data-say': 'Busca sem acento funciona: feijao acha Feijão.', value: c.query,
        oninput: function () { c.query = input.value; fillResults(); },
      });
      var fillResults = function () {
        if (!c.query.trim()) {
          results.replaceChildren(h('li', { class: 'hint', text: S.catalog.foods.length + ' alimentos no catálogo. Digite parte do nome.' }));
          return;
        }
        var found = C.search(c.query, S.catalog.foods, 7);
        results.replaceChildren.apply(results, found.length ? found.map(function (name) {
          return h('li', {}, h('button', {
            type: 'button', class: 'result', text: name,
            onclick: function () { c.food = name; c.query = ''; haptic('select'); renderFood(); focusQty(); },
          }));
        }) : [h('li', { class: 'hint', text: 'Não está no catálogo. Use "Sem cálculo" para registrar mesmo assim.' })]);
      };
      fillResults();
      return h('div', {}, h('label', { class: 'search' }, icon('search'), input), results,
        S.catalog.freeFoods ? h('button', { type: 'button', class: 'btn-text', text: 'Digitar outro nome', onclick: function () { c.manual = true; renderFood(); } }) : null);
    }

    if (free) {
      var nameInput = h('input', {
        class: 'text-input', type: 'text', placeholder: 'Nome do alimento', autocomplete: 'off', 'aria-label': 'Nome do alimento',
        'data-error-path': 'food', 'data-say': 'Escreva como está na planilha; ela confere o nome.', value: c.food,
        oninput: function () { c.food = nameInput.value; },
      });
      parts.push(nameInput, h('p', { class: 'hint warn', text: 'A lista de alimentos não coube no link. Escreva o nome como está na planilha: ela confere e sugere se errar.' }));
    } else {
      parts.push(h('div', { class: 'picked' }, h('span', { text: c.food }),
        h('button', { type: 'button', class: 'btn-x', 'aria-label': 'Trocar alimento', text: '×', onclick: function () { c.food = ''; renderFood(); } })));
    }
    var qty = qtyField(c.qty, 'Quantidade com vírgula vale: 82,5.', function (v) { c.qty = v; }, function () { return c.unit; });
    parts.push(h('p', { class: 'sub-label', text: 'Quantidade' }), qty,
      h('div', { class: 'mt-8' }, unitChips(c.unit, function (u) { c.unit = u; qty._refresh(); renderUnitsOnly(); })),
      h('p', { class: 'sub-label', text: 'Medição' }),
      h('div', { class: 'seg small', role: 'group', 'aria-label': 'Medição' }, C.MEASURES.map(function (m) {
        return h('button', {
          type: 'button', 'aria-pressed': String(c.measure === m), text: m,
          onclick: function () { c.measure = c.measure === m ? '' : m; haptic('select'); renderFood(); },
        });
      })),
      h('button', {
        type: 'button', class: 'btn-primary',
        onclick: function () {
          var item = { kind: 'food', food: c.food, qty: c.qty };
          if (c.unit) item.unit = c.unit;
          if (c.measure) item.measure = c.measure;
          if (addItem(item)) { var keepUnit = c.unit; S.food.compose = freshCompose(); S.food.compose.unit = keepUnit; renderFood(); }
        },
      }, icon('plus'), 'Pôr no prato'));
    return h('div', {}, parts);
  }

  function renderUnitsOnly() { renderFood(); }
  function focusQty() {
    setTimeout(function () {
      var q = els.view.querySelector('.qty-row input');
      if (q) q.focus();
    }, 30);
  }

  function clearComposerError(panel) {
    if (!panel) return;
    var prevErr = panel.querySelector('.composer-error');
    if (prevErr && prevErr.parentNode) prevErr.parentNode.removeChild(prevErr);
    if (panel._errTarget) {
      var t = panel._errTarget;
      if (!(t.getAttribute('data-error-path') === 'description' && C.formulaProblem(t.value))) {
        t.classList.remove('is-bad');
      }
      if (panel._errHandler) {
        t.removeEventListener('input', panel._errHandler);
        t.removeEventListener('change', panel._errHandler);
      }
      panel._errTarget = null;
    }
    panel.classList.remove('is-bad');
    if (panel._errHandler) {
      panel.removeEventListener('input', panel._errHandler);
      panel.removeEventListener('change', panel._errHandler);
      panel._errHandler = null;
    }
  }

  function addItem(item) {
    if (S.food.items.length >= C.LIMITS.MAX_FOOD_ITEMS) {
      haptic('error');
      nudge(els.view.querySelector('.plate'));
      say('alert', 'O prato já tem ' + C.LIMITS.MAX_FOOD_ITEMS + ' itens. Envie esta refeição e abra outra.');
      return false;
    }
    var r = C.buildFoodItem(item, S.catalog);
    if (r.errors.length) {
      var panel = els.view.querySelector('.panel');
      clearComposerError(panel);
      haptic('error');
      nudge(panel);
      var error = C.pulsoError(r.errors);
      var target = errorTarget(error, true);
      if (target) target.classList.add('is-bad');
      if (panel) {
        var msg = h('p', { class: 'field-error composer-error', role: 'alert', text: capFirst(error.line) });
        var body = panel.querySelector('.panel-body') || panel;
        body.appendChild(msg);
        var clear = function () { clearComposerError(panel); };
        panel._errTarget = target;
        panel._errHandler = clear;
        panel.addEventListener('input', clear);
        panel.addEventListener('change', clear);
        if (target && target !== panel) {
          target.addEventListener('input', clear);
          target.addEventListener('change', clear);
        }
      }
      react(error);
      glance(target);
      return false;
    }
    S.food.items.push(item);
    haptic('light');
    renderFood();
    // After this tap's last re-render (the composer resets too), the new item arrives on the plate.
    Promise.resolve().then(function () { motion('enter', els.view.querySelector('.plate > :last-child')); });
    changed(true, { quiet: true });
    say(S.food.meal ? 'happy' : 'idle', itemName(item) + ' no prato.' + (S.food.meal ? '' : ' Falta escolher a refeição.'));
    choreograph('acknowledge');
    return true;
  }

  function itemName(it) {
    return it.kind === 'food' ? it.food : it.kind === 'favorite' ? it.favorite : it.description.trim();
  }
  /** Kind and measure under the name; the amount goes in its own right-aligned column. */
  function itemMeta(it) {
    if (it.kind === 'food') {
      var value = C.foodNutrition(it, S.catalog);
      return (it.measure ? 'catálogo, ' + it.measure.toLowerCase() : 'catálogo') + (value ? ' · ' + Math.round(value.kcal) + ' kcal' : '');
    }
    if (it.kind === 'favorite') return 'favorita, porções';
    return 'sem cálculo';
  }
  function itemQty(it) {
    if (it.kind === 'favorite') return '';
    var n = C.parseDecimal(it.qty);
    return Number.isFinite(n) ? C.formatBR(n) + (it.unit ? ' ' + it.unit : '') : '';
  }

  function formatSwapMacros(n) {
    var r1 = function (v) { return Math.round((v || 0) * 10) / 10; };
    return Math.round(n.kcal) + ' kcal · P ' + C.formatBR(r1(n.protein)) + ' g · C ' + C.formatBR(r1(n.carbs)) + ' g · G ' + C.formatBR(r1(n.fat)) + ' g';
  }
  function formatSwapDelta(diffKcal) {
    var d = Math.round(diffKcal);
    return d > 0 ? '+' + d + ' kcal' : d < 0 ? '-' + Math.abs(d) + ' kcal' : '= kcal';
  }

  function openSwapSheet(index) {
    var it = S.food.items[index];
    var base = C.foodNutrition(it, S.catalog);
    if (!it || it.kind !== 'food' || !base) return;
    var criterion = C.defaultSwapCriterion(base);
    var query = '';
    var pickedName = '';

    var curMeta = (it.qty ? it.qty + (it.unit ? ' ' + it.unit : '') + ' · ' : '') + formatSwapMacros(base);
    var currentEl = h('div', { class: 'swap-current' },
      h('b', { text: it.food }),
      h('span', { class: 'swap-sub', text: curMeta }));

    var criteriaButtons = [];
    var criteriaRow = h('div', { class: 'seg small swap-criteria', role: 'group', 'aria-label': 'Manter equivalente por' },
      C.SWAP_CRITERIA.map(function (key) {
        var btn = h('button', {
          type: 'button',
          'aria-pressed': String(key === criterion),
          text: C.SWAP_CRITERION_LABELS[key],
          onclick: function () {
            if (criterion === key) return;
            criterion = key;
            haptic('select');
            criteriaButtons.forEach(function (pair) { pair[1].setAttribute('aria-pressed', String(pair[0] === criterion)); });
            renderResults();
            renderPreview();
          },
        });
        criteriaButtons.push([key, btn]);
        return btn;
      }));

    var searchInput = h('input', {
      class: 'text-input', type: 'search', placeholder: 'Buscar substituto (ex.: batata, frango)',
      autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'Buscar substituto', value: '',
      oninput: function () { query = searchInput.value; renderResults(); },
    });
    var previewEl = h('div', { class: 'swap-preview', hidden: true });
    var resultsEl = h('ul', { class: 'results swap-results' });

    function applySwap() {
      var res = C.computeSwap(it, pickedName, criterion, S.catalog);
      if (!res.ok) return;
      var nextItem = { kind: 'food', food: res.target.food, qty: res.target.qtyText, unit: res.target.unit };
      if (it.measure) nextItem.measure = it.measure;
      S.food.items[index] = nextItem;
      closeSheet();
      haptic('success');
      renderFood();
      changed(true, { quiet: true });
      say('happy', 'Troquei ' + res.base.food + ' por ' + res.target.food + ' (' + res.target.qtyText + ' ' + res.target.unit + ').');
      choreograph('acknowledge');
    }

    function renderPreview() {
      if (!pickedName) {
        previewEl.hidden = true;
        previewEl.replaceChildren();
        return;
      }
      var res = C.computeSwap(it, pickedName, criterion, S.catalog);
      previewEl.hidden = false;
      if (!res.ok) {
        previewEl.replaceChildren(
          h('b', { class: 'swap-compare', text: pickedName }),
          h('p', { class: 'field-error m-0', role: 'alert', text: res.error }),
          h('button', { type: 'button', class: 'btn-primary', disabled: true, text: 'Aplicar troca' }));
        return;
      }
      previewEl.replaceChildren(
        h('div', { class: 'swap-preview-head' },
          h('b', { class: 'swap-compare', text: res.base.food + ' (' + res.base.qty + ' ' + res.base.unit + ') → ' + res.target.food + ' (' + res.target.qtyText + ' ' + res.target.unit + ')' }),
          h('span', { class: 'swap-diff', text: formatSwapDelta(res.diff.kcal) })),
        h('p', { class: 'swap-sub m-0', text: formatSwapMacros(res.target.nutrition) }),
        h('button', { type: 'button', class: 'btn-primary', text: 'Aplicar troca', onclick: applySwap }));
    }

    function renderCandidate(res, fallbackName) {
      if (res && res.ok) {
        var isPicked = pickedName && C.foodKey(pickedName) === C.foodKey(res.target.food);
        return h('li', {}, h('button', {
          type: 'button',
          class: 'result' + (isPicked ? ' is-picked' : ''),
          onclick: function () { pickedName = res.target.food; haptic('select'); renderPreview(); renderResults(); },
        },
          h('span', { text: res.target.food }),
          h('span', { class: 'tag', text: res.target.qtyText + ' ' + res.target.unit + ' (' + Math.round(res.target.nutrition.kcal) + ' kcal)' })));
      }
      return h('li', {}, h('button', {
        type: 'button',
        class: 'result is-disabled',
        disabled: true,
        'aria-disabled': 'true',
      },
        h('span', { text: fallbackName }),
        h('span', { class: 'tag', text: 'sem ' + C.SWAP_CRITERION_LABELS[criterion].toLowerCase() })));
    }

    function renderResults() {
      if (!query.trim()) {
        var list = C.swapSuggestions(it, criterion, S.catalog, 6);
        resultsEl.replaceChildren.apply(resultsEl, list.length
          ? list.map(function (res) { return renderCandidate(res, res.target.food); })
          : [h('li', { class: 'hint', text: 'Nenhum substituto equivalente encontrado neste critério.' })]);
        return;
      }
      var map = S.catalog.nutrition || {};
      var curKey = C.foodKey(it.food);
      var seen = Object.create(null);
      var valued = [];
      (S.catalog.foods || []).forEach(function (name) {
        var key = C.foodKey(name);
        if (!key || seen[key] || key === curKey || !map[key]) return;
        seen[key] = true;
        valued.push(name);
      });
      var found = C.search(query, valued, 10);
      resultsEl.replaceChildren.apply(resultsEl, found.length
        ? found.map(function (name) { return renderCandidate(C.computeSwap(it, name, criterion, S.catalog), name); })
        : [h('li', { class: 'hint', text: 'Nenhum alimento com tabela encontrado para essa busca.' })]);
    }

    renderResults();
    openSheet('Trocar alimento', h('div', { class: 'sheet-col swap-col' },
      currentEl,
      criteriaRow,
      h('label', { class: 'search mt-8' }, icon('search'), searchInput),
      previewEl,
      resultsEl), searchInput);
  }

  function plateItem(it, i, itemErrs) {
    var bad = Array.isArray(itemErrs) ? itemErrs.length > 0 : !!itemErrs;
    var errText = Array.isArray(itemErrs) && itemErrs.length
      ? itemErrs.map(function (e) { return capFirst(e.message.replace('Item ' + (i + 1) + ': ', '')); }).join(' · ')
      : '';
    var errEl = h('span', { class: 'field-error plate-error', text: errText });
    if (bad) errEl.setAttribute('role', 'alert');
    errEl.hidden = !bad;
    var right = h('div', { class: 'plate-right' });
    if (itemQty(it)) right.appendChild(h('span', { class: 'plate-qty', text: itemQty(it) }));
    if (it.kind === 'favorite') {
      var out = h('output', { text: C.formatBR(C.parseDecimal(it.portions) || 1) });
      var stepP = function (sign) {
        it.portions = C.stepValue(it.portions || '1', sign * 0.5, 0.5, C.LIMITS.PORTIONS_MAX);
        out.textContent = it.portions;
        haptic('select');
        changed(false);
      };
      right.appendChild(h('div', { class: 'mini-step', 'aria-label': 'Porções' },
        h('button', { type: 'button', 'aria-label': 'Menos meia porção', text: '−', onclick: function () { stepP(-1); } }),
        out,
        h('button', { type: 'button', 'aria-label': 'Mais meia porção', text: '+', onclick: function () { stepP(1); } })));
    }
    if (it.kind === 'food' && C.foodNutrition(it, S.catalog)) {
      right.appendChild(h('button', {
        type: 'button', class: 'btn-swap', 'aria-label': 'Trocar ' + itemName(it), title: 'Trocar alimento',
        onclick: function () { openSwapSheet(i); },
      }, icon('swap')));
    }
    right.appendChild(h('button', {
      type: 'button', class: 'btn-x', 'aria-label': 'Tirar ' + itemName(it) + ' do prato', text: '×',
      onclick: function (e) {
        dropping(e.currentTarget.closest('.plate-item'), function () { S.food.items.splice(i, 1); haptic('light'); renderFood(); changed(true); });
      },
    }));
    var li = h('li', { class: 'plate-item k-' + it.kind + (bad ? ' bad' : '') },
      h('span', { class: 'plate-bar', 'aria-hidden': 'true' }),
      h('span', {}, h('span', { class: 'plate-name', text: itemName(it) }), h('span', { class: 'plate-meta', text: itemMeta(it) }), errEl),
      right);
    li._error = errEl;
    return li;
  }

  /* review & send ---------------------------------------------------------------------------- */

  var reviewTimer = null;
  /** Drop a pending "conferindo" beat (the user moved on); true if there was one. */
  function cancelReview() {
    if (reviewTimer === null) return false;
    clearTimeout(reviewTimer);
    reviewTimer = null;
    if (S.screen === 'form') S.reviewView = '';
    return true;
  }

  function goWaterReview() {
    cancelReview();
    var r = buildWaterState();
    if (r.errors.length) {
      haptic('error');
      react(C.pulsoError(r.errors));
      return;
    }
    var p = C.serializePayload('water', r.args, currentWaterId());
    if (!p.ok) {
      haptic('error');
      say('alert', 'Passou do limite do Telegram.');
      return;
    }
    S.showErrors = false;
    stopRest(true);
    S.reviewView = 'water';
    say('thinking', 'Conferindo a água');
    reviewTimer = setTimeout(function () {
      reviewTimer = null;
      var now = S.view === 'food' && S.screen === 'form' ? buildWaterState() : null;
      if (!now || !now.args || C.serializePayload('water', now.args, currentWaterId()).json !== p.json) {
        S.reviewView = '';
        updateMood();
        return;
      }
      S.screen = 'review';
      renderReview(r.args, p, 'water');
      motion('review', els.review);
      haptic('success');
      updateMood();
    }, 320);
  }

  function goReview() {
    cancelReview(); // a double tap builds the review once
    var r = build();
    if (r.errors.length) {
      S.showErrors = true;
      haptic('error');
      if (S.view === 'workout') {
        var firstCard = r.errors.filter(function (e) { return e.card !== undefined; })[0];
        if (firstCard) cards()[firstCard.card].open = true;
        renderWorkout();
        var el = firstCard ? cardEls[firstCard.card] : null;
        scrollInto(el, 'start');
        nudge(el);
      } else {
        renderFood();
        nudge(els.view.querySelectorAll('.plate-item.bad'));
      }
      S.focus = null;
      syncProgress();
      var error = C.pulsoError(r.errors);
      react(error);
      glance(errorTarget(error));
      return;
    }
    var view = S.view;
    var p = C.serializePayload(view, r.args, currentId());
    if (!p.ok) {
      haptic('error');
      nudge(null);
      say('alert', 'Passou do limite do Telegram (' + p.bytes + ' de ' + C.LIMITS.PAYLOAD_BYTES + ' bytes). Encurte as notas ou envie em duas partes.');
      return;
    }
    S.showErrors = false;
    stopRest(true);
    S.reviewView = view;
    // A short "thinking" beat while the review is built (the avatar sweeps its ring).
    say('thinking', 'Conferindo o registro');
    // Any navigation or edit before it fires cancels it (render, changed, openSheet).
    reviewTimer = setTimeout(function () {
      reviewTimer = null;
      // This also refuses a snapshot that went stale without cancelling the timer.
      var now = S.view === view && S.screen === 'form' ? build() : null;
      if (!now || !now.args || C.serializePayload(view, now.args, currentId()).json !== p.json) { S.reviewView = ''; updateMood(); return; }
      S.screen = 'review';
      renderReview(r.args, p, view);
      motion('review', els.review);
      haptic('success');
      updateMood();
    }, 320);
  }

  var copyTimer = null;
  function clearCopyTimer() {
    if (copyTimer !== null) {
      clearTimeout(copyTimer);
      copyTimer = null;
    }
  }

  function renderReview(args, p, view) {
    stopRest(true);
    clearCopyTimer();
    els.view.hidden = true;
    els.tabBar.hidden = true;
    els.dates.hidden = true;
    els.review.hidden = false;
    window.scrollTo(0, 0);

    var facts, list;
    if (view === 'workout') {
      facts = h('dl', { class: 'facts' },
        h('dt', { text: 'Data' }), h('dd', { text: dateLabel(args.date) }),
        h('dt', { text: 'Sessão' }), h('dd', { text: args.session }),
        h('dt', { text: 'Status' }), h('dd', { text: args.complete ? 'Concluída' : 'Parcial' }));
      list = args.exercises.length ? h('ul', { class: 'review-list' }, args.exercises.map(function (ex) {
        var lines = ex.work.map(function (s, j) { return 'Série ' + (j + 1) + ': ' + C.describeSet(s); });
        if (ex.warmup) lines.push('Aquecimento: ' + C.describeSet(ex.warmup));
        if (ex.feeder) lines.push('Feeder: ' + C.describeSet(ex.feeder));
        if (ex.pain !== undefined) lines.push('Dor: ' + ex.pain);
        if (ex.note) lines.push('Nota: ' + ex.note);
        return h('li', { class: 'review-item' }, h('b', { text: ex.name }), lines.map(function (l) { return h('span', { text: l }); }));
      })) : h('p', { class: 'empty-plate p-16', text: 'Sem exercícios: só marca a sessão como concluída.' });
    } else if (view === 'water') {
      facts = h('dl', { class: 'facts' },
        h('dt', { text: 'Data' }), h('dd', { text: dateLabel(args.date) }),
        h('dt', { text: 'Água total' }), h('dd', { text: C.formatLiters(args.waterL) }),
        h('dt', { text: 'Adicionado agora' }), h('dd', { text: C.formatWaterDelta(S.food.waterAdd) }));
      list = null;
    } else {
      facts = h('dl', { class: 'facts' },
        h('dt', { text: 'Data' }), h('dd', { text: dateLabel(args.date) }),
        h('dt', { text: 'Refeição' }), h('dd', { text: args.meal }));
      list = h('ul', { class: 'review-list' }, args.items.map(function (it) {
        var name, meta;
        if (it.food !== undefined) { name = it.food; meta = C.formatBR(it.qty) + (it.unit ? ' ' + it.unit : '') + (it.measure ? ', ' + it.measure.toLowerCase() : ''); }
        else if (it.favorite !== undefined) { var por = it.portions === undefined ? 1 : it.portions; name = it.favorite; meta = 'favorita, ' + C.formatBR(por) + (por === 1 ? ' porção' : ' porções'); }
        else { name = it.description; meta = 'sem cálculo' + (it.qty !== undefined ? ', ' + C.formatBR(it.qty) + (it.unit ? ' ' + it.unit : '') : ''); }
        return h('li', { class: 'review-item' }, h('b', { text: name }), h('span', { text: meta }));
      }));
    }

    var map = null;
    if (view === 'workout' && Body) {
      var levels = bodyLevels(args.exercises.map(function (ex) { return { name: ex.name, sets: ex.work.length }; }), false);
      if (Object.keys(levels).length) {
        map = h('div', { class: 'body-review' },
          Body.create(levels, { title: 'Músculos deste treino' }),
          h('p', { class: 'body-note', text: Body.describe(levels) }));
      }
    }

    var showMeter = !inTelegram || !p.ok || p.bytes > C.LIMITS.PAYLOAD_BYTES * 0.75;
    var pct = Math.min(100, Math.round(p.bytes / C.LIMITS.PAYLOAD_BYTES * 100));
    var meter = showMeter ? h('div', { class: 'meter' + (p.ok ? '' : ' over') },
      h('div', { class: 'meter-bar' }, h('i', { style: 'width:' + pct + '%' })),
      h('p', { text: p.bytes + ' de ' + C.LIMITS.PAYLOAD_BYTES + ' bytes do limite do Telegram' })) : null;

    var pretty = JSON.stringify(JSON.parse(p.json), null, 2);
    var raw = inTelegram
      ? (!p.ok ? h('details', { class: 'raw' }, h('summary', { text: 'Ver o JSON' }), h('pre', { class: 'json', text: pretty })) : null)
      : h('div', {}, h('h2', { class: 'section-title', text: 'JSON que iria para o bot' }), h('pre', { class: 'json', id: 'json-out', text: pretty }));

    var reviewNodes = [
      mascot('happy', null, C.pulsoSummary(pulsoContext()), 'revisao'),
      h('div', { class: 'view-head mt-12' },
        h('h1', { class: 'view-title', text: 'Confira o envio' }),
        h('p', { class: 'view-sub', text: 'Confira os dados abaixo antes de enviar.' })),
      facts, map, list, meter, raw,
    ].filter(function (node) { return !!node; });
    els.review.replaceChildren.apply(els.review, reviewNodes);
    var reviewOrb = els.review.querySelector ? els.review.querySelector('.mascot-scene .shape') : null;
    if (reviewOrb) perch(reviewOrb, { mode: 'stage' });

    if (inTelegram) {
      setMain('Enviar ao bot', function () { send(p.json); });
    } else {
      setMain('Copiar JSON', function () { copyJson(p.json); });
      setSecondary('Editar', showForm);
    }
    updateBack();
    syncVoiceDock();
  }

  var sending = false; // between the tap on "Enviar" and Telegram closing the app
  var lift = null;     // the review's hand-off animation

  var sendTimer = null; // gives up waiting for Telegram to close the app
  var SEND_WAIT_MS = 8000;

  function endSend() {
    sending = false;
    clearTimeout(sendTimer);
    sendTimer = null;
    if (lift) { lift.cancel(); lift = null; }
    if (S.catalog) syncForm();
  }

  function showForm() {
    var back = S.screen === 'review';
    clearCopyTimer();
    endSend();
    S.screen = 'form';
    S.reviewView = '';
    els.review.hidden = true;
    els.view.hidden = false;
    els.tabBar.hidden = !!S.catalog.view;
    els.dates.hidden = false;
    render();
    if (back) motion('settle', els.view);
    updateBack();
    syncVoiceDock();
  }

  function send(json) {
    if (sending) return; // a second tap while the first send is in flight
    var targetView = S.reviewView || S.view;
    // Rebuild right before sending so what goes out is what the review showed.
    var r = targetView === 'water' ? buildWaterState() : build();
    var id = targetView === 'water' ? currentWaterId() : currentId();
    var p = r.args ? C.serializePayload(targetView, r.args, id) : null;
    if (!p || !p.ok || p.json !== json) { showForm(); if (targetView === 'water') goWaterReview(); else goReview(); return; }
    sending = true;
    syncForm();
    var again = mainHandler;
    setMainActive(false); // off before sendData; back only if it fails
    recordAndClearSent(targetView, p.json);
    say('thinking', 'Enviando para o bot');
    lift = motion('handoff', els.review); // a hand-off, not a confirmation: that is the bot's reply
    try {
      tg.sendData(p.json); // Telegram closes the app; the bot's reply is the confirmation.
      var scene = els.review.querySelector('.mascot-scene');
      if (scene) els.review.replaceChild(mascot('happy', 'Envio solicitado', C.pulsoSummary(pulsoContext()), 'revisao'), scene);
      // If it does not close, stop waiting: nothing is known about delivery, so say only that.
      sendTimer = setTimeout(function () {
        endSend();
        setMainActive(true, again);
        say('focused', 'O Telegram não fechou o formulário. Veja no chat se o bot respondeu; se não, envie de novo sem mudar nada: a planilha não grava duas vezes.');
      }, SEND_WAIT_MS);
    } catch (e) {
      endSend();
      setMainActive(true, again);
      saveDraft(); // the form is still in memory: put its draft back
      haptic('error');
      say('alert', 'O Telegram não aceitou o envio. Abra pelo botão do teclado do bot (mande /app).');
    }
  }

  /** "Restaurar último envio": reopen something sent before (e.g. the bot answered "não gravei"). */
  function restoreButton(t) {
    if (!store || !store.sent(t).length) return null;
    return h('button', { type: 'button', class: 'btn-text', text: 'Restaurar último envio', onclick: function () { openRestore(t); } });
  }

  function openRestore(t) {
    var list = store.sent(t);
    var ul = h('ul', { class: 'results' }, list.map(function (e) {
      var when = new Date(e.at);
      var time = String(when.getHours()).padStart(2, '0') + ':' + String(when.getMinutes()).padStart(2, '0');
      return h('li', {}, h('button', {
        type: 'button', class: 'result',
        onclick: function () { closeSheet(); restoreSent(e); },
      }, h('span', { text: e.label }), h('span', { class: 'tag', text: 'enviado ' + C.shortDate(C.todayIn(S.catalog.tz, when)) + ' ' + time })));
    }));
    openSheet('Restaurar último envio', h('div', { class: 'sheet-col' },
      h('p', { class: 'hint m-0', text: 'Use se o bot respondeu que não gravou. O formulário volta como estava no envio; revise e envie de novo.' }), ul));
  }

  function restoreSent(e) {
    var src = JSON.parse(JSON.stringify(e.form || {}));
    var offered = S.dates.map(function (d) { return d.key; });
    var dateOk = offered.indexOf(src.date) >= 0;
    var date = dateOk ? src.date : S.today;
    var apply = function () {
      if (e.t === 'workout') {
        if (S.catalog.sessions.indexOf(src.session) < 0) { say('alert', 'A sessão ' + src.session + ' não está mais na ficha.'); return; }
        S.view = 'workout';
        S.workout.date = date;
        S.workout.session = src.session;
        S.workout.forms[formKey(date, src.session)] = { id: src.id, date: date, session: src.session, complete: !!src.complete, cards: src.cards || [] };
      } else if (e.t === 'water') {
        S.view = 'food';
        S.food.date = date;
        S.food.waterId = src.id;
        S.food.waterAdd = src.addWaterL || 0;
      } else {
        S.view = 'food';
        S.food.id = src.id; // the same id: the resend cannot be written twice
        S.food.date = date;
        S.food.meal = src.meal || '';
        S.food.items = src.items || [];
      }
      S.showErrors = false;
      haptic('success');
      render();
      saveDraft();
      say('idle', 'Voltou como estava no envio' + (dateOk ? '' : ', com a data de hoje') + '. Revise e envie de novo.');
    };
    var busy = e.t === 'workout'
      ? (S.catalog.sessions.indexOf(src.session) >= 0 && !C.workoutFormEmpty(S.workout.forms[formKey(date, src.session)]))
      : !C.foodFormEmpty({ meal: S.food.meal, items: S.food.items });
    if (busy) confirmDialog('Substituir o que está preenchido agora pelo envio restaurado?', apply); else apply();
  }

  function copyJson(json) {
    var done = function () {
      haptic('success');
      say('happy', 'JSON copiado. No Telegram ele iria para o bot, e só a resposta do bot confirma.');
      if (!inTelegram && S.screen === 'review' && !isVoiceActive() && els.dockPrimary) {
        clearCopyTimer();
        els.dockPrimary.textContent = 'JSON copiado';
        copyTimer = setTimeout(function () {
          copyTimer = null;
          if (!inTelegram && S.screen === 'review' && !isVoiceActive() && els.dockPrimary) {
            els.dockPrimary.textContent = 'Copiar JSON';
          }
        }, 1800);
      }
    };
    var fallback = function () {
      var pre = $('json-out');
      if (pre) { var range = document.createRange(); range.selectNodeContents(pre); var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); }
      say('focused', 'Não deu para copiar automaticamente. O JSON está selecionado: copie à mão.');
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(json).then(done, fallback);
      else fallback();
    } catch (e) { fallback(); }
  }

  /* voice (C6b-4) --------------------------------------------------------------------------- */

  var voiceCtrl = null;
  var voiceSessionResult = null;
  var voicePlanBOpen = false;
  var voiceUiBlocked = null;
  var voicePreviewResult = null;
  var voiceTimerId = null;
  var voiceStartedAt = 0;
  var lockedControls = [];
  var mmVoiceMeter = null; // MuscleMotion voice meter handle (progressive enhancement)

  /** Called by voice.js onStream: starts/stops MuscleMotion voice meter reactivity. */
  function mmOnStream(stream) {
    if (mmVoiceMeter && typeof mmVoiceMeter.stop === 'function') {
      try { mmVoiceMeter.stop(); } catch (e) { /* ignore */ }
      mmVoiceMeter = null;
    }
    if (stream && MM && typeof MM.createVoiceMeter === 'function') {
      try { mmVoiceMeter = MM.createVoiceMeter(stream, els.shape); } catch (e) { /* ignore */ }
    }
  }

  function isVoiceActive() {
    return voicePlanBOpen || !!voiceUiBlocked || !!voicePreviewResult || !!(voiceCtrl && voiceCtrl.state().status !== 'idle');
  }

  function ensureVoiceEls() {
    if (!els.voicePanel && els.review && els.review.parentNode) {
      var panel = h('section', { id: 'voice-panel', class: 'voice-panel', hidden: true });
      panel.hidden = true;
      if (typeof els.review.parentNode.insertBefore === 'function') {
        els.review.parentNode.insertBefore(panel, els.review);
      } else {
        els.review.parentNode.appendChild(panel);
      }
      els.voicePanel = panel;
    }
    if (!els.dockMic && els.dock) {
      var btn = h('button', { type: 'button', class: 'dock-mic', id: 'dock-mic', 'aria-label': 'Gravar por voz', hidden: true });
      btn.hidden = true;
      els.dock.appendChild(btn);
      els.dockMic = btn;
    }
    if (els.dockMic && !els.dockMic._voiceBound) {
      els.dockMic._voiceBound = true;
      els.dockMic.replaceChildren(icon('mic'), h('span', { text: 'Voz' }));
      els.dockMic.addEventListener('click', onMicClick);
    }
  }

  function formatVoiceDuration(ms) {
    var totalSec = Math.max(0, Math.min(C.VOICE_LIMITS.MAX_SECONDS, Math.floor((ms || 0) / 1000)));
    var min = Math.floor(totalSec / 60);
    var sec = totalSec % 60;
    return min + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function clearVoiceTimer() {
    if (voiceTimerId !== null) {
      clearTimeout(voiceTimerId);
      voiceTimerId = null;
    }
  }

  function startVoiceTimer() {
    clearVoiceTimer();
    voiceStartedAt = Date.now();
    (function tick() {
      if (!voiceCtrl || voiceCtrl.state().status !== 'listening') {
        voiceTimerId = null;
        return;
      }
      var timerEl = $('voice-timer');
      if (timerEl) {
        timerEl.textContent = formatVoiceDuration(Date.now() - voiceStartedAt) + ' / ' + formatVoiceDuration(C.VOICE_LIMITS.MAX_SECONDS * 1000);
      }
      voiceTimerId = setTimeout(tick, 250);
    })();
  }

  function hasRichState(state) {
    return !!(Avatar && Array.isArray(Avatar.STATES) && Avatar.STATES.indexOf(state) >= 0);
  }

  function clearVoiceMascot(resetState) {
    if (!els.shape) return;
    els.shape.classList.remove('voice-listening', 'voice-thinking', 'voice-alert', 'voice-understood', 'voice-oops');
    if (resetState) {
      if (Avatar && Avatar.setMood) Avatar.setMood('idle');
      else els.shape.setAttribute('data-state', 'idle');
    }
  }

  function setVoiceMascot(mascotState, line) {
    var fallbackMood = mascotState === 'listening' ? 'focused'
      : mascotState === 'understood' ? 'happy'
      : mascotState === 'oops' ? 'alert'
      : mascotState;
    var rich = hasRichState(mascotState);
    var avatarMood = rich ? mascotState : fallbackMood;
    say(avatarMood, line);
    clearVoiceMascot();
    if (!els.shape) return;
    if (mascotState) {
      if (!(Avatar && Avatar.setMood && rich)) {
        els.shape.setAttribute('data-state', mascotState);
      }
      if (mascotState === 'listening') els.shape.classList.add('voice-listening');
      else if (mascotState === 'thinking') els.shape.classList.add('voice-thinking');
      else if (mascotState === 'alert' || mascotState === 'oops') els.shape.classList.add('voice-alert');
      else if (mascotState === 'understood') els.shape.classList.add('voice-understood');
    }
  }

  function lockControl(ctrl) {
    if (!ctrl || ctrl._voiceLocked || ctrl.disabled || ctrl.hasAttribute('disabled')) return;
    ctrl.disabled = true;
    ctrl.setAttribute('disabled', '');
    ctrl._voiceLocked = true;
    lockedControls.push(ctrl);
  }

  function setFormLocked(locked) {
    [els.tabBar, els.dates, els.view].forEach(function (el) {
      if (!el) return;
      el.classList.toggle('is-voice-locked', !!locked);
      el.setAttribute('aria-disabled', locked ? 'true' : 'false');
    });
    if (locked) {
      [els.tabBar, els.dates, els.view].forEach(function (rootEl) {
        if (!rootEl) return;
        var controls = Array.prototype.slice.call(rootEl.querySelectorAll('input'))
          .concat(Array.prototype.slice.call(rootEl.querySelectorAll('textarea')))
          .concat(Array.prototype.slice.call(rootEl.querySelectorAll('button')))
          .concat(Array.prototype.slice.call(rootEl.querySelectorAll('select')));
        controls.forEach(lockControl);
      });
    } else if (lockedControls.length) {
      lockedControls.forEach(function (ctrl) {
        if (ctrl && ctrl._voiceLocked) {
          ctrl.disabled = false;
          ctrl.removeAttribute('disabled');
          ctrl._voiceLocked = false;
        }
      });
      lockedControls = [];
    }
  }

  function voiceTypeChecker() {
    if (typeof window.MediaRecorder !== 'function' || typeof window.MediaRecorder.isTypeSupported !== 'function') return null;
    return function (m) { return window.MediaRecorder.isTypeSupported(m); };
  }

  function hasRealVoiceMedia() {
    var hasGum = !!(navigator && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
    var checker = voiceTypeChecker();
    var mime = checker ? C.pickVoiceMime(checker) : null;
    return !!(hasGum && checker && mime);
  }

  function voiceContextAvailable() {
    if (!S.catalog || !V) {
      return { showButton: false, canRecord: false, disabled: false, planB: false, reason: 'no_voice', message: '', mime: null };
    }
    if (!inTelegram) {
      if (!VS) {
        return { showButton: false, canRecord: false, disabled: false, planB: false, reason: 'no_voice', message: '', mime: null };
      }
      return { showButton: true, canRecord: true, disabled: false, planB: false, reason: '', message: '', mime: 'audio/webm;codecs=opus' };
    }
    var hasSession = !!(voiceSessionResult && voiceSessionResult.ok && voiceSessionResult.session);
    var nowSec = Math.floor(Date.now() / 1000);
    var canExchange = !voiceSessionResult && !!(
      (tg && typeof tg.initData === 'string' && tg.initData.length > 0) ||
      (S.catalog.vc && S.catalog.vx && S.catalog.vx > nowSec)
    );
    var hasGum = !!(navigator && navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
    var hasRec = typeof window.MediaRecorder === 'function';
    return C.voiceAvailable({
      vu: S.catalog.vu,
      preview: false,
      hasSession: hasSession,
      canExchange: canExchange,
      reason: voiceSessionResult ? voiceSessionResult.reason : '',
      message: voiceSessionResult ? voiceSessionResult.message : '',
      hasGetUserMedia: hasGum,
      hasMediaRecorder: hasRec,
      isTypeSupported: voiceTypeChecker(),
    });
  }

  function syncVoiceDock() {
    ensureVoiceEls();
    var avail = voiceContextAvailable();
    var voiceBusy = isVoiceActive();
    var showMic = !!(avail.showButton && S.catalog && S.screen === 'form' && !voiceBusy && !S.sheetOpen);
    if (els.dockMic) {
      els.dockMic.hidden = !showMic;
      els.dockMic.classList.toggle('is-disabled', !!avail.disabled);
      els.dockMic.setAttribute('aria-disabled', avail.disabled ? 'true' : 'false');
    }
    if (!els.dock) return;
    if (inTelegram) {
      els.dock.hidden = !showMic;
      els.dock.classList.toggle('dock-voice-only', showMic);
      document.documentElement.style.setProperty('--dock-h', showMic ? '72px' : '0px');
    } else {
      var anyVisible = !els.dockPrimary.hidden || !els.dockSecondary.hidden || showMic;
      els.dock.hidden = !anyVisible;
      els.dock.classList.remove('dock-voice-only');
      document.documentElement.style.setProperty('--dock-h', anyVisible ? '72px' : '0px');
    }
  }

  function closeMiniApp() {
    if (inTelegram && tg && typeof tg.close === 'function') {
      try { tg.close(); } catch (e) { /* ignore */ }
      return;
    }
    voicePlanBOpen = false;
    voiceUiBlocked = null;
    syncVoiceUi();
    if (!inTelegram) say('idle', 'No Telegram, este botão fecha o app para você gravar no chat.');
  }

  function openPlanB() {
    voiceUiBlocked = null;
    voicePreviewResult = null;
    voicePlanBOpen = true;
    syncVoiceUi();
  }

  function closePlanB() {
    voicePlanBOpen = false;
    voiceUiBlocked = null;
    voicePreviewResult = null;
    syncVoiceUi();
  }

  function sendVoicePayload(data) {
    if (!data || !data.json || !data.payload || data.payload.t !== 'text' || data.payload.src !== 'voice') return;
    if (inTelegram) {
      try {
        tg.sendData(data.json);
        say('happy', 'Envio solicitado');
      } catch (e) {
        haptic('error');
        say('alert', 'O Telegram não aceitou o envio. Abra pelo botão do teclado do bot (mande /app).');
      }
    } else {
      voicePreviewResult = { json: data.json, payload: data.payload };
      syncVoiceUi();
      say('happy', 'Texto confirmado na prévia.');
    }
  }

  function onMicClick() {
    wake();
    var avail = voiceContextAvailable();
    if (!avail.showButton) return;
    if (avail.planB) {
      voicePreviewResult = null;
      voicePlanBOpen = false;
      voiceUiBlocked = {
        reason: avail.reason,
        message: avail.message || C.voiceError('no_supported_format').message,
      };
      cancelReview();
      if (S.sheetOpen) closeSheet();
      syncVoiceUi();
      return;
    }
    if (!voiceCtrl) return;
    voicePlanBOpen = false;
    voiceUiBlocked = null;
    voicePreviewResult = null;
    cancelReview();
    if (S.sheetOpen) closeSheet();
    voiceCtrl.start();
  }

  function renderVoicePanel() {
    ensureVoiceEls();
    var panel = els.voicePanel;
    if (!panel) return;

    if (voicePlanBOpen) {
      panel.hidden = false;
      panel.replaceChildren(
        h('div', { class: 'voice-head' }, h('h2', { class: 'voice-title', text: 'Gravar no chat' })),
        h('p', { class: 'voice-copy', text: 'Feche e segure o 🎤 na conversa: eu transcrevo e confirmo com você.' }),
        h('div', { class: 'voice-actions' },
          h('button', { type: 'button', class: 'btn-primary', text: 'Fechar app', onclick: closeMiniApp }),
          h('button', { type: 'button', class: 'btn-text', text: 'Voltar', onclick: closePlanB }))
      );
      return;
    }

    if (voiceUiBlocked) {
      panel.hidden = false;
      panel.replaceChildren(
        h('div', { class: 'voice-head' }, h('h2', { class: 'voice-title', text: 'Voz indisponível aqui' })),
        h('p', { class: 'voice-copy', text: voiceUiBlocked.message }),
        h('div', { class: 'voice-actions' },
          h('button', { type: 'button', class: 'btn-soft', text: 'Gravar no chat', onclick: openPlanB }),
          h('button', { type: 'button', class: 'btn-text', text: 'Fechar', onclick: closePlanB }))
      );
      return;
    }

    if (voicePreviewResult) {
      var pretty = JSON.stringify(voicePreviewResult.payload, null, 2);
      panel.hidden = false;
      panel.replaceChildren(
        h('div', { class: 'voice-head' }, h('h2', { class: 'voice-title', text: 'JSON que iria para o bot' })),
        h('p', { class: 'voice-copy', text: 'Modo prévia: texto confirmado localmente (nada foi enviado ao bot).' }),
        h('pre', { class: 'json', id: 'voice-json-out', text: pretty }),
        h('div', { class: 'voice-actions' },
          h('button', { type: 'button', class: 'btn-soft', text: 'Gravar outro', onclick: function () { voicePreviewResult = null; syncVoiceUi(); if (voiceCtrl) voiceCtrl.start(); } }),
          h('button', { type: 'button', class: 'btn-text', text: 'Fechar', onclick: closePlanB }))
      );
      return;
    }

    var st = voiceCtrl ? voiceCtrl.state() : C.initialVoiceState();
    if (st.status === 'idle') {
      panel.hidden = true;
      panel.replaceChildren();
      return;
    }

    panel.hidden = false;
    if (st.status === 'consent') {
      panel.replaceChildren(
        h('div', { class: 'voice-head' }, h('h2', { class: 'voice-title', text: 'Antes de gravar' })),
        h('p', { class: 'voice-copy', text: 'Seu áudio vai para transcrição automática (Google Gemini) e é apagado em seguida. Você confere o texto antes de eu registrar.' }),
        h('div', { class: 'voice-actions' },
          h('button', { type: 'button', class: 'btn-primary', text: 'Entendi', onclick: function () { voiceCtrl.acceptConsent(); } }),
          h('button', { type: 'button', class: 'btn-text', text: 'Agora não', onclick: function () { voiceCtrl.declineConsent(); } }))
      );
      return;
    }

    if (st.status === 'asking_permission') {
      panel.replaceChildren(
        h('div', { class: 'voice-head' }, h('h2', { class: 'voice-title', text: 'Permita o microfone…' })),
        h('p', { class: 'voice-copy', text: 'Autorize o acesso ao microfone para começar a gravar.' }),
        h('div', { class: 'voice-actions' },
          h('button', { type: 'button', class: 'btn-text', text: 'Cancelar', onclick: function () { voiceCtrl.cancel(); } }))
      );
      return;
    }

    if (st.status === 'listening') {
      var elapsed = voiceStartedAt ? (Date.now() - voiceStartedAt) : 0;
      panel.replaceChildren(
        h('div', { class: 'voice-head' },
          h('h2', { class: 'voice-title', text: 'Ouvindo…' }),
          h('span', { class: 'voice-timer', id: 'voice-timer', text: formatVoiceDuration(elapsed) + ' / ' + formatVoiceDuration(C.VOICE_LIMITS.MAX_SECONDS * 1000) })),
        h('p', { class: 'voice-copy', text: 'Fale seu treino ou refeição. Limite de 1min30.' }),
        h('div', { class: 'voice-actions' },
          h('button', { type: 'button', class: 'btn-primary', text: 'Parar', onclick: function () { voiceCtrl.stop(); } }),
          h('button', { type: 'button', class: 'btn-text', text: 'Cancelar', onclick: function () { voiceCtrl.cancel(); } }))
      );
      return;
    }

    if (st.status === 'sending') {
      panel.replaceChildren(
        h('div', { class: 'voice-head' }, h('h2', { class: 'voice-title', text: 'Entendendo…' })),
        h('p', { class: 'voice-copy', text: 'Transcrevendo seu áudio.' }),
        h('div', { class: 'voice-actions' },
          h('button', { type: 'button', class: 'btn-text', text: 'Cancelar', onclick: function () { voiceCtrl.cancel(); } }))
      );
      return;
    }

    if (st.status === 'transcribed') {
      var ta = h('textarea', {
        id: 'voice-textarea',
        class: 'textarea' + (st.textError ? ' is-bad' : ''),
        rows: '3',
        'aria-label': 'Texto transcrito',
        value: st.text || '',
        oninput: function () { voiceCtrl.editText(ta.value); },
      });
      var errEl = h('p', { id: 'voice-text-error', class: 'field-error', role: 'alert', text: st.textError || '' });
      errEl.hidden = !st.textError;
      panel.replaceChildren(
        h('div', { class: 'voice-head' }, h('h2', { class: 'voice-title', text: 'Entendi:' })),
        ta,
        errEl,
        h('div', { class: 'voice-actions' },
          h('button', { type: 'button', class: 'btn-soft', text: 'Regravar', onclick: function () { voiceCtrl.rerecord(); } }),
          h('button', { type: 'button', class: 'btn-text', text: 'Cancelar', onclick: function () { voiceCtrl.cancel(); } }))
      );
      return;
    }

    if (st.status === 'error') {
      var err = st.error || C.voiceError('unknown');
      var buttons = (err.buttons || []).map(function (btn) {
        return h('button', {
          type: 'button',
          class: btn.id === 'plan_b' ? 'btn-soft' : 'btn-primary',
          text: btn.label,
          onclick: function () {
            if (btn.id === 'retry') voiceCtrl.retry();
            else if (btn.id === 'retry_permission') voiceCtrl.retryPermission();
            else if (btn.id === 'rerecord') voiceCtrl.rerecord();
            else if (btn.id === 'plan_b') voiceCtrl.planB();
          },
        });
      });
      buttons.push(h('button', { type: 'button', class: 'btn-text', text: 'Cancelar', onclick: function () { voiceCtrl.cancel(); } }));
      panel.replaceChildren(
        h('div', { class: 'voice-head' }, h('h2', { class: 'voice-title', text: 'Não deu para gravar' })),
        h('p', { class: 'voice-error', role: 'alert', text: err.message }),
        h('div', { class: 'voice-actions' }, buttons)
      );
    }
  }

  function syncVoiceUi(prevState) {
    var st = voiceCtrl ? voiceCtrl.state() : C.initialVoiceState();
    if (st.status === 'listening') {
      if (!prevState || prevState.status !== 'listening') startVoiceTimer();
    } else {
      clearVoiceTimer();
    }

    var active = isVoiceActive();
    if (active) stopRest(true);
    setFormLocked(active);
    if (active) perch(null);

    if (voicePlanBOpen) {
      clearVoiceMascot();
      say('idle', 'Você pode mandar áudio direto no chat.');
      setMain('Fechar app', closeMiniApp);
      setSecondary('Voltar', closePlanB);
    } else if (voiceUiBlocked) {
      setVoiceMascot(hasRichState('oops') ? 'oops' : 'alert', voiceUiBlocked.message);
      hideMain();
      setSecondary(null);
    } else if (voicePreviewResult) {
      clearVoiceMascot();
      hideMain();
      setSecondary(null);
    } else if (st.status === 'idle') {
      clearVoiceMascot(true);
      if (S.catalog && S.screen === 'form') {
        updateMainForForm();
        updateMood();
      }
    } else {
      if (st.mascot === 'listening') {
        setVoiceMascot('listening', st.status === 'asking_permission' ? 'Permita o microfone.' : 'Estou ouvindo. Fale perto do microfone.');
      } else if (st.mascot === 'thinking') {
        setVoiceMascot('thinking', 'Entendendo o áudio');
      } else if (st.mascot === 'alert') {
        setVoiceMascot(hasRichState('oops') ? 'oops' : 'alert', st.error ? st.error.message : 'Não consegui gravar.');
      } else if (st.status === 'consent') {
        clearVoiceMascot();
        say('idle', 'Antes de gravar, confira o aviso de privacidade.');
      } else if (st.status === 'transcribed' || st.status === 'confirming') {
        var currentMascot = Avatar && Avatar.mood ? Avatar.mood() : (els.shape && els.shape.getAttribute('data-state'));
        var unchangedTranscribed = !!(prevState && prevState.status === st.status && !prevState.textError && !st.textError);
        if (st.textError) {
          clearVoiceMascot();
          say('alert', st.textError);
        } else if (hasRichState('understood')) {
          if (!(unchangedTranscribed && currentMascot === 'understood')) {
            setVoiceMascot('understood', 'Confira o texto antes de enviar.');
          }
        } else if (!(unchangedTranscribed && currentMascot === 'happy')) {
          clearVoiceMascot();
          say('happy', 'Confira o texto antes de enviar.');
        }
      }

      if (st.status === 'transcribed' || st.status === 'confirming') {
        setMain('Enviar', function () { voiceCtrl.send(); });
        setSecondary('Cancelar', function () { voiceCtrl.cancel(); });
      } else {
        hideMain();
        setSecondary(null);
      }
    }

    if (prevState && prevState.status === 'transcribed' && st.status === 'transcribed' && !voicePlanBOpen && !voiceUiBlocked && !voicePreviewResult) {
      var ta = $('voice-textarea');
      var errEl = $('voice-text-error');
      if (ta && errEl) {
        ta.classList.toggle('is-bad', !!st.textError);
        errEl.textContent = st.textError || '';
        errEl.hidden = !st.textError;
        syncVoiceDock();
        return;
      }
    }

    renderVoicePanel();
    syncVoiceDock();
  }

  function initVoice() {
    ensureVoiceEls();
    if (!V || !S.catalog) return;

    if (!inTelegram) {
      if (!VS) {
        voiceCtrl = null;
        voiceSessionResult = null;
        syncVoiceDock();
        return;
      }
      var previewFetch = VS.createFetch(function () { return S.view; });
      var useReal = hasRealVoiceMedia();
      var fallbackMedia = useReal ? null : VS.createMedia();
      var previewSession = {
        vu: VS.vu,
        ref: 'preview',
        session: 's1.preview-stub',
        expires_at: Math.floor(Date.now() / 1000) + 43200,
      };
      voiceSessionResult = { ok: true, status: 'ready', session: previewSession, showButton: true, canRecord: true };
      var ctrlOpts = {
        storage: storage,
        fetch: previewFetch,
        session: previewSession,
        onState: function (next, prev) { syncVoiceUi(prev); },
        onSendData: sendVoicePayload,
        onPlanB: openPlanB,
        onStream: mmOnStream,
      };
      if (!useReal) {
        ctrlOpts.getUserMedia = fallbackMedia.getUserMedia;
        ctrlOpts.MediaRecorder = fallbackMedia.MediaRecorder;
      }
      voiceCtrl = V.createVoiceController(ctrlOpts);
      syncVoiceDock();
      return;
    }

    if (!S.catalog.vu) {
      voiceCtrl = null;
      voiceSessionResult = null;
      syncVoiceDock();
      return;
    }

    var tgFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
    voiceCtrl = V.createVoiceController({
      storage: storage,
      fetch: tgFetch,
      getSession: function () { return voiceSessionResult && voiceSessionResult.ok ? voiceSessionResult.session : null; },
      onState: function (next, prev) { syncVoiceUi(prev); },
      onSendData: sendVoicePayload,
      onPlanB: openPlanB,
      onStream: mmOnStream,
      onDeleteSession: function () {
        voiceSessionResult = {
          ok: false,
          status: 'disabled',
          session: null,
          reason: 'auth_expired',
          message: C.voiceError('auth_expired').message,
          showButton: true,
          canRecord: false,
        };
        syncVoiceDock();
      },
    });
    syncVoiceDock();

    V.resolveSession({
      vu: S.catalog.vu,
      vc: S.catalog.vc,
      vx: S.catalog.vx,
      initData: tg && typeof tg.initData === 'string' ? tg.initData : '',
    }, {
      storage: storage,
      fetch: tgFetch,
    }).then(function (res) {
      voiceSessionResult = res;
      if (voiceCtrl && res && res.ok && res.session) voiceCtrl.setSession(res.session);
      syncVoiceDock();
    });
  }

  /* render / init ---------------------------------------------------------------------------- */

  function render() {
    cancelReview(); // navigation (tab, date, restore) drops a review being prepared
    S.reviewView = '';
    focusedCard = null;
    S.focus = null;
    glance(null);
    perch(null);
    renderChrome();
    if (S.view === 'workout') renderWorkout(); else renderFood();
    updateMainForForm();
    updateMood();
  }

  function applyScheme() {
    var dark = inTelegram ? tg.colorScheme === 'dark'
      : !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.setAttribute('data-scheme', dark ? 'dark' : 'light');
    if (inTelegram && versionAtLeast('6.1')) {
      try { tg.setHeaderColor('secondary_bg_color'); tg.setBackgroundColor('secondary_bg_color'); } catch (e) { /* ignore */ }
    }
    if (S.catalog) { if (S.screen === 'form') updateMainForForm(); }
  }

  function fatal(line, text) {
    els.tabBar.hidden = true;
    els.dates.hidden = true;
    els.dock.hidden = true;
    if (els.voicePanel) els.voicePanel.hidden = true;
    if (els.dockMic) els.dockMic.hidden = true;
    syncForm({ intro: true });
    els.view.replaceChildren(h('div', { class: 'empty-plan mt-16' }, mascot('alert', line, text, 'base')));
    say('alert', line);
    if (tg && tg.MainButton) { try { tg.MainButton.hide(); } catch (e) { /* ignore */ } }
  }

  /** Plain-language reason for a catalog that could not be read. */
  function catalogProblem(err) {
    var m = String(err && err.message || err);
    var detail = inTelegram ? '' : ' (' + m + ')';
    if (err && err.code === 'no_catalog') {
      return ['Abra de novo pelo /app.', 'Este botão não trouxe a sua ficha. Mande /app no chat do bot: ele envia botões novos de Treino e Refeição.'];
    }
    if (/TextDecoder|DecompressionStream|is not defined|not a function|not supported/i.test(m)) {
      return ['Este Telegram está desatualizado.', 'O aplicativo não consegue abrir a ficha neste aparelho' + detail + '. Atualize o Telegram, ou registre pelo chat do bot como antes.'];
    }
    if (/inflate|base64|JSON|Unexpected|versão|inválid/i.test(m)) {
      return ['A ficha deste link veio quebrada.', 'Não consegui ler a ficha' + detail + '. Mande /app no chat do bot para receber botões novos.'];
    }
    return ['Não consegui abrir a ficha.', 'Algo deu errado ao abrir a ficha' + detail + '. Mande /app no chat do bot e tente de novo.'];
  }

  function loadCatalog(hash) {
    if (hash.blob) {
      // A stalled decompressor must not leave Shape saying "Carregando" forever.
      var timeout = new Promise(function (_, reject) {
        setTimeout(function () { reject(new Error('DecompressionStream not supported (tempo esgotado)')); }, 8000);
      });
      return Promise.race([C.decodeCatalog(hash.blob), timeout]);
    }
    if (inTelegram) { var e = new Error('link sem catálogo'); e.code = 'no_catalog'; return Promise.reject(e); }
    return fetch('dev/sample-catalog.json', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(C.normalizeCatalog);
  }

  function init() {
    applyScheme();
    ensureRestBar();
    ensureVoiceEls();
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        if (voiceCtrl) voiceCtrl.hide();
      } else if (rest.active) {
        clearRestTimer();
        tickRest();
      }
    });
    if (window.addEventListener) {
      window.addEventListener('pagehide', function () {
        stopRest(true);
        if (voiceCtrl) voiceCtrl.hide();
        mmOnStream(null); // deterministic meter cleanup
      });
    }
    if (tg) {
      try { tg.ready(); tg.expand(); } catch (e) { /* ignore */ }
      if (inTelegram) {
        tg.onEvent('themeChanged', applyScheme);
        tg.onEvent('viewportChanged', function (ev) {
          if (((ev && ev.isExpanded === false) || (tg && tg.isExpanded === false)) && voiceCtrl) voiceCtrl.collapse();
        });
        if (tg.MainButton) tg.MainButton.onClick(onMain);
        if (tg.BackButton) tg.BackButton.onClick(onBack);
      }
    }
    if (!inTelegram) {
      els.banner.hidden = false;
      els.dock.hidden = false;
      document.documentElement.style.setProperty('--dock-h', '72px');
      els.dockPrimary.addEventListener('click', onMain);
      if (window.matchMedia) {
        var mq = window.matchMedia('(prefers-color-scheme: dark)');
        if (mq && mq.addEventListener) mq.addEventListener('change', applyScheme);
        else if (mq && mq.addListener) mq.addListener(applyScheme);
      }
    }

    var hash = launch;
    S.view = hash.view;
    loadCatalog(hash).then(function (catalog) {
      S.catalog = catalog;
      if (catalog.view) S.view = catalog.view;
      S.dates = C.dateOptions(catalog.tz);
      S.today = S.dates[0].key;
      S.workout = { date: S.today, session: catalog.next, forms: {} };
      S.food = { date: S.today, meal: '', items: [], mode: 'food', compose: null, waterAdd: 0, waterId: '' };

      store = C.draftStore(storage, catalog.client);
      try { if (storage) storage.removeItem(LEGACY_DRAFT_KEY); } catch (e) { /* ignore */ }
      var drafts = store.loadWorkouts(S.today).filter(function (d) { return catalog.sessions.indexOf(d.session) >= 0; });
      drafts.forEach(function (d) {
        d.cards.forEach(function (card) {
          var row = planRowFor(card.name);
          if (row) { card.p = row.p; card.l = row.l; }
        });
        S.workout.forms[formKey(d.date, d.session)] = { id: d.id, date: d.date, session: d.session, complete: !!d.complete, cards: d.cards, touchedAt: d.savedAt };
      });
      // Reopen where the user was: the most recently edited workout draft.
      var latest = drafts.slice().sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); })[0];
      if (latest) { S.workout.date = latest.date; S.workout.session = latest.session; }
      var foodDraft = !catalog.prefillFood ? store.loadFood(S.today) : null;
      if (catalog.prefillFood) {
        var pre = catalog.prefillFood;
        var validDate = S.dates.some(function (d) { return d.key === pre.date; });
        S.view = 'food';
        S.food = {
          id: C.newSubmissionId(),
          date: validDate ? pre.date : S.today,
          meal: pre.meal || '',
          items: pre.items.slice(),
          mode: 'food',
          compose: null,
          waterAdd: 0,
          waterId: '',
        };
      } else if (foodDraft) {
        S.food.id = foodDraft.id;
        S.food.date = foodDraft.date;
        S.food.meal = foodDraft.meal || '';
        S.food.items = foodDraft.items;
      }
      var draft = !!(latest || foodDraft);
      var first = cards()[0];
      if (first && !cards().some(function (c) { return c.open; })) first.open = true;
      render();
      if (catalog.prefillFood) {
        say('idle', 'Rascunho carregado! Ajuste as gramas ou troque itens antes de enviar.');
        choreograph('notice');
      } else if (draft) say('idle', 'Rascunho recuperado. Continue de onde parou.');
      initVoice();
      if (catalog.ft) {
        var timeout = new Promise(function (resolve) {
          setTimeout(function () { resolve(Object.assign({}, catalog, { tableStatus: 'unavailable', freeFoods: true })); }, 8000);
        });
        Promise.race([C.loadFoodTable(catalog), timeout]).then(function (loaded) {
          S.catalog = loaded;
          if (S.view !== 'food' || S.screen !== 'form' || isVoiceActive()) return;
          var active = document.activeElement;
          var label = active && active.getAttribute('aria-label');
          var start = active && active.selectionStart, end = active && active.selectionEnd;
          renderFood();
          if (label) {
            var inputs = Array.prototype.slice.call(els.view.querySelectorAll('input'))
              .concat(Array.prototype.slice.call(els.view.querySelectorAll('textarea')));
            Array.prototype.some.call(inputs, function (input) {
              if (input.getAttribute('aria-label') !== label) return false;
              input.focus();
              if (input.setSelectionRange && typeof start === 'number') input.setSelectionRange(start, end);
              return true;
            });
          }
        });
      }
    }).catch(function (err) {
      if (!inTelegram && !hash.blob) {
        fatal('O catálogo de exemplo não carregou.', 'Não consegui carregar dev/sample-catalog.json (' + err.message + '). Sirva a pasta apps/miniapp por HTTP.');
        return;
      }
      var why = catalogProblem(err);
      fatal(why[0], why[1]);
    });
  }

  try {
    init();
  } catch (err) {
    var why = catalogProblem(err);
    fatal(why[0], why[1]);
  }
  window.__shapeStarted = true;
})();
