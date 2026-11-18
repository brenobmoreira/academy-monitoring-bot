'use strict';
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// ── 1. HTML script tags ─────────────────────────────────────────────────────

describe('M-Motion-Wire: HTML script includes', () => {
  test('index.html: muscle-motion.js is loaded after avatar.js', () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const avatarPos = html.indexOf('src/avatar.js');
    const mmPos     = html.indexOf('src/muscle-motion.js');
    assert.ok(avatarPos >= 0, 'avatar.js script tag must exist');
    assert.ok(mmPos >= 0,     'muscle-motion.js script tag must exist in index.html');
    assert.ok(mmPos > avatarPos, 'muscle-motion.js must come after avatar.js');
  });

  test('muscle-motion-lab.html: muscle-motion.js is loaded after avatar.js', () => {
    const html = fs.readFileSync(path.join(ROOT, 'dev', 'muscle-motion-lab.html'), 'utf8');
    const avatarPos = html.indexOf('src/avatar.js');
    const mmPos     = html.indexOf('src/muscle-motion.js');
    assert.ok(avatarPos >= 0, 'avatar.js script tag must exist in lab');
    assert.ok(mmPos >= 0,     'muscle-motion.js script tag must exist in lab');
    assert.ok(mmPos > avatarPos, 'muscle-motion.js must come after avatar.js in lab');
  });
});

// ── 2. app.js: syncForm calls MM.morph when form changes ────────────────────

describe('M-Motion-Wire: syncForm morph wiring', () => {
  test('app.js contains MM.morph call in syncForm', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
    assert.ok(
      src.includes('MM.morph(els.shape, nextForm)') || src.includes('MM.morph('),
      'app.js must call MM.morph in syncForm'
    );
  });

  test('app.js MuscleMotion morph is guarded by MM truthy check', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
    assert.ok(
      src.includes('MM && typeof MM.morph') || src.includes('MM &&'),
      'morph call must be gated on MM truthy check'
    );
  });

  test('app.js still calls Avatar.setForm as fallback', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
    assert.ok(src.includes('Avatar.setForm(nextForm)'), 'Avatar.setForm must remain as fallback');
  });

  test('app.js skips morph when form has not changed (currentForm !== nextForm guard)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
    assert.ok(
      src.includes('currentForm !== nextForm'),
      'morph must only fire when form actually changes'
    );
  });
});

// ── 3. voice.js: onStream callback in createVoiceController ─────────────────

describe('M-Motion-Wire: voice.js onStream callback – source inspection', () => {
  test('voice.js calls o.onStream with the stream on start_recorder', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'voice.js'), 'utf8');
    assert.ok(
      src.includes('o.onStream(activeStream)'),
      'voice.js must call o.onStream(activeStream) in start_recorder effect'
    );
  });

  test('voice.js calls o.onStream(null) in both stop_tracks branches', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'voice.js'), 'utf8');
    const nullCalls = (src.match(/o\.onStream\(null\)/g) || []).length;
    assert.ok(nullCalls >= 2, 'o.onStream(null) must appear in both stop_tracks branches (got ' + nullCalls + ')');
  });

  test('voice.js onStream calls are wrapped in typeof guard', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'voice.js'), 'utf8');
    assert.ok(
      src.includes("typeof o.onStream === 'function'"),
      'onStream calls must be guarded by typeof check'
    );
  });

  test('voice.js onStream calls are wrapped in try/catch', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'voice.js'), 'utf8');
    // Confirm try { o.onStream( pattern
    assert.ok(
      /try\s*\{[^}]*o\.onStream/.test(src),
      'onStream calls must be inside try blocks'
    );
  });
});

// ── 4. app.js: createVoiceMeter lifecycle ────────────────────────────────────

describe('M-Motion-Wire: app.js createVoiceMeter lifecycle', () => {
  test('app.js wires onStream: mmOnStream to both ctrl creation paths', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
    const occurrences = (src.match(/onStream:\s*mmOnStream/g) || []).length;
    assert.ok(occurrences >= 2, 'onStream: mmOnStream must appear in both preview and tg ctrl paths (found ' + occurrences + ')');
  });

  test('app.js defines mmOnStream function that calls MM.createVoiceMeter', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
    assert.ok(src.includes('function mmOnStream'), 'mmOnStream function must be defined');
    assert.ok(
      src.includes('MM.createVoiceMeter'),
      'mmOnStream must call MM.createVoiceMeter'
    );
  });

  test('app.js stops existing meter before starting a new one (defensive)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
    assert.ok(
      src.includes('mmVoiceMeter.stop()'),
      'mmOnStream must stop the previous meter before creating a new one'
    );
  });

  test('app.js calls mmOnStream(null) on pagehide for deterministic cleanup', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
    const pagehideIdx = src.indexOf('pagehide');
    assert.ok(pagehideIdx >= 0, 'pagehide listener must exist');
    // Check mmOnStream(null) appears after pagehide
    const afterPagehide = src.slice(pagehideIdx, pagehideIdx + 300);
    assert.ok(
      afterPagehide.includes('mmOnStream(null)'),
      'pagehide handler must call mmOnStream(null)'
    );
  });

  test('app.js MuscleMotion attachLife is called on els.shape after Avatar.mount', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'app.js'), 'utf8');
    assert.ok(
      src.includes('MM.attachLife(els.shape)'),
      'app.js must call MM.attachLife(els.shape)'
    );
    // Guard check
    assert.ok(
      src.includes('MM && typeof MM.attachLife'),
      'attachLife must be guarded by MM existence check'
    );
  });
});
