import { chromium } from 'playwright-core';

const url = process.env.RACE_URL ||
  'http://127.0.0.1:8140/?showcase=1&driver=sam&difficulty=pro&contract=sprint';
const browser = await chromium.launch({
  headless: false,
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: [
    '--window-position=0,0',
    '--window-size=1920,1080',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-infobars',
  ],
});

const page = await browser.newPage({ viewport: null });
page.on('console', message => {
  if (message.type() === 'error') console.error(`[browser] ${message.text()}`);
});
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__aiRace?.state?.().driver === 'sam');
console.log('READY: Sam Altman / Pro / Sprint');

// Leave a clean opening title/setup beat for the edit before launch.
await page.waitForTimeout(Number(process.env.OPENING_MS || 8_000));
await page.locator('#startBtn').click();
await page.waitForFunction(() => ['countdown', 'race'].includes(window.__aiRace?.state?.().phase));
await page.evaluate(() => {
  if (window.__aiRace.state().muted) document.querySelector('#muteBtn')?.click();
});
await page.evaluate(() => window.__aiRace.autopilot(true));
const audio = await page.evaluate(() => window.__aiRace.audio());
console.log(`RACING: game AI is driving Sam // audio=${JSON.stringify(audio)}`);

await page.waitForFunction(
  () => window.__aiRace?.state?.().phase === 'results',
  null,
  { timeout: Number(process.env.RACE_TIMEOUT_MS || 150_000) },
);
const result = await page.evaluate(() => {
  const state = window.__aiRace.state();
  return {
    driver: state.driver,
    finishTime: state.finishTime,
    classification: [...document.querySelectorAll('#results tbody tr')]
      .slice(0, 3)
      .map(row => row.textContent.trim().replace(/\s+/g, ' ')),
  };
});
console.log(`FINISHED: ${JSON.stringify(result)}`);
await page.waitForTimeout(Number(process.env.RESULTS_MS || 30_000));
await browser.close();
