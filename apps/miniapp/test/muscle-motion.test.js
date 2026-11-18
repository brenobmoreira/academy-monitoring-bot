'use strict';
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Avatar = require('../src/avatar.js');
const MM = require('../src/muscle-motion.js');
const { FakeDocument, FakeElement } = require('./app_harness');

const AVATAR_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'avatar.js'), 'utf8');
const MOTION_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'muscle-motion.js'), 'utf8');

function createHarness(opts = {}) {
  const doc = new FakeDocument();
  let now = 1000;
  let nextTimerId = 1;
  let nextRafId = 1;
  let reduced = !!opts.reduced;

  const timers = new Map();
  const rafs = new Map();

  const win = {
    document: doc,
    Element: FakeElement,
    Uint8Array,
    Float32Array,
    ShapeAvatar: opts.useDitoFallback ? undefined : Avatar,
    DitoArt: opts.ditoArt || undefined,
    AudioContext: opts.AudioContext || undefined,
    webkitAudioContext: opts.webkitAudioContext || undefined,
    performance: { now: () => now },
    setTimeout(fn, ms) {
      const id = nextTimerId++;
      timers.set(id, { id, at: now + (ms || 0), ms: ms || 0, fn });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    requestAnimationFrame(fn) {
      const id = nextRafId++;
      rafs.set(id, fn);
      return id;
    },
    cancelAnimationFrame(id) {
      rafs.delete(id);
    },
    matchMedia(query) {
      if (String(query).includes('prefers-reduced-motion')) {
        return { get matches() { return reduced; }, addEventListener() {} };
      }
      return { matches: false, addEventListener() {} };
    },
  };
  doc.defaultView = win;

  const coach = doc.createElement('header');
  coach.className = 'coach';
  coach._rect = { left: 16, top: 20, right: 56, bottom: 60, width: 40, height: 40 };
  doc.body.appendChild(coach);

  const shape = doc.createElement('button');
  shape.className = 'shape';
  shape.id = 'shape';
  shape.setAttribute('type', 'button');
  shape.setAttribute('aria-label', 'Muscle: toque para uma dica');
  shape._rect = { left: 16, top: 20, right: 56, bottom: 60, width: 40, height: 40 };
  coach.appendChild(shape);

  const say = doc.createElement('p');
  say.className = 'bubble-text';
  coach.appendChild(say);

  Avatar.mount(shape, say);

  return {
    doc,
    win,
    coach,
    shape,
    timers,
    rafs,
    setReduced(v) { reduced = !!v; },
    advanceTimers(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.values()]
          .filter((t) => t.at <= target)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.delete(due.id);
        now = due.at;
        due.fn();
      }
      now = target;
    },
    stepRaf(frameDeltaMs = 16) {
      now += frameDeltaMs;
      const batch = [...rafs.entries()];
      rafs.clear();
      for (const [, fn] of batch) fn(now);
    },
  };
}

function makeMockAudio(samplesByFrame) {
  const state = {
    instances: 0,
    closeCalls: 0,
    sourceDisconnectCalls: 0,
    analyserDisconnectCalls: 0,
    fftSizes: [],
    frameIdx: 0,
  };

  class MockAudioContext {
    constructor() {
      state.instances += 1;
      this.state = 'running';
    }
    createAnalyser() {
      const analyser = {
        fftSize: 2048,
        smoothingTimeConstant: 0.8,
        get frequencyBinCount() { return this.fftSize >> 1; },
        getByteTimeDomainData(buf) {
          state.fftSizes.push(this.fftSize);
          const spec = samplesByFrame[Math.min(state.frameIdx, samplesByFrame.length - 1)];
          state.frameIdx += 1;
          for (let i = 0; i < buf.length; i++) {
            buf[i] = typeof spec === 'function' ? spec(i) : spec;
          }
        },
        disconnect() {
          state.analyserDisconnectCalls += 1;
        },
      };
      return analyser;
    }
    createMediaStreamSource(stream) {
      return {
        stream,
        connectedTo: null,
        connect(dest) { this.connectedTo = dest; },
        disconnect() { state.sourceDisconnectCalls += 1; },
      };
    }
    close() {
      state.closeCalls += 1;
      this.state = 'closed';
      return Promise.resolve();
    }
  }

  return { MockAudioContext, state };
}

describe('Exports & browser UMD contract', () => {
  test('exposes core curves, timing constants, REACTIONS, BLINK_SEQUENCE and public API', () => {
    assert.equal(typeof MM.SPRING, 'string');
    assert.equal(typeof MM.SPRING_SOFT, 'string');
    assert.equal(typeof MM.ANTICIPATE, 'string');
    assert.equal(typeof MM.SETTLE, 'string');
    assert.match(MM.SPRING, /^cubic-bezier\(/);
    assert.match(MM.SPRING_SOFT, /^cubic-bezier\(/);
    assert.match(MM.ANTICIPATE, /^cubic-bezier\(/);
    assert.match(MM.SETTLE, /^cubic-bezier\(/);

    for (const fn of [
      'morph', 'react', 'glance', 'blink', 'startBlink', 'startBlinkLoop',
      'nextBlinkDelay', 'startIdleBreath', 'startFootTap', 'createVoiceMeter',
      'connectVoice', 'flip', 'travelTo', 'guideTo', 'onValidationError',
      'attachLife', 'destroy', 'reducedMotion',
    ]) {
      assert.equal(typeof MM[fn], 'function', `expected function ${fn}`);
    }
  });

  test('attaches window.MuscleMotion in a browser VM alongside window.ShapeAvatar and DitoArt fallback', () => {
    const doc = new FakeDocument();
    const ctx = {
      document: doc,
      Element: FakeElement,
      Uint8Array,
      Float32Array,
      setTimeout,
      clearTimeout,
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    };
    doc.defaultView = ctx;
    ctx.window = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(AVATAR_SRC, ctx, { filename: 'avatar.js' });
    vm.runInContext(MOTION_SRC, ctx, { filename: 'muscle-motion.js' });

    assert.equal(ctx.ShapeAvatar.NAME, 'Muscle');
    assert.equal(typeof ctx.MuscleMotion.morph, 'function');

    // Verify DitoArt fallback when ShapeAvatar is absent
    const calls = [];
    const fallbackEl = doc.createElement('div');
    fallbackEl.setAttribute('data-motion', 'off');
    ctx.ShapeAvatar = undefined;
    ctx.DitoArt = {
      setForm(el, f) { calls.push(['form', f]); el.setAttribute('data-form', f); },
      setState(el, s) { calls.push(['state', s]); el.setAttribute('data-state', s); },
    };
    ctx.MuscleMotion.morph(fallbackEl, 'agua');
    assert.deepEqual(calls, [['form', 'agua']]);
    assert.equal(fallbackEl.getAttribute('data-form'), 'agua');
  });
});

describe('FLIP pure math', () => {
  test('flip() computes top-left dx/dy/sx/sy/scale inversion accurately', () => {
    const first = { left: 16, top: 20, width: 40, height: 40 };
    const last = { left: 136, top: 220, width: 80, height: 100 };
    const inv = MM.flip(first, last);
    assert.deepEqual(inv, {
      dx: -120,
      dy: -200,
      sx: 0.5,
      sy: 0.4,
      scale: 0.5,
    });
  });

  test('flip() with identical rects returns 0, 0, 1, 1, 1 (never -0)', () => {
    const r = { left: 24, top: 48, width: 64, height: 64 };
    const inv = MM.flip(r, r);
    assert.ok(Object.is(inv.dx, 0));
    assert.ok(Object.is(inv.dy, 0));
    assert.deepEqual(inv, { dx: 0, dy: 0, sx: 1, sy: 1, scale: 1 });
  });

  test('flip() safely returns scale=1 when width===0, height===0 or rects are missing', () => {
    assert.deepEqual(
      MM.flip({ left: 10, top: 10, width: 0, height: 0 }, { left: 30, top: 50, width: 80, height: 80 }),
      { dx: -20, dy: -40, sx: 1, sy: 1, scale: 1 }
    );
    assert.deepEqual(
      MM.flip({ left: 10, top: 10, width: 40, height: 40 }, { left: 10, top: 10, width: 0, height: 0 }),
      { dx: 0, dy: 0, sx: 1, sy: 1, scale: 1 }
    );
    assert.deepEqual(MM.flip(null, undefined), { dx: 0, dy: 0, sx: 1, sy: 1, scale: 1 });
  });
});

describe('Blink deterministic sequence', () => {
  test('nextBlinkDelay() returns BLINK_SEQUENCE values in order and cycles after 8 steps', () => {
    MM.resetBlinkSequence();
    assert.equal(MM.BLINK_SEQUENCE.length, 8);
    const firstCycle = [];
    for (let i = 0; i < 8; i++) firstCycle.push(MM.nextBlinkDelay());
    assert.deepEqual(firstCycle, MM.BLINK_SEQUENCE);

    const secondCycle = [];
    for (let i = 0; i < 8; i++) secondCycle.push(MM.nextBlinkDelay());
    assert.deepEqual(secondCycle, MM.BLINK_SEQUENCE);
  });

  test('every BLINK_SEQUENCE interval is within 2500..8000ms', () => {
    for (const ms of MM.BLINK_SEQUENCE) {
      assert.ok(ms >= 2500 && ms <= 8000, `blink delay ${ms} out of range 2500..8000`);
    }
  });
});

describe('REACTIONS definitions', () => {
  test('contains nod, tick, full, celebrate, pr and no with valid [0..1] keyframes and <= 600ms', () => {
    const expected = ['nod', 'tick', 'full', 'celebrate', 'pr', 'no'];
    for (const key of expected) {
      const r = MM.REACTIONS[key];
      assert.ok(r, `missing reaction ${key}`);
      assert.ok(Array.isArray(r.pose) && r.pose.length >= 3, `${key} pose keyframes`);
      assert.equal(r.pose[0].offset, 0, `${key} starts at offset 0`);
      assert.equal(r.pose[r.pose.length - 1].offset, 1, `${key} ends at offset 1`);
      assert.ok(r.poseMs > 0 && r.poseMs <= 600, `${key} duration ${r.poseMs}ms exceeds 600ms`);
    }
  });

  test('nod gaze lag is 25ms and celebrate/pr activate record state', () => {
    assert.equal(MM.REACTIONS.nod.gazeDelay, 25);
    assert.equal(MM.REACTIONS.celebrate.setState, 'record');
    assert.equal(MM.REACTIONS.pr.setState, 'record');
  });
});

describe('morph()', () => {
  test('orchestrates 70ms anticipation -> setForm -> 210ms overshoot -> 90ms settle (<= 370ms) + gaze (+35ms) & foot (+50ms)', () => {
    const env = createHarness();
    const animEl = env.shape.querySelector('.dt-anim');
    const gazeEl = env.shape.querySelector('.dt-gaze');
    const footEl = env.shape.querySelector('.dt-foot');

    let finishedForm = null;
    const handle = MM.morph(env.shape, 'treino', {
      onFinish(_el, f) { finishedForm = f; },
    });

    assert.ok(handle);
    assert.ok(handle.totalMs <= 370 && handle.totalMs <= 400);
    assert.equal(animEl._animations.length, 1);
    const anticipation = animEl._animations[0];
    assert.equal(anticipation.options.duration, 70);
    assert.equal(anticipation.options.easing, MM.ANTICIPATE);
    // Form has not switched yet during crouch anticipation
    assert.equal(env.shape.getAttribute('data-form'), 'base');

    // Finish Phase 1 (70ms) -> triggers setForm + overshoot (210ms) + secondary follow-through
    anticipation.finish();
    assert.equal(env.shape.getAttribute('data-form'), 'treino');

    const overshoot = animEl._animations.find((a) => a.options.duration === 210);
    assert.ok(overshoot, 'expected 210ms spring overshoot');
    assert.equal(overshoot.options.easing, MM.SPRING);

    assert.equal(gazeEl._animations.length, 1);
    assert.equal(gazeEl._animations[0].options.delay, 35);
    assert.ok(70 + gazeEl._animations[0].options.delay + gazeEl._animations[0].options.duration <= 370);

    assert.equal(footEl._animations.length, 1);
    assert.equal(footEl._animations[0].options.delay, 50);
    assert.ok(70 + footEl._animations[0].options.delay + footEl._animations[0].options.duration <= 370);

    // Finish Phase 2 (210ms) -> triggers 90ms settle
    overshoot.finish();
    const settle = animEl._animations.find((a) => a.options.duration === 90);
    assert.ok(settle, 'expected 90ms settle');
    assert.equal(settle.options.easing, MM.SETTLE);
    assert.equal(70 + 210 + 90, 370);

    settle.finish();
    assert.equal(finishedForm, 'treino');
    MM.destroy(env.shape);
  });

  test('with prefers-reduced-motion or data-motion="off", applies setForm immediately with zero WAAPI calls', () => {
    const env = createHarness({ reduced: true });
    const animEl = env.shape.querySelector('.dt-anim');

    const res1 = MM.morph(env.shape, 'refeicao');
    assert.equal(res1, null);
    assert.equal(env.shape.getAttribute('data-form'), 'refeicao');
    assert.equal(animEl._animations.length, 0);

    env.setReduced(false);
    env.shape.setAttribute('data-motion', 'off');
    const res2 = MM.morph(env.shape, 'agua');
    assert.equal(res2, null);
    assert.equal(env.shape.getAttribute('data-form'), 'agua');
    assert.equal(animEl._animations.length, 0);
  });
});

describe('react() & glance()', () => {
  test('nod animates pose and gaze with 25ms secondary lag', () => {
    const env = createHarness();
    const pose = env.shape.querySelector('.dt-pose');
    const gaze = env.shape.querySelector('.dt-gaze');

    const ok = MM.react(env.shape, 'nod');
    assert.equal(ok, true);
    assert.equal(pose._animations.length, 1);
    assert.equal(pose._animations[0].options.duration, 280);
    assert.equal(gaze._animations.length, 1);
    assert.equal(gaze._animations[0].options.delay, 25);
    MM.destroy(env.shape);
  });

  test('celebrate and pr transition avatar to record state and animate pose + gaze + foot', () => {
    const env = createHarness();
    const pose = env.shape.querySelector('.dt-pose');
    const gaze = env.shape.querySelector('.dt-gaze');
    const foot = env.shape.querySelector('.dt-foot');

    assert.equal(MM.react(env.shape, 'celebrate'), true);
    assert.equal(env.shape.getAttribute('data-state'), 'record');
    assert.equal(pose._animations.length, 1);
    assert.equal(gaze._animations.length, 1);
    assert.equal(foot._animations.length, 1);

    env.shape.setAttribute('data-state', 'idle');
    assert.equal(MM.react(env.shape, 'pr'), true);
    assert.equal(env.shape.getAttribute('data-state'), 'record');
    assert.equal(pose._animations.length, 2);
    MM.destroy(env.shape);
  });

  test('react() returns false under reduced-motion, data-motion="off", or unknown reaction', () => {
    const env = createHarness({ reduced: true });
    const pose = env.shape.querySelector('.dt-pose');
    assert.equal(MM.react(env.shape, 'celebrate'), false);
    assert.equal(pose._animations.length, 0);

    env.setReduced(false);
    assert.equal(MM.react(env.shape, 'unknown-kind'), false);

    env.shape.setAttribute('data-motion', 'off');
    assert.equal(MM.react(env.shape, 'nod'), false);
    assert.equal(pose._animations.length, 0);
  });

  test('glance() shifts gaze and tilts pose toward target, and resets on null or reduced-motion', () => {
    const env = createHarness();
    const field = env.doc.createElement('input');
    field._rect = { left: 116, top: 20, right: 156, bottom: 60, width: 40, height: 40 };
    env.doc.body.appendChild(field);

    MM.glance(env.shape, field);
    const gaze = env.shape.querySelector('.dt-gaze');
    const pose = env.shape.querySelector('.dt-pose');
    assert.equal(gaze.style.transform, 'translate(3px, 0px)');
    assert.equal(pose.style.transform, 'rotate(3deg)');

    MM.glance(env.shape, null);
    assert.equal(gaze.style.transform, '');
    assert.equal(pose.style.transform, '');

    env.setReduced(true);
    MM.glance(env.shape, field);
    assert.equal(gaze.style.transform, '');
    assert.equal(pose.style.transform, '');
  });
});

describe('createVoiceMeter() & connectVoice()', () => {
  test('computes RMS with fftSize=256, smooths attack=0.45 / release=0.18 in 0..1, and updates ShapeAvatar.setLevel', () => {
    // Frame 0: loud square wave (255 -> +127/128 ~= 0.992 RMS -> raw clamped to 1 -> level = 0.45)
    // Frame 1: silence (128 -> 0 RMS -> raw = 0 -> level = 0.45 * (1 - 0.18) = 0.369)
    const { MockAudioContext, state } = makeMockAudio([255, 128]);
    const env = createHarness({ AudioContext: MockAudioContext });
    const stream = { id: 'mic-stream-1' };

    const meter = MM.connectVoice(env.shape, stream);
    assert.equal(state.instances, 1);
    assert.equal(meter.level(), 0);
    assert.equal(env.rafs.size, 1);

    // Step 1st rAF frame: attack 0.45 toward 1.0
    env.stepRaf(16);
    assert.deepEqual(state.fftSizes, [256]);
    assert.ok(Math.abs(meter.level() - 0.45) < 1e-6);
    assert.equal(env.shape.getAttribute('data-level'), '0.45');

    // Step 2nd rAF frame: release 0.18 toward 0.0 -> 0.45 * 0.82 = 0.369
    env.stepRaf(16);
    assert.ok(Math.abs(meter.level() - 0.369) < 1e-6);
    assert.ok(meter.level() >= 0 && meter.level() <= 1);
    assert.equal(env.shape.getAttribute('data-level'), '0.37');

    // Idempotent double stop(): cancels rAF, zeroes level, closes AudioContext once
    meter.stop();
    assert.equal(env.rafs.size, 0);
    assert.equal(meter.level(), 0);
    assert.equal(env.shape.getAttribute('data-level'), '0');
    assert.equal(state.closeCalls, 1);
    assert.equal(state.sourceDisconnectCalls, 1);
    assert.equal(state.analyserDisconnectCalls, 1);

    assert.doesNotThrow(() => meter.stop());
    assert.equal(state.closeCalls, 1);
  });

  test('supports createVoiceMeter(stream, opts) signature and reduced-motion opacity-only wave updates', () => {
    const { MockAudioContext } = makeMockAudio([255]);
    const env = createHarness({ AudioContext: MockAudioContext, reduced: true });
    const levels = [];
    const meter = MM.createVoiceMeter({ id: 'mic-2' }, {
      el: env.shape,
      onLevel: (v) => levels.push(v),
    });

    env.stepRaf(16);
    assert.ok(Math.abs(meter.level() - 0.45) < 1e-6);
    assert.ok(levels.length >= 1);
    // In reduced-motion, ShapeAvatar.setLevel updates wave opacity without scale transform
    const w1 = env.shape.querySelector('.dt-w1');
    const breath = env.shape.querySelector('.dt-breath');
    assert.ok(Number(w1.style.opacity) > 0.3);
    assert.equal(breath.style.transform, '');

    meter.stop();
    assert.equal(levels.at(-1), 0);
  });

  test('falls back gracefully (level() => 0) when Web Audio is missing, stream is null, or AudioContext throws', () => {
    const envNoAudio = createHarness();
    const m1 = MM.createVoiceMeter({ id: 'mic' }, { el: envNoAudio.shape });
    assert.equal(m1.level(), 0);
    assert.doesNotThrow(() => { m1.stop(); m1.stop(); });

    const m2 = MM.createVoiceMeter(null, envNoAudio.shape);
    assert.equal(m2.level(), 0);

    class ThrowingAudioContext {
      constructor() { throw new Error('NotAllowedError'); }
    }
    const envThrows = createHarness({ AudioContext: ThrowingAudioContext });
    const m3 = MM.createVoiceMeter({ id: 'mic' }, envThrows.shape);
    assert.equal(m3.level(), 0);
    assert.doesNotThrow(() => m3.stop());
  });
});

describe('travelTo() spatial FLIP & single-instance stage presence', () => {
  test('reparents the single Muscle element, plays top-left FLIP with parabolic arc, and fires onArrive', () => {
    const env = createHarness();
    const reviewSlot = env.doc.createElement('div');
    reviewSlot.className = 'muscle-stage';
    reviewSlot.setAttribute('data-stage', 'review');
    env.doc.body.appendChild(reviewSlot);

    // Simulate layout change when Muscle moves from header (40x40 at 16,20) to review center (80x80 at 140,220)
    const origAppend = reviewSlot.appendChild.bind(reviewSlot);
    reviewSlot.appendChild = (child) => {
      const res = origAppend(child);
      child._rect = { left: 140, top: 220, right: 220, bottom: 300, width: 80, height: 80 };
      return res;
    };

    let arrivedArgs = null;
    const anim = MM.travelTo(env.shape, reviewSlot, {
      form: 'revisao',
      state: 'happy',
      onArrive(el, slot) { arrivedArgs = [el, slot]; },
    });

    // Single Muscle instance in the entire document, now inside reviewSlot
    assert.equal(env.doc.querySelectorAll('.shape').length, 1);
    assert.equal(env.shape.parentNode, reviewSlot);
    assert.equal(env.coach.querySelector('.shape'), null);
    assert.equal(env.shape.getAttribute('data-form'), 'revisao');
    assert.equal(env.shape.getAttribute('data-state'), 'happy');
    assert.equal(env.shape.getAttribute('aria-label'), 'Muscle: revisão pronta');

    assert.ok(anim, 'expected FLIP WAAPI animation');
    assert.equal(anim.frames.length, 3);
    assert.equal(anim.frames[0].offset, 0);
    assert.equal(anim.frames[0].transformOrigin, 'top left');
    assert.equal(anim.frames[0].transform, 'translate(-124px, -200px) scale(0.5, 0.5)');

    // Parabolic midpoint at offset 0.5 must lift above linear midpoint (-100px)
    assert.equal(anim.frames[1].offset, 0.5);
    const midMatch = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(anim.frames[1].transform);
    assert.ok(midMatch);
    assert.equal(Number(midMatch[1]), -62);
    assert.ok(Number(midMatch[2]) < -100, `expected parabolic upward lift < -100px, got ${midMatch[2]}`);

    assert.equal(anim.frames[2].offset, 1);
    assert.equal(anim.frames[2].transform, 'translate(0px, 0px) scale(1, 1)');
    assert.equal(arrivedArgs, null);

    anim.finish();
    assert.deepEqual(arrivedArgs, [env.shape, reviewSlot]);
    // Landing micro-bounce triggered on .dt-pose
    const pose = env.shape.querySelector('.dt-pose');
    assert.equal(pose._animations.length, 1);
    MM.destroy(env.shape);
  });

  test('does not animate when rects are identical, while still reparenting and calling onArrive', () => {
    const env = createHarness();
    const sameRectSlot = env.doc.createElement('div');
    env.doc.body.appendChild(sameRectSlot);

    let arrived = 0;
    const anim = MM.travelTo(env.shape, sameRectSlot, {
      onArrive() { arrived += 1; },
    });

    assert.equal(anim, null);
    assert.equal(env.shape.parentNode, sameRectSlot);
    assert.equal(env.shape._animations.length, 0);
    assert.equal(arrived, 1);
  });

  test('with reduced-motion or data-motion="off", reparents immediately without WAAPI animation', () => {
    const env = createHarness({ reduced: true });
    const voiceSlot = env.doc.createElement('div');
    voiceSlot.setAttribute('data-stage', 'voice');
    env.doc.body.appendChild(voiceSlot);

    const origAppend = voiceSlot.appendChild.bind(voiceSlot);
    voiceSlot.appendChild = (child) => {
      const res = origAppend(child);
      child._rect = { left: 120, top: 260, right: 200, bottom: 340, width: 80, height: 80 };
      return res;
    };

    let arrived = false;
    const anim = MM.travelTo(env.shape, voiceSlot, {
      state: 'listening',
      onArrive() { arrived = true; },
    });

    assert.equal(anim, null);
    assert.equal(env.shape.parentNode, voiceSlot);
    assert.equal(env.shape.getAttribute('data-state'), 'listening');
    assert.equal(env.shape._animations.length, 0);
    assert.equal(arrived, true);
  });
});

describe('Timers, micro-life, guiding & lifecycle cleanup', () => {
  test('startBlink schedules deterministic timer, blinks eyes, and cleanup cancels timer + animation (0 timers in reduced-motion)', () => {
    MM.resetBlinkSequence();
    const env = createHarness();
    const stopBlink = MM.startBlink(env.shape);
    assert.equal(env.timers.size, 1);
    const firstTimer = [...env.timers.values()][0];
    assert.equal(firstTimer.ms, 3800);

    env.advanceTimers(3800);
    const eyes = env.shape.querySelector('.f-idle .dt-eyes');
    assert.equal(eyes._animations.length, 1);
    assert.equal(eyes._animations[0].playState, 'running');

    // Finishing blink schedules next deterministic delay (5200ms)
    eyes._animations[0].finish();
    assert.equal(env.timers.size, 1);
    assert.equal([...env.timers.values()][0].ms, 5200);

    stopBlink();
    assert.equal(env.timers.size, 0);

    // Reduced motion schedules zero timers
    env.setReduced(true);
    const stopReduced = MM.startBlink(env.shape);
    assert.equal(env.timers.size, 0);
    stopReduced();
  });

  test('startFootTap and startIdleBreath loop WAAPI animations and cancel cleanly on cleanup', () => {
    const env = createHarness();
    const foot = env.shape.querySelector('.dt-foot');
    const breath = env.shape.querySelector('.dt-breath');

    const stopTap = MM.startFootTap(env.shape);
    assert.equal(foot._animations.length, 1);
    assert.equal(foot._animations[0].playState, 'running');

    // Completing one tap cycle starts the next
    foot._animations[0].finish();
    assert.equal(foot._animations.length, 2);
    assert.equal(foot._animations[1].playState, 'running');

    stopTap();
    assert.equal(foot._animations[1].playState, 'idle');

    const stopBreath = MM.startIdleBreath(env.shape);
    assert.equal(typeof stopBreath, 'function');
    assert.equal(breath._animations.length, 1);
    assert.equal(breath._animations[0].playState, 'running');
    stopBreath();
    assert.equal(breath._animations[0].playState, 'idle');
  });

  test('onValidationError glances at field, triggers no + oops, restores after 1500ms, and supports cancelable timer', () => {
    const env = createHarness();
    env.shape.setAttribute('data-state', 'focused');
    const badInput = env.doc.createElement('input');
    badInput._rect = { left: 16, top: 180, right: 200, bottom: 220, width: 184, height: 40 };
    env.doc.body.appendChild(badInput);

    const cancel1 = MM.onValidationError(env.shape, badInput);
    assert.equal(env.shape.getAttribute('data-state'), 'oops');
    assert.equal(env.timers.size, 1);

    // Cancel before 1500ms -> timer removed immediately and never fires
    cancel1();
    assert.equal(env.timers.size, 0);
    env.advanceTimers(2000);
    assert.equal(env.shape.getAttribute('data-state'), 'oops');

    // Second error allowed to complete -> restores 'focused' after 1500ms
    env.shape.setAttribute('data-state', 'focused');
    MM.onValidationError(env.shape, badInput);
    assert.equal(env.shape.getAttribute('data-state'), 'oops');
    env.advanceTimers(1500);
    assert.equal(env.shape.getAttribute('data-state'), 'focused');
    assert.equal(env.timers.size, 0);
  });

  test('guideTo, attachLife and destroy() clean up every active timer, rAF, AudioContext and WAAPI animation', () => {
    const { MockAudioContext, state } = makeMockAudio([220]);
    const env = createHarness({ AudioContext: MockAudioContext });
    const card = env.doc.createElement('div');
    card.className = 'card';
    card._rect = { left: 16, top: 140, right: 320, bottom: 220, width: 304, height: 80 };
    env.doc.body.appendChild(card);

    MM.attachLife(env.shape);
    MM.startFootTap(env.shape);
    MM.connectVoice(env.shape, { id: 'live-mic' });
    MM.guideTo(env.shape, card, { delay: 120, reaction: 'nod' });
    MM.onValidationError(env.shape, card);

    assert.ok(env.timers.size >= 2);
    assert.equal(env.rafs.size, 1);

    MM.destroy(env.shape);

    assert.equal(env.timers.size, 0);
    assert.equal(env.rafs.size, 0);
    assert.equal(state.closeCalls, 1);
    for (const part of ['.dt-breath', '.dt-foot', '.dt-pose']) {
      const node = env.shape.querySelector(part);
      for (const anim of node._animations) {
        assert.notEqual(anim.playState, 'running', `${part} animation still running after destroy`);
      }
    }
  });
});
