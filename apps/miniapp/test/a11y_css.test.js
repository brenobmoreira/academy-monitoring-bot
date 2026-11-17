'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(CSS);
  assert.ok(match, `expected CSS rule for ${selector}`);
  return match[1];
}

test('focus-visible rules use high-contrast --accent outline instead of --accent-soft', () => {
  const focusRules = [...CSS.matchAll(/([^\n{}]*:focus-visible[^{]*)\{([^}]*)\}/g)];
  assert.ok(focusRules.length >= 3, 'expected at least 3 :focus-visible rules');
  for (const [, selector, body] of focusRules) {
    assert.doesNotMatch(body, /--accent-soft/, `${selector.trim()} must not use --accent-soft`);
    assert.match(body, /outline:\s*2px solid var\(--accent\)/, `${selector.trim()} must declare 2px solid var(--accent)`);
  }
});

test('interactive buttons and controls declare at least 44px touch targets', () => {
  const btnX = ruleBody('.btn-x');
  assert.match(btnX, /\bwidth:\s*44px\b/);
  assert.match(btnX, /\bheight:\s*44px\b/);
  assert.match(btnX, /\bline-height:\s*44px\b/);

  const miniStep = ruleBody('.mini-step button');
  assert.match(miniStep, /\bwidth:\s*44px\b/);
  assert.match(miniStep, /\bheight:\s*44px\b/);

  const chip = ruleBody('.chip');
  assert.match(chip, /\bmin-height:\s*44px\b/);
  assert.match(chip, /\bmin-width:\s*44px\b/);

  assert.match(ruleBody('.tab'), /\bheight:\s*44px\b/);
  for (const sel of ['.date-chip', '.pair .step-input', '.extra', '.btn-text', '.seg button', '.seg.small button']) {
    assert.match(ruleBody(sel), /\bmin-height:\s*44px\b/, `${sel} must declare min-height: 44px`);
  }
});

test('WCAG AA palette tokens, placeholders, selected chip tags and error dot ink are set', () => {
  const root = ruleBody(':root');
  assert.match(root, /--accent:\s*#c9410c\b/);
  assert.match(root, /--hint:\s*var\(--tg-theme-hint-color,\s*#635d58\)/);
  assert.match(root, /--alert-ink:\s*#ffffff\b/);

  const dark = ruleBody(':root[data-scheme="dark"]');
  assert.match(dark, /--accent:\s*#ff6a2b\b/);
  assert.match(dark, /--alert-ink:\s*#1a0a02\b/);

  const placeholder = ruleBody('.step-input::placeholder');
  assert.match(placeholder, /\bcolor:\s*var\(--hint\)/);
  assert.match(placeholder, /\bopacity:\s*1\b/);

  const selectedTag = ruleBody('.chip[aria-pressed="true"] .tag, .chip[aria-checked="true"] .tag');
  assert.match(selectedTag, /\bopacity:\s*1\b/);

  const errorDot = ruleBody('.card[data-status="error"] .dot::after');
  assert.match(errorDot, /\bcolor:\s*var\(--alert-ink\)/);
});

function parseHexColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function parseRgbaColor(rgba) {
  const m = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([0-9.]+)\s*\)$/.exec(rgba.trim());
  assert.ok(m, `expected rgba color, got ${rgba}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
}

function blendOver(fgRgba, bgRgb) {
  const a = fgRgba[3];
  return [0, 1, 2].map((i) => fgRgba[i] * a + bgRgb[i] * (1 - a));
}

function relLuminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(rgbA, rgbB) {
  const l1 = relLuminance(rgbA);
  const l2 = relLuminance(rgbB);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function tokenValue(body, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`${escaped}:\\s*([^;]+);`).exec(body);
  assert.ok(m, `expected token ${name}`);
  const val = m[1].trim();
  const fb = /var\([^,]+,\s*([^)]+)\)/.exec(val);
  return (fb ? fb[1] : val).trim();
}

test('light theme composite WCAG AA contrast (>= 4.5:1) on translucent surfaces', () => {
  const root = ruleBody(':root');
  const bg = parseHexColor(tokenValue(root, '--bg'));
  const surface = parseHexColor(tokenValue(root, '--surface'));
  const accentText = parseHexColor(tokenValue(root, '--accent-text'));
  const accentSoft = parseRgbaColor(tokenValue(root, '--accent-soft'));
  const alert = parseHexColor(tokenValue(root, '--alert'));
  const alertInk = parseHexColor(tokenValue(root, '--alert-ink'));
  const alertSoft = parseRgbaColor(tokenValue(root, '--alert-soft'));

  const dateChipBg = blendOver(accentSoft, bg);
  const dateChipRatio = contrastRatio(accentText, dateChipBg);
  assert.ok(dateChipRatio >= 4.5, `.date-chip[aria-checked="true"] composite contrast ${dateChipRatio.toFixed(2)} must be >= 4.5`);

  const alertSoftBg = blendOver(alertSoft, surface);
  const alertSoftRatio = contrastRatio(alert, alertSoftBg);
  assert.ok(alertSoftRatio >= 4.5, `.errors/.voice-error composite contrast ${alertSoftRatio.toFixed(2)} must be >= 4.5`);

  const errorDotRatio = contrastRatio(alertInk, alert);
  assert.ok(errorDotRatio >= 4.5, `.card[data-status="error"] .dot ink contrast ${errorDotRatio.toFixed(2)} must be >= 4.5`);
});

test('M4 360px layout rules wrap card summaries, favorite plates, pair steppers, and facts', () => {
  const summary = ruleBody('.card-summary');
  assert.match(summary, /\bwhite-space:\s*normal\b/);
  assert.match(summary, /\btext-align:\s*right\b/);
  assert.match(summary, /\bmax-width:\s*112px\b/);

  assert.match(CSS, /@media\s*\(max-width:\s*400px\)\s*\{[^}]*\.plate-item\.k-favorite\b[\s\S]*?\.plate-item\.k-favorite\s+\.plate-right\b/);

  const pairStepper = ruleBody('.pair .stepper');
  assert.match(pairStepper, /\bgrid-template-columns:\s*44px minmax\(0,\s*1fr\) 44px\b/);
  assert.match(pairStepper, /\bborder-radius:\s*16px\b/);

  const pairInput = ruleBody('.pair .step-input');
  assert.match(pairInput, /\bmin-height:\s*44px\b/);
  assert.match(pairInput, /\bfont-size:\s*20px\b/);

  const factsDd = ruleBody('.facts dd');
  assert.match(factsDd, /\bmin-width:\s*0\b/);
  assert.match(factsDd, /\boverflow-wrap:\s*anywhere\b/);

  const parsed = ruleBody('.qty-row .parsed');
  assert.match(parsed, /\bmin-width:\s*0\b/);
  assert.match(parsed, /\boverflow-wrap:\s*anywhere\b/);
  assert.match(parsed, /\bmax-width:\s*45%/);
});

test('M5-M7 sheet height, scroll margins, tokens, and utility classes are declared', () => {
  const sheet = ruleBody('.sheet');
  assert.match(sheet, /\bmax-height:\s*82vh\b/);
  assert.match(sheet, /\bmax-height:\s*82dvh\b/);
  assert.match(sheet, /\bborder:\s*1px solid var\(--line\)/);
  assert.match(sheet, /\bborder-radius:\s*var\(--radius-sheet\)/);

  const scrollTargets = ruleBody('.card, .panel, .step-input, .text-input, .textarea');
  assert.match(scrollTargets, /\bscroll-margin-top:\s*calc\(var\(--safe-top\) \+ 104px\)/);
  assert.match(scrollTargets, /\bscroll-margin-bottom:\s*calc\(var\(--dock-h\) \+ var\(--safe-bottom\) \+ 16px\)/);

  const root = ruleBody(':root');
  for (const token of ['--radius-sm:\\s*12px', '--radius-md:\\s*14px', '--radius:\\s*16px', '--radius-sheet:\\s*26px', '--backdrop:\\s*rgba\\(28, 25, 23, 0\\.45\\)']) {
    assert.match(root, new RegExp(token));
  }
  assert.match(ruleBody(':root[data-scheme="dark"]'), /--backdrop:\s*rgba\(0, 0, 0, 0\.6\)/);
  assert.match(ruleBody('.sheet-backdrop'), /\bbackground:\s*var\(--backdrop\)/);

  const nutrition = ruleBody('.meal-nutrition');
  assert.match(nutrition, /\bbackground:\s*var\(--surface\)/);
  assert.match(nutrition, /\bborder-radius:\s*var\(--radius-md\)/);
  assert.match(nutrition, /\bbox-shadow:\s*var\(--shadow\)/);
  assert.match(nutrition, /\bborder:\s*0\b/);

  for (const util of ['.sheet-col', '.mt-8', '.mt-12', '.mt-16', '.m-0', '.p-16']) {
    ruleBody(util);
  }
});
