'use strict';
/** src/app.js driven through a fake DOM and Telegram (test/app_harness.js). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, storageWith, doneWorkoutDraft, foodDraft, today, SAMPLE, C } = require('./app_harness');

const ID = /^[0-9a-f]{32}$/;
const button = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);

function pulsoProbe(ctx) {
  let mood = 'idle', asleep = false, text = null;
  return {
    lines: [], pulses: [], glances: [], progress: 0,
    mount(host, line) { text = line; },
    setMood(value) { mood = value; }, mood() { return mood; },
    say(line) { this.lines.push(line); text.textContent = line; },
    setProgress(value) { this.progress = value; },
    pulse(kind) { this.pulses.push(kind); },
    glance(target) { this.glances.push(target); },
    setDozing(value) { asleep = value; }, dozing() { return asleep; },
    create(value) {
      const art = ctx.document.createElement('div');
      art.className = 'shape';
      art.setAttribute('data-state', value);
      return art;
    },
  };
}

async function withPulso(opts = {}) {
  let avatar;
  const page = await boot(Object.assign({}, opts, { globals(ctx) {
    avatar = pulsoProbe(ctx);
    return { ShapeAvatar: avatar };
  } }));
  return Object.assign(page, { avatar });
}

function pulsoWorkout(cards) {
  const entries = doneWorkoutDraft(today(), SAMPLE.next);
  const draft = entries[Object.keys(entries)[0]];
  draft.complete = false;
  draft.cards = cards || C.planCards(C.normalizeCatalog(SAMPLE), SAMPLE.next);
  draft.cards.forEach((card) => { card.open = true; });
  return storageWith(entries);
}

test('Pulso tap cycles context tips, preserves typing focus and survives delayed focusout', async () => {
  const p = await withPulso({ storage: pulsoWorkout() });
  const input = p.doc.querySelectorAll('.card')[1].querySelector('.step-input');
  p.focus(input);
  const pulso = p.doc.getElementById('shape');
  const before = p.avatar.lines.length;
  pulso.click();
  assert.match(p.say(), /^Remada curvada, última vez: 50 kg × 10/);
  assert.equal(p.avatar.lines.length, before + 1, 'one line per tap');
  assert.equal(p.doc.activeElement, input);
  assert.equal(p.avatar.pulses.at(-1), 'nod');
  pulso.click();
  assert.match(p.say(), /^Faltam 10 séries/);
  pulso.click();
  assert.match(p.say(), /^Depois de Remada curvada: Desenvolvimento/);
  p.focus(pulso); // keyboard navigation from an input to the native button
  pulso.click();
  const line = p.say();
  p.timers.run(1);
  assert.equal(p.say(), line, 'blur timer does not overwrite the tip');
});

test('Pulso tap with no applicable data remains friendly', async () => {
  const p = await withPulso({ catalog: Object.assign({}, SAMPLE, { plan: [] }), storage: storageWith(doneWorkoutDraft(today(), SAMPLE.next)) });
  p.doc.getElementById('shape').click();
  assert.equal(p.say(), 'Tô por aqui. Um registro de cada vez.');
});

test('Pulso celebrates a better entered set exactly once and never rebuilds its input', async () => {
  const p = await withPulso({ storage: pulsoWorkout() });
  const input = p.doc.querySelector('.card').querySelectorAll('.step-input');
  p.input(input[0], '62,5');
  p.focus(input[1]);
  const before = p.avatar.lines.length;
  p.input(input[1], '8');
  assert.equal(p.say(), '+2,5 kg em relação à última vez.');
  assert.equal(p.avatar.lines.length, before + 1);
  assert.equal(p.avatar.pulses.at(-1), 'celebrate');
  assert.equal(p.doc.activeElement, input[1]);
  assert.equal(p.doc.querySelector('.card').querySelectorAll('.step-input')[1], input[1]);
  const count = p.avatar.lines.length;
  p.input(input[2], '1');
  assert.equal(p.avatar.lines.length, count, 'RIR edits do not celebrate the same gain again');
});

test('Pulso compares reps at the same load and gives full priority on the final planned set', async () => {
  const catalog = Object.assign({}, SAMPLE, { plan: [SAMPLE.plan[0]] });
  const card = C.planCards(C.normalizeCatalog(catalog), SAMPLE.next)[0];
  card.sets = [{ kg: '60', reps: '8', rir: '' }, { kg: '60', reps: '', rir: '' }];
  const p = await withPulso({ catalog, storage: pulsoWorkout([card]) });
  const input = p.doc.querySelector('.card').querySelectorAll('.step-input');
  const before = p.avatar.lines.length;
  p.input(input[4], '9');
  assert.equal(p.avatar.lines.length, before + 1);
  assert.equal(p.avatar.pulses.at(-1), 'full');
  assert.match(p.say(), /Todas as séries planejadas.*\+2 reps/);
  assert.equal(p.avatar.progress, 1);
});

test('Pulso repeat-last gives one line, with full only when the current session plan is complete', async () => {
  const card = C.planCards(C.normalizeCatalog(SAMPLE), SAMPLE.next)[0];
  const p = await withPulso({ storage: pulsoWorkout([card]) });
  const before = p.avatar.lines.length;
  button(p.doc.getElementById('view'), 'Repetir última').click();
  assert.equal(p.avatar.lines.length, before + 1);
  assert.equal(p.say(), 'Última carga copiada. Ajuste o que mudou hoje.');
  assert.equal(p.avatar.progress, 0.2, 'missing exercises in an old draft still belong to the plan');
  const catalog = Object.assign({}, SAMPLE, { plan: [SAMPLE.plan[0]] });
  const q = await withPulso({ catalog, storage: pulsoWorkout([C.planCards(C.normalizeCatalog(catalog), SAMPLE.next)[0]]) });
  const lines = q.avatar.lines.length;
  button(q.doc.getElementById('view'), 'Repetir última').click();
  assert.equal(q.avatar.lines.length, lines + 1);
  assert.equal(q.avatar.pulses.at(-1), 'full');
  assert.match(q.say(), /Todas as séries planejadas preenchidas/);
});

test('Pulso uses the newly opened exercise for tips even before an input is focused', async () => {
  const p = await withPulso({ storage: pulsoWorkout() });
  p.doc.querySelectorAll('.card-head')[1].click();
  p.doc.getElementById('shape').click();
  assert.match(p.say(), /^Remada curvada, última vez/);
});

test('Pulso validation points its eyes at the exact invalid work field and shakes', async () => {
  const card = C.planCards(C.normalizeCatalog(SAMPLE), SAMPLE.next)[0];
  card.sets[0].reps = '8';
  const p = await withPulso({ storage: pulsoWorkout([card]) });
  const before = p.avatar.lines.length;
  p.press();
  assert.equal(p.review.hidden, true);
  assert.equal(p.avatar.mood(), 'alert');
  assert.match(p.say(), /kg: obrigatório/);
  assert.equal(p.avatar.lines.length, before + 1);
  assert.equal(p.avatar.pulses.at(-1), 'no');
  assert.equal(p.avatar.glances.at(-1).getAttribute('data-error-path'), 'work[0].kg');
  assert.equal(p.doc.activeElement, null, 'eyes do not steal focus');
});

test('Pulso keeps the error gaze when a delayed blur belongs to the removed input', async () => {
  const card = C.planCards(C.normalizeCatalog(SAMPLE), SAMPLE.next)[0];
  card.sets[0].reps = '8';
  const p = await withPulso({ storage: pulsoWorkout([card]) });
  const old = p.doc.querySelector('.step-input');
  p.focus(old);
  p.focus(p.doc.getElementById('dock-primary')); // queues the old field blur
  p.press(); // error re-render replaces that input and installs the new gaze target
  const target = p.avatar.glances.at(-1);
  p.timers.run(1);
  assert.equal(p.avatar.glances.at(-1), target);
  assert.equal(target.getAttribute('data-error-path'), 'work[0].kg');
});

test('Pulso meal tips include item count and the no-calculation reminder', async () => {
  const p = await withPulso({ view: 'food', storage: storageWith(foodDraft(today())) });
  p.doc.getElementById('shape').click();
  assert.equal(p.say(), 'Seu prato tem 1 item.');
  p.doc.getElementById('shape').click();
  assert.match(p.say(), /descrição sem quantidade.*sem cálculo/);
});

test('Pulso meal validation looks toward the invalid composer field', async () => {
  const p = await withPulso({ view: 'food', catalog: Object.assign({}, SAMPLE, { foods: null }) });
  const name = p.doc.querySelectorAll('input').find((el) => el.getAttribute('data-error-path') === 'food');
  p.input(name, 'Arroz');
  const before = p.avatar.lines.length;
  button(p.doc.getElementById('view'), 'Pôr no prato').click();
  assert.equal(p.avatar.lines.length, before + 1);
  assert.equal(p.avatar.glances.at(-1).getAttribute('data-error-path'), 'qty');
  assert.equal(p.avatar.pulses.at(-1), 'no');
});

test('Pulso dozes after 45 seconds and wakes on input or a tap without an unsolicited line', async () => {
  const p = await withPulso({ storage: pulsoWorkout() });
  const lines = p.avatar.lines.length;
  p.timers.run(44999);
  assert.equal(p.avatar.dozing(), false);
  p.timers.run(1);
  assert.equal(p.avatar.dozing(), true);
  assert.equal(p.avatar.lines.length, lines);
  const input = p.doc.querySelector('.step-input');
  p.input(input, '60');
  assert.equal(p.avatar.dozing(), false);
  p.timers.run(45000);
  assert.equal(p.avatar.dozing(), true);
  p.doc.getElementById('shape').click();
  assert.equal(p.avatar.dozing(), false);
});

test('Pulso eyes follow focused inputs and return on focus leaving', async () => {
  const p = await withPulso({ storage: pulsoWorkout() });
  const input = p.doc.querySelector('.step-input');
  p.focus(input);
  assert.equal(p.avatar.glances.at(-1), input);
  p.focus(null);
  p.timers.run(1);
  assert.equal(p.avatar.glances.at(-1), null);
});

test('Pulso is large in review and Telegram handoff with a factual meal line', async () => {
  const p = await withPulso({ view: 'food', storage: storageWith(foodDraft(today())) });
  p.press();
  p.timers.run(1000);
  assert.match(p.review.querySelector('.mascot-scene').textContent, /1 item nesta refeição/);
  assert.ok(p.review.querySelector('.mascot-scene .shape'));
  p.press();
  assert.match(p.review.querySelector('.mascot-scene').textContent, /Envio solicitado.*1 item nesta refeição/);
  assert.doesNotMatch(p.review.querySelector('.mascot-scene').textContent, /gravado|salvo/);
  assert.deepEqual(Object.keys(JSON.parse(p.tg.sent[0])), ['v', 't', 'id', 'args']);
});

async function inReview(storage, view) {
  const p = await boot({ storage, view });
  p.press();
  p.timers.run(1000);
  assert.equal(p.review.hidden, false, 'the review is shown');
  return p;
}

test('send: a second tap while sending does not send twice; the button is off before sendData', async () => {
  const p = await inReview(storageWith(doneWorkoutDraft(today(), SAMPLE.next)));
  let activeAtSend = null;
  const sendData = p.tg.sendData.bind(p.tg);
  p.tg.sendData = (data) => { activeAtSend = p.tg.MainButton.params.is_active; sendData(data); };
  const handler = p.tg.MainButton.handler;
  handler();
  handler();
  assert.equal(p.tg.sent.length, 1);
  assert.equal(activeAtSend, false, 'disabled synchronously, before sendData');
  assert.equal(p.tg.MainButton.params.is_active, false);
});

test('send: if Telegram does not close the app, the wait ends and the same send can be repeated', async () => {
  const p = await inReview(storageWith(doneWorkoutDraft(today(), SAMPLE.next)));
  p.press();
  assert.equal(p.tg.MainButton.params.is_active, false, 'off while waiting');
  p.timers.run(7000);
  assert.equal(p.tg.MainButton.params.is_active, false, 'still waiting before the limit');
  p.timers.run(2000);
  assert.notEqual(p.tg.MainButton.params.is_active, false, 'available again');
  p.press();
  assert.equal(p.tg.sent.length, 2);
  assert.equal(p.tg.sent[1], p.tg.sent[0], 'byte-identical, same id: the sheet deduplicates it');
});

test('send: when Telegram refuses the send, the button works again', async () => {
  const p = await inReview(storageWith(doneWorkoutDraft(today(), SAMPLE.next)));
  p.tg.failSend = true;
  p.press();
  assert.equal(p.tg.sent.length, 0);
  assert.notEqual(p.tg.MainButton.params.is_active, false, 'available again after a failed send');
  p.tg.failSend = false;
  p.press();
  assert.equal(p.tg.sent.length, 1);
});

test('review: switching to Refeição during the thinking pause cancels the workout review', async () => {
  const p = await boot({ storage: storageWith(Object.assign(doneWorkoutDraft(today(), SAMPLE.next), foodDraft(today()))) });
  p.press(); // the workout review is 420 ms away
  p.tab('food');
  assert.doesNotThrow(() => p.timers.run(1000));
  assert.equal(p.review.hidden, true, 'no review of a view that is no longer shown');
  p.press();
  p.timers.run(1000);
  assert.equal(p.review.hidden, false);
  assert.match(p.review.textContent, /pastel de feira/);
  assert.doesNotMatch(p.review.textContent, new RegExp(SAMPLE.next));
});

test('review: an edit during the thinking pause cancels it', async () => {
  const p = await boot({ storage: storageWith(doneWorkoutDraft(today(), SAMPLE.next)) });
  p.press();
  p.doc.getElementById('dates').children[1].click(); // another date: the snapshot is stale
  p.timers.run(1000);
  assert.equal(p.review.hidden, true);
});

test('the payload carries the draft id; "Restaurar último envio" resends under the same id', async () => {
  const storage = storageWith(foodDraft(today()));
  const first = await inReview(storage, 'food');
  first.press();
  const sent = JSON.parse(first.tg.sent[0]);
  assert.match(sent.id, ID);
  assert.deepEqual(Object.keys(sent), ['v', 't', 'id', 'args']);

  const again = await boot({ storage, view: 'food' }); // the page reopened after the bot's answer
  button(again.doc.getElementById('view'), 'Restaurar último envio').click();
  again.doc.getElementById('sheet').querySelector('.result').click();
  again.press();
  again.timers.run(1000);
  again.press();
  assert.equal(again.tg.sent[0], first.tg.sent[0], 'byte-identical resend, same id');
});

test('a draft keeps its id across reopening; a fresh or cleared draft gets a new id', async () => {
  const kept = 'abcdefabcdefabcdefabcdefabcdef12';
  const p = await inReview(storageWith(foodDraft(today(), { id: kept })), 'food');
  p.press();
  assert.equal(JSON.parse(p.tg.sent[0]).id, kept);

  const q = await inReview(storageWith(foodDraft(today())), 'food');
  q.press();
  const fresh = JSON.parse(q.tg.sent[0]).id;
  assert.match(fresh, ID);
  assert.notEqual(fresh, kept);

  const storage = storageWith(foodDraft(today(), { id: kept }));
  const r = await boot({ storage, view: 'food' });
  button(r.doc.getElementById('view'), 'Limpar prato').click();
  r.timers.run(1000); // the draft is saved
  const saved = JSON.parse([...storage.map.entries()].find(([k]) => k.indexOf(':f:') > 0)[1]);
  assert.match(saved.id, ID);
  assert.notEqual(saved.id, kept, 'a cleared meal is a new draft');
});

/* body map ------------------------------------------------------------------------------------- */

/** A ShapeBody stand-in: levels are the summed sets per group; every create/update is recorded. */
function fakeBody(log) {
  return (ctx) => ({
    ShapeBody: {
      levels(entries) {
        const out = {};
        entries.forEach((e) => { out[e.group] = (out[e.group] || 0) + e.sets; });
        return out;
      },
      describe: (levels) => Object.keys(levels).join(', ') || 'nada',
      create(levels, opts) { log.push(['create', opts.title, { ...levels }]); return ctx.document.createElement('div'); },
      update(el, levels) { log.push(['update', { ...levels }]); },
    },
  });
}

function workoutDraftWith(date, session, name, group) {
  const card = Object.assign(C.newCard(name, group), { sets: [{ kg: '60', reps: '8', rir: '' }, { kg: '60', reps: '7', rir: '' }] });
  const key = `shape-miniapp:v2:w:${encodeURIComponent(SAMPLE.client)}:${date}:${encodeURIComponent(session)}`;
  return { [key]: { v: 1, savedAt: 1, date, session, complete: false, cards: [card] } };
}

test('body map: the form shows the last 7 days plus the valid sets typed; the review shows this workout only', async () => {
  const log = [];
  const catalog = { ...SAMPLE, wk: [['Costas', 5], ['Peito', 1]] };
  const [name, group] = SAMPLE.ex[0];
  const p = await boot({ catalog, globals: fakeBody(log), storage: storageWith(workoutDraftWith(today(), SAMPLE.next, name, group)) });
  assert.deepEqual(log[0], ['create', 'Músculos nos últimos 7 dias', { Costas: 5, [group]: 3 }]);
  p.press();
  p.timers.run(1000);
  assert.equal(p.review.hidden, false);
  assert.deepEqual(log[log.length - 1], ['create', 'Músculos deste treino', { [group]: 2 }]);
});

test('body map: without the component the page works as before', async () => {
  const p = await inReview(storageWith(doneWorkoutDraft(today(), SAMPLE.next)));
  assert.equal(p.review.hidden, false);
});

/* sheet focus trap & scrollInto -------------------------------------------------------------- */

function keyEvent(key, shiftKey = false) {
  let prevented = false;
  return {
    type: 'keydown',
    key,
    shiftKey,
    preventDefault() { prevented = true; },
    get prevented() { return prevented; },
  };
}

test('sheet: openSheet traps Tab/Shift+Tab circularly, focuses fallback element, and restores opener on close', async () => {
  const p = await boot({ storage: storageWith(doneWorkoutDraft(today(), SAMPLE.next)) });
  const addBtn = button(p.doc.getElementById('view'), 'Adicionar exercício');
  p.focus(addBtn);
  addBtn.click();

  const sheet = p.doc.getElementById('sheet');
  assert.equal(sheet.hidden, false);
  assert.equal(p.doc.getElementById('sheet-title').getAttribute('tabindex'), '-1');

  p.timers.run(60);
  const input = sheet.querySelector('input');
  const results = sheet.querySelectorAll('.result');
  assert.ok(results.length >= 2, 'exercise picker has at least 2 focusable result buttons');
  assert.equal(p.doc.activeElement, input, 'explicit focusEl receives initial focus');

  // Shift+Tab on first focusable wraps to last focusable
  const shiftFirst = keyEvent('Tab', true);
  p.doc.dispatchEvent(shiftFirst);
  assert.equal(shiftFirst.prevented, true);
  assert.equal(p.doc.activeElement, results[results.length - 1]);

  // Tab on last focusable wraps back to first focusable
  const tabLast = keyEvent('Tab', false);
  p.doc.dispatchEvent(tabLast);
  assert.equal(tabLast.prevented, true);
  assert.equal(p.doc.activeElement, input);

  // Tab from a middle item is allowed without trapping override
  p.focus(results[0]);
  const tabMid = keyEvent('Tab', false);
  p.doc.dispatchEvent(tabMid);
  assert.equal(tabMid.prevented, false);

  // Escape closes the sheet, clears the trap, and restores focus to the opener
  p.doc.dispatchEvent(keyEvent('Escape'));
  assert.equal(sheet.hidden, true);
  assert.equal(p.doc.activeElement, addBtn);

  // Trap listener is cleaned up after closeSheet
  const outsideTab = keyEvent('Tab', false);
  p.doc.dispatchEvent(outsideTab);
  assert.equal(outsideTab.prevented, false);

  // If opener was detached before closing, closeSheet does not restore focus to it
  p.focus(addBtn);
  addBtn.click();
  p.timers.run(60);
  addBtn.parentNode.removeChild(addBtn);
  p.doc.dispatchEvent(keyEvent('Escape'));
  assert.notEqual(p.doc.activeElement, addBtn);
});

test('sheet: openSheet without focusEl focuses the first focusable item (openRestore)', async () => {
  const storage = storageWith(foodDraft(today()));
  const first = await inReview(storage, 'food');
  first.press();

  const p = await boot({ storage, view: 'food' });
  const restoreBtn = button(p.doc.getElementById('view'), 'Restaurar último envio');
  p.focus(restoreBtn);
  restoreBtn.click();
  p.timers.run(60);

  const firstResult = p.doc.getElementById('sheet').querySelector('.result');
  assert.equal(p.doc.activeElement, firstResult);

  // Backdrop click closes and restores focus to restoreBtn
  p.doc.getElementById('sheet-backdrop').click();
  assert.equal(p.doc.getElementById('sheet').hidden, true);
  assert.equal(p.doc.activeElement, restoreBtn);
});

test('scrollInto: uses auto when ShapeMotion.enabled() is false and smooth when true', async () => {
  const calls = [];
  let motionEnabled = false;
  let origScroll = null;
  const card = C.planCards(C.normalizeCatalog(SAMPLE), SAMPLE.next)[0];
  card.sets[0].reps = '8'; // missing kg triggers validation scrollInto(el, 'start')

  const p = await boot({
    storage: pulsoWorkout([card]),
    globals(ctx) {
      origScroll = ctx.Element.prototype.scrollIntoView;
      ctx.Element.prototype.scrollIntoView = function (opts) { calls.push({ ...opts }); };
      return { ShapeMotion: { enabled: () => motionEnabled } };
    },
  });

  try {
    p.press();
    assert.deepEqual(calls.at(-1), { behavior: 'auto', block: 'start' });

    motionEnabled = true;
    p.press();
    assert.deepEqual(calls.at(-1), { behavior: 'smooth', block: 'start' });

    // Exercise picker uses block: 'center' and respects ShapeMotion.enabled()
    button(p.doc.getElementById('view'), 'Adicionar exercício').click();
    p.doc.getElementById('sheet').querySelector('.result').click();
    assert.deepEqual(calls.at(-1), { behavior: 'smooth', block: 'center' });

    motionEnabled = false;
    button(p.doc.getElementById('view'), 'Adicionar exercício').click();
    p.doc.getElementById('sheet').querySelector('.result').click();
    assert.deepEqual(calls.at(-1), { behavior: 'auto', block: 'center' });
  } finally {
    if (origScroll) p.doc.body.constructor.prototype.scrollIntoView = origScroll;
  }
});

/* M9 & M10 polish ---------------------------------------------------------------------------- */

test('M9: addItem shows inline role=alert and .is-bad and clears them on input', async () => {
  const p = await boot({ view: 'food', catalog: Object.assign({}, SAMPLE, { foods: null }) });
  const nameInput = p.doc.querySelectorAll('input').find((el) => el.getAttribute('data-error-path') === 'food');
  const qtyInput = p.doc.querySelectorAll('input').find((el) => el.getAttribute('data-error-path') === 'qty');
  p.input(nameInput, 'Arroz');

  button(p.doc.getElementById('view'), 'Pôr no prato').click();
  const panel = p.doc.querySelector('.panel');
  const alertEl = panel.querySelector('.composer-error');
  assert.ok(alertEl, 'composer inline error is rendered inside .panel');
  assert.equal(alertEl.getAttribute('role'), 'alert');
  assert.match(alertEl.textContent, /Quantidade: obrigatório/i);
  assert.equal(qtyInput.classList.contains('is-bad'), true);

  // Typing into the invalid field clears .is-bad and removes the inline alert
  p.input(qtyInput, '150');
  assert.equal(qtyInput.classList.contains('is-bad'), false);
  assert.equal(panel.querySelector('.composer-error'), null);
});

test('M9: invalid plateItem displays inline error below .plate-meta', async () => {
  const badDraft = foodDraft(today(), { items: [{ kind: 'description', description: '' }] });
  const p = await boot({ view: 'food', storage: storageWith(badDraft) });
  p.press(); // triggers S.showErrors = true and renderFood()
  assert.equal(p.review.hidden, true);
  const li = p.doc.querySelector('.plate-item');
  assert.equal(li.classList.contains('bad'), true);
  const meta = li.querySelector('.plate-meta');
  const err = li.querySelector('.plate-error');
  assert.ok(meta && err);
  assert.equal(err.hidden, false);
  assert.equal(err.classList.contains('field-error'), true);
  assert.equal(err.getAttribute('role'), 'alert');
  assert.match(err.textContent, /Descrição: obrigatório/i);
  assert.ok(meta.parentNode === err.parentNode);
  const kids = meta.parentNode.children;
  assert.ok(kids.indexOf(err) > kids.indexOf(meta), 'error sits below .plate-meta');
});

test('M9: copyJson shows "JSON copiado" for 1800ms, resets timer on double tap, and guards screen changes', async () => {
  const copied = [];
  const p = await boot({
    telegram: null,
    fetch: async () => ({ ok: true, status: 200, json: async () => SAMPLE }),
    storage: storageWith(foodDraft(today())),
    navigator: { clipboard: { writeText: (txt) => { copied.push(txt); return Promise.resolve(); } } },
  });
  p.tab('food');
  p.press();
  p.timers.run(400);
  assert.equal(p.review.hidden, false);

  const primary = p.doc.getElementById('dock-primary');
  assert.equal(primary.textContent, 'Copiar JSON');

  // First copy click
  primary.click();
  await Promise.resolve();
  assert.equal(copied.length, 1);
  assert.equal(primary.textContent, 'JSON copiado');

  // Second click at 1000ms resets the 1800ms timer
  p.timers.run(1000);
  assert.equal(primary.textContent, 'JSON copiado');
  primary.click();
  await Promise.resolve();
  p.timers.run(1000); // 2000ms since 1st, 1000ms since 2nd
  assert.equal(primary.textContent, 'JSON copiado');
  p.timers.run(800); // 1800ms since 2nd
  assert.equal(primary.textContent, 'Copiar JSON');

  // Leaving review before 1800ms does not restore "Copiar JSON" over the form button
  primary.click();
  await Promise.resolve();
  assert.equal(primary.textContent, 'JSON copiado');
  p.doc.getElementById('dock-secondary').click(); // Editar -> showForm()
  p.timers.run(2000);
  assert.match(primary.textContent, /^Revisar refeição/);
});

test('M10: renderReview hides meter and details.raw for small ok payloads in Telegram and reveals when >75% or !ok', async () => {
  // 1) Small ok payload in Telegram: no meter, no details.raw, capitalized Status, concise view-sub
  const pSmall = await inReview(storageWith(doneWorkoutDraft(today(), SAMPLE.next)));
  assert.equal(pSmall.review.querySelector('.meter'), null);
  assert.equal(pSmall.review.querySelector('details.raw'), null);
  assert.ok(pSmall.review.querySelectorAll('dd').some((dd) => dd.textContent === 'Concluída'));
  assert.doesNotMatch(pSmall.review.querySelector('.view-sub').textContent, /planilha confere/i);

  // 2) Payload > 75% of PAYLOAD_BYTES (4096 * 0.75 = 3072) and ok: shows meter, keeps details.raw hidden
  const longNote = 'a'.repeat(200);
  const bigCards = C.planCards(C.normalizeCatalog(SAMPLE), SAMPLE.next);
  while (bigCards.length < 12) {
    const ex = SAMPLE.ex[bigCards.length % SAMPLE.ex.length];
    bigCards.push(C.newCard(ex[0] + ' ' + bigCards.length, ex[1]));
  }
  const bigCat = Object.assign({}, SAMPLE, { ex: bigCards.map((c) => [c.name, c.group]) });
  bigCards.forEach((c) => { c.sets = [{ kg: '60', reps: '10', rir: '1' }, { kg: '60', reps: '10', rir: '1' }]; c.note = longNote; });
  const key = `shape-miniapp:v2:w:${encodeURIComponent(SAMPLE.client)}:${today()}:${encodeURIComponent(SAMPLE.next)}`;
  const pBig = await boot({ catalog: bigCat, storage: storageWith({ [key]: { v: 1, savedAt: 1, date: today(), session: SAMPLE.next, complete: false, cards: bigCards } }) });
  pBig.press();
  pBig.timers.run(400);
  assert.equal(pBig.review.hidden, false);
  assert.ok(pBig.review.querySelector('.meter'), 'meter is shown when payload > 75%');
  assert.equal(pBig.review.querySelector('.meter').classList.contains('over'), false);
  assert.equal(pBig.review.querySelector('details.raw'), null, 'details.raw stays hidden when p.ok is true');
  assert.ok(pBig.review.querySelectorAll('dd').some((dd) => dd.textContent === 'Parcial'));

  // 3) !p.ok in renderReview: shows .meter.over and details.raw ("Ver o JSON")
  let okReads = 0;
  const wrappedCore = Object.assign({}, C, {
    serializePayload(t, args, id) {
      const base = C.serializePayload(t, args, id);
      return {
        json: base.json,
        bytes: C.LIMITS.PAYLOAD_BYTES + 120,
        get ok() { okReads += 1; return okReads === 1; },
      };
    },
  });
  const pOver = await boot({ storage: storageWith(doneWorkoutDraft(today(), SAMPLE.next)), globals: { ShapeCore: wrappedCore } });
  pOver.press();
  pOver.timers.run(400);
  assert.equal(pOver.review.hidden, false);
  assert.ok(pOver.review.querySelector('.meter.over'), 'meter.over shown when !p.ok');
  assert.ok(pOver.review.querySelector('details.raw'), 'details.raw shown when !p.ok');
  assert.equal(pOver.review.querySelector('details.raw summary').textContent, 'Ver o JSON');
});

test('M10: catalogProblem in Telegram never leaks raw technical English err.message', async () => {
  const zlib = require('node:zlib');
  const badJsonBlob = zlib.deflateRawSync(Buffer.from('{not-json', 'utf8')).toString('base64url');
  const p1 = await boot({ hash: `#v=workout&c=${badJsonBlob}`, expectFatal: true });
  const body1 = p1.doc.querySelector('#view .empty-plan').textContent;
  assert.match(p1.say(), /veio quebrada/);
  assert.doesNotMatch(body1, /Unexpected|JSON|SyntaxError|property name/i);

  const p2 = await boot({
    hash: `#v=workout&c=${badJsonBlob}`,
    expectFatal: true,
    globals: { ShapeCore: Object.assign({}, C, { decodeCatalog: () => Promise.reject(new Error('DecompressionStream is not defined')) }) },
  });
  const body2 = p2.doc.querySelector('#view .empty-plan').textContent;
  assert.match(p2.say(), /desatualizado/);
  assert.doesNotMatch(body2, /DecompressionStream|is not defined/i);
});

test('M10: favorite chips render SVG star with aria-hidden and workout card errors start uppercase', async () => {
  const card = C.planCards(C.normalizeCatalog(SAMPLE), SAMPLE.next)[0];
  card.sets[0].reps = '8';
  const p = await boot({ view: 'workout', storage: pulsoWorkout([card]) });
  p.press();
  const errLi = p.doc.querySelector('.card .errors li');
  assert.ok(errLi);
  assert.match(errLi.textContent, /^[A-ZÁÉÍÓÚÂÊÔÃÕÇ]/, 'card error starts uppercase');

  p.tab('food');
  button(p.doc.getElementById('view'), 'Favorita').click();
  const favChip = p.doc.querySelector('.chip.fav');
  assert.ok(favChip);
  const svg = favChip.querySelector('svg');
  assert.ok(svg, 'favorite chip renders an inline SVG star');
  assert.equal(svg.getAttribute('aria-hidden'), 'true');
});

test('Shaping integration: header displays Shaping, tabs morph treino <-> refeicao, review morphs to revisao, and 45s sleep morphs to descanso and wakes back to active tab form', async () => {
  const entries = Object.assign({}, doneWorkoutDraft(today(), SAMPLE.next), foodDraft(today()));
  const p = await boot({ loadAvatar: true, storage: storageWith(entries) });
  const shape = p.doc.getElementById('shape');
  const nameEl = p.doc.querySelector('.bubble-name');

  // 1) Official name Shaping in header and ShapeAvatar API
  assert.equal(p.ctx.ShapeAvatar.NAME, 'Shaping');
  assert.equal(nameEl.textContent, 'Shaping');
  assert.equal(shape.getAttribute('aria-label'), 'Shaping: toque para uma dica');

  // 2) Booted on Treino -> form is 'treino'; empty workout plan scene uses 'base'
  assert.equal(shape.getAttribute('data-form'), 'treino');
  assert.equal(p.doc.querySelector('#view .empty-plan .shape').getAttribute('data-form'), 'base');

  // 3) Switching Treino <-> Alimentação morphs form 'treino' <-> 'refeicao'
  p.tab('food');
  assert.equal(shape.getAttribute('data-form'), 'refeicao');
  p.tab('workout');
  assert.equal(shape.getAttribute('data-form'), 'treino');

  // 4) Entering Review morphs header avatar AND static scene avatar to 'revisao'; Back restores active tab form
  p.tab('food');
  assert.equal(shape.getAttribute('data-form'), 'refeicao');
  p.press();
  p.timers.run(400);
  assert.equal(p.review.hidden, false);
  assert.equal(shape.getAttribute('data-form'), 'revisao');
  assert.equal(p.review.querySelector('.mascot-scene .shape').getAttribute('data-form'), 'revisao');

  p.tg.BackButton.handler();
  assert.equal(p.review.hidden, true);
  assert.equal(shape.getAttribute('data-form'), 'refeicao');

  // 5) Dozing after 45s idle morphs to 'descanso' and waking restores the active tab form ('refeicao' and 'treino')
  p.timers.run(45000);
  assert.equal(p.ctx.ShapeAvatar.dozing(), true);
  assert.equal(shape.getAttribute('data-dozing'), 'true');
  assert.equal(shape.getAttribute('data-form'), 'descanso');

  shape.click();
  assert.equal(p.ctx.ShapeAvatar.dozing(), false);
  assert.equal(shape.getAttribute('data-form'), 'refeicao');

  p.tab('workout');
  assert.equal(shape.getAttribute('data-form'), 'treino');
  p.timers.run(45000);
  assert.equal(p.ctx.ShapeAvatar.dozing(), true);
  assert.equal(shape.getAttribute('data-form'), 'descanso');

  shape.click();
  assert.equal(p.ctx.ShapeAvatar.dozing(), false);
  assert.equal(shape.getAttribute('data-form'), 'treino');

  // 6) Fatal catalog error resets header and static scene to 'base' + 'alert'
  const zlib = require('node:zlib');
  const badBlob = zlib.deflateRawSync(Buffer.from('{broken', 'utf8')).toString('base64url');
  const pf = await boot({ loadAvatar: true, hash: `#v=workout&c=${badBlob}`, expectFatal: true });
  assert.equal(pf.doc.getElementById('shape').getAttribute('data-state'), 'alert');
  assert.equal(pf.doc.getElementById('shape').getAttribute('data-form'), 'base');
  assert.equal(pf.doc.querySelector('#view .empty-plan .shape').getAttribute('data-form'), 'base');
});

test('rest timer runs in the Shaping ring from prescribed chip, supports +15s/-15s, notifies on completion and restores workout state', async () => {
  const customCatalog = Object.assign({}, SAMPLE, {
    plan: [
      Object.assign({}, SAMPLE.plan[0], { p: '2×6–10 · RIR 0–1 · 150 s' }),
      SAMPLE.plan[1],
    ],
  });
  const card0 = C.planCards(C.normalizeCatalog(customCatalog), SAMPLE.next)[0];
  card0.sets[0] = { kg: '60', reps: '8', rir: '1' };
  const p = await boot({ loadAvatar: true, catalog: customCatalog, storage: pulsoWorkout([card0]) });

  const haptics = [];
  p.tg.HapticFeedback.notificationOccurred = (kind) => haptics.push(kind);

  const shape = p.doc.getElementById('shape');
  const restBar = p.doc.getElementById('rest-bar');
  assert.ok(restBar);
  assert.equal(restBar.hidden, true);

  // Initial workout progress before rest (1 of 2 sets on card0, plus missing card1 in draft = 0.25)
  const initialProgress = p.ctx.ShapeAvatar.progress();
  assert.equal(initialProgress, 0.25);
  assert.equal(shape.getAttribute('data-form'), 'treino');

  // Prescribed 150s chip gets .is-suggested and starts 2:30 rest on Shaping ring
  const suggested = p.doc.querySelector('.card .rest-chip.is-suggested');
  assert.ok(suggested);
  assert.equal(suggested.textContent, '150s');
  suggested.click();

  assert.equal(restBar.hidden, false);
  assert.equal(restBar.querySelector('.rest-time').textContent, '2:30');
  assert.equal(restBar.querySelector('.rest-label').textContent, SAMPLE.plan[0].e);
  assert.equal(shape.getAttribute('data-form'), 'descanso');
  assert.equal(p.ctx.ShapeAvatar.progress(), 1);
  assert.match(p.say(), /^Descanso 2:30/);

  // Advance 50s -> remaining 1:40, ring = 100 / 150
  p.timers.run(50000);
  assert.equal(restBar.querySelector('.rest-time').textContent, '1:40');
  assert.ok(Math.abs(p.ctx.ShapeAvatar.progress() - 100 / 150) < 0.02);

  // Tap +15s -> remaining 1:55 (total 150s since 115s < 150s); tap -15s -> back to 1:40
  restBar.querySelector('.rest-plus').click();
  assert.equal(restBar.querySelector('.rest-time').textContent, '1:55');
  restBar.querySelector('.rest-minus').click();
  assert.equal(restBar.querySelector('.rest-time').textContent, '1:40');

  // Shaping must NOT doze while actively resting (even past 45s)
  assert.equal(p.ctx.ShapeAvatar.dozing(), false);

  // Complete remaining 100s -> hides bar, restores treino form & workout progress, fires success haptic
  p.timers.run(100250);
  assert.equal(restBar.hidden, true);
  assert.equal(shape.getAttribute('data-form'), 'treino');
  assert.equal(p.ctx.ShapeAvatar.progress(), initialProgress);
  assert.ok(haptics.includes('success'));
  assert.match(p.say(), /^Descanso acabou! Próxima série de /);
});

test('rest timer stops cleanly on Pular, tab switch and review without altering sendData payload', async () => {
  const card = C.planCards(C.normalizeCatalog(SAMPLE), SAMPLE.next)[0];
  card.sets[0] = { kg: '60', reps: '8', rir: '1' };
  const p = await boot({ loadAvatar: true, storage: pulsoWorkout([card]) });
  const shape = p.doc.getElementById('shape');
  const restBar = p.doc.getElementById('rest-bar');

  // 1) Pular cancels rest and restores treino form + progress
  p.doc.querySelector('.card .rest-chip').click();
  assert.equal(restBar.hidden, false);
  assert.equal(shape.getAttribute('data-form'), 'descanso');
  restBar.querySelector('.rest-skip').click();
  assert.equal(restBar.hidden, true);
  assert.equal(shape.getAttribute('data-form'), 'treino');
  assert.equal(p.ctx.ShapeAvatar.progress(), 0.1, '1 of 10 planned sets restored');

  // 2) Switching to Refeição cancels active rest
  p.doc.querySelector('.card .rest-chip').click();
  assert.equal(restBar.hidden, false);
  p.tab('food');
  assert.equal(restBar.hidden, true);
  assert.equal(shape.getAttribute('data-form'), 'refeicao');

  // 3) Opening review stops active rest and workout payload has no rest fields
  p.tab('workout');
  p.doc.querySelector('.card .rest-chip').click();
  assert.equal(restBar.hidden, false);
  p.press();
  p.timers.run(400);
  assert.equal(p.review.hidden, false);
  assert.equal(restBar.hidden, true);
  assert.equal(shape.getAttribute('data-form'), 'revisao');

  p.press();
  assert.equal(p.tg.sent.length, 1);
  const payload = JSON.parse(p.tg.sent[0]);
  assert.equal(payload.t, 'workout');
  assert.deepEqual(Object.keys(payload.args).sort(), ['complete', 'date', 'exercises', 'session']);
});

test('daily balance updates live vs goal on food tab and date switch isolates yesterday baseline', async () => {
  const ownName = 'Frango grelhado teste';
  const customCatalog = Object.assign({}, SAMPLE, {
    foods: [ownName],
    fv: [[0, 0, 100, 160, 32, 0, 3, null, null]],
    fu: ['g'],
    goal: { k: 2400, p: 160, c: 260, g: 70 },
    day: { k: 920, p: 72, c: 95, g: 26, w: 1.25 },
  });
  const p = await boot({ view: 'food', catalog: customCatalog });
  const box = p.doc.getElementById('daily-balance');
  assert.ok(box);
  assert.equal(box.querySelector('.balance-title').textContent, 'Hoje vs. meta');
  assert.equal(box.querySelector('.balance-kcal').textContent, '920 / 2400 kcal');
  assert.equal(box.querySelector('.balance-rem').textContent, 'Faltam 1480 kcal');
  assert.match(box.querySelector('.water-val').textContent, /^1,25 L \/ 2,5 L/);

  // Add 200 g chicken (+320 kcal, +64 P, +6 G) -> totals become 1240 kcal, P 136 g, G 32 g
  const search = p.doc.querySelectorAll('input').find((e) => e.getAttribute('aria-label') === 'Buscar alimento');
  p.input(search, 'frango');
  button(p.doc.getElementById('view'), ownName).click();
  const qty = p.doc.querySelectorAll('input').find((e) => e.getAttribute('aria-label') === 'Quantidade');
  p.input(qty, '200');
  button(p.doc.getElementById('view'), 'Pôr no prato').click();

  const updated = p.doc.getElementById('daily-balance');
  assert.equal(updated.querySelector('.balance-kcal').textContent, '1240 / 2400 kcal');
  assert.equal(updated.querySelector('.balance-delta').textContent, '+320 no prato');
  assert.equal(updated.querySelector('.balance-rem').textContent, 'Faltam 1160 kcal');
  assert.equal(updated.querySelectorAll('.macro-val')[0].textContent, '136 / 160 g');

  // Remove item -> drops back to 920 kcal
  p.doc.querySelectorAll('button').find((b) => b.getAttribute('aria-label') === 'Tirar ' + ownName + ' do prato').click();
  assert.equal(p.doc.getElementById('daily-balance').querySelector('.balance-kcal').textContent, '920 / 2400 kcal');

  // Switch date to Ontem -> drops today's baseline (meal-only kcal & 0 L water)
  p.doc.getElementById('dates').children[1].click();
  const yest = p.doc.getElementById('daily-balance');
  assert.equal(yest.querySelector('.balance-title').textContent, 'Nesta refeição');
  assert.equal(yest.querySelector('.balance-kcal').textContent, '0 / 2400 kcal');
  assert.match(yest.querySelector('.water-val').textContent, /^0 L \/ 2,5 L/);
});

test('quick hydration chips accumulate water, switch MainButton when plate is empty, and emit t=water preserving food draft', async () => {
  const storage = storageWith(foodDraft(today()));
  const customCatalog = Object.assign({}, SAMPLE, {
    goal: { k: 2400, p: 160, c: 260, g: 70 },
    day: { k: 920, p: 72, c: 95, g: 26, w: 1.5 },
  });
  const p = await boot({ loadAvatar: true, view: 'food', catalog: customCatalog, storage });
  const haptics = [];
  p.tg.HapticFeedback.notificationOccurred = (kind) => haptics.push(kind);

  const box = () => p.doc.getElementById('daily-balance');
  assert.equal(p.tg.MainButton.params.text, 'Revisar refeição (1)');
  assert.equal(box().querySelector('#water-send'), null);

  // Tap +500 ml and +500 ml -> 1.5 + 1.0 = 2.5 L (hits water goal)
  button(box(), '+500 ml').click();
  assert.equal(box().querySelector('.water-delta').textContent, '+500 ml');
  assert.ok(box().querySelector('#water-send'), 'Registrar água appears alongside non-empty plate');

  button(box(), '+500 ml').click();
  assert.match(box().querySelector('.water-val').textContent, /^2,5 L \/ 2,5 L/);
  assert.equal(box().querySelector('.water-delta').textContent, '+1 L');
  assert.ok(haptics.includes('success'));
  assert.match(p.say(), /^Meta de água batida: 2,5 L/);

  // Tap −250 ml -> drops back to 2.25 L (+750 ml)
  box().querySelector('.water-undo').click();
  assert.match(box().querySelector('.water-val').textContent, /^2,25 L \/ 2,5 L/);
  assert.equal(box().querySelector('.water-delta').textContent, '+750 ml');

  // Review via Registrar água button -> emits t: "water" without wiping food draft
  box().querySelector('#water-send').click();
  p.timers.run(400);
  assert.equal(p.review.hidden, false);
  assert.match(p.review.textContent, /2,25 L/);
  assert.doesNotMatch(p.review.textContent, /gravado|salvo/i);

  p.press();
  assert.equal(p.tg.sent.length, 1);
  const waterPayload = JSON.parse(p.tg.sent[0]);
  assert.equal(waterPayload.t, 'water');
  assert.match(waterPayload.id, ID);
  assert.deepEqual(waterPayload.args, { date: today(), waterL: 2.25 });
  const draftKey = [...storage.map.keys()].find((k) => k.indexOf(':f:') > 0);
  assert.ok(draftKey, 'existing food draft stays intact in storage after water send');

  // Empty plate + water delta switches MainButton directly to Revisar água
  const emptyP = await boot({ view: 'food', catalog: customCatalog });
  button(emptyP.doc.getElementById('daily-balance'), '+250 ml').click();
  assert.equal(emptyP.tg.MainButton.params.text, 'Revisar água (+250 ml)');
  emptyP.press();
  emptyP.timers.run(400);
  emptyP.press();
  assert.deepEqual(JSON.parse(emptyP.tg.sent[0]).args, { date: today(), waterL: 1.75 });
});
