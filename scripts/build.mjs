import { cp, mkdir, rm } from 'node:fs/promises';

const files = ['index.html', 'game.js', 'track.js'];
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
for (const file of files) await cp(file, `dist/${file}`);
await cp('assets', 'dist/assets', { recursive: true });
await cp('vendor', 'dist/vendor', { recursive: true });
console.log('Static production build written to dist/');
