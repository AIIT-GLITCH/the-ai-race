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
      playerShield: finish.shield,
      playerCleanRun: finish.cleanRun,
      rivalSlingshots: finish.ships
        .filter(ship => ship.name !== 'OPENAI')
        .reduce((total, ship) => total + (ship.slingshots || 0), 0),
      rivalSlingshotters: finish.ships
        .filter(ship => ship.name !== 'OPENAI' && ship.slingshots > 0)
        .map(ship => ship.name),
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
assert.ok(
  reports[1].rivalSlingshots >= 1,
  `Seeded Pro AI should earn and fire at least one rival slingshot: ${JSON.stringify(reports[1])}`,
);

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

const gameplayIntegrity = {};
{
  const { context, page } = await openGame({ difficulty: 'pro' });
  Object.assign(gameplayIntegrity, await page.evaluate(() => {
    const race = window.__aiRace;
    const input = boost => ({
      throttle: 1,
      steer: 0,
      brake: 0,
      airbrake: 0,
      boost,
    });
    const beginRun = () => {
      race.reset();
      race.skipCountdown();
      race.autopilot(false);
      race.setInput(input(0));
      race.step(2);
    };

    // Capture the exact simulation step that creates disruption. Comparing
    // adjacent frames distinguishes an intentional energy spill from ordinary
    // continuous burst drain without tying the test to a particular balance
    // constant.
    beginRun();
    race.setInput(input(1));
    race.step(3);
    race.teleport(
      race.track.length * .12,
      race.track.halfWidth - 1.25,
      .72,
      76,
    );
    let previous = race.state();
    let wallImpact = null;
    for (let frame = 1; frame <= 90; frame++) {
      race.step(1);
      const current = race.state();
      if (current.boostLockout > 0 && previous.boostLockout <= 0) {
        wallImpact = {
          frame,
          boostBefore: previous.boost,
          boostAfter: current.boost,
          spill: previous.boost - current.boost,
          boosting: current.boosting,
          lockout: current.boostLockout,
          damageCooldown: current.damageCooldown,
          cleanRun: current.cleanRun,
        };
        break;
      }
      previous = current;
    }

    // Repeated separated impacts guarantee an actual limp state without a
    // privileged shield setter. Keep boost held throughout and observe every
    // frame, so a transient limp+boost overlap cannot hide in the final state.
    beginRun();
    race.setInput(input(1));
    let limpState = null;
    let limpBoostObserved = false;
    let impactAttempts = 0;
    for (; impactAttempts < 20 && !limpState; impactAttempts++) {
      const s = race.track.length * (.14 + impactAttempts * .002);
      race.teleport(s, 0, 0, 70);
      race.step(2);
      race.teleport(s, race.track.halfWidth - 1.22, .92, 92);
      for (let frame = 0; frame < 55; frame++) {
        race.step(1);
        const current = race.state();
        if (current.limp && current.boosting) limpBoostObserved = true;
        if (current.limp) {
          limpState = {
            shield: current.shield,
            boost: current.boost,
            boosting: current.boosting,
            lockout: current.boostLockout,
            damageCooldown: current.damageCooldown,
          };
          break;
        }
      }
    }
    if (limpState) {
      for (let frame = 0; frame < 30; frame++) {
        race.step(1);
        const current = race.state();
        if (current.limp && current.boosting) limpBoostObserved = true;
      }
    }

    // The former dominant strategy was to hold thrust+boost, never steer, and
    // let the wall guide the ship to a win. Run that exact input through a
    // complete Pro classification and preserve the result for comparison with
    // the clean reference drive above.
    beginRun();
    race.setInput(input(1));
    race.step(8_000);
    const wallRiderState = race.state();
    const wallRiderSnapshot = race.raceControlSnapshot();
    const wallRider = {
      finished: wallRiderState.finished,
      finishTime: wallRiderState.finishTime,
      rank: wallRiderSnapshot.player.rank,
      shield: wallRiderState.shield,
      cleanRun: wallRiderState.cleanRun,
    };

    return { wallImpact, limpState, limpBoostObserved, impactAttempts, wallRider };
  }));
  await context.close();
}

assert.ok(gameplayIntegrity.wallImpact, 'A meaningful wall strike should create disruption');
assert.equal(
  gameplayIntegrity.wallImpact.boosting,
  false,
  `Wall disruption must cancel active boost: ${JSON.stringify(gameplayIntegrity.wallImpact)}`,
);
assert.ok(
  gameplayIntegrity.wallImpact.lockout > 0,
  `Wall disruption must create boost lockout: ${JSON.stringify(gameplayIntegrity.wallImpact)}`,
);
assert.ok(
  gameplayIntegrity.wallImpact.damageCooldown > 0,
  `Wall disruption must defer shield regeneration: ${JSON.stringify(gameplayIntegrity.wallImpact)}`,
);
assert.ok(
  gameplayIntegrity.wallImpact.spill > 2,
  `Wall disruption must spill substantially more than one frame of ordinary boost drain: ${JSON.stringify(gameplayIntegrity.wallImpact)}`,
);
assert.equal(
  gameplayIntegrity.wallImpact.cleanRun,
  false,
  `Meaningful wall disruption must invalidate a clean run: ${JSON.stringify(gameplayIntegrity.wallImpact)}`,
);
assert.ok(
  gameplayIntegrity.limpState,
  `Repeated meaningful impacts should be able to produce limp mode: ${JSON.stringify(gameplayIntegrity)}`,
);
assert.equal(
  gameplayIntegrity.limpBoostObserved,
  false,
  `A limp ship must never remain in boost: ${JSON.stringify(gameplayIntegrity)}`,
);
assert.equal(
  gameplayIntegrity.limpState.boosting,
  false,
  `Limp state must suppress boost even while the input remains held: ${JSON.stringify(gameplayIntegrity.limpState)}`,
);
assert.notEqual(
  gameplayIntegrity.wallRider.rank,
  1,
  `Zero-steer wall riding must not win Pro: ${JSON.stringify(gameplayIntegrity.wallRider)}`,
);
assert.ok(
  !gameplayIntegrity.wallRider.finished ||
    gameplayIntegrity.wallRider.finishTime > reports[1].finishTime + 1.2,
  `Zero-steer wall riding must lose meaningful time to a clean Pro reference: ${JSON.stringify({
    wallRider: gameplayIntegrity.wallRider,
    cleanReference: reports[1].finishTime,
  })}`,
);

const slingshotBehavior = {};
{
  const { context, page } = await openGame({ difficulty: 'pro' });
  Object.assign(slingshotBehavior, await page.evaluate(() => {
    const race = window.__aiRace;
    const input = boost => ({
      throttle: 1,
      steer: 0,
      brake: 0,
      airbrake: 0,
      boost,
    });
    const beginRun = () => {
      race.reset();
      race.skipCountdown();
      race.autopilot(false);
      race.setInput(input(0));
      race.teleport(race.track.length * .21, 0, 0, 52);
      race.step(2);
    };

    beginRun();
    const beforeArm = race.state();
    race.armSlingshot();
    const armed = race.state();
    race.setInput(input(1));
    race.step(1);
    const fired = race.state();
    let maxSerialWhileHeld = fired.slingshotSerial;
    let maxCountWhileHeld = fired.slingshots;
    for (let frame = 0; frame < 120; frame++) {
      race.step(1);
      const current = race.state();
      maxSerialWhileHeld = Math.max(maxSerialWhileHeld, current.slingshotSerial);
      maxCountWhileHeld = Math.max(maxCountWhileHeld, current.slingshots);
    }
    const held = race.state();

    const speedTrial = armedTrial => {
      beginRun();
      const start = race.state();
      if (armedTrial) race.armSlingshot();
      race.setInput(input(1));
      race.step(24);
      const finish = race.state();
      return {
        startSpeed: start.speed,
        finishSpeed: finish.speed,
        delta: finish.speed - start.speed,
        slingshots: finish.slingshots,
        slingshotSerial: finish.slingshotSerial,
      };
    };

    const ordinary = speedTrial(false);
    const slingshot = speedTrial(true);
    return {
      beforeArm: {
        ready: beforeArm.slingshotReady,
        serial: beforeArm.slingshotSerial,
        count: beforeArm.slingshots,
      },
      armed: {
        ready: armed.slingshotReady,
        serial: armed.slingshotSerial,
        count: armed.slingshots,
      },
      fired: {
        ready: fired.slingshotReady,
        timer: fired.slingshotT,
        serial: fired.slingshotSerial,
        count: fired.slingshots,
      },
      held: {
        serial: held.slingshotSerial,
        count: held.slingshots,
        maxSerial: maxSerialWhileHeld,
        maxCount: maxCountWhileHeld,
      },
      ordinary,
      slingshot,
    };
  }));
  await context.close();
}

assert.equal(slingshotBehavior.beforeArm.ready, false, 'A fresh run should not start armed');
assert.equal(slingshotBehavior.armed.ready, true, 'armSlingshot() should arm the next fresh press');
assert.equal(
  slingshotBehavior.fired.serial,
  slingshotBehavior.beforeArm.serial + 1,
  `A fresh boost press should fire exactly one slingshot: ${JSON.stringify(slingshotBehavior)}`,
);
assert.equal(
  slingshotBehavior.fired.count,
  slingshotBehavior.beforeArm.count + 1,
  `A fired slingshot should increment the run count once: ${JSON.stringify(slingshotBehavior)}`,
);
assert.ok(
  slingshotBehavior.fired.timer > 0,
  `A fired slingshot should expose an active attack window: ${JSON.stringify(slingshotBehavior.fired)}`,
);
assert.equal(slingshotBehavior.fired.ready, false, 'Firing should consume slingshot readiness');
assert.equal(
  slingshotBehavior.held.maxSerial,
  slingshotBehavior.fired.serial,
  `Holding boost must not retrigger slingshots: ${JSON.stringify(slingshotBehavior.held)}`,
);
assert.equal(
  slingshotBehavior.held.maxCount,
  slingshotBehavior.fired.count,
  `Holding boost must not increment the slingshot count repeatedly: ${JSON.stringify(slingshotBehavior.held)}`,
);
assert.ok(
  slingshotBehavior.slingshot.delta > slingshotBehavior.ordinary.delta + .2,
  `Slingshot acceleration should materially exceed ordinary boost over the same interval: ${JSON.stringify({
    ordinary: slingshotBehavior.ordinary,
    slingshot: slingshotBehavior.slingshot,
  })}`,
);

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
console.log(JSON.stringify({
  reports,
  economy,
  impacts,
  gameplayIntegrity,
  slingshotBehavior,
}, null, 2));
