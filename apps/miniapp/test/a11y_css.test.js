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
