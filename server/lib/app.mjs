// HTTP handler. Zero dependencies.
//   POST /ingest        Authorization: Bearer <INGEST_TOKEN>   body {device, samples:[...]}
//   GET  /healthz       public, no data: {ok, points, uptimeS}
//   GET  /              map page shell (no data in it; the page asks for the view key)
//   GET  /api/latest    Authorization: Bearer <VIEW_TOKEN>  ?device=
//   GET  /api/track     Authorization: Bearer <VIEW_TOKEN>  ?device=&minutes=60&limit=2000
import { readFileSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { validateBatch } from './validate.mjs';

const PUBLIC = new URL('../public/', import.meta.url);
const asset = (name) => readFileSync(new URL(name, PUBLIC));
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const CSP = [
  "default-src 'none'",
  "script-src 'self' https://unpkg.com",
  "style-src 'self' https://unpkg.com",
  "img-src 'self' data: https://*.tile.openstreetmap.org https://unpkg.com",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const MAX_BODY = 1024 * 1024;

/** Constant-time token check (hash both sides so lengths match). */
export function tokenOk(header, expected) {
  if (!expected) return false;
  const m = /^Bearer\s+(.+)$/i.exec(String(header || ''));
  if (!m) return false;
  const a = createHash('sha256').update(m[1].trim()).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...headers,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        // Stop buffering and answer now; the rest of the upload is discarded and the connection closed afterwards.
        req.removeAllListeners('data');
        req.resume();
        reject(Object.assign(new Error('body too large (max 1 MB)'), { status: 413, close: true }));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function createHandler({ store, ingestToken, viewToken = ingestToken, log = console, now = () => Date.now() }) {
  if (!ingestToken) throw new Error('INGEST_TOKEN is required');
  const started = now();
  return async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;
    try {
      if (path === '/healthz' && (req.method === 'GET' || req.method === 'HEAD')) {
        return send(res, 200, { ok: true, points: store.recent.length, uptimeS: Math.round((now() - started) / 1000) });
      }
      if (path === '/ingest') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, { allow: 'POST' });
        if (!tokenOk(req.headers.authorization, ingestToken)) return send(res, 401, { error: 'bad or missing bearer token' }, { 'www-authenticate': 'Bearer' });
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'content-type must be application/json' });
        const text = await readBody(req);
        let body;
        try { body = JSON.parse(text); } catch { return send(res, 400, { error: 'body is not valid JSON' }); }
        const { device, samples } = validateBatch(body);
        const stored = store.append(device, samples, now());
        log.log?.(`[ingest] ${device}: ${stored} sample(s)`);
        return send(res, 200, { ok: true, stored });
      }
      if (path.startsWith('/api/')) {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET only' }, { allow: 'GET' });
        if (!tokenOk(req.headers.authorization, viewToken)) return send(res, 401, { error: 'bad or missing bearer token' }, { 'www-authenticate': 'Bearer' });
        const device = url.searchParams.get('device') || undefined;
        if (path === '/api/latest') return send(res, 200, { latest: store.latest(device), devices: store.devices() });
        if (path === '/api/track') {
          const minutes = Math.min(7 * 24 * 60, Math.max(1, Number(url.searchParams.get('minutes')) || 60));
          const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit')) || 2000));
          const points = store.track({ device, minutes, limit, now: now() });
          return send(res, 200, { minutes, count: points.length, points });
        }
        return send(res, 404, { error: 'not found' });
      }
      if (ASSETS[path] && (req.method === 'GET' || req.method === 'HEAD')) {
        const [file, type] = ASSETS[path];
        return send(res, 200, asset(file), { 'content-type': type, 'content-security-policy': CSP, 'cache-control': 'no-cache' });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) log.error?.('[error]', e);
      if (e.close) res.once('finish', () => req.socket?.destroy());
      return send(res, status, { error: status === 500 ? 'internal error' : e.message }, e.close ? { connection: 'close' } : {});
    }
  };
}
