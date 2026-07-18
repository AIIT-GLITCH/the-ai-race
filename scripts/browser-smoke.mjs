import { mkdir } from 'node:fs/promises';
import playwright, { chromeExecutable } from './playwright-loader.mjs';

const url = process.env.GAME_URL || 'http://127.0.0.1:8140/';
const browser = await playwright.chromium.launch({
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  headless: process.env.HEADFUL !== '1',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', error => errors.push(`page: ${error.message}`));
page.on('console', message => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
page.on('requestfailed', request => errors.push(`request: ${request.url()} — ${request.failure()?.errorText}`));
page.on('response', response => {
  if (response.status() >= 400) errors.push(`response: ${response.status()} ${response.url()}`);
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => Boolean(window.__aiRace), null, { timeout: 60_000 });
const initial = await page.evaluate(() => ({
  title: document.title,
  state: window.__aiRace.state(),
  track: window.__aiRace.track,
}));

await mkdir('.qa', { recursive: true });
await page.screenshot({ path: '.qa/menu.png' });
await page.click('#startBtn');
await page.evaluate(() => {
  window.__aiRace.testMode(true);
  window.__aiRace.skipCountdown();
  window.__aiRace.autopilot(true);
  window.__aiRace.step(2_200);
  window.__aiRace.renderOnce();
});
await page.screenshot({ path: '.qa/race.png' });
await page.evaluate(() => window.__aiRace.step(7_000));
const raced = await page.evaluate(() => window.__aiRace.state());

if (initial.state.phase !== 'menu') errors.push(`initial phase: ${initial.state.phase}`);
if (initial.state.ships.length !== 12) errors.push(`field size: ${initial.state.ships.length}`);
if (initial.track.length < 2_600) errors.push(`track too short: ${initial.track.length}`);
if (initial.track.halfWidth < 11) errors.push(`track too narrow: ${initial.track.halfWidth}`);
if (!raced.finished) errors.push('player did not complete the orbital sprint');
if (!raced.ships.every(ship => Number.isFinite(ship.speed))) errors.push('non-finite rival telemetry');
if (errors.length) {
  console.error(JSON.stringify({ initial, raced, errors }, null, 2));
  await browser.close();
  process.exit(1);
}

console.log(JSON.stringify({
  title: initial.title,
  track: initial.track,
  field: raced.ships.length,
  playerFinished: raced.finished,
  classificationFinished: raced.ships.filter(ship => ship.lap >= 1).length,
  errors,
  screenshots: ['.qa/menu.png', '.qa/race.png'],
}, null, 2));
await browser.close();
