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
    banner: $('preview-banner'), shape: $('shape'), say: $('say'), tabs: document.querySelectorAll('.tab'),
    tabBar: document.querySelector('.tabs'), dates: $('dates'), view: $('view'), review: $('review'),
    dock: $('dock'), dockPrimary: $('dock-primary'), dockSecondary: $('dock-secondary'),
    sheet: $('sheet'), backdrop: $('sheet-backdrop'),
  };

  var S = {
    catalog: null,
    view: 'workout',
    screen: 'form',
    today: '',
    dates: [],
    showErrors: false,
    focus: null,
    // One form per (date, session): {complete, cards}. Only the visible one is sent.
    workout: { date: '', session: '', forms: {} },
    food: { date: '', meal: '', items: [], mode: 'food', compose: null },
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
  };
  function icon(name) {
    var span = document.createElement('span');
    span.className = 'ic';
    span.setAttribute('aria-hidden', 'true');
    // Constant markup only (never user text).
    span.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' + ICONS[name] + '</svg>';
    return span.firstChild;
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
  function dateLabel(key) {
    var opt = S.dates.filter(function (d) { return d.key === key; })[0];
    return (opt ? opt.label + ', ' : '') + C.weekday(key) + ' ' + C.shortDate(key);
  }

  /* Shape (mascot) --------------------------------------------------------------------------- */

  // Artwork stays swappable; context/reaction decisions come from ShapeCore.
  var Avatar = window.ShapeAvatar;
  var Body = window.ShapeBody || null; // the muscle map (src/body.js); the page works without it
  if (Avatar) Avatar.mount(els.shape, els.say);
  if (Avatar && Avatar.intro) Avatar.intro('Abrindo sua ficha'); // lands in the header on the first say()

  function say(mood, text) {
    if (!Avatar) { if (text) els.say.textContent = text; return; }
    if (Avatar.setDozing) Avatar.setDozing(false);
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
    var compose = S.food.compose;
    return { view: S.view, cards: S.catalog && S.workout.session ? cards() : [], cardIndex: focusedCard, plan: currentPlan(),
      items: S.food.items, compose: compose && S.food.mode === 'description'
        ? { kind: 'description', description: compose.description, qty: compose.dqty } : null };
  }

  function react(reaction) {
    if (!reaction) return;
    say(reaction.mood, reaction.line);
    if (Avatar && Avatar.pulse) Avatar.pulse(reaction.pulse);
  }

  function glance(target) {
    gazeTarget = target;
    if (Avatar && Avatar.glance) Avatar.glance(target);
  }

  function wake() {
    var wasDozing = Avatar && Avatar.dozing && Avatar.dozing();
    if (Avatar && Avatar.setDozing) Avatar.setDozing(false);
    if (wasDozing && gazeTarget && Avatar.glance) Avatar.glance(gazeTarget);
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function rest() {
      if (C.pulsoDozing(C.PULSO_IDLE_MS, !S.catalog || sending || reviewTimer !== null || S.sheetOpen)) {
        if (Avatar && Avatar.setDozing) Avatar.setDozing(true);
      } else idleTimer = setTimeout(rest, C.PULSO_IDLE_MS);
    }, C.PULSO_IDLE_MS);
  }

  els.shape.addEventListener('pointerdown', function (e) { e.preventDefault(); }); // keep the typing field focused
  els.shape.addEventListener('click', function () {
    wake();
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

  /** A large Shape for empty, error and success states (its own, independent mood). */
  function mascot(mood, title, text) {
    var box = Avatar ? Avatar.create(mood) : h('div', { class: 'shape' });
    return h('div', { class: 'mascot-scene' }, box, h('p', {}, title ? h('b', { text: title }) : null, text));
  }

  /** Motion is decoration (src/motion.js): a missing or failing call changes nothing. */
  function motion(name) {
    var M = window.ShapeMotion;
    if (!M || typeof M[name] !== 'function') return null;
    try { return M[name].apply(M, Array.prototype.slice.call(arguments, 1)); } catch (e) { return null; }
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

  /** Avatar ring: explicit planned sets, otherwise exercises with a set; meal = items / 3. */
  function syncProgress() {
    if (!S.catalog) return;
    if (S.view === 'workout' && S.workout.session) {
      observedForm = form();
      observedCards = JSON.parse(JSON.stringify(cards()));
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
      else if (!S.food.meal) say('idle', 'Escolha a refeição.');
      else if (!k) say('idle', S.food.meal + ': adicione o que você comeu.');
      else say('idle', S.food.meal + ' com ' + plural(k, 'item', 'itens') + '.');
    }
  }

  document.addEventListener('focusin', function (e) {
    var t = e.target;
    wake();
    if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) {
      for (var parent = t; parent && parent.getAttribute; parent = parent.parentNode) {
        if (parent.hasAttribute('data-card-index')) { focusedCard = Number(parent.getAttribute('data-card-index')); break; }
      }
      glance(t);
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
        if (gazeTarget === leaving) glance(null);
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
      els.dockPrimary.textContent = text;
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
    var label;
    if (S.view === 'workout') {
      var n = filledCount();
      label = n ? 'Revisar treino (' + n + ')' : 'Revisar treino';
    } else {
      var k = S.food.items.length;
      label = k ? 'Revisar refeição (' + k + ')' : 'Revisar refeição';
    }
    setMain(label, goReview);
    setSecondary(null);
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
          if (S.view === 'workout') S.workout.date = d.key; else S.food.date = d.key;
          haptic('select');
          render();
          motion('settle', els.view);
          changed(true);
        },
      }, d.label, h('small', { text: C.weekday(d.key) + ' ' + C.shortDate(d.key) }));
    }));
  }

  Array.prototype.forEach.call(els.tabs, function (t) {
    t.addEventListener('click', function () {
      var v = t.getAttribute('data-view');
      if (v === S.view || (S.catalog.view && S.catalog.view !== v)) return;
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
        w.session ? 'Adicione exercícios do catálogo logo abaixo.' : 'Cadastre a ficha na planilha e mande /app de novo.')));
    }
    list.forEach(function (card, i) {
      var el = renderCard(card, i);
      cardEls.push(el);
      cardsBox.appendChild(el);
    });

    var addBtn = h('button', { type: 'button', class: 'btn-soft btn-block add-ex', onclick: openExercisePicker }, icon('plus'), 'Adicionar exercício');

    var sw = h('input', {
      type: 'checkbox', role: 'switch',
      onchange: function () { form().complete = sw.checked; haptic('select'); changed(true); },
    });
    sw.checked = w.session ? !!form().complete : false;
    var complete = h('label', { class: 'switch-row' },
      h('span', {}, h('b', { text: 'Marcar sessão como concluída' }), h('small', { text: 'Desligado, o treino entra como parcial e pode ser retomado.' })),
      h('span', { class: 'switch' }, sw, h('span', {})));

    var reset = h('div', { class: 'foot-actions' }, restoreButton('workout'), h('button', { type: 'button', class: 'btn-text', onclick: resetWorkout, text: 'Limpar este treino' }));

    els.view.replaceChildren.apply(els.view, [head, chips].concat(w.session ? [bodyPanel(), cardsBox, addBtn, complete, reset] : [cardsBox])
      .filter(function (el) { return !!el; }));
    if (!w.session) bodyEl = bodyNote = null;
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
      onclick: function () { focusedCard = i; card.open = !card.open; replaceCard(i); scheduleSave(); },
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
          h('p', { class: 'hint', style: 'margin:0', text: 'Vazio = não informado.' }))));
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
    errs.forEach(function (e) { ul.appendChild(h('li', { text: e.message.replace(card.name + ': ', '') })); });
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
          el._errors.replaceChildren.apply(el._errors, mine.map(function (e) { return h('li', { text: e.message.replace(card.name + ': ', '') }); }));
          el._errors.hidden = !mine.length;
        }
      });
    } else {
      var ferrs = build().errors;
      document.querySelectorAll('.plate-item').forEach(function (li, i) {
        li.classList.toggle('bad', ferrs.some(function (e) { return e.item === i; }));
      });
    }
  }

  function resetWorkout() {
    var go = function () {
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

  function openSheet(title, content, focusEl) {
    els.sheet.replaceChildren(h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }), h('h2', { class: 'sheet-title', id: 'sheet-title', text: title }), content);
    cancelReview();
    motion('keep', els.sheet); // reopened while it was still sliding out
    motion('keep', els.backdrop);
    els.sheet.hidden = false;
    els.backdrop.hidden = false;
    S.sheetOpen = true;
    updateBack();
    if (focusEl) setTimeout(function () { focusEl.focus(); }, 60);
  }
  /** The state closes at once; the sheet and backdrop only finish sliding out (taps pass through). */
  function closeSheet() {
    [els.sheet, els.backdrop].forEach(function (el) {
      if (el.hidden) return;
      if (!motion('out', el, function () { el.hidden = true; })) el.hidden = true;
    });
    S.sheetOpen = false;
    updateBack();
  }
  els.backdrop.addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.sheetOpen) closeSheet(); });

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
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          },
        }, h('span', { text: e.name }), h('span', { class: 'tag', text: e.group })));
      }) : [h('li', { class: 'hint', text: options.length ? 'Nada com esse nome no catálogo.' : 'Todos os exercícios do catálogo já estão na lista.' })]);
    }
    fill();
    openSheet('Adicionar exercício', h('div', { style: 'display:flex;flex-direction:column;min-height:0;flex:1' },
      h('label', { class: 'search' }, icon('search'), input), list), input);
  }

  /* food view -------------------------------------------------------------------------------- */

  function freshCompose() {
    return { query: '', food: '', qty: '', unit: S.catalog.units[0] || '', measure: '', description: '', dqty: '', dunit: '' };
  }

  function renderFood() {
    var f = S.food;
    if (!f.compose) f.compose = freshCompose();
    var head = h('div', { class: 'view-head' },
      h('h1', { class: 'view-title', text: f.meal || 'Refeição' }),
      h('p', { class: 'view-sub', text: f.items.length ? plural(f.items.length, 'item', 'itens') + ' no prato' : 'Escolha a refeição e monte o prato.' }));

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
      return plateItem(it, i, errs.some(function (e) { return e.item === i; }));
    })) : h('div', { class: 'empty-plate' }, mascot('idle', 'Prato vazio', 'Busque um alimento, toque numa favorita ou descreva sem cálculo.'));

    var reset = h('div', { class: 'foot-actions' }, restoreButton('food'), f.items.length ? h('button', {
      type: 'button', class: 'btn-text', text: 'Limpar refeição',
      onclick: function () { confirmDialog('Tirar todos os itens do prato?', function () { f.items = []; f.id = C.newSubmissionId(); S.showErrors = false; renderFood(); changed(true); }); },
    }) : null);

    var status = S.catalog.tableStatus;
    var notice = h('p', { id: 'food-table-status', class: 'hint', role: 'status', text: status === 'loading'
      ? 'Lista completa indisponível enquanto carrega.' : status === 'unavailable' ? 'Lista completa indisponível.'
        : status === 'values_unavailable' ? 'Valores da tabela indisponíveis; soma parcial.' : '' });
    notice.hidden = !status || status === 'ready';
    var total = h('p', { id: 'meal-nutrition', class: 'meal-nutrition', 'aria-live': 'polite', 'aria-atomic': 'true' });
    els.view.replaceChildren(head, meals, h('h2', { class: 'section-title', text: 'Adicionar' }), notice, panel, plateTitle, plate, total, reset);
    syncNutrition();
  }

  function syncNutrition() {
    var line = $('meal-nutrition');
    if (line) line.textContent = S.food.items.length ? C.nutritionText(C.mealNutrition(S.food.items, S.catalog)) : 'Adicione itens para ver a soma.';
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
            type: 'button', class: 'chip fav', text: name,
            onclick: function () { addItem({ kind: 'favorite', favorite: name, portions: '1' }); },
          });
        })),
        h('p', { class: 'hint', text: 'Um toque põe 1 porção no prato; ajuste as porções na lista.' }));
    }

    if (f.mode === 'description') {
      var counter = h('span', { class: 'counter', text: c.description.length + '/' + C.LIMITS.DESCRIPTION_MAX });
      var ta = h('textarea', {
        class: 'textarea', rows: '2', maxlength: String(C.LIMITS.DESCRIPTION_MAX), placeholder: 'Ex.: pastel de feira',
        'aria-label': 'Descrição do item', 'data-error-path': 'description', 'data-say': 'Sem cálculo: entra no diário sem calorias nem macros.', value: c.description,
        oninput: function () { c.description = ta.value; counter.textContent = ta.value.length + '/' + C.LIMITS.DESCRIPTION_MAX; descErr.check(); },
      });
      var descErr = formulaHint(ta, 'A descrição');
      var dq = qtyField(c.dqty, 'Quantidade é opcional aqui.', function (v) { c.dqty = v; }, function () { return c.dunit; });
      return h('div', {},
        h('label', { class: 'field-label' }, h('span', { text: 'Descrição' }), counter), ta, descErr,
        h('p', { class: 'sub-label', text: 'Quantidade (opcional)' }), dq,
        h('div', { style: 'margin-top:8px' }, unitChips(c.dunit, function (u) { c.dunit = u; renderFood(); }, true)),
        h('p', { class: 'hint warn', text: 'Sem cálculo: o item entra no diário sem calorias nem macros.' }),
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
        S.catalog.freeFoods ? h('button', { type: 'button', class: 'btn-text', text: 'Digitar nome da planilha', onclick: function () { c.manual = true; renderFood(); } }) : null);
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
      h('div', { style: 'margin-top:8px' }, unitChips(c.unit, function (u) { c.unit = u; qty._refresh(); renderUnitsOnly(); })),
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

  function addItem(item) {
    if (S.food.items.length >= C.LIMITS.MAX_FOOD_ITEMS) {
      haptic('error');
      nudge(els.view.querySelector('.plate'));
      say('alert', 'O prato já tem ' + C.LIMITS.MAX_FOOD_ITEMS + ' itens. Envie esta refeição e abra outra.');
      return false;
    }
    var r = C.buildFoodItem(item, S.catalog);
    if (r.errors.length) {
      haptic('error');
      nudge(els.view.querySelector('.panel'));
      var error = C.pulsoError(r.errors);
      react(error);
      glance(errorTarget(error, true));
      return false;
    }
    S.food.items.push(item);
    haptic('light');
    renderFood();
    // After this tap's last re-render (the composer resets too), the new item arrives on the plate.
    Promise.resolve().then(function () { motion('enter', els.view.querySelector('.plate > :last-child')); });
    changed(true, { quiet: true });
    say(S.food.meal ? 'happy' : 'idle', itemName(item) + ' no prato.' + (S.food.meal ? '' : ' Falta escolher a refeição.'));
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

  function plateItem(it, i, bad) {
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
    right.appendChild(h('button', {
      type: 'button', class: 'btn-x', 'aria-label': 'Tirar ' + itemName(it) + ' do prato', text: '×',
      onclick: function (e) {
        dropping(e.currentTarget.closest('.plate-item'), function () { S.food.items.splice(i, 1); haptic('light'); renderFood(); changed(true); });
      },
    }));
    return h('li', { class: 'plate-item k-' + it.kind + (bad ? ' bad' : '') },
      h('span', { class: 'plate-bar', 'aria-hidden': 'true' }),
      h('span', {}, h('span', { class: 'plate-name', text: itemName(it) }), h('span', { class: 'plate-meta', text: itemMeta(it) })),
      right);
  }

  /* review & send ---------------------------------------------------------------------------- */

  var reviewTimer = null;
  /** Drop a pending "conferindo" beat (the user moved on); true if there was one. */
  function cancelReview() {
    if (reviewTimer === null) return false;
    clearTimeout(reviewTimer);
    reviewTimer = null;
    return true;
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
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
    // A short "thinking" beat while the review is built (the avatar sweeps its ring).
    say('thinking', 'Conferindo o registro');
    // Any navigation or edit before it fires cancels it (render, changed, openSheet).
    reviewTimer = setTimeout(function () {
      reviewTimer = null;
      // This also refuses a snapshot that went stale without cancelling the timer.
      var now = S.view === view && S.screen === 'form' ? build() : null;
      if (!now || !now.args || C.serializePayload(view, now.args, currentId()).json !== p.json) { updateMood(); return; }
      S.screen = 'review';
      renderReview(r.args, p, view);
      motion('review', els.review);
      haptic('success');
      updateMood();
    }, 320);
  }

  function renderReview(args, p, view) {
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
        h('dt', { text: 'Status' }), h('dd', { text: args.complete ? 'concluída' : 'parcial' }));
      list = args.exercises.length ? h('ul', { class: 'review-list' }, args.exercises.map(function (ex) {
        var lines = ex.work.map(function (s, j) { return 'Série ' + (j + 1) + ': ' + C.describeSet(s); });
        if (ex.warmup) lines.push('Aquecimento: ' + C.describeSet(ex.warmup));
        if (ex.feeder) lines.push('Feeder: ' + C.describeSet(ex.feeder));
        if (ex.pain !== undefined) lines.push('Dor: ' + ex.pain);
        if (ex.note) lines.push('Nota: ' + ex.note);
        return h('li', { class: 'review-item' }, h('b', { text: ex.name }), lines.map(function (l) { return h('span', { text: l }); }));
      })) : h('p', { class: 'empty-plate', style: 'padding:16px', text: 'Sem exercícios: só marca a sessão como concluída.' });
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

    var pct = Math.min(100, Math.round(p.bytes / C.LIMITS.PAYLOAD_BYTES * 100));
    var meter = h('div', { class: 'meter' + (p.ok ? '' : ' over') },
      h('div', { class: 'meter-bar' }, h('i', { style: 'width:' + pct + '%' })),
      h('p', { text: p.bytes + ' de ' + C.LIMITS.PAYLOAD_BYTES + ' bytes do limite do Telegram' }));

    var pretty = JSON.stringify(JSON.parse(p.json), null, 2);
    var raw = inTelegram
      ? h('details', { class: 'raw' }, h('summary', { text: 'Ver o JSON' }), h('pre', { class: 'json', text: pretty }))
      : h('div', {}, h('h2', { class: 'section-title', text: 'JSON que iria para o bot' }), h('pre', { class: 'json', id: 'json-out', text: pretty }));

    els.review.replaceChildren(
      mascot('happy', null, C.pulsoSummary(pulsoContext())),
      h('div', { class: 'view-head', style: 'margin-top:12px' },
        h('h1', { class: 'view-title', text: 'Confira o envio' }),
        h('p', { class: 'view-sub', text: 'É exatamente isto que vai para o bot. A planilha confere de novo, e só a resposta do bot diz o que foi gravado.' })),
      facts, map || '', list, meter, raw);

    if (inTelegram) {
      setMain('Enviar ao bot', function () { send(p.json); });
    } else {
      setMain('Copiar JSON', function () { copyJson(p.json); });
      setSecondary('Editar', showForm);
    }
    updateBack();
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
  }

  function showForm() {
    var back = S.screen === 'review';
    endSend();
    S.screen = 'form';
    els.review.hidden = true;
    els.view.hidden = false;
    els.tabBar.hidden = !!S.catalog.view;
    els.dates.hidden = false;
    render();
    if (back) motion('settle', els.view);
    updateBack();
  }

  function send(json) {
    if (sending) return; // a second tap while the first send is in flight
    // Rebuild right before sending so what goes out is what the review showed.
    var r = build();
    var p = r.args ? C.serializePayload(S.view, r.args, currentId()) : null;
    if (!p || !p.ok || p.json !== json) { showForm(); goReview(); return; }
    sending = true;
    var again = mainHandler;
    setMainActive(false); // off before sendData; back only if it fails
    recordAndClearSent(S.view, p.json);
    say('thinking', 'Enviando para o bot');
    lift = motion('handoff', els.review); // a hand-off, not a confirmation: that is the bot's reply
    try {
      tg.sendData(p.json); // Telegram closes the app; the bot's reply is the confirmation.
      var scene = els.review.querySelector('.mascot-scene');
      if (scene) els.review.replaceChild(mascot('happy', 'Envio solicitado', C.pulsoSummary(pulsoContext())), scene);
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
    openSheet('Restaurar último envio', h('div', { style: 'display:flex;flex-direction:column;min-height:0;flex:1' },
      h('p', { class: 'hint', style: 'margin:0', text: 'Use se o bot respondeu que não gravou. O formulário volta como estava no envio; revise e envie de novo.' }), ul));
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
    var done = function () { haptic('success'); say('happy', 'JSON copiado. No Telegram ele iria para o bot, e só a resposta do bot confirma.'); };
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

  /* render / init ---------------------------------------------------------------------------- */

  function render() {
    cancelReview(); // navigation (tab, date, restore) drops a review being prepared
    focusedCard = null;
    S.focus = null;
    glance(null);
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
    els.view.replaceChildren(h('div', { class: 'empty-plan', style: 'margin-top:16px' }, mascot('alert', line, text)));
    say('alert', line);
    if (tg && tg.MainButton) { try { tg.MainButton.hide(); } catch (e) { /* ignore */ } }
  }

  /** Plain-language reason for a catalog that could not be read. */
  function catalogProblem(err) {
    var m = String(err && err.message || err);
    if (err && err.code === 'no_catalog') {
      return ['Abra de novo pelo /app.', 'Este botão não trouxe a sua ficha. Mande /app no chat do bot: ele envia botões novos de Treino e Refeição.'];
    }
    if (/TextDecoder|DecompressionStream|is not defined|not a function|not supported/i.test(m)) {
      return ['Este Telegram está desatualizado.', 'O aplicativo não consegue abrir a ficha neste aparelho (' + m + '). Atualize o Telegram, ou registre pelo chat do bot como antes.'];
    }
    if (/inflate|base64|JSON|Unexpected|versão|inválid/i.test(m)) {
      return ['A ficha deste link veio quebrada.', 'Não consegui ler a ficha (' + m + '). Mande /app no chat do bot para receber botões novos.'];
    }
    return ['Não consegui abrir a ficha.', 'Algo deu errado ao abrir a ficha (' + m + '). Mande /app no chat do bot e tente de novo.'];
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
    if (tg) {
      try { tg.ready(); tg.expand(); } catch (e) { /* ignore */ }
      if (inTelegram) {
        tg.onEvent('themeChanged', applyScheme);
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
        if (mq.addEventListener) mq.addEventListener('change', applyScheme);
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
      S.food = { date: S.today, meal: '', items: [], mode: 'food', compose: null };

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
      var foodDraft = store.loadFood(S.today);
      if (foodDraft) {
        S.food.id = foodDraft.id;
        S.food.date = foodDraft.date;
        S.food.meal = foodDraft.meal || '';
        S.food.items = foodDraft.items;
      }
      var draft = !!(latest || foodDraft);
      var first = cards()[0];
      if (first && !cards().some(function (c) { return c.open; })) first.open = true;
      render();
      if (draft) say('idle', 'Rascunho recuperado. Continue de onde parou.');
      if (catalog.ft) {
        var timeout = new Promise(function (resolve) {
          setTimeout(function () { resolve(Object.assign({}, catalog, { tableStatus: 'unavailable', freeFoods: true })); }, 8000);
        });
        Promise.race([C.loadFoodTable(catalog), timeout]).then(function (loaded) {
          S.catalog = loaded;
          if (S.view !== 'food' || S.screen !== 'form') return;
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
