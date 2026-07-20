import assert from 'node:assert/strict';
import playwright, { chromeExecutable } from './playwright-loader.mjs';

const url = process.env.GAME_URL || 'http://127.0.0.1:8140/?showcase=1&autostart=1';
const browser = await playwright.chromium.launch({
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function patchedGetContext(type, ...args) {
      if (/^(?:webgl2?|experimental-webgl)$/.test(type)) return null;
      return original.call(this, type, ...args);
    };
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.__aiRace), null, { timeout: 60_000 });
  await page.waitForFunction(
    () => ['countdown', 'race'].includes(window.__aiRace.state().phase),
    null,
    { timeout: 10_000 },
  );

  const automatic = await page.evaluate(() => ({
    phase: window.__aiRace.state().phase,
    graphics: window.__aiRace.graphics(),
    driver: window.__aiRace.driver(),
    difficulty: window.__aiRace.difficulty(),
    bodyClass: document.body.classList.contains('graphics-fallback'),
  }));
  assert.equal(automatic.graphics.fallback, true);
  assert.equal(automatic.bodyClass, true);
  assert.equal(automatic.driver.id, 'sam');
  assert.equal(automatic.difficulty.id, 'pro');

  await page.goto(new URL('/', url).href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.__aiRace), null, { timeout: 60_000 });
  await page.click('[data-difficulty="apex"]');
  await page.click('[data-driver="sam"]');
  const selected = await page.evaluate(() => window.__aiRace.state());
  assert.equal(selected.difficulty, 'apex');
  assert.equal(selected.driver, 'sam');
  await page.click('#startBtn');
  await page.waitForFunction(
    () => ['countdown', 'race'].includes(window.__aiRace.state().phase),
    null,
    { timeout: 10_000 },
  );
  console.log(JSON.stringify({ automatic, clickPhase: await page.evaluate(() => window.__aiRace.state().phase) }, null, 2));
} finally {
  await browser.close();
}
