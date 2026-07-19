import { mkdir } from 'node:fs/promises';
import playwright, { chromeExecutable } from './playwright-loader.mjs';

const url = process.env.GAME_URL || 'http://127.0.0.1:8140/';
const browser = await playwright.chromium.launch({
  ...(chromeExecutable ? { executablePath: chromeExecutable } : {}),
  headless: true,
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(`page: ${error.message}`));
page.on('response', response => {
  if (response.status() >= 400) errors.push(`response: ${response.status()} ${response.url()}`);
});

await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await page.waitForFunction(() => Boolean(window.__aiRace), null, { timeout: 60_000 });
const mobileGraphics = await page.evaluate(() => ({
  ...window.__aiRace.graphics(),
  coarse: matchMedia('(pointer: coarse)').matches,
  memory: Number(navigator.deviceMemory || 8),
  cores: Number(navigator.hardwareConcurrency || 8),
  bodyProfile: document.body.dataset.renderProfile || '',
}));
const coarseProfileProbe = await page.evaluate(async () => {
  const { selectRenderProfile } = await import('./spectacle.js');
  const nativeMatchMedia = window.matchMedia;
  const memoryDescriptor = Object.getOwnPropertyDescriptor(navigator, 'deviceMemory');
  const coresDescriptor = Object.getOwnPropertyDescriptor(navigator, 'hardwareConcurrency');
  const debugInfo = { UNMASKED_RENDERER_WEBGL: 0x9246 };
  let testGpu = 'NVIDIA RTX A6000';
  const gl = {
    MAX_SAMPLES: 0x8d57,
    getExtension(name) {
      if (name === 'WEBGL_debug_renderer_info') return debugInfo;
      if (name === 'EXT_color_buffer_float') return {};
      return null;
    },
    getParameter(parameter) {
      if (parameter === debugInfo.UNMASKED_RENDERER_WEBGL) return testGpu;
      if (parameter === this.MAX_SAMPLES) return 8;
      return 0;
    },
  };
  const renderer = {
    getContext: () => gl,
    capabilities: { isWebGL2: true },
  };
  const choose = (coarse, gpu = 'NVIDIA RTX A6000') => {
    testGpu = gpu;
    window.matchMedia = query => ({
      matches: query === '(pointer: coarse)' ? coarse : false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    });
    return selectRenderProfile(renderer);
  };

  try {
    Object.defineProperty(navigator, 'deviceMemory', {
      configurable: true,
      value: 8,
    });
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      configurable: true,
      value: 8,
    });
    const s24 = choose(true, 'ANGLE (Qualcomm, Adreno (TM) 750, OpenGL ES 3.2)');
    return {
      fine: choose(false).name,
      coarse: choose(true).name,
      s24: {
        name: s24.name,
        mobileTuned: s24.mobileTuned,
        mobileTier: s24.mobileTier,
        post: s24.post,
        pixelRatio: s24.pixelRatio,
      },
    };
  } finally {
    window.matchMedia = nativeMatchMedia;
    if (memoryDescriptor) Object.defineProperty(navigator, 'deviceMemory', memoryDescriptor);
    else delete navigator.deviceMemory;
    if (coresDescriptor) Object.defineProperty(navigator, 'hardwareConcurrency', coresDescriptor);
    else delete navigator.hardwareConcurrency;
  }
});
await page.click('[data-difficulty="rookie"]');
await page.click('[data-driver="sam"]');
const menuLayout = await page.evaluate(() => ({
  optionHeights: [...document.querySelectorAll('.setupOption')].map(option => option.getBoundingClientRect().height),
  start: (() => {
    const rect = document.querySelector('#startBtn').getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: rect.height };
  })(),
  setup: window.__aiRace.state(),
}));
await mkdir('.qa', { recursive: true });
await page.screenshot({ path: '.qa/mobile-menu.png' });
await page.click('#startBtn');
const armed = await page.evaluate(() => {
  window.__aiRace.testMode(true);
  window.__aiRace.skipCountdown();
  window.__aiRace.renderOnce();
  return window.__aiRace.armSlingshot();
});
const beforeSlingshot = await page.evaluate(() => window.__aiRace.state());
await page.dispatchEvent('#tboost', 'pointerdown', {
  pointerId: 41,
  pointerType: 'touch',
  isPrimary: true,
  buttons: 1,
});
const slingshot = await page.evaluate(() => {
  window.__aiRace.step(1);
  window.__aiRace.renderOnce();
  return {
    state: window.__aiRace.state(),
    burstPressed: document.querySelector('#tboost').classList.contains('on'),
    width: innerWidth,
    height: innerHeight,
    bodyWidth: document.body.scrollWidth,
  };
});
await page.waitForFunction(() => {
  const cue = document.querySelector('#launchCue');
  const control = document.querySelector('#raceControl');
  const copy = control?.querySelector('[data-race-control-copy]');
  return cue?.classList.contains('active') &&
    Number(getComputedStyle(cue).opacity) > .8 &&
    control?.classList.contains('live') &&
    control?.dataset.kind === 'slingshotFire' &&
    /^Slingshot deployed\. OpenAI (?:attacks .+|is coming through)\.$/.test(
      copy?.textContent || '',
    ) &&
    Number(getComputedStyle(control).opacity) > .8;
}, null, { timeout: 2_000 });
// Let the legacy moment-stamp transition complete before proving that the
// mobile stylesheet actually suppresses it. Sampling in the class-add frame
// would mistake a not-yet-painted duplicate for an intentionally hidden one.
await page.waitForTimeout(240);
Object.assign(slingshot, await page.evaluate(() => {
  const measure = element => {
    if (!element) return { exists: false, painted: false };
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      exists: true,
      top: bounds.top,
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
      width: bounds.width,
      height: bounds.height,
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity),
      text: element.textContent || '',
      classes: [...element.classList],
      painted: style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > .05 &&
        bounds.width > 0 &&
        bounds.height > 0,
    };
  };
  const control = document.querySelector('#raceControl');
  const shell = control?.querySelector('.race-control-shell');
  const copy = control?.querySelector('[data-race-control-copy]');
  const narrator = {
    ...measure(control),
    kind: control?.dataset.kind || '',
    shell: measure(shell),
    copy: {
      ...measure(copy),
      count: control?.querySelectorAll('[data-race-control-copy]').length || 0,
      clientWidth: copy?.clientWidth || 0,
      scrollWidth: copy?.scrollWidth || 0,
    },
    reservedOverlaps: [],
  };
  const reserved = [
    '#missionBar',
    '#raceBox',
    '#muteBtn',
    '#telemetry',
    '#touch .tbtn',
  ];
  if (narrator.shell.painted) {
    const a = shell.getBoundingClientRect();
    narrator.reservedOverlaps = reserved.flatMap(selector =>
      [...document.querySelectorAll(selector)]
        .filter(element => measure(element).painted)
        .filter(element => {
          const b = element.getBoundingClientRect();
          return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
            Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
        })
        .map(element => element.id || element.getAttribute('aria-label') || selector)
    );
  }
  const moment = measure(document.querySelector('#momentStamp'));
  return {
    cue: measure(document.querySelector('#launchCue')),
    moment,
    narrator,
    narratorPresentations: [
      { id: 'raceControl', painted: narrator.painted },
      { id: 'momentStamp', painted: moment.painted },
    ],
    width: innerWidth,
    height: innerHeight,
    bodyWidth: document.body.scrollWidth,
  };
}));
await page.dispatchEvent('#tboost', 'pointerup', {
  pointerId: 41,
  pointerType: 'touch',
  isPrimary: true,
  buttons: 0,
});
await page.screenshot({ path: '.qa/mobile-slingshot.png' });
await page.dispatchEvent('#tg', 'pointerdown', {
  pointerId: 42,
  pointerType: 'touch',
  isPrimary: true,
  buttons: 1,
});
await page.evaluate(() => {
  window.__aiRace.step(420);
  window.__aiRace.renderOnce();
});
await page.dispatchEvent('#tg', 'pointerup', {
  pointerId: 42,
  pointerType: 'touch',
  isPrimary: true,
  buttons: 0,
});
const result = await page.evaluate(() => ({
  state: window.__aiRace.state(),
  touchDisplay: getComputedStyle(document.querySelector('#touch')).display,
  muteDisplay: getComputedStyle(document.querySelector('#muteBtn')).display,
  muteHeight: document.querySelector('#muteBtn').getBoundingClientRect().height,
  width: innerWidth,
  bodyWidth: document.body.scrollWidth,
}));
await page.screenshot({ path: '.qa/mobile-race.png' });
await page.evaluate(() => {
  window.__aiRace.autopilot(true);
  window.__aiRace.step(7_000);
  window.__aiRace.showResults();
  window.__aiRace.renderOnce();
});
const mobileResults = await page.evaluate(() => {
  const rect = element => {
    const bounds = element.getBoundingClientRect();
    return {
      top: bounds.top,
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
      width: bounds.width,
      height: bounds.height,
    };
  };
  const panel = document.querySelector('#results .panel');
  const tableWrap = document.querySelector('.resultsTableWrap');
  return {
    panel: rect(panel),
    actions: [...document.querySelectorAll('.resultsActions .btn')].map(rect),
    table: {
      ...rect(tableWrap),
      clientHeight: tableWrap.clientHeight,
      scrollHeight: tableWrap.scrollHeight,
    },
    mute: {
      ...rect(document.querySelector('#muteBtn')),
      display: getComputedStyle(document.querySelector('#muteBtn')).display,
      visibility: getComputedStyle(document.querySelector('#muteBtn')).visibility,
    },
    bodyWidth: document.body.scrollWidth,
    width: innerWidth,
  };
});
await page.click('#muteBtn');
const resultsMuteWorks = await page.evaluate(() => window.__aiRace.state().muted);
await page.click('#muteBtn');
await page.screenshot({ path: '.qa/mobile-results.png' });

if (result.touchDisplay !== 'block') errors.push(`touch display: ${result.touchDisplay}`);
if (result.muteDisplay === 'none' || result.muteHeight < 40) errors.push(`mobile mute target: ${result.muteDisplay}/${result.muteHeight}`);
if (menuLayout.optionHeights.some(height => height < 44)) {
  errors.push(`setup target below 44px: ${JSON.stringify(menuLayout.optionHeights)}`);
}
if (menuLayout.start.top < 0 || menuLayout.start.bottom > 844 || menuLayout.start.height < 44) {
  errors.push(`launch control clipped: ${JSON.stringify(menuLayout.start)}`);
}
if (menuLayout.setup.difficulty !== 'rookie' || menuLayout.setup.driver !== 'sam') {
  errors.push(`mobile setup failed: ${JSON.stringify(menuLayout.setup)}`);
}
if (!armed ||
    beforeSlingshot.slingshots !== 0 ||
    slingshot.state.slingshots !== 1 ||
    slingshot.state.slingshotSerial !== beforeSlingshot.slingshotSerial + 1 ||
    slingshot.state.slingshotT <= 0 ||
    !slingshot.burstPressed) {
  errors.push(`touch slingshot did not fire exactly once: ${JSON.stringify({ armed, beforeSlingshot, slingshot })}`);
}
if (!slingshot.cue.painted ||
    slingshot.cue.left < 0 ||
    slingshot.cue.right > slingshot.width ||
    slingshot.cue.top < 0 ||
    slingshot.cue.bottom > slingshot.height) {
  errors.push(`mobile slingshot cue unsafe: ${JSON.stringify(slingshot.cue)}`);
}
if (!slingshot.cue.classes.includes('active') ||
    !/SLINGSHOT/.test(slingshot.cue.text) ||
    slingshot.bodyWidth !== slingshot.width) {
  errors.push(`mobile slingshot feedback missing: ${JSON.stringify(slingshot)}`);
}
if (slingshot.moment.exists && slingshot.moment.painted) {
  errors.push(`redundant mobile moment stamp is visible: ${JSON.stringify(slingshot.moment)}`);
}
const visibleNarratorPresentations =
  slingshot.narratorPresentations.filter(presentation => presentation.painted);
if (visibleNarratorPresentations.length !== 1 ||
    visibleNarratorPresentations[0]?.id !== 'raceControl' ||
    slingshot.narrator.kind !== 'slingshotFire' ||
    slingshot.narrator.copy.count !== 1 ||
    !/^Slingshot deployed\. OpenAI (?:attacks .+|is coming through)\.$/.test(
      slingshot.narrator.copy.text,
    )) {
  errors.push(`mobile narrator is not canonical: ${JSON.stringify({
    presentations: slingshot.narratorPresentations,
    narrator: slingshot.narrator,
  })}`);
}
if (!slingshot.narrator.painted ||
    !slingshot.narrator.shell.painted ||
    slingshot.narrator.shell.left < 0 ||
    slingshot.narrator.shell.right > slingshot.width ||
    slingshot.narrator.shell.top < 0 ||
    slingshot.narrator.shell.bottom > slingshot.height ||
    slingshot.narrator.copy.scrollWidth > slingshot.narrator.copy.clientWidth + 1 ||
    slingshot.narrator.reservedOverlaps.length > 0) {
  errors.push(`mobile race control unsafe: ${JSON.stringify(slingshot.narrator)}`);
}
if (coarseProfileProbe.coarse !== coarseProfileProbe.fine) {
  errors.push(`coarse pointer changed render profile: ${JSON.stringify(coarseProfileProbe)}`);
}
if (coarseProfileProbe.s24.name !== 'HIGH' ||
    !coarseProfileProbe.s24.mobileTuned ||
    coarseProfileProbe.s24.mobileTier !== 'FLAGSHIP' ||
    !coarseProfileProbe.s24.post ||
    coarseProfileProbe.s24.pixelRatio < 1.45) {
  errors.push(`flagship mobile profile regressed: ${JSON.stringify(coarseProfileProbe.s24)}`);
}
if (mobileGraphics.coarse &&
    !mobileGraphics.software &&
    mobileGraphics.memory > 3 &&
    mobileGraphics.cores > 3 &&
    mobileGraphics.profile === 'BALANCED') {
  errors.push(`capable touch device was automatically downgraded: ${JSON.stringify(mobileGraphics)}`);
}
if (mobileGraphics.bodyProfile !== mobileGraphics.profile.toLowerCase()) {
  errors.push(`render profile marker mismatch: ${JSON.stringify(mobileGraphics)}`);
}
if (result.bodyWidth !== result.width) errors.push(`horizontal overflow: ${result.bodyWidth}/${result.width}`);
if (result.state.speed < 5) errors.push(`touch throttle failed: ${result.state.speed}`);
if (result.state.boost >= 18) errors.push(`touch burst failed to drain charge: ${result.state.boost}`);
if (mobileResults.panel.left < 0 || mobileResults.panel.right > mobileResults.width) {
  errors.push(`mobile results panel overflow: ${JSON.stringify(mobileResults.panel)}`);
}
if (mobileResults.actions.some(action =>
  action.top < 0 || action.bottom > 844 || action.height < 44)) {
  errors.push(`mobile results action clipped: ${JSON.stringify(mobileResults.actions)}`);
}
if (mobileResults.table.clientHeight > 212 ||
    mobileResults.table.scrollHeight <= mobileResults.table.clientHeight) {
  errors.push(`mobile classification scroller failed: ${JSON.stringify(mobileResults.table)}`);
}
if (mobileResults.bodyWidth !== mobileResults.width) {
  errors.push(`mobile results horizontal overflow: ${mobileResults.bodyWidth}/${mobileResults.width}`);
}
if (mobileResults.mute.display === 'none' ||
    mobileResults.mute.visibility !== 'visible' ||
    mobileResults.mute.height < 40 ||
    !resultsMuteWorks) {
  errors.push(`mobile results mute unavailable: ${JSON.stringify({ mute: mobileResults.mute, resultsMuteWorks })}`);
}

const landscapeContext = await browser.newContext({
  viewport: { width: 844, height: 390 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});
const landscapePage = await landscapeContext.newPage();
landscapePage.on('pageerror', error => errors.push(`landscape page: ${error.message}`));
await landscapePage.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await landscapePage.waitForFunction(() => Boolean(window.__aiRace), null, { timeout: 60_000 });
await landscapePage.click('[data-driver="sam"]');
const landscapeMenu = await landscapePage.evaluate(() => {
  const launch = document.querySelector('#startBtn').getBoundingClientRect();
  return {
    optionHeights: [...document.querySelectorAll('.setupOption')]
      .map(option => option.getBoundingClientRect().height),
    launch: { top: launch.top, bottom: launch.bottom, height: launch.height },
    width: innerWidth,
    bodyWidth: document.body.scrollWidth,
  };
});
await landscapePage.screenshot({ path: '.qa/mobile-landscape-menu.png' });
if (landscapeMenu.optionHeights.some(height => height < 44)) {
  errors.push(`landscape setup target below 44px: ${JSON.stringify(landscapeMenu.optionHeights)}`);
}
if (landscapeMenu.launch.top < 0 ||
    landscapeMenu.launch.bottom > 390 ||
    landscapeMenu.launch.height < 44) {
  errors.push(`landscape launch control clipped: ${JSON.stringify(landscapeMenu.launch)}`);
}
if (landscapeMenu.bodyWidth !== landscapeMenu.width) {
  errors.push(`landscape horizontal overflow: ${landscapeMenu.bodyWidth}/${landscapeMenu.width}`);
}
await landscapeContext.close();

// Match the usable CSS viewport measured on the physical Galaxy S24 in
// landscape. Its browser chrome leaves much less vertical room than a generic
// 844x390 emulation, which is exactly where telemetry used to clip off-screen.
const compactLandscapeContext = await browser.newContext({
  viewport: { width: 697, height: 274 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});
const compactLandscapePage = await compactLandscapeContext.newPage();
compactLandscapePage.on('pageerror', error => errors.push(`compact landscape page: ${error.message}`));
await compactLandscapePage.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
await compactLandscapePage.waitForFunction(() => Boolean(window.__aiRace), null, { timeout: 60_000 });
await compactLandscapePage.evaluate(() => {
  document.querySelector('#startBtn').click();
  window.__aiRace.testMode(true);
  window.__aiRace.skipCountdown();
  window.__aiRace.armSlingshot();
});
await compactLandscapePage.dispatchEvent('#tboost', 'pointerdown', {
  pointerId: 51,
  pointerType: 'touch',
  isPrimary: true,
  buttons: 1,
});
await compactLandscapePage.evaluate(() => {
  window.__aiRace.step(1);
  window.__aiRace.renderOnce();
});
await compactLandscapePage.waitForFunction(() =>
  document.querySelector('#raceControl')?.dataset.kind === 'slingshotFire'
);
await compactLandscapePage.waitForTimeout(240);
const compactLandscape = await compactLandscapePage.evaluate(() => {
  const selectors = {
    mission: '#missionBar',
    raceBox: '#raceBox',
    mute: '#muteBtn',
    cue: '#launchCue',
    moment: '#momentStamp',
    narrator: '#raceControl',
    telemetry: '#telemetry',
    drift: '#tdrift',
    burst: '#tboost',
    left: '#tl',
    right: '#tr',
    brake: '#tb',
    thrust: '#tg',
  };
  const items = Object.fromEntries(Object.entries(selectors).map(([name, selector]) => {
    const element = document.querySelector(selector);
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return [name, {
      top: bounds.top,
      bottom: bounds.bottom,
      left: bounds.left,
      right: bounds.right,
      width: bounds.width,
      height: bounds.height,
      display: style.display,
      visibility: style.visibility,
      opacity: Number(style.opacity),
    }];
  }));
  const painted = item => item.display !== 'none' &&
    item.visibility !== 'hidden' &&
    item.opacity > .05 &&
    item.width > 0 &&
    item.height > 0;
  const intersects = (a, b) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  const names = Object.keys(items).filter(name => painted(items[name]));
  const overlaps = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (intersects(items[names[i]], items[names[j]])) overlaps.push([names[i], names[j]]);
    }
  }
  const clipped = names.filter(name =>
    items[name].left < 0 ||
    items[name].top < 0 ||
    items[name].right > innerWidth + 1 ||
    items[name].bottom > innerHeight + 1
  );
  return {
    width: innerWidth,
    height: innerHeight,
    bodyWidth: document.body.scrollWidth,
    items,
    overlaps,
    clipped,
    narratorKind: document.querySelector('#raceControl')?.dataset.kind || '',
  };
});
await compactLandscapePage.dispatchEvent('#tboost', 'pointerup', {
  pointerId: 51,
  pointerType: 'touch',
  isPrimary: true,
  buttons: 0,
});
await compactLandscapePage.screenshot({ path: '.qa/mobile-landscape-race.png' });
if (compactLandscape.overlaps.length ||
    compactLandscape.clipped.length ||
    compactLandscape.items.moment.display !== 'none' ||
    compactLandscape.narratorKind !== 'slingshotFire' ||
    compactLandscape.bodyWidth > compactLandscape.width + 1) {
  errors.push(`compact landscape HUD unsafe: ${JSON.stringify(compactLandscape)}`);
}
await compactLandscapeContext.close();

if (errors.length) {
  console.error(JSON.stringify({
    mobileGraphics,
    coarseProfileProbe,
    menuLayout,
    slingshot,
    result,
    mobileResults,
    landscapeMenu,
    compactLandscape,
    errors,
  }, null, 2));
  await browser.close();
  process.exit(1);
}
console.log(JSON.stringify({
  viewport: `${result.width}x844`,
  speed: result.state.speed.toFixed(1),
  boost: result.state.boost.toFixed(1),
  touchSlingshots: slingshot.state.slingshots,
  narratorPresentations: slingshot.narratorPresentations,
  graphics: {
    actual: mobileGraphics.profile,
    coarseProbe: coarseProfileProbe,
  },
  errors,
  screenshots: [
    '.qa/mobile-menu.png',
    '.qa/mobile-slingshot.png',
    '.qa/mobile-race.png',
    '.qa/mobile-results.png',
    '.qa/mobile-landscape-menu.png',
    '.qa/mobile-landscape-race.png',
  ],
}, null, 2));
await browser.close();
