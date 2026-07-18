import { existsSync } from 'node:fs';

const moduleCandidates = [
  process.env.PLAYWRIGHT_MODULE,
  'playwright-core',
  'playwright',
  '/home/buddybox/cluster-command-center/node_modules/playwright-core/index.js',
  '/home/buddybox/codex-motorsport/node_modules/playwright-core/index.js',
].filter(Boolean);

let loaded;
let lastError;
for (const candidate of moduleCandidates) {
  try {
    loaded = await import(candidate);
    break;
  } catch (error) {
    lastError = error;
  }
}
if (!loaded) {
  throw new Error(`Playwright is unavailable. Run npm install. ${lastError?.message || ''}`);
}

export default loaded.default || loaded;

const browserCandidates = [
  process.env.CHROME,
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
export const chromeExecutable = browserCandidates.find(candidate => existsSync(candidate));
