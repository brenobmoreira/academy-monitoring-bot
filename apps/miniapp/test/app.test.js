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
  button(r.doc.getElementById('view'), 'Limpar refeição').click();
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
