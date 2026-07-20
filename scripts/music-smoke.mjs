import assert from 'node:assert/strict';
import playwright, { chromeExecutable } from './playwright-loader.mjs';

const browser = await playwright.chromium.launch({
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', error => errors.push(`page: ${error.message}`));
page.on('requestfailed', request => errors.push(`request: ${request.url()} — ${request.failure()?.errorText}`));
page.on('response', response => {
  if (response.status() >= 400) errors.push(`response: ${response.status()} ${response.url()}`);
});

await page.goto(process.env.GAME_URL || 'http://127.0.0.1:8140/', {
  waitUntil: 'networkidle',
  timeout: 60_000,
});
await page.waitForFunction(() => Boolean(window.__aiRace), null, { timeout: 60_000 });
await page.click('#startBtn');
await page.evaluate(() => window.__aiRace.skipCountdown());
await page.waitForTimeout(650);
const launched = await page.evaluate(() => window.__aiRace.audio());
assert.equal(launched.musicPlaying, true, 'soundtrack starts from the launch gesture');
assert.ok(launched.music > .005, `soundtrack bus is audible: ${JSON.stringify(launched)}`);

await page.keyboard.press('p');
await page.waitForTimeout(100);
const paused = await page.evaluate(() => window.__aiRace.audio());
assert.equal(paused.musicPlaying, false, 'soundtrack pauses with the race');

await page.keyboard.press('p');
await page.waitForTimeout(200);
const resumed = await page.evaluate(() => window.__aiRace.audio());
assert.equal(resumed.musicPlaying, true, 'soundtrack resumes with the race');

await page.keyboard.press('m');
await page.waitForTimeout(180);
const muted = await page.evaluate(() => window.__aiRace.audio());
assert.ok(muted.music < .005, `mute closes the music bus: ${JSON.stringify(muted)}`);

await page.keyboard.press('m');
await page.evaluate(() => window.__aiRace.showResults());
await page.waitForTimeout(1_050);
const results = await page.evaluate(() => window.__aiRace.audio());
assert.equal(results.musicPlaying, false, 'soundtrack fades out and stops at results');
assert.deepEqual(errors, [], `music browser errors:\n${errors.join('\n')}`);

console.log(JSON.stringify({ launched, paused, resumed, muted, results, errors }, null, 2));
await browser.close();
