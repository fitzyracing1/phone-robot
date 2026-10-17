// HTTP handler. Zero dependencies.
//   POST /ingest        Authorization: Bearer <INGEST_TOKEN>   body {device, samples:[...]}
//   GET  /healthz       public, no data: {ok, points, uptimeS}
//   GET  /              map page shell (no data in it; the page asks for the view key)
//   GET  /api/latest    Authorization: Bearer <VIEW_TOKEN>  ?device=
//   GET  /api/track     Authorization: Bearer <VIEW_TOKEN>  ?device=&minutes=60&limit=2000
// Milestone 2 (all additive; the milestone-1 app keeps working unchanged):
//   device token (INGEST_TOKEN):  GET /commands?device=   POST /commands/ack   POST /devices/fcm
//   owner token (VIEW_TOKEN):     POST /commands {device?, type: start|stop|ping}   GET /api/commands
//                                 POST /tasks {goal, device?}   GET /audit   GET /api/features
import { readFileSync } from 'node:fs';
import { timingSafeEqual, createHash } from 'node:crypto';
import { validateBatch, DEVICE_RE } from './validate.mjs';
import { Commands, OWNER_COMMANDS } from './commands.mjs';
import { Audit } from './audit.mjs';
import { RateLimits, limitsFromEnv } from './ratelimit.mjs';
import { Gate } from './gate.mjs';
import { Safety } from './safety.mjs';
import { Dispatcher } from './dispatch.mjs';
import { runTask } from './planner.mjs';

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

const bad = (message, status = 400) => Object.assign(new Error(message), { status });

async function readJson(req) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw bad('content-type must be application/json', 415);
  const text = await readBody(req);
  try { return JSON.parse(text || '{}'); } catch { throw bad('body is not valid JSON'); }
}

export function createHandler({
  store, ingestToken, viewToken = ingestToken, log = console, now = () => Date.now(),
  commands, audit, limits, gate, fcm = null, llm = null, maxTurns,
}) {
  if (!ingestToken) throw new Error('INGEST_TOKEN is required');
  const started = now();
  commands ||= new Commands(store.dir);
  audit ||= new Audit(store.dir);
  limits ||= new RateLimits(limitsFromEnv());
  gate ||= new Gate();
  const safety = new Safety({ limits, audit, maxTurns });
  const dispatcher = new Dispatcher({ commands, audit, gate, fcm });
  const knownDevice = (d) => store.devices().includes(d) || commands.knownDevices().includes(d);
  /** The owner's phone: the named device if known, else the device that uploaded most recently. */
  const ownerDevice = (d) => {
    if (d) {
      if (!DEVICE_RE.test(d) || !knownDevice(d)) throw bad('unknown device: it must have uploaded or polled with the device token first', 404);
      return d;
    }
    const latest = store.latest()?.device || commands.knownDevices()[0];
    if (!latest) throw bad('no device has connected yet', 409);
    return latest;
  };
  const device = (v) => { const d = String(v ?? ''); if (!DEVICE_RE.test(d)) throw bad('device must be 1-64 chars: letters, digits, . _ -'); return d; };
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
      // ---- device side (INGEST_TOKEN) ----
      if (path === '/commands' && req.method === 'GET') {
        if (!tokenOk(req.headers.authorization, ingestToken)) return send(res, 401, { error: 'bad or missing bearer token' }, { 'www-authenticate': 'Bearer' });
        const d = device(url.searchParams.get('device'));
        const list = commands.pendingFor(d);
        if (list.length) audit.write('delivered', { device: d, commandIds: list.map((c) => c.id) });
        return send(res, 200, { commands: list, pollSeconds: 60 });
      }
      if (path === '/commands/ack') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, { allow: 'POST' });
        if (!tokenOk(req.headers.authorization, ingestToken)) return send(res, 401, { error: 'bad or missing bearer token' }, { 'www-authenticate': 'Bearer' });
        const body = await readJson(req);
        const d = device(body.device);
        if (!Array.isArray(body.acks) || body.acks.length > 50) throw bad('acks must be an array (max 50)');
        const acks = body.acks.map((a) => {
          if (!a || typeof a.id !== 'string' || a.id.length > 64) throw bad('each ack needs an id');
          const result = a.result === undefined ? undefined : JSON.parse(JSON.stringify(a.result));
          if (result !== undefined && JSON.stringify(result).length > 2048) throw bad('ack result too large (max 2 KB)');
          return { id: a.id, ok: a.ok !== false, result };
        });
        const n = commands.ack(d, acks);
        if (n) audit.write('ack', { device: d, acks: acks.map((a) => ({ id: a.id, ok: a.ok, result: a.result })) });
        return send(res, 200, { ok: true, acked: n });
      }
      if (path === '/devices/fcm') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, { allow: 'POST' });
        if (!tokenOk(req.headers.authorization, ingestToken)) return send(res, 401, { error: 'bad or missing bearer token' }, { 'www-authenticate': 'Bearer' });
        const body = await readJson(req);
        const d = device(body.device);
        const t = String(body.token ?? '');
        if (!/^[A-Za-z0-9_:.-]{20,4096}$/.test(t)) throw bad('token must be an FCM registration token');
        commands.setFcmToken(d, t);
        audit.write('fcm_register', { device: d });
        return send(res, 200, { ok: true, fcm: Boolean(fcm) });
      }

      // ---- owner side (VIEW_TOKEN) ----
      const owner = () => tokenOk(req.headers.authorization, viewToken);
      if (path === '/commands' && req.method === 'POST') {
        if (!owner()) return send(res, 401, { error: 'bad or missing bearer token' }, { 'www-authenticate': 'Bearer' });
        const body = await readJson(req);
        if (!OWNER_COMMANDS.includes(body.type)) throw bad(`type must be one of ${OWNER_COMMANDS.join(', ')}`);
        const d = ownerDevice(body.device);
        const rl = limits.take('commands');
        if (!rl.ok) { audit.write('rate_limited', { limit: 'commands', device: d, type: body.type }); return send(res, 429, { error: `command rate limit reached; retry in ${rl.retryAfterS}s` }, { 'retry-after': String(rl.retryAfterS) }); }
        const { command, via } = await dispatcher.send(d, body.type, {}, { source: 'owner' });
        return send(res, 202, { ok: true, command, via });
      }
      if (path === '/tasks') {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' }, { allow: 'POST' });
        if (!owner()) return send(res, 401, { error: 'bad or missing bearer token' }, { 'www-authenticate': 'Bearer' });
        const body = await readJson(req);
        const goal = typeof body.goal === 'string' ? body.goal.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
        if (!goal || goal.length > 500) throw bad('goal must be 1-500 characters');
        const d = ownerDevice(body.device);
        const rl = limits.take('tasks');
        if (!rl.ok) { audit.write('rate_limited', { limit: 'tasks', device: d }); return send(res, 429, { error: `task rate limit reached; retry in ${rl.retryAfterS}s` }, { 'retry-after': String(rl.retryAfterS) }); }
        const transcript = await runTask({ goal, device: d }, { store, dispatcher, safety, audit, gate, limits, llm });
        return send(res, 200, transcript);
      }
      if (path === '/audit') {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET only' }, { allow: 'GET' });
        if (!owner()) return send(res, 401, { error: 'bad or missing bearer token' }, { 'www-authenticate': 'Bearer' });
        const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        const entries = audit.list({ limit, taskId: url.searchParams.get('taskId') || undefined, kind: url.searchParams.get('kind') || undefined });
        return send(res, 200, { count: entries.length, chain: url.searchParams.get('verify') ? audit.verify() : undefined, entries });
      }

      if (path.startsWith('/api/')) {
        if (req.method !== 'GET') return send(res, 405, { error: 'GET only' }, { allow: 'GET' });
        if (!tokenOk(req.headers.authorization, viewToken)) return send(res, 401, { error: 'bad or missing bearer token' }, { 'www-authenticate': 'Bearer' });
        const dev = url.searchParams.get('device') || undefined;
        if (path === '/api/latest') return send(res, 200, { latest: store.latest(dev), devices: [...new Set([...store.devices(), ...commands.knownDevices()])] });
        if (path === '/api/commands') return send(res, 200, { commands: commands.recent({ device: dev, limit: 30 }), lastPollAt: dev ? commands.lastPollAt(dev) : null });
        if (path === '/api/features') return send(res, 200, { fcm: Boolean(fcm), planner: llm ? 'llm (falls back to rules)' : 'rules', maxTurns: safety.maxTurns, tools: ['report_location', 'notify_user', 'stop'] });
        if (path === '/api/track') {
          const minutes = Math.min(7 * 24 * 60, Math.max(1, Number(url.searchParams.get('minutes')) || 60));
          const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get('limit')) || 2000));
          const points = store.track({ device: dev, minutes, limit, now: now() });
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
