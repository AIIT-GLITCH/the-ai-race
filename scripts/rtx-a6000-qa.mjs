import { mkdir } from 'node:fs/promises';
import playwright, { chromeExecutable } from './playwright-loader.mjs';

const baseUrl = process.env.GAME_URL || 'http://127.0.0.1:8140/';
const hardware = process.env.SOFTWARE_QA !== '1';
const browser = await playwright.chromium.launch({
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  headless: !hardware,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    ...(hardware ? [
      '--use-gl=angle',
      '--use-angle=gl',
      '--ozone-platform=x11',
    ] : []),
  ],
});

await mkdir('.qa/rtx-a6000', { recursive: true });
const context = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(`page: ${error.message}`));
page.on('console', message => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
page.on('requestfailed', request => {
  errors.push(`request: ${request.url()} — ${request.failure()?.errorText}`);
});

await page.addInitScript(() => {
  window.requestAnimationFrame = () => 0;
  window.cancelAnimationFrame = () => {};
});
const target = new URL(baseUrl);
target.searchParams.set('quality', 'ultra');
await page.goto(target.href, { waitUntil: 'networkidle', timeout: 90_000 });
await page.waitForFunction(() => Boolean(window.__aiRace), null, { timeout: 90_000 });
await page.click('#startBtn');
await page.evaluate(() => {
  const race = window.__aiRace;
  race.testMode(true);
  race.skipCountdown();
});

const shots = [
  ['compute-array', .065],
  ['earthside', .18],
  ['lunar-relay', .405],
  ['radiance-array', .645],
  ['final-approach', .94],
];
const screenshots = [];
const LAUNCH_DRAW_CALL_BUDGET = 280;
const COURSE_DRAW_CALL_BUDGET = 220;
await page.evaluate(() => {
  window.__aiRace.renderOnce();
  window.__aiRace.renderOnce();
});
await page.waitForTimeout(80);
const launchGraphics = await page.evaluate(() => window.__aiRace.graphics());
for (const [label, progress] of shots) {
  await page.evaluate(({ progress }) => {
    const race = window.__aiRace;
    race.teleport(race.track.length * progress, 0, 0, 205);
    race.renderOnce();
    race.renderOnce();
  }, { progress });
  await page.waitForTimeout(80);
  const path = `.qa/rtx-a6000/${label}.png`;
  await page.screenshot({ path });
  screenshots.push(path);
}

const graphics = await page.evaluate(() => window.__aiRace.graphics());
await browser.close();

if (hardware && (!/NVIDIA|RTX A6000/i.test(graphics.gpu) || graphics.software)) {
  errors.push(`hardware WebGL unavailable: ${graphics.gpu}`);
}
if (launchGraphics.calls <= 0 || launchGraphics.calls > LAUNCH_DRAW_CALL_BUDGET) {
  errors.push(`launch draw calls out of budget: ${launchGraphics.calls}`);
}
if (graphics.calls <= 0 || graphics.calls > COURSE_DRAW_CALL_BUDGET) {
  errors.push(`course draw calls out of budget: ${graphics.calls}`);
}
if (graphics.width * graphics.height > 3_700_000 * 1.02) {
  errors.push(`ULTRA pixel budget exceeded: ${graphics.width}x${graphics.height}`);
}

const result = { launchGraphics, graphics, screenshots, errors };
console.log(JSON.stringify(result, null, 2));
if (errors.length) process.exit(1);
