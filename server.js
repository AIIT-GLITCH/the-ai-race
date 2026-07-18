import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8140;
const MIME = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webp', 'image/webp'],
]);

function headers() {
  return {
    'Cache-Control': 'no-cache',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  };
}

function reply(response, status, message, extra = {}) {
  response.writeHead(status, {
    ...headers(),
    ...extra,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(message),
  });
  response.end(message);
}

async function resolveRequest(requestUrl) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, 'http://localhost').pathname);
  } catch {
    return null;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  const parts = pathname.split('/').filter(Boolean);
  if (parts.some(part => part === '..' || part.startsWith('.'))) return null;
  const candidate = path.resolve(ROOT, parts.length ? parts.join('/') : 'index.html');
  if (candidate !== ROOT && !candidate.startsWith(`${ROOT}${path.sep}`)) return null;
  try {
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const canonical = await realpath(candidate);
    if (canonical !== ROOT && !canonical.startsWith(`${ROOT}${path.sep}`)) return null;
    return { path: canonical, size: info.size };
  } catch {
    return undefined;
  }
}

export function createStaticServer() {
  return createServer(async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      reply(response, 405, 'Method Not Allowed\n', { Allow: 'GET, HEAD' });
      return;
    }
    const file = await resolveRequest(request.url ?? '/');
    if (file === null) {
      reply(response, 400, 'Bad Request\n');
      return;
    }
    if (file === undefined) {
      reply(response, 404, 'Not Found\n');
      return;
    }
    response.writeHead(200, {
      ...headers(),
      'Content-Type': MIME.get(path.extname(file.path).toLowerCase()) ?? 'application/octet-stream',
      'Content-Length': file.size,
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(file.path)
      .on('error', () => response.destroy())
      .pipe(response);
  });
}

function readPort(value) {
  if (!value) return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError(`PORT must be an integer from 1 to 65535; received ${value}.`);
  }
  return port;
}

export function startStaticServer({
  host = process.env.HOST || DEFAULT_HOST,
  port = readPort(process.env.PORT),
} = {}) {
  const server = createStaticServer();
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`THE AI RACE running at http://${host}:${actualPort}/`);
  });
  return server;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  const server = startStaticServer();
  const close = signal => {
    console.log(`\n${signal} received; closing server.`);
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => close('SIGINT'));
  process.once('SIGTERM', () => close('SIGTERM'));
}
