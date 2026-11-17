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
