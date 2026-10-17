#!/usr/bin/env node
// phone-robot server. Env: INGEST_TOKEN (required), VIEW_TOKEN (defaults to INGEST_TOKEN), PORT (8080),
// DATA_DIR (./data), RECENT_MAX (5000 points kept in memory for the page).
import http from 'node:http';
import { Store } from './lib/store.mjs';
import { createHandler } from './lib/app.mjs';

const ingestToken = process.env.INGEST_TOKEN || '';
if (ingestToken.length < 16) {
  console.error('INGEST_TOKEN must be set (at least 16 characters). Generate one with: openssl rand -hex 24');
  process.exit(1);
}
const store = new Store(process.env.DATA_DIR || 'data', { recentMax: Number(process.env.RECENT_MAX) || 5000 });
const handler = createHandler({ store, ingestToken, viewToken: process.env.VIEW_TOKEN || ingestToken });
const port = Number(process.env.PORT) || 8080;
const server = http.createServer(handler);
server.requestTimeout = 30_000;
server.listen(port, () => console.log(`phone-robot server on :${port}, data in ${store.dir}, ${store.recent.length} recent point(s) loaded`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
