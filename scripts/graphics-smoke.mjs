import { mkdir } from 'node:fs/promises';
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

await mkdir('.qa', { recursive: true });
const profiles = [
  { query: 'balanced', name: 'BALANCED', pixelBudget: 900_000 },
  { query: 'high', name: 'HIGH', pixelBudget: 2_400_000 },
  { query: 'ultra', name: 'ULTRA', pixelBudget: 3_700_000 },
];
const results = [];
const errors = [];

for (const expected of profiles) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(`page: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') pageErrors.push(`console: ${message.text()}`);
  });
  page.on('requestfailed', request => pageErrors.push(`request: ${request.url()} — ${request.failure()?.errorText}`));
  page.on('response', response => {
    if (response.status() >= 400) pageErrors.push(`response: ${response.status()} ${response.url()}`);
  });

  // A deterministic frame seam keeps software WebGL CI bounded while still
  // compiling every material and executing the complete render graph.
  await page.addInitScript(() => {
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
  });
  const target = new URL(baseUrl);
  target.searchParams.set('quality', expected.query);
  await page.goto(target.href, { waitUntil: 'networkidle', timeout: 90_000 });
  await page.waitForFunction(() => Boolean(window.__aiRace), null, { timeout: 90_000 });
  await page.click('#startBtn');
  const graphics = await page.evaluate(() => {
    const race = window.__aiRace;
    race.testMode(true);
    race.skipCountdown();
    race.teleport(race.track.length * 0.12, 0, 0, 185);
    race.renderOnce();
    const graphics = race.graphics();
    graphics.gateAlignment = [1, 2].map(index => {
      const gate = race.scene.getObjectByName(`LUNAR_SLINGSHOT_GATE_${index}`);
      if (!gate) return null;
      const normal = new race.THREE.Vector3(0, 0, 1)
        .applyQuaternion(gate.getWorldQuaternion(new race.THREE.Quaternion()))
        .normalize();
      const tangent = new race.THREE.Vector3(
        ...race.frameAt(race.track.length * gate.userData.trackFraction).t,
      ).normalize();
      return Math.abs(normal.dot(tangent));
    });
    return graphics;
  });
  await page.screenshot({ path: `.qa/graphics-${expected.query}.png` });

  if (graphics.profile !== expected.name) {
    pageErrors.push(`profile mismatch: ${graphics.profile} !== ${expected.name}`);
  }
  if (graphics.width * graphics.height > expected.pixelBudget * 1.02) {
    pageErrors.push(`pixel budget exceeded: ${graphics.width}x${graphics.height}`);
  }
  if (graphics.calls <= 0 || graphics.calls > 220) {
    pageErrors.push(`scene draw calls out of budget: ${graphics.calls}`);
  }
  if (!Number.isFinite(graphics.triangles) || graphics.triangles < 10_000) {
    pageErrors.push(`invalid triangle count: ${graphics.triangles}`);
  }
  if (graphics.gateAlignment.some(value => value === null || value < .999)) {
    pageErrors.push(`track gate alignment invalid: ${graphics.gateAlignment.join(', ')}`);
  }

  if (expected.name === 'ULTRA') {
    const setPieces = [
      ['earth', 0.18],
      ['lunar', 0.38],
      ['helios', 0.965],
    ];
    for (const [label, progress] of setPieces) {
      await page.evaluate(({ progress }) => {
        const race = window.__aiRace;
        race.teleport(race.track.length * progress, 0, 0, 210);
        race.renderOnce();
      }, { progress });
      await page.screenshot({ path: `.qa/ultra-${label}-final.png` });
    }
  }

  results.push({ ...graphics, errors: pageErrors });
  errors.push(...pageErrors.map(error => `${expected.name}: ${error}`));
  await context.close();
}

await browser.close();
if (errors.length) {
  console.error(JSON.stringify({ results, errors }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  profiles: results,
  screenshots: [
    '.qa/graphics-balanced.png',
    '.qa/graphics-high.png',
    '.qa/graphics-ultra.png',
    '.qa/ultra-earth-final.png',
    '.qa/ultra-lunar-final.png',
    '.qa/ultra-helios-final.png',
  ],
}, null, 2));
