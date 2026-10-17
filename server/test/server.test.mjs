import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { createHandler, tokenOk } from '../lib/app.mjs';
import { validateBatch } from '../lib/validate.mjs';

const TOKEN = 'ingest-token-0123456789';
const VIEW = 'view-token-0123456789';
const quiet = { log() {}, error() {} };
const dir = mkdtempSync(join(tmpdir(), 'pr-'));
let store, server, base;

before(async () => {
  store = new Store(dir);
  server = http.createServer(createHandler({ store, ingestToken: TOKEN, viewToken: VIEW, log: quiet }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.closeAllConnections?.(); server.close(); rmSync(dir, { recursive: true, force: true }); });

const T0 = Date.now() - 5 * 60_000;
const sample = (i, extra = {}) => ({
  t: T0 + i * 10_000,
  loc: { lat: 40.7128 + i * 0.0001, lon: -74.006 - i * 0.0001, acc: 8, speed: 1.4, alt: 12, bearing: 90 },
  activity: 'WALKING',
  transitions: i === 0 ? [{ activity: 'WALKING', type: 'ENTER', t: T0 }] : [],
  motion: { accel: { n: 500, mean: 9.9, rms: 1.2, peak: 4.1 }, gyro: { n: 500, mean: 0.2, rms: 0.3, peak: 1.1 } },
  battery: 87, charging: false, ...extra,
});
const post = (body, { token = TOKEN, type = 'application/json' } = {}) =>
  fetch(`${base}/ingest`, { method: 'POST', headers: { 'content-type': type, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const get = (path, token = VIEW) => fetch(base + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

test('tokenOk: bearer, constant-time compare, empty expected never matches', () => {
  assert.ok(tokenOk(`Bearer ${TOKEN}`, TOKEN));
  assert.ok(tokenOk(`bearer   ${TOKEN}`, TOKEN));
  assert.ok(!tokenOk(`Bearer ${TOKEN}x`, TOKEN));
  assert.ok(!tokenOk(TOKEN, TOKEN));
  assert.ok(!tokenOk('Bearer ', ''));
  assert.ok(!tokenOk(undefined, TOKEN));
});

test('createHandler refuses to run without an ingest token', () => {
  assert.throws(() => createHandler({ store, ingestToken: '' }), /INGEST_TOKEN/);
});

test('GET /healthz is public and has no data', async () => {
  const r = await fetch(`${base}/healthz`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.deepEqual(Object.keys(j).sort(), ['ok', 'points', 'uptimeS']);
});

test('POST /ingest: auth, content-type, JSON and method checks', async () => {
  assert.equal((await post({ device: 'p', samples: [sample(0)] }, { token: '' })).status, 401);
  assert.equal((await post({ device: 'p', samples: [sample(0)] }, { token: 'wrong' })).status, 401);
  assert.equal((await post({ device: 'p', samples: [sample(0)] }, { token: VIEW })).status, 401, 'view token cannot ingest');
  assert.equal((await post('{}', { type: 'text/plain' })).status, 415);
  assert.equal((await post('{nope')).status, 400);
  assert.equal((await fetch(`${base}/ingest`)).status, 405);
});

test('POST /ingest stores a batch as NDJSON and the API serves it', async () => {
  const r = await post({ device: 'pixel-8', samples: [0, 1, 2, 3, 4, 5].map((i) => sample(i)) });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, stored: 6 });

  const files = readdirSync(dir).filter((f) => f.endsWith('.ndjson'));
  assert.ok(files.length >= 1);
  const lines = files.flatMap((f) => readFileSync(join(dir, f), 'utf8').trim().split('\n')).map((l) => JSON.parse(l));
  assert.equal(lines.length, 6);
  assert.equal(lines[0].device, 'pixel-8');
  assert.ok(lines[0].receivedAt >= lines[0].t);
  assert.equal(lines[0].transitions[0].type, 'ENTER');

  const latest = await (await get('/api/latest')).json();
  assert.equal(latest.latest.t, sample(5).t);
  assert.deepEqual(latest.devices, ['pixel-8']);
  const track = await (await get('/api/track?minutes=60')).json();
  assert.equal(track.count, 6);
  assert.ok(track.points.every((p) => p.loc));
});

test('/api/* needs the view token; ingest token alone is not enough when VIEW_TOKEN differs', async () => {
  assert.equal((await get('/api/latest', '')).status, 401);
  assert.equal((await get('/api/latest', TOKEN)).status, 401);
  assert.equal((await get('/api/nope')).status, 404);
});

test('samples without a fix are stored but left off the map track; old points fall out of the window', async () => {
  await post({ device: 'pixel-8', samples: [{ t: Date.now() - 1000, activity: 'STILL', battery: 80 }] });
  const latest = await (await get('/api/latest?device=pixel-8')).json();
  assert.equal(latest.latest.activity, 'STILL');
  assert.equal(latest.latest.loc, undefined);
  const track = await (await get('/api/track?minutes=1')).json();
  assert.equal(track.count, 0);
});

test('validation rejects bad batches with 400 and a reason', async () => {
  const cases = [
    [{ samples: [sample(0)] }, /device/],
    [{ device: 'a b', samples: [sample(0)] }, /device/],
    [{ device: 'p', samples: [] }, /non-empty/],
    [{ device: 'p', samples: [sample(0, { t: 12 })] }, /unix time/],
    [{ device: 'p', samples: [sample(0, { loc: { lat: 91, lon: 0 } })] }, /lat/],
    [{ device: 'p', samples: [sample(0, { activity: 'FLYING' })] }, /activity/],
    [{ device: 'p', samples: [sample(0, { battery: 101 })] }, /battery/],
    [{ device: 'p', samples: [sample(0, { motion: { accel: { rms: 'x' } } })] }, /rms/],
    [{ device: 'p', samples: Array.from({ length: 501 }, (_, i) => sample(0)) }, /at most 500/],
  ];
  for (const [body, re] of cases) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.match((await r.json()).error, re);
  }
});

test('validateBatch drops unknown fields', () => {
  const { samples } = validateBatch({ device: 'p', samples: [{ ...sample(0), secret: 'x', loc: { lat: 1, lon: 2, junk: 1 } }] });
  assert.equal(samples[0].secret, undefined);
  assert.equal(samples[0].loc.junk, undefined);
});

test('oversized bodies get 413', async () => {
  const r = await post('{"device":"p","samples":[' + '"x",'.repeat(300_000) + '"x"]}');
  assert.equal(r.status, 413);
});

test('page and assets are served with a strict CSP and no data inline', async () => {
  const r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  const html = await r.text();
  assert.match(html, /leaflet@1\.9\.4/);
  assert.match(html, /integrity="sha256-/);
  assert.doesNotMatch(html, /40\.71/);
  assert.equal((await fetch(`${base}/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
});

test('Store reloads recent points from disk after a restart', () => {
  const again = new Store(dir);
  assert.equal(again.latest('pixel-8').activity, 'STILL');
  assert.ok(again.track({ minutes: 60 }).length >= 6);
});

test('Store ring is capped', () => {
  const d = mkdtempSync(join(tmpdir(), 'pr-cap-'));
  const s = new Store(d, { recentMax: 3 });
  s.append('p', [0, 1, 2, 3, 4].map((i) => sample(i)));
  assert.equal(s.recent.length, 3);
  assert.equal(s.latest().t, sample(4).t);
  assert.equal(new Store(d, { recentMax: 3 }).recent.length, 3);
  rmSync(d, { recursive: true, force: true });
});

test('server.mjs refuses to start with a short INGEST_TOKEN', async () => {
  const { spawn } = await import('node:child_process');
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [new URL('../server.mjs', import.meta.url).pathname], { env: { ...process.env, INGEST_TOKEN: 'short', PORT: '0' }, stdio: 'ignore' });
    p.on('exit', resolve);
  });
  assert.equal(code, 1);
});
