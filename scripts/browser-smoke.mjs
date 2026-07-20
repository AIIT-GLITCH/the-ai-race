import { mkdir } from 'node:fs/promises';
import playwright, { chromeExecutable } from './playwright-loader.mjs';
import { DEFAULT_RACE_CONTROL_CLIPS } from '../race-control.js';

const narratorSourceCount = new Set(
  Object.values(DEFAULT_RACE_CONTROL_CLIPS).map(descriptor => descriptor.src),
).size;

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
const slingshot = await page.evaluate(() => {
  const race = window.__aiRace;
  const feedback = selector => {
    const element = document.querySelector(selector);
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      text: element.textContent || '',
      classes: [...element.classList],
      visible: style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0,
      rect: {
        top: bounds.top,
        bottom: bounds.bottom,
        left: bounds.left,
        right: bounds.right,
      },
    };
  };

  race.testMode(true);
  race.skipCountdown();
  race.autopilot(false);
  race.setInput({ steer: 0, throttle: 0, brake: 0, airbrake: 0, boost: 0 });
  race.teleport(race.track.length * .21, 0, 0, 60);
  race.step(2);
  const before = race.state();
  const armed = race.armSlingshot();
  race.renderOnce();
  const readyCue = feedback('#launchCue');

  race.setInput({ steer: 0, throttle: 1, brake: 0, airbrake: 0, boost: 1 });
  race.step(6);
  race.renderOnce();
  return {
    armed,
    beforeSerial: before.slingshotSerial,
    beforeCount: before.slingshots,
    attackSpeed: before.speed,
    state: race.state(),
    readyCue,
    activeCue: feedback('#launchCue'),
    moment: feedback('#momentStamp'),
  };
});
await page.waitForFunction(() => {
  const cue = document.querySelector('#launchCue');
  const stamp = document.querySelector('#momentStamp');
  return cue?.classList.contains('active') &&
    stamp?.classList.contains('live') &&
    Number(getComputedStyle(cue).opacity) > .8 &&
    Number(getComputedStyle(stamp).opacity) > .8;
}, null, { timeout: 2_000 });
Object.assign(slingshot, await page.evaluate(() => {
  const feedback = selector => {
    const element = document.querySelector(selector);
    const style = getComputedStyle(element);
    return {
      text: element.textContent || '',
      classes: [...element.classList],
      visible: style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > .8,
    };
  };
  return {
    activeCue: feedback('#launchCue'),
    moment: feedback('#momentStamp'),
  };
}));
await page.screenshot({ path: '.qa/slingshot.png' });
await page.evaluate(() => {
  window.__aiRace.setInput({ steer: 0, throttle: 0, brake: 0, airbrake: 0, boost: 0 });
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
      stinger: document.querySelector('#resultsStinger')?.textContent || '',
      slingshots: document.querySelector('#resultSlingshots')?.textContent || '',
      hasStinger: Boolean(document.querySelector('#resultsStinger')),
      hasSlingshotStat: Boolean(document.querySelector('.resultStat.slingshotStat')),
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
// Every authored full-line call plus one deduplicated compositional audio
// sprite may be fetched once; duplicate network work is a regression.
if (raced.audioCache.decoded < 2 || raced.audioCache.fetches > narratorSourceCount) {
  errors.push(`narrator cache not warm: ${JSON.stringify(raced.audioCache)}`);
}
if (menuNarratorCache.decoded < 2) {
  errors.push(`critical narrator clips not predecoded in menu: ${JSON.stringify(menuNarratorCache)}`);
}
if (!Number.isFinite(criticalNarratorStartLatencyMs) || criticalNarratorStartLatencyMs > 100) {
  errors.push(`critical narrator start path too slow: ${criticalNarratorStartLatencyMs}ms`);
}
if (!slingshot.armed ||
    slingshot.state.slingshotSerial !== slingshot.beforeSerial + 1 ||
    slingshot.state.slingshots !== slingshot.beforeCount + 1 ||
    slingshot.state.slingshotT <= 0 ||
    slingshot.attackSpeed < 55 ||
    slingshot.state.speed < 55) {
  errors.push(`slingshot did not fire exactly once: ${JSON.stringify(slingshot)}`);
}
if (!slingshot.readyCue.visible ||
    !slingshot.readyCue.classes.includes('ready') ||
    !/WAKE LOCKED/.test(slingshot.readyCue.text)) {
  errors.push(`slingshot ready cue missing: ${JSON.stringify(slingshot.readyCue)}`);
}
if (!slingshot.activeCue.visible ||
    !slingshot.activeCue.classes.includes('active') ||
    !/SLINGSHOT/.test(slingshot.activeCue.text) ||
    !slingshot.moment.visible ||
    !slingshot.moment.classes.includes('live') ||
    !/SLINGSHOT DEPLOYED/.test(slingshot.moment.text)) {
  errors.push(`slingshot feedback missing: ${JSON.stringify(slingshot)}`);
}
if (raced.results.subtitle.includes('SAM ALTMAN') ||
    !/^OPENAI (?:reached the HELIOS array first|classified P\d+ of \d+)$/.test(raced.results.subtitle) ||
    !raced.results.meta.startsWith('APEX // SPRINT // UNOFFICIAL TEXT-ONLY TRIBUTE // ') ||
    raced.results.driver !== 'SAM ALTMAN' ||
    raced.results.protocol !== 'APEX' ||
    !/OPENAI \/ SAM ALTMAN/.test(raced.results.playerRow)) {
  errors.push(`identity-aware results failed: ${JSON.stringify(raced.results)}`);
}
if (!raced.results.hasStinger ||
    !raced.results.hasSlingshotStat ||
    !/^CONTRACT (?:SECURED|MISSED) \/\/ P12 → P\d{2} \/\/ .+ \/\/ \d+ SLINGSHOTS/.test(raced.results.stinger) ||
    !/^\d+$/.test(raced.results.slingshots) ||
    Number(raced.results.slingshots) < 1) {
  errors.push(`results payoff missing: ${JSON.stringify(raced.results)}`);
}
if (!raced.finishCaption.live || !raced.finishCaption.visible || !raced.finishCaption.aboveResults) {
  errors.push(`finish caption hidden at results boundary: ${JSON.stringify(raced.finishCaption)}`);
}
if (!/HELIOS|Compute claimed/i.test(raced.finishCaption.text)) {
  errors.push(`finish caption missing classification: ${raced.finishCaption.text}`);
}
if (errors.length) {
  console.error(JSON.stringify({ initial, setup, slingshot, raced, errors }, null, 2));
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
  slingshots: Number(raced.results.slingshots),
  playerFinished: raced.finished,
  classificationFinished: raced.ships.filter(ship => ship.lap >= 1).length,
  errors,
  screenshots: ['.qa/menu.png', '.qa/slingshot.png', '.qa/race.png', '.qa/results.png'],
}, null, 2));
await browser.close();
