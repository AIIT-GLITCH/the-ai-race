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
  const stamp = document.querySelector('#momentStamp');
  return cue?.classList.contains('active') &&
    stamp?.classList.contains('live') &&
    Number(getComputedStyle(cue).opacity) > .8 &&
    Number(getComputedStyle(stamp).opacity) > .8;
}, null, { timeout: 2_000 });
Object.assign(slingshot, await page.evaluate(() => {
  const rect = element => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
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
    };
  };
  return {
    cue: rect(document.querySelector('#launchCue')),
    moment: rect(document.querySelector('#momentStamp')),
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
for (const [name, feedback] of [['cue', slingshot.cue], ['moment', slingshot.moment]]) {
  if (feedback.display === 'none' ||
      feedback.visibility === 'hidden' ||
      feedback.opacity <= 0 ||
      feedback.left < 0 ||
      feedback.right > slingshot.width ||
      feedback.top < 0 ||
      feedback.bottom > slingshot.height) {
    errors.push(`mobile slingshot ${name} unsafe: ${JSON.stringify(feedback)}`);
  }
}
if (!slingshot.cue.classes.includes('active') ||
    !/SLINGSHOT/.test(slingshot.cue.text) ||
    !slingshot.moment.classes.includes('live') ||
    !/SLINGSHOT DEPLOYED/.test(slingshot.moment.text) ||
    slingshot.bodyWidth !== slingshot.width) {
  errors.push(`mobile slingshot feedback missing: ${JSON.stringify(slingshot)}`);
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
if (errors.length) {
  console.error(JSON.stringify({ menuLayout, slingshot, result, mobileResults, landscapeMenu, errors }, null, 2));
  await browser.close();
  process.exit(1);
}
console.log(JSON.stringify({
  viewport: `${result.width}x844`,
  speed: result.state.speed.toFixed(1),
  boost: result.state.boost.toFixed(1),
  touchSlingshots: slingshot.state.slingshots,
  errors,
  screenshots: [
    '.qa/mobile-menu.png',
    '.qa/mobile-slingshot.png',
    '.qa/mobile-race.png',
    '.qa/mobile-results.png',
    '.qa/mobile-landscape-menu.png',
  ],
}, null, 2));
await browser.close();
