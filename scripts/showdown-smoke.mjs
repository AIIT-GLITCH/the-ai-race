import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import playwright, { chromeExecutable } from './playwright-loader.mjs';

const baseUrl = process.env.GAME_URL || 'http://127.0.0.1:8140/';
const browser = await playwright.chromium.launch({
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  headless: process.env.HEADFUL !== '1',
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
  ],
});

const browserErrors = [];
let pageSerial = 0;

async function openGame(query = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const label = `page-${++pageSerial}`;
  page.on('pageerror', error => browserErrors.push(`${label} page: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') browserErrors.push(`${label} console: ${message.text()}`);
  });
  page.on('requestfailed', request => {
    browserErrors.push(`${label} request: ${request.url()} — ${request.failure()?.errorText}`);
  });
  page.on('response', response => {
    if (response.status() >= 400) {
      browserErrors.push(`${label} response: ${response.status()} ${response.url()}`);
    }
  });
  // Simulation and presentation are advanced exclusively through __aiRace.
  // That keeps this suite deterministic on fast desktops and throttled CI.
  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
  });
  const url = new URL(baseUrl);
  url.searchParams.set('quality', 'balanced');
  url.searchParams.set('seed', '47018');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  await page.goto(url.href, { waitUntil: 'networkidle', timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__aiRace), null, { timeout: 90_000 });
  return { context, page };
}

function assertNear(actual, expected, epsilon, message) {
  assert.ok(
    Number.isFinite(actual) && Math.abs(actual - expected) <= epsilon,
    `${message}: expected ${expected} ± ${epsilon}, got ${actual}`,
  );
}

const hookNames = [
  'showcase',
  'showdown',
  'tickPresentation',
  'ghost',
  'sectorDeltas',
  'contracts',
  'forceFinish',
];

// Stable markup and API contracts are release gates. A renamed selector or
// missing seam should fail with a targeted message instead of timing out later.
{
  const { context, page } = await openGame();
  const contract = await page.evaluate(names => {
    const race = window.__aiRace;
    return {
      hooks: Object.fromEntries(names.map(name => [name, typeof race[name]])),
      api: race.contracts(),
      contractButtons: [...document.querySelectorAll('#contractSelect [data-contract]')].map(button => ({
        id: button.dataset.contract,
        pressed: button.getAttribute('aria-pressed'),
        text: button.textContent.trim(),
      })),
      sectors: [...document.querySelectorAll('#sectorBreakdownList [data-sector-code]')].map(item => ({
        code: item.dataset.sectorCode,
        hasTime: Boolean(item.querySelector('[data-sector-time]')),
        hasDelta: Boolean(item.querySelector('[data-sector-delta]')),
      })),
      pbButton: {
        exists: Boolean(document.querySelector('#racePbBtn')),
        disabled: document.querySelector('#racePbBtn')?.disabled,
      },
      ghost: {
        available: document.querySelector('#ghostDelta')?.dataset.available,
        status: document.querySelector('#ghostDelta')?.dataset.status,
      },
    };
  }, hookNames);

  for (const name of hookNames) {
    assert.equal(contract.hooks[name], 'function', `__aiRace.${name} must be a function`);
  }
  const expectedIds = ['sprint', 'full-payload', 'clean-uplink', 'slingshot-master'];
  assert.deepEqual(
    contract.contractButtons.map(button => button.id),
    expectedIds,
    'menu and engine use the same four canonical contract IDs',
  );
  assert.deepEqual(
    contract.api.items.map(item => item.id),
    expectedIds,
    'contract API preserves the canonical menu order',
  );
  assert.equal(contract.api.selected, 'sprint');
  assert.deepEqual(
    Object.fromEntries(contract.api.items.map(item => [item.id, item.target])),
    {
      sprint: 1,
      'full-payload': 8,
      'clean-uplink': 1,
      'slingshot-master': 2,
    },
    'contract targets match the player-facing copy',
  );
  assert.equal(contract.contractButtons.filter(button => button.pressed === 'true').length, 1);
  assert.deepEqual(contract.sectors.map(sector => sector.code), ['01', '02', '03', '04', '05', '06']);
  assert.ok(contract.sectors.every(sector => sector.hasTime && sector.hasDelta));
  assert.deepEqual(contract.pbButton, { exists: true, disabled: true });
  assert.deepEqual(contract.ghost, { available: 'false', status: 'neutral' });

  for (const id of expectedIds) {
    await page.click(`#contractSelect [data-contract="${id}"]`);
    const selected = await page.evaluate(() => ({
      api: window.__aiRace.contracts().selected,
      body: document.body.dataset.contract,
      pressed: [...document.querySelectorAll('#contractSelect [data-contract][aria-pressed="true"]')]
        .map(button => button.dataset.contract),
    }));
    assert.equal(selected.api, id, `${id} selects through the public contract model`);
    assert.equal(selected.body, id, `${id} updates the presentation state`);
    assert.deepEqual(selected.pressed, [id], `${id} is the only pressed contract option`);
  }
  await context.close();
}

// Every mission contract evaluates against the final race state and paints one
// unambiguous result. The helper supplies state, not a precomputed outcome.
{
  const { context, page } = await openGame();
  const cases = [
    { id: 'sprint', finish: { rank: 1, time: 42, packets: 0, cleanRun: false, slingshots: 0 } },
    { id: 'full-payload', finish: { rank: 4, time: 42, packets: 8, cleanRun: false, slingshots: 0 } },
    { id: 'clean-uplink', finish: { rank: 4, time: 42, packets: 0, cleanRun: true, slingshots: 0 } },
    { id: 'slingshot-master', finish: { rank: 4, time: 42, packets: 0, cleanRun: false, slingshots: 2 } },
  ];
  for (const testCase of cases) {
    const result = await page.evaluate(({ id, finish }) => {
      const race = window.__aiRace;
      race.setContract(id);
      race.testMode(true);
      race.reset();
      race.skipCountdown();
      race.forceFinish(finish);
      race.showResults();
      const snapshot = race.contracts();
      return {
        selected: snapshot.selected,
        result: snapshot.result,
        dom: {
          name: document.querySelector('#resultContractName')?.textContent,
          status: document.querySelector('#resultContractStatus')?.textContent,
          progress: document.querySelector('#resultContractProgress')?.textContent,
          state: document.querySelector('#resultContract')?.dataset.status,
          stinger: document.querySelector('#resultsStinger')?.textContent,
        },
      };
    }, testCase);
    assert.equal(result.selected, testCase.id);
    assert.equal(result.result.id, testCase.id);
    assert.equal(result.result.completed, true, `${testCase.id} should complete at its exact target`);
    assert.equal(result.dom.state, 'complete');
    assert.match(result.dom.status, /COMPLETE/);
    assert.match(result.dom.stinger, /CONTRACT SECURED/);
    assert.ok(result.dom.name && result.dom.progress);
  }

  const miss = await page.evaluate(() => {
    const race = window.__aiRace;
    race.setContract('full-payload');
    race.reset();
    race.skipCountdown();
    race.forceFinish({ rank: 1, time: 42, packets: 7, cleanRun: true, slingshots: 2 });
    race.showResults();
    return {
      result: race.contracts().result,
      state: document.querySelector('#resultContract')?.dataset.status,
      status: document.querySelector('#resultContractStatus')?.textContent,
      progress: document.querySelector('#resultContractProgress')?.textContent,
    };
  });
  assert.equal(miss.result.completed, false, 'seven of eight cores cannot complete Full Payload');
  assert.equal(miss.state, 'failed');
  assert.match(miss.status, /FAILED/);
  assert.match(miss.progress, /7 \/ 8/);
  await context.close();
}

// Force a precise 0.18-second win, then sample semantic stages. No assertion
// depends on speech duration or requestAnimationFrame cadence.
let showdownReport;
{
  const { context, page } = await openGame();
  showdownReport = await page.evaluate(() => {
    const race = window.__aiRace;
    race.setDifficulty('rookie');
    race.setContract('sprint');
    race.testMode(true);
    race.skipCountdown();
    const finish = race.forceFinish({
      rank: 1,
      time: 42,
      packets: 8,
      cleanRun: true,
      slingshots: 2,
    });
    const samples = [{ at: 0, ...race.showdown() }];
    let at = 0;
    for (const dt of [.2, .4, 1.7, 1.3, 2, 2.1]) {
      at += dt;
      samples.push({ at, ...race.tickPresentation(dt) });
    }
    race.renderOnce();
    const history = race.raceControl().history.filter(item =>
      item.kind === 'claim' || item.kind === 'finish');
    return { finish, samples, history };
  });

  assert.deepEqual(
    showdownReport.samples.map(sample => sample.stage),
    ['handshake', 'handshake', 'cascade', 'claimed', 'beam', 'hero', 'complete'],
    'HELIOS presentation advances through all six semantic stages in order',
  );
  const initial = showdownReport.samples[0];
  const claimed = showdownReport.samples.find(sample => sample.stage === 'claimed');
  const beam = showdownReport.samples.find(sample => sample.stage === 'beam');
  const complete = showdownReport.samples.at(-1);
  assert.equal(initial.active, true);
  assert.equal(initial.winner, 'OPENAI');
  assert.equal(initial.rank, 1);
  assertNear(initial.margin, .18, 1e-9, 'forced finish margin');
  assert.equal(initial.duration, 7.6);
  assert.ok(claimed.stationClaimed, 'station ownership locks during the claimed stage');
  assert.ok(claimed.bannerOpacity > .9, 'claim banner is fully visible before beam ignition');
  assert.ok(beam.beamActive && beam.beamOpacity > .1, 'Earthward beam visibly ignites');
  assert.ok(beam.beaconIntensity > claimed.beaconIntensity, 'beam stage materially lifts beacon energy');
  assert.ok(complete.elapsed >= 7.6 && complete.elapsed < 8, 'payoff lasts the promised ~7.6 seconds');
  assert.equal(complete.stage, 'complete');
  assert.equal(complete.stationClaimed, true);
  assert.equal(complete.beamActive, true);
  assert.equal(complete.accent, '#dfff47');
  assert.equal(complete.ringColor, '#dfff47');

  const exactClaims = showdownReport.history.filter(item => item.kind === 'claim');
  assert.equal(exactClaims.length, 1, 'the forced classification produces one exact claim');
  assert.equal(exactClaims[0].text, 'HELIOS online. OpenAI wins by 0.18 seconds.');
  assertNear(exactClaims[0].meta.margin, .18, 1e-9, 'narrator margin metadata');
  assert.equal(exactClaims[0].meta.rival, 'ANTHROPIC');
  await mkdir('.qa', { recursive: true });
  // Restage the beam moment with small deterministic camera steps so the
  // screenshot reviews the station takeover rather than the later ship hero.
  await page.evaluate(() => {
    const race = window.__aiRace;
    race.reset();
    race.skipCountdown();
    race.forceFinish({
      rank: 1,
      time: 42,
      packets: 8,
      cleanRun: true,
      slingshots: 2,
    });
    for (let i = 0; i < 36; i++) race.tickPresentation(.1);
    race.renderOnce();
  });
  await page.screenshot({ path: '.qa/helios-showdown.png' });
  await context.close();
}

// Record a real seeded lap, race it again, and deliberately wait two seconds.
// The ghost and sector model must report the delay numerically and in the HUD.
let replayReport;
{
  const { context, page } = await openGame();
  const firstRun = await page.evaluate(() => {
    const race = window.__aiRace;
    race.setDifficulty('rookie');
    race.setContract('sprint');
    race.testMode(true);
    race.skipCountdown();
    race.autopilot(true);
    race.step(7_200);
    race.renderOnce();
    const state = race.state();
    race.showResults();
    return {
      state,
      ghost: race.ghost(),
      sectors: race.sectorDeltas(),
      contracts: race.contracts(),
      pbButton: {
        disabled: document.querySelector('#racePbBtn')?.disabled,
        available: document.querySelector('#racePbBtn')?.dataset.available,
      },
      resultsMeta: document.querySelector('#resultsMeta')?.textContent,
    };
  });
  assert.equal(firstRun.state.finished, true, 'seeded Rookie reference lap must finish');
  assert.equal(firstRun.contracts.result.completed, true, 'reference lap secures Sprint');
  assert.equal(firstRun.ghost.available, true, 'completed PB becomes MODEL N-1');
  assert.ok(firstRun.ghost.sampleCount >= 100, 'MODEL N-1 contains a useful sampled trajectory');
  assertNear(firstRun.ghost.bestTime, firstRun.state.finishTime, .001, 'stored ghost time');
  assert.deepEqual(firstRun.pbButton, { disabled: false, available: 'true' });
  assert.match(firstRun.resultsMeta, /NEW MODEL N-1/);
  assert.equal(firstRun.sectors.length, 6);
  assert.ok(firstRun.sectors.every(sector => Number.isFinite(sector.current)));

  await page.click('#racePbBtn');
  const replayStart = await page.evaluate(() => ({
    phase: window.__aiRace.state().phase,
    ghost: window.__aiRace.ghost(),
  }));
  assert.equal(replayStart.phase, 'countdown');
  assert.equal(replayStart.ghost.available, true);
  assert.equal(replayStart.ghost.active, true);
  assert.equal(replayStart.ghost.sampleCount, firstRun.ghost.sampleCount);

  replayReport = await page.evaluate(() => {
    const race = window.__aiRace;
    race.skipCountdown();
    race.autopilot(false);
    race.setInput({ steer: 0, throttle: 0, brake: 0, airbrake: 0, boost: 0 });
    race.step(240);
    race.renderOnce();
    const afterDelay = {
      ghost: race.ghost(),
      hud: {
        available: document.querySelector('#ghostDelta')?.dataset.available,
        status: document.querySelector('#ghostDelta')?.dataset.status,
        value: document.querySelector('#ghostDeltaValue')?.textContent,
      },
    };
    race.autopilot(true);
    race.step(1_800);
    race.renderOnce();
    const midRace = {
      state: race.state(),
      ghost: race.ghost(),
      sectors: race.sectorDeltas(),
      hud: {
        status: document.querySelector('#ghostDelta')?.dataset.status,
        value: document.querySelector('#ghostDeltaValue')?.textContent,
        sector: document.querySelector('#ghostSectorLabel')?.textContent,
      },
    };
    race.step(6_000);
    race.renderOnce();
    const finish = race.state();
    race.showResults();
    return {
      afterDelay,
      midRace,
      finish,
      ghost: race.ghost(),
      sectors: race.sectorDeltas(),
      results: {
        meta: document.querySelector('#resultsMeta')?.textContent,
        total: document.querySelector('#resultPbDelta')?.textContent,
        rows: [...document.querySelectorAll('#sectorBreakdownList [data-sector-code]')].map(item => ({
          code: item.dataset.sectorCode,
          status: item.dataset.status,
          time: item.querySelector('[data-sector-time]')?.textContent,
          delta: item.querySelector('[data-sector-delta]')?.textContent,
        })),
      },
    };
  });

  assert.equal(replayReport.afterDelay.hud.available, 'true');
  assert.equal(replayReport.afterDelay.hud.status, 'behind');
  assert.match(replayReport.afterDelay.hud.value, /^\+\d+\.\d{2}$/);
  assert.ok(replayReport.afterDelay.ghost.currentDelta > 1.8);
  assert.equal(replayReport.midRace.ghost.active, true);
  assert.equal(replayReport.midRace.hud.status, 'behind');
  assert.match(replayReport.midRace.hud.sector, /LOSING/);
  const liveSplits = replayReport.midRace.sectors.filter(sector => Number.isFinite(sector.delta));
  assert.ok(liveSplits.length >= 1, 'at least one sector split resolves during the replay');
  assert.ok(
    liveSplits.some(sector => sector.delta > .5 && sector.status === 'behind'),
    'the deliberate hold is reflected as a red/behind sector delta',
  );
  assert.equal(replayReport.finish.finished, true);
  assert.match(replayReport.results.meta, /PB /);
  assert.doesNotMatch(replayReport.results.meta, /NEW MODEL N-1/);
  assert.match(replayReport.results.total, /^\+\d+\.\d{2} TOTAL$/);
  assert.deepEqual(
    replayReport.results.rows.map(row => row.code),
    ['01', '02', '03', '04', '05', '06'],
  );
  assert.ok(replayReport.results.rows.every(row => row.time !== '—' && row.delta !== 'FIRST'));
  assert.ok(replayReport.results.rows.some(row => row.status === 'behind' && /^\+/.test(row.delta)));
  await page.screenshot({ path: '.qa/model-n1-results.png' });
  await context.close();
}

// Showcase mode is isolated from real PB data and can optionally stage the
// near-finish showdown automatically for hands-off judging.
let showcaseReport;
{
  const menu = await openGame({ showcase: '1' });
  const menuReport = await menu.page.evaluate(() => ({
    mode: window.__aiRace.showcase(),
    state: window.__aiRace.state(),
    driver: window.__aiRace.driver(),
    ghost: window.__aiRace.ghost(),
    start: document.querySelector('#startBtn')?.textContent,
  }));
  assert.deepEqual(menuReport.mode, { enabled: true, autoStart: false });
  assert.equal(menuReport.state.phase, 'menu');
  assert.equal(menuReport.state.showcase, true);
  assert.equal(menuReport.driver.id, 'sam');
  assert.equal(menuReport.ghost.available, false);
  assert.match(menuReport.start, /HELIOS showdown/i);
  await menu.context.close();

  const automatic = await openGame({ showcase: '1', autostart: '1' });
  await automatic.page.waitForFunction(
    () => window.__aiRace.state().phase !== 'menu',
    null,
    { timeout: 5_000 },
  );
  showcaseReport = await automatic.page.evaluate(() => ({
    mode: window.__aiRace.showcase(),
    state: window.__aiRace.state(),
    ghost: window.__aiRace.ghost(),
    track: window.__aiRace.track,
  }));
  assert.deepEqual(showcaseReport.mode, { enabled: true, autoStart: true });
  assert.equal(showcaseReport.state.phase, 'countdown');
  assert.ok(
    showcaseReport.state.progress >= showcaseReport.track.length * .82,
    'autostart stages the field on final approach',
  );
  assert.equal(showcaseReport.state.slingshotReady, true);
  assert.equal(showcaseReport.state.drafting, true);
  assert.equal(showcaseReport.state.draftTarget, 'ANTHROPIC');
  assert.equal(showcaseReport.ghost.available, false, 'showcase never reads a personal ghost');
  await automatic.context.close();
}

assert.deepEqual(browserErrors, [], `browser errors:\n${browserErrors.join('\n')}`);

console.log(JSON.stringify({
  showdown: {
    stages: showdownReport.samples.map(sample => `${sample.stage}@${sample.at.toFixed(1)}s`),
    margin: showdownReport.samples[0].margin,
    claim: showdownReport.history.find(item => item.kind === 'claim')?.text,
  },
  replay: {
    initialDelay: replayReport.afterDelay.ghost.currentDelta,
    resolvedSectors: replayReport.sectors.length,
    total: replayReport.results.total,
  },
  showcase: {
    autostart: showcaseReport.mode.autoStart,
    progress: Math.round(showcaseReport.state.progress),
  },
  screenshots: ['.qa/helios-showdown.png', '.qa/model-n1-results.png'],
  errors: browserErrors,
}, null, 2));

await browser.close();
