import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../lib/store.mjs';
import { createHandler } from '../lib/app.mjs';
import { Audit } from '../lib/audit.mjs';
import { Commands } from '../lib/commands.mjs';
import { RateLimits, limitsFromEnv } from '../lib/ratelimit.mjs';
import { Gate } from '../lib/gate.mjs';

export const TOKEN = 'ingest-token-0123456789';
export const VIEW = 'view-token-0123456789';
export const quiet = { log() {}, error() {} };

/** Start a throwaway HTTP server around a handler function. */
export async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, server, close: () => { server.closeAllConnections?.(); server.close(); } };
}

/** A phone-robot server with injectable parts. Returns helpers bound to it. */
export async function makeApp(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pr2-'));
  const store = new Store(dir);
  const audit = opts.audit || new Audit(dir);
  const commands = opts.commands || new Commands(dir);
  const limits = opts.limits || new RateLimits(limitsFromEnv(opts.env || {}));
  const gate = opts.gate || new Gate({ providers: { fcm: { disTarget: null, feed: null }, llm: { disTarget: null, feed: null } } });
  const handler = createHandler({ store, ingestToken: TOKEN, viewToken: VIEW, log: quiet, audit, commands, limits, gate, fcm: opts.fcm || null, llm: opts.llm || null, maxTurns: opts.maxTurns });
  const srv = await listen(handler);
  const req = (method, path, { token, body } = {}) => fetch(srv.url + path, {
    method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = async (method, path, o) => { const r = await req(method, path, o); return { status: r.status, body: await r.json() }; };
  const ingest = (device = 'pixel-8', extra = {}) => json('POST', '/ingest', { token: TOKEN, body: { device, samples: [{ t: Date.now() - 30_000, loc: { lat: 40.7644, lon: -73.9732, acc: 7 }, activity: 'WALKING', battery: 81, ...extra }] } });
  return { dir, store, audit, commands, limits, gate, url: srv.url, close: srv.close, req, json, ingest };
}
