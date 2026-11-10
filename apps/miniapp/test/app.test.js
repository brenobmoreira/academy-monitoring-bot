'use strict';
/** src/app.js driven through a fake DOM and Telegram (test/app_harness.js). */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { boot, storageWith, doneWorkoutDraft, foodDraft, today, SAMPLE } = require('./app_harness');

const ID = /^[0-9a-f]{32}$/;
const button = (root, text) => root.querySelectorAll('button').find((b) => b.textContent === text);

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
