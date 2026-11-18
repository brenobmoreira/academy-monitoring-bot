'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('../src/avatar.js');
const { FakeDocument, FakeElement, fakeTimers } = require('./app_harness');

const AVATAR_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'avatar.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function avatarEnv(opts = {}) {
  const doc = new FakeDocument();
  const timers = fakeTimers();
  let reduced = !!opts.reduced;
  const mediaListeners = [];
  const mq = {
    get matches() { return reduced; },
    addEventListener(type, fn) { if (type === 'change') mediaListeners.push(fn); },
  };
  const ctx = {
    document: doc,
    Element: FakeElement,
    Date: { now: () => timers.now() },
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    matchMedia(query) {
      if (query.includes('prefers-reduced-motion')) return mq;
      return { matches: false, addEventListener() {} };
    },
    console,
  };
  doc.defaultView = ctx;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(AVATAR_SRC, ctx, { filename: 'avatar.js' });

  const coach = doc.createElement('header');
  coach.className = 'coach';
  doc.body.appendChild(coach);

  const shape = doc.createElement('button');
  shape.className = 'shape';
  shape.id = 'shape';
  shape.setAttribute('type', 'button');
  shape.setAttribute('aria-label', opts.ariaLabel || 'Pulso: toque para uma dica');
  shape.setAttribute('aria-describedby', 'say');
  shape._rect = { left: 16, top: 20, right: 56, bottom: 60, width: 40, height: 40 };
  coach.appendChild(shape);

  const bubble = doc.createElement('div');
  bubble.className = 'bubble';
  coach.appendChild(bubble);

  const nameEl = doc.createElement('span');
  nameEl.className = 'bubble-name';
  nameEl.textContent = opts.initialName || 'Pulso';
  bubble.appendChild(nameEl);

  const sayEl = doc.createElement('p');
  sayEl.className = 'bubble-text';
  sayEl.id = 'say';
  sayEl.textContent = 'Abrindo sua ficha';
  bubble.appendChild(sayEl);

  return {
    doc,
    timers,
    coach,
    shape,
    bubble,
    nameEl,
    sayEl,
    Avatar: ctx.ShapeAvatar,
    setReduced(next) {
      reduced = !!next;
      mediaListeners.slice().forEach((fn) => fn({ matches: reduced }));
    },
  };
}

test('the public API keeps all ShapeAvatar members and exposes Muscle identity, forms and rich states', () => {
  assert.equal(A.NAME, 'Muscle');
  assert.deepEqual(A.MOODS, ['idle', 'focused', 'happy', 'alert', 'thinking']);
  assert.deepEqual(A.STATES, ['idle', 'focused', 'happy', 'alert', 'thinking', 'listening', 'understood', 'oops', 'record', 'dozing']);
  assert.deepEqual(A.FORMS, ['base', 'treino', 'refeicao', 'agua', 'revisao', 'descanso']);
  assert.equal(A.FORM_MS, 340);
  assert.equal(A.OUT_MS, 140);
  assert.equal(A.IN_DELAY, 90);
  assert.equal(A.TICKS, 12);
  for (const k of [
    'mount', 'setMood', 'mood', 'setForm', 'form', 'setLevel', 'say', 'create',
    'setProgress', 'progress', 'pulse', 'intro', 'glance', 'setDozing', 'dozing',
    'clampProgress', 'litTicks', 'flip', 'formFor', 'morphPlan', 'svg', 'iconSvg', 'monoSvg',
  ]) {
    assert.equal(typeof A[k], 'function', k);
  }
});

test('index.html renders Muscle in the header bubble name and #shape accessible label', () => {
  assert.match(INDEX_HTML, /<button[^>]*id="shape"[^>]*aria-label="Muscle: toque para uma dica"/);
  assert.match(INDEX_HTML, /<span class="bubble-name">Muscle<\/span>/);
  assert.doesNotMatch(INDEX_HTML, /Pulso/);
});

test('clampProgress keeps 0..1 and reads junk as 0', () => {
  assert.equal(A.clampProgress(0.5), 0.5);
  assert.equal(A.clampProgress(0), 0);
  assert.equal(A.clampProgress(1), 1);
  assert.equal(A.clampProgress(-0.2), 0);
  assert.equal(A.clampProgress(7), 1);
  assert.equal(A.clampProgress('0.25'), 0.25);
  for (const junk of [NaN, Infinity, -Infinity, null, undefined, '', '  ', 'abc', true, {}, []]) {
    assert.equal(A.clampProgress(junk), 0, String(junk));
  }
});

test('litTicks: none at 0, one as soon as there is progress, all only at 1', () => {
  assert.equal(A.litTicks(0), 0);
  assert.equal(A.litTicks(0.001), 1);
  assert.equal(A.litTicks(0.5), 6);
  assert.equal(A.litTicks(1 / 3), 4);
  assert.equal(A.litTicks(0.999), 11);
  assert.equal(A.litTicks(1), 12);
  assert.equal(A.litTicks(3), 12);
  assert.equal(A.litTicks(0.5, 4), 2);
  assert.equal(A.litTicks('junk'), 0);
});

test('flip maps one rect onto another, centre to centre', () => {
  const big = { left: 139, top: 300, width: 112, height: 112 };
  const slot = { left: 16, top: 20, width: 40, height: 40 };
  const m = A.flip(big, slot);
  assert.equal(m.x, 36 - 195);
  assert.equal(m.y, 40 - 356);
  assert.equal(m.s, 40 / 112);
  assert.deepEqual(A.flip(slot, slot), { x: 0, y: 0, s: 1 });
  assert.equal(A.flip({ left: 0, top: 0, width: 0, height: 0 }, slot).s, 1);
});

test('formFor enforces exact priority order: dozing > review/sent > intro > view > base', () => {
  // 1. dozing wins over every screen, intro and view
  assert.equal(A.formFor({ dozing: true, screen: 'review', intro: true, view: 'workout' }), 'descanso');
  assert.equal(A.formFor({ dozing: true, screen: 'sent', view: 'food' }), 'descanso');
  assert.equal(A.formFor({ dozing: true, view: 'water' }), 'descanso');

  // 2. review / sent screen wins over intro and view
  assert.equal(A.formFor({ dozing: false, screen: 'review', intro: true, view: 'workout' }), 'revisao');
  assert.equal(A.formFor({ screen: 'review', view: 'food' }), 'revisao');
  assert.equal(A.formFor({ screen: 'sent', view: 'workout' }), 'revisao');

  // 3. intro wins over view
  assert.equal(A.formFor({ intro: true, view: 'workout', screen: 'form' }), 'base');
  assert.equal(A.formFor({ intro: true, view: 'food' }), 'base');
  assert.equal(A.formFor({ intro: true, view: 'water' }), 'base');

  // 4. view maps workout -> treino, food -> refeicao, water -> agua
  assert.equal(A.formFor({ view: 'workout', screen: 'form' }), 'treino');
  assert.equal(A.formFor({ view: 'food', screen: 'form' }), 'refeicao');
  assert.equal(A.formFor({ view: 'water', screen: 'form' }), 'agua');

  // 5. fallback to base
  assert.equal(A.formFor(), 'base');
  assert.equal(A.formFor(null), 'base');
  assert.equal(A.formFor({ view: 'other' }), 'base');
});

test('morphPlan computes 340 ms squash on real transitions and 0 ms when unchanged or reduced', () => {
  assert.deepEqual(A.morphPlan('base', 'treino', false), { to: 'treino', ms: 340, squash: true });
  assert.deepEqual(A.morphPlan('treino', 'refeicao', false), { to: 'refeicao', ms: 340, squash: true });
  assert.deepEqual(A.morphPlan('treino', 'treino', false), { to: 'treino', ms: 0, squash: false });
  assert.deepEqual(A.morphPlan('base', 'treino', true), { to: 'treino', ms: 0, squash: false });
  assert.deepEqual(A.morphPlan('base', 'unknown', false), { to: 'base', ms: 0, squash: false });
  assert.deepEqual(A.morphPlan('treino', 'unknown', false), { to: 'base', ms: 340, squash: true });
});

test('intro, pulse, glance, setDozing and setProgress are safe before mount', () => {
  assert.equal(A.intro('x'), false);
  assert.equal(A.pulse('tick'), false);
  assert.equal(A.pulse('nope'), false);
  assert.equal(A.pulse('celebrate'), false);
  assert.doesNotThrow(() => A.glance(null));
  assert.doesNotThrow(() => A.setDozing(true));
  assert.equal(A.dozing(), false);
  assert.equal(A.mood(), null);
  assert.equal(A.form(), null);
  assert.equal(A.setProgress(2), 1);
  assert.equal(A.progress(), 1);
  assert.equal(A.setProgress(-1), 0);
  assert.equal(A.progress(), 0);
});

test('mount draws Muscle artwork, syncs Muscle name/label, injects style once, and wires .pl-bar + .pl-dots', () => {
  const env = avatarEnv({ ariaLabel: 'Pulso: toque para uma dica', initialName: 'Pulso' });
  const { Avatar, doc, coach, shape, nameEl, sayEl } = env;

  const mounted = Avatar.mount(shape, sayEl);
  assert.equal(mounted, shape);
  assert.equal(nameEl.textContent, 'Muscle');
  assert.equal(shape.getAttribute('aria-label'), 'Muscle: toque para uma dica');
  assert.equal(shape.hasAttribute('aria-hidden'), false, 'interactive header button must not become aria-hidden');
  assert.equal(shape.getAttribute('data-state'), 'idle');
  assert.equal(shape.getAttribute('data-form'), 'base');
  assert.ok(doc.getElementById('shape-avatar-style'));
  assert.ok(shape.querySelector('.dt-svg'));
  assert.ok(shape.querySelector('.dt-gaze'));
  assert.ok(shape.querySelector('.dt-waves'));
  assert.ok(shape.querySelector('.dt-sparks'));
  assert.ok(shape.querySelector('.dt-zz'));
  assert.ok(shape.querySelector('.dt-oopsdrop'));
  assert.equal(shape.querySelectorAll('.dt-f').length, Avatar.STATES.length);
  assert.ok(coach.querySelector('.pl-bar'));
  assert.equal(coach.firstChild, coach.querySelector('.pl-bar'));
  assert.ok(sayEl.querySelector('.pl-dots'));

  // Re-mounting reuses style and .pl-bar cleanly without duplicating them
  Avatar.mount(shape, sayEl);
  assert.equal(doc.head.querySelectorAll('#shape-avatar-style').length, 1);
  assert.equal(coach.querySelectorAll('.pl-bar').length, 1);
});

test('setMood supports all MOODS and rich STATES, syncs .pl-bar, and create() supports all signatures', () => {
  const env = avatarEnv();
  const { Avatar, coach, shape, sayEl } = env;
  Avatar.mount(shape, sayEl);
  const bar = coach.querySelector('.pl-bar');

  for (const s of Avatar.STATES) {
    Avatar.setMood(s);
    assert.equal(Avatar.mood(), s);
    assert.equal(shape.getAttribute('data-state'), s);
    assert.equal(bar.getAttribute('data-state'), s);
    assert.ok(shape.querySelector(`.f-${s}`), `SVG includes .f-${s}`);
  }

  Avatar.setMood('nonexistent');
  assert.equal(Avatar.mood(), 'dozing', 'unknown mood is ignored');

  // create() signatures: (mood), (mood, progress), (mood, form), (mood, progress, form), (mood, {progress, form})
  const c1 = Avatar.create('happy');
  assert.equal(c1.getAttribute('aria-hidden'), 'true');
  assert.equal(c1.getAttribute('data-state'), 'happy');
  assert.equal(c1.getAttribute('data-form'), 'base');
  assert.equal(c1.getAttribute('data-progress'), '1');

  const c2 = Avatar.create('happy', 'revisao');
  assert.equal(c2.getAttribute('data-state'), 'happy');
  assert.equal(c2.getAttribute('data-form'), 'revisao');
  assert.equal(c2.getAttribute('data-progress'), '1');

  const c3 = Avatar.create('focused', 0.4, 'treino');
  assert.equal(c3.getAttribute('data-state'), 'focused');
  assert.equal(c3.getAttribute('data-form'), 'treino');
  assert.equal(c3.getAttribute('data-progress'), '0.4');

  const c4 = Avatar.create('listening', { progress: 0.25, form: 'agua' });
  assert.equal(c4.getAttribute('data-state'), 'listening');
  assert.equal(c4.getAttribute('data-form'), 'agua');
  assert.equal(c4.getAttribute('data-progress'), '0.25');

  assert.match(Avatar.iconSvg('coral'), /<svg /);
  assert.match(Avatar.iconSvg('dark'), /<svg /);
  assert.match(Avatar.monoSvg(), /<mask id="dt-mono-/);
});

test('setForm morphs across all FORMS with 340 ms squash and switches instantly under reduced motion', () => {
  const env = avatarEnv();
  const { Avatar, shape, sayEl } = env;
  Avatar.mount(shape, sayEl);
  const animEl = shape.querySelector('.dt-anim');

  for (const f of ['treino', 'refeicao', 'agua', 'revisao', 'descanso', 'base']) {
    const before = animEl._animations.length;
    const plan = Avatar.setForm(f);
    assert.equal(Avatar.form(), f);
    assert.equal(shape.getAttribute('data-form'), f);
    assert.equal(plan.to, f);
    assert.equal(plan.ms, 340);
    assert.equal(animEl._animations.length, before + 1);
    assert.equal(animEl._animations.at(-1).options.duration, 340);
  }

  // Calling setForm with the current form does not replay squash
  const sameCount = animEl._animations.length;
  const noopPlan = Avatar.setForm('base');
  assert.equal(noopPlan.ms, 0);
  assert.equal(animEl._animations.length, sameCount);

  // Under prefers-reduced-motion: reduce, form switches immediately with 0 animations
  env.setReduced(true);
  const redCount = animEl._animations.length;
  const redPlan = Avatar.setForm('treino');
  assert.equal(Avatar.form(), 'treino');
  assert.equal(redPlan.ms, 0);
  assert.equal(redPlan.squash, false);
  assert.equal(animEl._animations.length, redCount);

  // Standalone decorative avatar also supports setForm(el, form)
  const standalone = Avatar.create('idle');
  Avatar.setForm(standalone, 'refeicao');
  assert.equal(standalone.getAttribute('data-form'), 'refeicao');
});

test('setProgress, pulse (nod/tick/full/no/celebrate), say and setDozing work and respect reduced motion', () => {
  const env = avatarEnv();
  const { Avatar, timers, coach, shape, sayEl } = env;
  Avatar.mount(shape, sayEl);
  const pose = shape.querySelector('.dt-pose');
  const barFill = coach.querySelector('.pl-bar').firstChild;

  // Progress increments trigger 'tick' then 'full' at 1
  assert.equal(Avatar.setProgress(0.25), 0.25);
  assert.equal(barFill.style.transform, 'scaleX(0.25)');
  assert.equal(pose._animations.length, 1);
  assert.equal(pose._animations.at(-1).options.duration, 260); // tick

  assert.equal(Avatar.setProgress(1), 1);
  assert.equal(barFill.style.transform, 'scaleX(1)');
  assert.equal(pose._animations.length, 2);
  assert.equal(pose._animations.at(-1).options.duration, 400); // full

  // Lowering progress does not pulse
  Avatar.setProgress(0.5);
  assert.equal(pose._animations.length, 2);

  // Pulse kinds preserve mood; celebrate sets data-reaction="celebrate" for 900 ms
  Avatar.setMood('happy');
  for (const kind of ['nod', 'tick', 'full', 'no']) {
    assert.equal(Avatar.pulse(kind), true, kind);
    assert.equal(Avatar.mood(), 'happy');
  }
  assert.equal(Avatar.pulse('celebrate'), true);
  assert.equal(shape.getAttribute('data-reaction'), 'celebrate');
  timers.run(899);
  assert.equal(shape.getAttribute('data-reaction'), 'celebrate');
  timers.run(1);
  assert.equal(shape.hasAttribute('data-reaction'), false);

  // Reduced motion and data-motion="off" suppress pulse Web Animations
  shape.setAttribute('data-motion', 'off');
  const countBeforeOff = pose._animations.length;
  assert.equal(Avatar.pulse('nod'), false);
  assert.equal(pose._animations.length, countBeforeOff);
  shape.removeAttribute('data-motion');

  // say() updates bubble text, preserves .pl-dots, and toggles .swap
  Avatar.say('Primeira fala');
  assert.equal(sayEl.textContent, 'Primeira fala');
  assert.ok(sayEl.querySelector('.pl-dots'));
  assert.equal(sayEl.classList.contains('swap'), true);

  // setDozing() toggles data-dozing without overwriting mood()
  Avatar.setDozing(true);
  assert.equal(Avatar.dozing(), true);
  assert.equal(shape.getAttribute('data-dozing'), 'true');
  assert.equal(Avatar.mood(), 'happy');
  Avatar.setDozing(false);
  assert.equal(Avatar.dozing(), false);
  assert.equal(shape.getAttribute('data-dozing'), 'false');
});

test('glance shifts .dt-gaze up to 3 SVG units toward field and stays still under reduced motion', () => {
  const env = avatarEnv();
  const { Avatar, doc, shape, sayEl } = env;
  Avatar.mount(shape, sayEl);
  const gaze = shape.querySelector('.dt-gaze');

  const field = doc.createElement('input');
  field._rect = { left: 16, top: 220, right: 216, bottom: 260, width: 200, height: 40 };
  Avatar.glance(field);
  const m = /^translate\(([-\d.]+)px, ([-\d.]+)px\)$/.exec(gaze.style.transform);
  assert.ok(m, `unexpected transform: ${gaze.style.transform}`);
  const gx = Number(m[1]), gy = Number(m[2]);
  const dist = Math.hypot(gx, gy);
  assert.ok(dist > 2.9 && dist <= 3.05, `expected ~3px gaze shift, got ${dist}`);
  assert.ok(gy > 0, 'field below avatar shifts gaze downward');

  // Null returns eyes to centre
  Avatar.glance(null);
  assert.equal(gaze.style.transform, 'translate(0px, 0px)');

  // Under prefers-reduced-motion: reduce, glance never shifts eyes away from centre
  env.setReduced(true);
  Avatar.glance(field);
  assert.equal(gaze.style.transform, 'translate(0px, 0px)');
});

test('setLevel drives listening voice waves, respects reduced motion, and clears when leaving listening', () => {
  const env = avatarEnv();
  const { Avatar, shape, sayEl } = env;
  Avatar.mount(shape, sayEl);
  Avatar.setMood('listening');

  const breath = shape.querySelector('.dt-breath');
  const w1 = shape.querySelector('.dt-w1');
  const w2 = shape.querySelector('.dt-w2');

  assert.equal(Avatar.setLevel(0.8), 0.8);
  assert.equal(shape.getAttribute('data-level'), '0.8');
  assert.match(breath.style.transform, /^scale\(/);
  assert.equal(w1.style.opacity, '1');
  assert.ok(Number(w2.style.opacity) > 0.7);

  // Under reduced motion, opacity responds without scale transforms
  env.setReduced(true);
  Avatar.setLevel(0.6);
  assert.equal(breath.style.transform, '');
  assert.equal(w1.style.transform, '');
  assert.equal(w2.style.transform, '');
  env.setReduced(false);

  // Switching away from listening clears data-level and inline styles automatically
  Avatar.setMood('understood');
  assert.equal(shape.hasAttribute('data-level'), false);
  assert.equal(w1.style.opacity, '');
  assert.equal(w2.style.opacity, '');
});

test('intro glides from centred overlay to header via FLIP and skips completely under reduced motion', () => {
  const env = avatarEnv();
  const { Avatar, doc, timers, shape, sayEl } = env;
  Avatar.mount(shape, sayEl);

  assert.equal(Avatar.intro('Abrindo sua ficha'), true);
  assert.equal(shape.style.opacity, '0');
  const introLayer = doc.body.querySelector('.pl-intro');
  assert.ok(introLayer);
  const big = introLayer.querySelector('.shape');
  big._rect = { left: 139, top: 300, right: 251, bottom: 412, width: 112, height: 112 };
  assert.equal(big.getAttribute('data-state'), 'thinking');
  assert.equal(big.getAttribute('data-form'), 'base');

  Avatar.setForm('treino');
  Avatar.setMood('idle');
  Avatar.say('Upper A: registre série por série.');
  timers.run(750);
  assert.equal(big.getAttribute('data-form'), 'treino');
  assert.equal(big._animations.length, 1);
  big._animations[0].finish();
  assert.equal(doc.body.querySelector('.pl-intro'), null);
  assert.equal(shape.style.opacity, '');

  // Under reduced motion, intro() returns false and creates no overlay
  env.setReduced(true);
  assert.equal(Avatar.intro('Abrindo sua ficha'), false);
  assert.equal(doc.body.querySelector('.pl-intro'), null);
});

test('Muscle CSS animates only transform and opacity and disables all motion under prefers-reduced-motion: reduce', () => {
  const keyframes = [...A.CSS.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?\})\s*\}/g)];
  assert.ok(keyframes.length >= 12, 'expected Muscle keyframes in ShapeAvatar.CSS');
  for (const [block, body] of keyframes) {
    const props = [...body.matchAll(/([a-z-]+)\s*:/gi)].map((m) => m[1].toLowerCase());
    for (const prop of props) {
      assert.ok(prop === 'transform' || prop === 'opacity', `forbidden animated property "${prop}" in ${block}`);
    }
  }
  assert.match(A.CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?animation:\s*none\s*!important;[\s\S]*?transition:\s*none\s*!important;/);
  assert.match(A.CSS, /\.shape\[data-motion="off"\]/);
});
