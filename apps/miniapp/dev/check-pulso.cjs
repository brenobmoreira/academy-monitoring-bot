'use strict';
/**
 * Optional visual check, with an ALREADY installed Playwright (no project dependency).
 * Serve the repo root on 127.0.0.1:8765, then:
 *   node apps/miniapp/dev/check-pulso.cjs <absolute path to existing playwright module> [msedge|chrome]
 * Screenshots stay in dev/shots/; Telegram's SDK is stubbed and nothing is sent to a real bot.
 */
const { chromium } = require(process.argv[2] || 'playwright');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const shots = path.join(__dirname, 'shots');
const base = 'http://127.0.0.1:8765/apps/miniapp/';

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const browser = await chromium.launch({ headless: true, channel: process.argv[3] || undefined });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', hasTouch: true, isMobile: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('https://telegram.org/**', (route) => route.fulfill({ body: '' }));
    await page.clock.install();
    for (const scheme of ['light', 'dark']) {
      await page.goto(base + 'dev/pulso-demo.html?scheme=' + scheme);
      await page.screenshot({ path: path.join(shots, 'pulso-moods-' + scheme + '.png'), fullPage: true, animations: 'disabled' });
    }
    await page.goto(base);
    await page.locator('.card').first().waitFor();
    await page.screenshot({ path: path.join(shots, 'pulso-intro.png'), animations: 'disabled' });
    await page.clock.fastForward(1600);
    await page.evaluate(() => document.getAnimations().filter((a) => a.id.indexOf('pl-intro') === 0).forEach((a) => a.finish()));
    await page.locator('.pl-intro').waitFor({ state: 'detached' });
    const pulso = page.getByRole('button', { name: 'Pulso: toque para uma dica' });
    const fields = page.locator('.card').first().locator('.step-input');
    await fields.nth(0).fill('62,5');
    await fields.nth(1).fill('8');
    assert.match(await page.locator('#say').textContent(), /\+2,5 kg/);
    const formTop = await page.locator('#view').evaluate((el) => el.getBoundingClientRect().top);
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.screenshot({ path: path.join(shots, 'pulso-workout-' + scheme + '.png'), fullPage: true, animations: 'disabled' });
    }
    await pulso.tap();
    assert.equal(await fields.nth(1).evaluate((el) => document.activeElement === el), true, 'touch keeps the input focused');
    assert.match(await page.locator('#say').textContent(), /última vez/);
    assert.equal(await page.locator('#view').evaluate((el) => el.getBoundingClientRect().top), formTop, 'bubble causes no layout shift');
    await pulso.focus();
    await pulso.press('Enter');
    assert.match(await page.locator('#say').textContent(), /Faltam/);
    await pulso.press('Space');
    assert.match(await page.locator('#say').textContent(), /Depois de/);
    await fields.nth(0).focus();
    assert.notEqual(await page.locator('#shape .pl-gaze').evaluate((el) => el.style.transform), 'translate(0px, 0px)');
    await page.clock.fastForward(45000);
    assert.equal(await pulso.getAttribute('data-dozing'), 'true');
    await page.screenshot({ path: path.join(shots, 'pulso-dozing.png'), animations: 'disabled' });
    assert.equal(await page.locator('#shape .pl-sleep').evaluate((el) => getComputedStyle(el).display), 'inline');
    assert.equal(await page.locator('#shape .pl-eyes').evaluate((el) => getComputedStyle(el).opacity), '0');
    await fields.nth(0).fill('65');
    assert.equal(await pulso.getAttribute('data-dozing'), 'false');
    await fields.nth(0).fill('');
    await page.locator('#dock-primary').click();
    assert.equal(await pulso.getAttribute('data-state'), 'alert');
    assert.match(await page.locator('#say').textContent(), /kg: obrigatório/);
    assert.notEqual(await page.locator('#shape .pl-gaze').evaluate((el) => el.style.transform), 'translate(0px, 0px)');
    await page.screenshot({ path: path.join(shots, 'pulso-error.png'), animations: 'disabled' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const running = await page.locator('#shape').evaluate((el) => {
      ShapeAvatar.pulse('celebrate');
      return el.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length;
    });
    assert.equal(running, 0, 'reduced motion stops CSS and Web Animations');
    await pulso.click();
    assert.ok(await page.locator('#say').textContent());
    await page.locator('#tab-food').click();
    await page.getByRole('radio', { name: 'Almoço', exact: true }).click();
    await page.getByRole('button', { name: 'Sem cálculo', exact: true }).click();
    await page.getByRole('textbox', { name: 'Descrição do item', exact: true }).fill('pastel de feira');
    await page.getByRole('button', { name: 'Pôr no prato', exact: true }).click();
    await page.locator('#dock-primary').click();
    await page.clock.fastForward(400);
    await page.locator('#review').waitFor({ state: 'visible' });
    assert.match(await page.locator('.mascot-scene').textContent(), /1 item nesta refeição/);
    await page.screenshot({ path: path.join(shots, 'pulso-review-dark.png'), fullPage: true, animations: 'disabled' });
    assert.equal(await page.locator('.mascot-scene .shape').getAttribute('aria-hidden'), 'true');
    assert.equal(await pulso.getAttribute('aria-hidden'), null);
    // Inspect the handoff with a local SDK stub. The real bot is never involved.
    const handoff = await context.newPage();
    await handoff.emulateMedia({ reducedMotion: 'reduce' });
    handoff.on('pageerror', (e) => errors.push(e.message));
    await handoff.route('https://telegram.org/**', (route) => route.fulfill({
      contentType: 'application/javascript',
      body: `window.Telegram = { WebApp: {
        platform: 'android', colorScheme: 'dark', ready: function(){}, expand: function(){}, onEvent: function(){},
        isVersionAtLeast: function(){ return false; },
        MainButton: { onClick: function(fn){ window.demoMain = fn; }, setParams: function(){}, show: function(){}, hide: function(){}, enable: function(){}, disable: function(){} },
        BackButton: { onClick: function(){}, show: function(){}, hide: function(){} },
        sendData: function(json){ window.demoSent = JSON.parse(json); }
      } };`,
    }));
    const catalog = fs.readFileSync(path.join(__dirname, 'sample-catalog.json'));
    const blob = zlib.deflateRawSync(catalog).toString('base64url');
    await handoff.goto(base + '#v=food&c=' + blob);
    await handoff.locator('.plate-item').waitFor();
    await handoff.evaluate(() => window.demoMain());
    await handoff.locator('#review').waitFor({ state: 'visible' });
    await handoff.evaluate(() => window.demoMain());
    assert.match(await handoff.locator('.mascot-scene').textContent(), /Envio solicitado.*1 item nesta refeição/);
    assert.equal(await handoff.evaluate(() => window.demoSent.args.items.length), 1);
    await handoff.screenshot({ path: path.join(shots, 'pulso-handoff-stub.png'), fullPage: true, animations: 'disabled' });
    await handoff.close();
    assert.deepEqual(errors, []);
    console.log('Browser checks passed: phone 390px, all moods 32/40/112px, light/dark, keyboard, focus, no layout shift, gains, gaze, errors, 45s sleep/wake, reduced motion, meal review and stubbed Telegram handoff.');
    console.log('Screenshots: ' + shots);
    await context.close();
  } finally { await browser.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
