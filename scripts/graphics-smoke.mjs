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
const LAUNCH_DRAW_CALL_BUDGET = 280;
const COURSE_DRAW_CALL_BUDGET = 220;

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
  const launchGraphics = await page.evaluate(async () => {
    const race = window.__aiRace;
    race.testMode(true);
    race.skipCountdown();
    let graphics = race.graphics();
    for (let frame = 0; frame < 10; frame++) {
      race.renderOnce();
      graphics = race.graphics();
      if (graphics.triangles >= 10_000) break;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    return graphics;
  });
  const graphics = await page.evaluate(async () => {
    const race = window.__aiRace;
    race.teleport(race.track.length * 0.12, 0, 0, 185);
    // Parallel shader compilation can need several event-loop turns on a
    // fresh or contended software context. Measure only after the complete
    // scene has rendered, retaining a hard geometry assertion below.
    let graphics = race.graphics();
    for (let frame = 0; frame < 10; frame++) {
      race.renderOnce();
      graphics = race.graphics();
      if (graphics.triangles >= 10_000) break;
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    graphics.gateSafety = [1, 2].map(index => {
      const gate = race.scene.getObjectByName(`LUNAR_SLINGSHOT_GATE_${index}`);
      if (!gate) return null;
      const normal = new race.THREE.Vector3(0, 0, 1)
        .applyQuaternion(gate.getWorldQuaternion(new race.THREE.Quaternion()))
        .normalize();
      const tangent = new race.THREE.Vector3(
        ...race.frameAt(race.track.length * gate.userData.trackFraction).t,
      ).normalize();
      const glow = gate.parent.children.find(object =>
        object !== gate &&
        object.isMesh &&
        object.geometry?.type === 'TorusGeometry' &&
        Math.abs(object.geometry.parameters.radius - (gate.geometry.parameters.radius - 1)) < .001
      );
      return {
        alignment: Math.abs(normal.dot(tangent)),
        radius: gate.geometry.parameters.radius,
        depthTest: glow?.material?.depthTest === true,
      };
    });
    const station = race.scene.getObjectByName('HELIOS_STATION');
    if (station) {
      const trackPoint = new race.THREE.Vector3(
        ...race.frameAt(race.track.length * station.userData.trackFraction).p,
      );
      graphics.heliosApertureClear = station.children
        .filter(object => object.name.startsWith('HELIOS_RACK_'))
        .every(rack => new race.THREE.Box3().setFromObject(rack).distanceToPoint(trackPoint) > 2);
    } else {
      graphics.heliosApertureClear = false;
    }
    return graphics;
  });
  await page.screenshot({ path: `.qa/graphics-${expected.query}.png` });

  if (graphics.profile !== expected.name) {
    pageErrors.push(`profile mismatch: ${graphics.profile} !== ${expected.name}`);
  }
  if (graphics.width * graphics.height > expected.pixelBudget * 1.02) {
    pageErrors.push(`pixel budget exceeded: ${graphics.width}x${graphics.height}`);
  }
  if (launchGraphics.calls <= 0 || launchGraphics.calls > LAUNCH_DRAW_CALL_BUDGET) {
    pageErrors.push(`launch draw calls out of budget: ${launchGraphics.calls}`);
  }
  if (graphics.calls <= 0 || graphics.calls > COURSE_DRAW_CALL_BUDGET) {
    pageErrors.push(`course draw calls out of budget: ${graphics.calls}`);
  }
  if (!Number.isFinite(graphics.triangles) || graphics.triangles < 10_000) {
    pageErrors.push(`invalid triangle count: ${graphics.triangles}`);
  }
  if (graphics.gateSafety.some(gate => gate === null || gate.alignment < .999)) {
    pageErrors.push(`track gate alignment invalid: ${JSON.stringify(graphics.gateSafety)}`);
  }
  if (graphics.gateSafety.some(gate => gate && (gate.radius > 20 || !gate.depthTest))) {
    pageErrors.push(`track gate visual safety invalid: ${JSON.stringify(graphics.gateSafety)}`);
  }
  if (!graphics.heliosApertureClear) {
    pageErrors.push('HELIOS racing aperture is obstructed');
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

  results.push({ ...graphics, launch: launchGraphics, errors: pageErrors });
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
