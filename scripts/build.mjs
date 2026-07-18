import { cp, mkdir, rm } from 'node:fs/promises';

const files = ['index.html', 'game.js', 'track.js', 'spectacle.js'];
await rm('dist', { recursive: true, force: true });
await mkdir('dist/client', { recursive: true });
for (const file of files) await cp(file, `dist/client/${file}`);
await cp('assets', 'dist/client/assets', { recursive: true });
await cp('vendor', 'dist/client/vendor', { recursive: true });
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await cp('scripts/worker-entry.mjs', 'dist/server/index.js');
await cp('.openai/hosting.json', 'dist/.openai/hosting.json');
console.log('Sites production build written to dist/ (worker + client assets)');
