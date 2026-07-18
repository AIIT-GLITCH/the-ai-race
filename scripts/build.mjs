import { cp, mkdir, rm } from 'node:fs/promises';

const files = ['index.html', 'game.js', 'track.js'];
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of files) await cp(file, `dist/${file}`);
await cp('assets', 'dist/assets', { recursive: true });
await cp('vendor', 'dist/vendor', { recursive: true });
await mkdir('dist/server', { recursive: true });
await mkdir('dist/.openai', { recursive: true });
await cp('scripts/worker-entry.mjs', 'dist/server/index.js');
await cp('.openai/hosting.json', 'dist/.openai/hosting.json');
console.log('Static production build written to dist/');
