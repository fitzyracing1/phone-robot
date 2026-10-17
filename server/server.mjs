#!/usr/bin/env node
// phone-robot server. Env: INGEST_TOKEN (required), VIEW_TOKEN (defaults to INGEST_TOKEN), PORT (8080),
// DATA_DIR (./data), RECENT_MAX (5000 points kept in memory for the page).
// Milestone 2, all optional: FCM_SERVICE_ACCOUNT_JSON (JSON or base64), PLANNER_BASE_URL / PLANNER_API_KEY /
// PLANNER_MODEL (OpenAI-compatible), PLANNER_STATUS_URL [+ _FORMAT, _COMPONENT], DIS_URL [+ DIS_FCM_TARGET,
// DIS_LLM_TARGET], TASKS_PER_HOUR, NOTIFY_PER_HOUR, COMMANDS_PER_HOUR, LLM_CALLS_PER_HOUR.
import http from 'node:http';
import { Store } from './lib/store.mjs';
import { createHandler } from './lib/app.mjs';
import { Gate, providersFromEnv } from './lib/gate.mjs';
import { Fcm, parseServiceAccount } from './lib/fcm.mjs';
import { llmFromEnv } from './lib/planner.mjs';
import { RateLimits, limitsFromEnv } from './lib/ratelimit.mjs';

const ingestToken = process.env.INGEST_TOKEN || '';
if (ingestToken.length < 16) {
  console.error('INGEST_TOKEN must be set (at least 16 characters). Generate one with: openssl rand -hex 24');
  process.exit(1);
}
const store = new Store(process.env.DATA_DIR || 'data', { recentMax: Number(process.env.RECENT_MAX) || 5000 });
let fcm = null;
try {
  const sa = parseServiceAccount(process.env.FCM_SERVICE_ACCOUNT_JSON);
  if (sa) fcm = new Fcm(sa);
} catch (e) {
  console.error(`FCM disabled: ${e.message}`);
}
const llm = llmFromEnv(process.env);
const gate = new Gate({ disUrl: process.env.DIS_URL || '', providers: providersFromEnv(process.env) });
const handler = createHandler({ store, ingestToken, viewToken: process.env.VIEW_TOKEN || ingestToken, fcm, llm, gate, limits: new RateLimits(limitsFromEnv(process.env)) });
console.log(`commands: polling${fcm ? ' + FCM' : ''}; planner: ${llm ? `LLM (${process.env.PLANNER_MODEL}) with rule fallback` : 'rules'}; gate: ${process.env.DIS_URL ? 'DIS' : 'status feeds'}`);
const port = Number(process.env.PORT) || 8080;
const server = http.createServer(handler);
server.requestTimeout = 30_000;
server.listen(port, () => console.log(`phone-robot server on :${port}, data in ${store.dir}, ${store.recent.length} recent point(s) loaded`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
