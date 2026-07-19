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
await page.click('[data-difficulty="apex"]');
await page.click('[data-driver="sam"]');
const setup = await page.evaluate(() => ({
  state: window.__aiRace.state(),
  difficulty: window.__aiRace.difficulty(),
  driver: window.__aiRace.driver(),
  status: document.querySelector('#setupStatus')?.textContent,
  startLabel: document.querySelector('#startBtn')?.textContent,
}));

await mkdir('.qa', { recursive: true });
await page.screenshot({ path: '.qa/menu.png' });
await page.waitForFunction(
  () => window.__aiRace.raceControl().audioCache.decoded >= 2,
  null,
  { timeout: 3_000 },
);
const menuNarratorCache = await page.evaluate(() => window.__aiRace.raceControl().audioCache);
await page.click('#startBtn');
await page.waitForFunction(
  () => window.__aiRace.raceControl().audioCache.decodedStarts >= 1,
  null,
  { timeout: 10_000 },
);
const criticalNarratorStartLatencyMs = await page.evaluate(
  () => window.__aiRace.raceControl().audioCache.lastDecodedStartLatencyMs,
);
await page.evaluate(() => {
  window.__aiRace.testMode(true);
  window.__aiRace.skipCountdown();
  window.__aiRace.autopilot(true);
  window.__aiRace.step(2_200);
  window.__aiRace.renderOnce();
});
await page.screenshot({ path: '.qa/race.png' });
await page.evaluate(() => window.__aiRace.step(7_000));
await page.waitForFunction(
  () => window.__aiRace.raceControl().history.some(call => call.kind === 'finish'),
  null,
  { timeout: 10_000 },
);
const raced = await page.evaluate(() => {
  window.__aiRace.showResults();
  const caption = document.querySelector('#raceControl');
  const style = getComputedStyle(caption);
  return {
    ...window.__aiRace.state(),
    audioCache: window.__aiRace.raceControl().audioCache,
    driver: window.__aiRace.driver(),
    results: {
      subtitle: document.querySelector('#resultsSub')?.textContent || '',
      meta: document.querySelector('#resultsMeta')?.textContent || '',
      driver: document.querySelector('#resultDriver')?.textContent || '',
      protocol: document.querySelector('#resultDifficulty')?.textContent || '',
      playerRow: document.querySelector('tr.you')?.textContent || '',
    },
    finishCaption: {
      live: caption.classList.contains('live'),
      visible: style.visibility !== 'hidden' && Number(style.opacity) > 0,
      aboveResults: Number.parseInt(style.zIndex, 10) > 30,
      text: caption.querySelector('[data-race-control-copy]')?.textContent || '',
    },
  };
});
await page.screenshot({ path: '.qa/results.png' });

if (initial.state.phase !== 'menu') errors.push(`initial phase: ${initial.state.phase}`);
if (initial.state.difficulty !== 'pro' || initial.state.driver !== 'pilot') {
  errors.push(`unexpected default setup: ${initial.state.difficulty}/${initial.state.driver}`);
}
if (setup.state.difficulty !== 'apex' || setup.state.driver !== 'sam') {
  errors.push(`setup selection failed: ${JSON.stringify(setup)}`);
}
if (setup.driver.badgeName !== 'PLAYER_DRIVER_BADGE' || !setup.driver.badgeVisible) {
  errors.push(`driver badge missing: ${JSON.stringify(setup.driver)}`);
}
if (!/APEX/.test(setup.status) || !/SAM ALTMAN/.test(setup.status) || !/sam/i.test(setup.startLabel)) {
  errors.push(`setup presentation failed: ${JSON.stringify(setup)}`);
}
if (initial.state.ships.length !== 12) errors.push(`field size: ${initial.state.ships.length}`);
if (initial.track.length < 2_600) errors.push(`track too short: ${initial.track.length}`);
if (initial.track.halfWidth < 11) errors.push(`track too narrow: ${initial.track.halfWidth}`);
if (!raced.finished) errors.push('player did not complete the orbital sprint');
if (!raced.ships.every(ship => Number.isFinite(ship.speed))) errors.push('non-finite rival telemetry');
if (raced.audioCache.decoded < 2 || raced.audioCache.fetches > 29) {
  errors.push(`narrator cache not warm: ${JSON.stringify(raced.audioCache)}`);
}
if (menuNarratorCache.decoded < 2) {
  errors.push(`critical narrator clips not predecoded in menu: ${JSON.stringify(menuNarratorCache)}`);
}
if (!Number.isFinite(criticalNarratorStartLatencyMs) || criticalNarratorStartLatencyMs > 100) {
  errors.push(`critical narrator start path too slow: ${criticalNarratorStartLatencyMs}ms`);
}
if (!/SAM ALTMAN/.test(raced.results.subtitle) ||
    !/APEX/.test(raced.results.meta) ||
    !/UNOFFICIAL TRIBUTE/.test(raced.results.meta) ||
    raced.results.driver !== 'SAM ALTMAN' ||
    raced.results.protocol !== 'APEX' ||
    !/OPENAI \/ SAM ALTMAN/.test(raced.results.playerRow)) {
  errors.push(`identity-aware results failed: ${JSON.stringify(raced.results)}`);
}
if (!raced.finishCaption.live || !raced.finishCaption.visible || !raced.finishCaption.aboveResults) {
  errors.push(`finish caption hidden at results boundary: ${JSON.stringify(raced.finishCaption)}`);
}
if (!/HELIOS|Compute claimed/i.test(raced.finishCaption.text)) {
  errors.push(`finish caption missing classification: ${raced.finishCaption.text}`);
}
if (errors.length) {
  console.error(JSON.stringify({ initial, setup, raced, errors }, null, 2));
  await browser.close();
  process.exit(1);
}

console.log(JSON.stringify({
  title: initial.title,
  track: initial.track,
  field: raced.ships.length,
  setup: `${setup.state.driver}/${setup.state.difficulty}`,
  criticalNarratorStartLatencyMs: Math.round(criticalNarratorStartLatencyMs),
  decodedNarratorClips: raced.audioCache.decoded,
  playerFinished: raced.finished,
  classificationFinished: raced.ships.filter(ship => ship.lap >= 1).length,
  errors,
  screenshots: ['.qa/menu.png', '.qa/race.png', '.qa/results.png'],
}, null, 2));
await browser.close();
