import assert from 'node:assert/strict';
import playwright, { chromeExecutable } from './playwright-loader.mjs';

const baseUrl = process.env.GAME_URL || 'http://127.0.0.1:8140/';
const browser = await playwright.chromium.launch({
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
  ],
});

async function openGame(query = {}) {
  const context = await browser.newContext({
    viewport: { width: 960, height: 540 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
  });
  const url = new URL(baseUrl);
  url.searchParams.set('quality', 'balanced');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  await page.goto(url.href, { waitUntil: 'networkidle', timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__aiRace), null, { timeout: 90_000 });
  return { context, page };
}

const reports = [];
for (const difficulty of ['rookie', 'pro', 'apex']) {
  const { context, page } = await openGame({ difficulty });
  const report = await page.evaluate(() => {
    const race = window.__aiRace;
    race.testMode(true);
    race.skipCountdown();
    race.autopilot(true);
    race.step(1_800);
    const mid = race.state();
    const rivalProgress = mid.ships
      .filter(ship => ship.name !== 'OPENAI')
      .map(ship => ship.progress)
      .sort((a, b) => a - b);
    const medianRivalProgress = rivalProgress[Math.floor(rivalProgress.length / 2)];
    race.step(5_200);
    const finish = race.state();
    const snapshot = race.raceControlSnapshot();
    const classification = snapshot.order.map(ship => ({
      name: ship.name,
      finishTime: ship.finishTime,
    }));
    return {
      difficulty: finish.difficulty,
      medianRivalProgress,
      playerRank: snapshot.player.rank,
      playerFinished: finish.finished,
      classificationFinished: finish.ships.filter(ship => ship.lap >= 1).length,
      finishTime: snapshot.order.find(ship => ship.name === 'OPENAI')?.finishTime,
      leader: classification[0],
      topThree: classification.slice(0, 3),
    };
  });
  reports.push(report);
  await context.close();
}

assert.equal(reports[0].difficulty, 'rookie');
assert.equal(reports[1].difficulty, 'pro');
assert.equal(reports[2].difficulty, 'apex');
assert.ok(
  reports[1].medianRivalProgress - reports[0].medianRivalProgress >= 8,
  `Pro rival progress should exceed Rookie by at least 8m: ${JSON.stringify(reports)}`,
);
assert.ok(
  reports[2].medianRivalProgress - reports[1].medianRivalProgress >= 8,
  `Apex rival progress should exceed Pro by at least 8m: ${JSON.stringify(reports)}`,
);
for (const report of reports) {
  assert.equal(report.playerFinished, true, `${report.difficulty} player should finish`);
  assert.equal(report.classificationFinished, 12, `${report.difficulty} field should classify`);
  assert.ok(report.finishTime >= 38 && report.finishTime <= 52, `${report.difficulty} finish time is plausible`);
}
assert.equal(reports[0].playerRank, 1, 'Rookie reference drive should be a clear win');
assert.ok(reports[1].playerRank <= 3, 'Pro reference drive should remain podium-competitive');
assert.ok(
  reports[2].playerRank >= 3 && reports[2].playerRank > reports[1].playerRank,
  `Apex must produce a materially harder race outcome: ${JSON.stringify(reports)}`,
);
assert.notEqual(reports[2].leader.name, 'OPENAI', 'Apex reference drive must not be a guaranteed win');

const economy = [];
for (const difficulty of ['rookie', 'pro', 'apex']) {
  const { context, page } = await openGame({ difficulty });
  const report = await page.evaluate(() => {
    const race = window.__aiRace;
    race.testMode(true);
    race.skipCountdown();
    race.setInput({ throttle: 1, steer: 0, brake: 0, airbrake: 0, boost: 1 });
    race.step(60);
    return { difficulty: race.state().difficulty, boost: race.state().boost };
  });
  economy.push(report);
  await context.close();
}
assert.ok(economy[0].boost > economy[1].boost, `Rookie boost should drain slower: ${JSON.stringify(economy)}`);
assert.ok(economy[1].boost > economy[2].boost, `Apex boost should drain faster: ${JSON.stringify(economy)}`);

const impacts = [];
for (const difficulty of ['rookie', 'pro', 'apex']) {
  const { context, page } = await openGame({ difficulty });
  const report = await page.evaluate(() => {
    const race = window.__aiRace;
    race.testMode(true);
    race.skipCountdown();
    race.teleport(race.track.length * .12, 9.0, .35, 45);
    race.setInput({ throttle: 0, steer: 0, brake: 0, airbrake: 0, boost: 0 });
    race.step(45);
    return { difficulty: race.state().difficulty, shield: race.state().shield };
  });
  impacts.push(report);
  await context.close();
}
assert.ok(impacts[0].shield > impacts[1].shield, `Rookie contact should be more forgiving: ${JSON.stringify(impacts)}`);
assert.ok(impacts[1].shield > impacts[2].shield, `Apex contact should be harsher: ${JSON.stringify(impacts)}`);
assert.ok(impacts[2].shield > 40, `Apex contact must not be a one-hit failure: ${JSON.stringify(impacts)}`);

{
  const { context, page } = await openGame({ difficulty: 'not-a-mode' });
  assert.equal(await page.evaluate(() => window.__aiRace.state().difficulty), 'pro');
  await page.evaluate(() => window.__aiRace.setDifficulty('rookie', { persist: true }));
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => Boolean(window.__aiRace));
  // The invalid query remains present and must continue to fall back to the
  // newly persisted valid preference.
  assert.equal(await page.evaluate(() => window.__aiRace.state().difficulty), 'rookie');
  await context.close();
}

await browser.close();
console.log(JSON.stringify({ reports, economy, impacts }, null, 2));
