import { mkdir } from 'node:fs/promises';
import playwright, { chromeExecutable } from './playwright-loader.mjs';

const url = process.env.GAME_URL || 'http://127.0.0.1:8140/';
const browser = await playwright.chromium.launch({
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  headless: true,
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(`page: ${error.message}`));
page.on('response', response => {
  if (response.status() >= 400) errors.push(`response: ${response.status()} ${response.url()}`);
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => Boolean(window.__aiRace), null, { timeout: 60_000 });
await mkdir('.qa', { recursive: true });
await page.screenshot({ path: '.qa/mobile-menu.png' });
await page.click('#startBtn');
await page.evaluate(() => {
  window.__aiRace.testMode(true);
  window.__aiRace.skipCountdown();
  document.querySelector('#tg').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  window.__aiRace.step(420);
  document.querySelector('#tg').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  document.querySelector('#tboost').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  window.__aiRace.step(90);
  document.querySelector('#tboost').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  window.__aiRace.renderOnce();
});
const result = await page.evaluate(() => ({
  state: window.__aiRace.state(),
  touchDisplay: getComputedStyle(document.querySelector('#touch')).display,
  width: innerWidth,
  bodyWidth: document.body.scrollWidth,
}));
await page.screenshot({ path: '.qa/mobile-race.png' });

if (result.touchDisplay !== 'block') errors.push(`touch display: ${result.touchDisplay}`);
if (result.bodyWidth !== result.width) errors.push(`horizontal overflow: ${result.bodyWidth}/${result.width}`);
if (result.state.speed < 5) errors.push(`touch throttle failed: ${result.state.speed}`);
if (result.state.boost >= 18) errors.push(`touch burst failed to drain charge: ${result.state.boost}`);
if (errors.length) {
  console.error(JSON.stringify({ result, errors }, null, 2));
  await browser.close();
  process.exit(1);
}
console.log(JSON.stringify({
  viewport: `${result.width}x844`,
  speed: result.state.speed.toFixed(1),
  boost: result.state.boost.toFixed(1),
  errors,
  screenshots: ['.qa/mobile-menu.png', '.qa/mobile-race.png'],
}, null, 2));
await browser.close();
