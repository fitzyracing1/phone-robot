import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeApp, listen, TOKEN, VIEW } from './helpers.mjs';
import { validateArgs, TOOL_NAMES, MAX_TURNS } from '../lib/safety.mjs';
import { RulePlanner, LlmPlanner, describeLocation, openAiTools } from '../lib/planner.mjs';
import { Gate } from '../lib/gate.mjs';
import { Fcm, signJwt, parseServiceAccount } from '../lib/fcm.mjs';
import { Audit } from '../lib/audit.mjs';
import { RateLimits } from '../lib/ratelimit.mjs';

const apps = [];
const servers = [];
after(() => { apps.forEach((a) => a.close()); servers.forEach((s) => s.close()); });
const app = async (o) => { const a = await makeApp(o); apps.push(a); return a; };
const mock = async (h) => { const s = await listen(h); servers.push(s); return s; };
const readJsonBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? (() => { try { return JSON.parse(b); } catch { return b; } })() : null)); });

// ---------- commands ----------

test('owner command → device poll → ack, with the right token on each side', async () => {
  const a = await app();
  await a.ingest();
  assert.equal((await a.json('POST', '/commands', { token: TOKEN, body: { type: 'ping' } })).status, 401, 'device token cannot command');
  assert.equal((await a.json('POST', '/commands', { body: { type: 'ping' } })).status, 401);
  assert.equal((await a.json('POST', '/commands', { token: VIEW, body: { type: 'notify' } })).status, 400, 'owner cannot send notify directly');
  assert.equal((await a.json('POST', '/commands', { token: VIEW, body: { type: 'start', device: 'stranger' } })).status, 404, 'unknown device');

  const sent = await a.json('POST', '/commands', { token: VIEW, body: { type: 'ping' } });
  assert.equal(sent.status, 202);
  assert.equal(sent.body.command.device, 'pixel-8', 'defaults to the phone that uploaded last');
  assert.equal(sent.body.via, 'poll');

  assert.equal((await a.json('GET', '/commands?device=pixel-8', { token: VIEW })).status, 401, 'view token cannot poll');
  const polled = await a.json('GET', '/commands?device=pixel-8', { token: TOKEN });
  assert.equal(polled.status, 200);
  assert.deepEqual(polled.body.commands.map((c) => c.type), ['ping']);
  assert.equal(polled.body.pollSeconds, 60);
  const again = await a.json('GET', '/commands?device=pixel-8', { token: TOKEN });
  assert.equal(again.body.commands.length, 1, 'unacked commands are redelivered');

  const id = polled.body.commands[0].id;
  assert.equal((await a.json('POST', '/commands/ack', { token: TOKEN, body: { device: 'other-phone', acks: [{ id }] } })).body.acked, 0, 'only the addressee can ack');
  const ack = await a.json('POST', '/commands/ack', { token: TOKEN, body: { device: 'pixel-8', acks: [{ id, ok: true, result: { battery: 80, running: true } }] } });
  assert.equal(ack.body.acked, 1);
  assert.equal((await a.json('GET', '/commands?device=pixel-8', { token: TOKEN })).body.commands.length, 0);
  const list = await a.json('GET', '/api/commands?device=pixel-8', { token: VIEW });
  assert.equal(list.body.commands[0].status, 'acked');
  assert.equal(list.body.commands[0].result.battery, 80);
  assert.ok(list.body.lastPollAt);
  assert.ok(a.audit.list().some((e) => e.kind === 'ack'));
});

test('owner commands are rate limited (429) and the refusal is audited', async () => {
  const a = await app({ env: { COMMANDS_PER_HOUR: '2' } });
  await a.ingest();
  assert.equal((await a.json('POST', '/commands', { token: VIEW, body: { type: 'start' } })).status, 202);
  assert.equal((await a.json('POST', '/commands', { token: VIEW, body: { type: 'stop' } })).status, 202);
  const r = await a.req('POST', '/commands', { token: VIEW, body: { type: 'ping' } });
  assert.equal(r.status, 429);
  assert.ok(Number(r.headers.get('retry-after')) > 0);
  assert.ok(a.audit.list().some((e) => e.kind === 'rate_limited'));
});

test('FCM token registration needs the device token and a plausible token', async () => {
  const a = await app();
  assert.equal((await a.json('POST', '/devices/fcm', { token: VIEW, body: { device: 'pixel-8', token: 'x'.repeat(40) } })).status, 401);
  assert.equal((await a.json('POST', '/devices/fcm', { token: TOKEN, body: { device: 'pixel-8', token: 'short' } })).status, 400);
  const ok = await a.json('POST', '/devices/fcm', { token: TOKEN, body: { device: 'pixel-8', token: 'fcm:token_' + 'a'.repeat(40) } });
  assert.equal(ok.status, 200);
  assert.equal(a.commands.fcmToken('pixel-8'), 'fcm:token_' + 'a'.repeat(40));
});

// ---------- planner + safety ----------

test('rules: "where is the phone?" → report_location → notify_user → done, and the phone gets the notification', async () => {
  const a = await app();
  await a.ingest();
  const t = await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'Where is the phone?' } });
  assert.equal(t.status, 200);
  assert.equal(t.body.planner, 'rules');
  assert.deepEqual(t.body.turns.map((x) => [x.tool, x.verdict]), [['report_location', 'ok'], ['notify_user', 'ok']]);
  assert.equal(t.body.turns[0].result.loc.lat, 40.7644);
  assert.equal(t.body.endedBy, 'planner');
  assert.match(t.body.summary, /40\.76440, -73\.97320/);
  const cmds = (await a.json('GET', '/commands?device=pixel-8', { token: TOKEN })).body.commands;
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].type, 'notify');
  assert.match(cmds[0].args.body, /Phone at 40\.76440/);
  const kinds = a.audit.list({ taskId: t.body.taskId }).map((e) => e.kind);
  assert.deepEqual(kinds, ['task_start', 'safety', 'tool', 'safety', 'command', 'tool', 'task_end']);
});

test('rules: stop logging → notify, then stop (ends the task); tell me …; no match', async () => {
  const a = await app();
  await a.ingest();
  const s = (await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'stop logging please' } })).body;
  assert.deepEqual(s.turns.map((x) => x.tool), ['notify_user', 'stop']);
  assert.equal(s.endedBy, 'stop');
  const tell = (await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'tell me to buy milk' } })).body;
  assert.equal(tell.turns[0].args.body, 'buy milk');
  const none = (await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'make me a sandwich' } })).body;
  assert.equal(none.turns.length, 0);
  assert.match(none.summary, /No rule matched/);
  const types = (await a.json('GET', '/commands?device=pixel-8', { token: TOKEN })).body.commands.map((c) => c.type);
  assert.deepEqual(types, ['notify', 'stop', 'notify']);
});

test('/tasks: auth, goal validation, no device yet, rate limit', async () => {
  const a = await app({ env: { TASKS_PER_HOUR: '1' } });
  assert.equal((await a.json('POST', '/tasks', { token: TOKEN, body: { goal: 'where?' } })).status, 401);
  assert.equal((await a.json('POST', '/tasks', { token: VIEW, body: { goal: '' } })).status, 400);
  assert.equal((await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'x'.repeat(501) } })).status, 400);
  assert.equal((await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'where?' } })).status, 409, 'no phone has connected');
  await a.ingest();
  assert.equal((await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'where?' } })).status, 200);
  assert.equal((await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'where?' } })).status, 429);
});

test('safety: allowlist and argument validation', () => {
  assert.deepEqual(TOOL_NAMES, ['report_location', 'notify_user', 'stop']);
  assert.equal(MAX_TURNS, 4);
  assert.match(validateArgs('send_sms', { to: '+15551234567' }).reason, /not allowed/);
  assert.match(validateArgs('call', {}).reason, /not allowed/);
  assert.match(validateArgs('notify_user', {}).reason, /required/);
  assert.match(validateArgs('notify_user', { body: 'hi', to: 'mom' }).reason, /unknown argument "to"/);
  assert.match(validateArgs('notify_user', { body: 'x'.repeat(241) }).reason, /longer than 240/);
  assert.match(validateArgs('notify_user', { body: 5 }).reason, /string/);
  assert.match(validateArgs('report_location', { lat: '1' }).reason, /unknown argument/);
  assert.match(validateArgs('stop', []).reason, /object/);
  assert.deepEqual(validateArgs('notify_user', { body: ' hi\u0000\nthere \u2028 ' }).args, { body: 'hi there' });
  assert.deepEqual(validateArgs('stop', null).args, {});
});

/** A fake OpenAI-compatible endpoint. `script` returns the assistant message for each call. */
async function fakeLlm(script) {
  const calls = [];
  const s = await mock(async (req, res) => {
    const body = await readJsonBody(req);
    calls.push({ headers: req.headers, body });
    const out = script(calls.length, body);
    if (typeof out === 'number') { res.writeHead(out); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: out }] }));
  });
  return { url: s.url, calls };
}
const toolCall = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } }] });

test('LLM planner: only the 3 tools are offered, results are fed back, a final text ends the task', async () => {
  const llm = await fakeLlm((n) => (n === 1 ? toolCall('report_location', {}) : n === 2 ? toolCall('notify_user', { body: 'At the park' }) : { role: 'assistant', content: 'Told you where it is.' }));
  const a = await app({ llm: new LlmPlanner({ baseUrl: llm.url, apiKey: 'k-test', model: 'tiny' }) });
  await a.ingest();
  const t = (await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'where is it' } })).body;
  assert.equal(t.planner, 'llm');
  assert.deepEqual(t.turns.map((x) => x.tool), ['report_location', 'notify_user']);
  assert.equal(t.summary, 'Told you where it is.');
  const first = llm.calls[0];
  assert.equal(first.headers.authorization, 'Bearer k-test');
  assert.equal(first.body.model, 'tiny');
  assert.deepEqual(first.body.tools.map((x) => x.function.name), ['report_location', 'notify_user', 'stop']);
  assert.equal(first.body.tools[1].function.parameters.additionalProperties, false);
  const third = llm.calls[2].body.messages;
  assert.equal(third.filter((m) => m.role === 'tool').length, 2);
  assert.match(third.find((m) => m.role === 'tool').content, /40\.7644/);
});

test('LLM planner: forbidden tool and bad args are rejected by the safety layer; maxTurns=4 is enforced', async () => {
  const llm = await fakeLlm((n) => (n === 1 ? toolCall('send_sms', { to: '+15551234567', body: 'hi' }) : n === 2 ? toolCall('notify_user', '{not json') : toolCall('report_location', {})));
  const a = await app({ llm: new LlmPlanner({ baseUrl: llm.url, model: 'tiny' }) });
  await a.ingest();
  const t = (await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'text my mom' } })).body;
  assert.equal(t.turns.length, 4);
  assert.equal(llm.calls.length, 4, 'never more than 4 model calls');
  assert.deepEqual(t.turns.map((x) => x.verdict), ['rejected', 'rejected', 'ok', 'ok']);
  assert.match(t.turns[0].reason, /not allowed/);
  assert.equal(t.endedBy, 'max_turns');
  const kinds = a.audit.list({ taskId: t.taskId }).map((e) => e.kind);
  assert.ok(kinds.includes('max_turns'));
  assert.equal(a.commands.recent().length, 0, 'nothing was sent anywhere');
  assert.match(JSON.stringify(llm.calls[1].body.messages), /rejected by safety layer/);
});

test('LLM planner: endpoint error → rule planner takes over, audited', async () => {
  const llm = await fakeLlm(() => 500);
  const a = await app({ llm: new LlmPlanner({ baseUrl: llm.url, model: 'tiny' }) });
  await a.ingest();
  const t = (await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'where is the phone' } })).body;
  assert.equal(t.planner, 'llm→rules');
  assert.deepEqual(t.turns.map((x) => x.planner), ['rules', 'rules']);
  const fb = a.audit.list({ taskId: t.taskId, kind: 'fallback' });
  assert.equal(fb[0].provider, 'llm');
  assert.match(fb[0].reason, /HTTP 500/);
});

test('gate: LLM provider dark on its status feed → rules for the whole task, audited, LLM never called', async () => {
  const llm = await fakeLlm(() => toolCall('report_location', {}));
  const feed = await mock((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: { indicator: 'major', description: 'Major Outage' } })); });
  const gate = new Gate({ providers: { fcm: { disTarget: null, feed: null }, llm: { disTarget: null, feed: { format: 'statuspage', url: feed.url + '/api/v2/status.json' } } } });
  const a = await app({ llm: new LlmPlanner({ baseUrl: llm.url, model: 'tiny' }), gate });
  await a.ingest();
  const t = (await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'where is the phone' } })).body;
  assert.equal(t.planner, 'rules');
  assert.equal(llm.calls.length, 0);
  const dark = a.audit.list({ taskId: t.taskId, kind: 'gate_dark' })[0];
  assert.equal(dark.provider, 'llm');
  assert.equal(dark.fallback, 'rules');
});

test('gate: LLM rate limit → rules, audited', async () => {
  const llm = await fakeLlm(() => toolCall('report_location', {}));
  const a = await app({ llm: new LlmPlanner({ baseUrl: llm.url, model: 'tiny' }), env: { LLM_CALLS_PER_HOUR: '1' } });
  await a.ingest();
  const t = (await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'where is the phone' } })).body;
  assert.equal(llm.calls.length, 1);
  assert.equal(t.planner, 'llm→rules');
  assert.ok(a.audit.list({ taskId: t.taskId, kind: 'fallback' }).some((e) => /rate limit/.test(e.reason)));
});

test('notify_user is rate limited by the safety layer', async () => {
  const a = await app({ env: { NOTIFY_PER_HOUR: '1' } });
  await a.ingest();
  assert.equal((await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'tell me one' } })).body.turns[0].verdict, 'ok');
  const t = (await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'tell me two' } })).body;
  assert.equal(t.turns[0].verdict, 'rejected');
  assert.match(t.turns[0].reason, /rate limit/);
  assert.match(t.summary, /rejected/);
});

test('describeLocation and the OpenAI tool schema', () => {
  assert.equal(describeLocation({ found: false }), 'No location has been logged yet.');
  assert.match(describeLocation({ found: true, ageS: 30, loc: null, activity: 'STILL' }), /no GPS fix/);
  assert.equal(openAiTools().length, 3);
});

test('rule planner gives up after a rejection instead of retrying', async () => {
  const r = await new RulePlanner().next({ goal: 'where', history: [{ tool: 'report_location', verdict: 'rejected', reason: 'x' }] });
  assert.equal(r.done, true);
});

// ---------- FCM + gate ----------

function serviceAccount(tokenUri) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { sa: { type: 'service_account', project_id: 'demo-proj', client_email: 'robot@demo-proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: tokenUri }, publicKey };
}

test('FCM: JWT is RS256-signed for the service account; service account parses from JSON or base64', () => {
  const { sa, publicKey } = serviceAccount('https://oauth2.example/token');
  const jwt = signJwt(sa, 1_000_000);
  const [h, c, s] = jwt.split('.');
  assert.equal(JSON.parse(Buffer.from(h, 'base64url')).alg, 'RS256');
  const claims = JSON.parse(Buffer.from(c, 'base64url'));
  assert.equal(claims.iss, sa.client_email);
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(s, 'base64url')));
  assert.equal(parseServiceAccount(Buffer.from(JSON.stringify(sa)).toString('base64')).project_id, 'demo-proj');
  assert.equal(parseServiceAccount(''), null);
  assert.throws(() => parseServiceAccount('{"project_id":"x"}'), /client_email/);
});

async function fakeGoogle() {
  const sends = [];
  let fail = false;
  const s = await mock(async (req, res) => {
    const body = await readJsonBody(req);
    if (req.url === '/token') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ access_token: 'at-1', expires_in: 3600 })); }
    if (req.url === '/v1/projects/demo-proj/messages:send') {
      sends.push({ auth: req.headers.authorization, body });
      res.writeHead(fail ? 503 : 200, { 'content-type': 'application/json' });
      return res.end('{"name":"projects/demo-proj/messages/1"}');
    }
    res.writeHead(404); res.end();
  });
  return { url: s.url, sends, setFail: (v) => { fail = v; } };
}

test('FCM lit: owner command is queued AND pushed as a high-priority data nudge', async () => {
  const g = await fakeGoogle();
  const { sa } = serviceAccount(g.url + '/token');
  const a = await app({ fcm: new Fcm(sa, { apiBase: g.url }) });
  await a.ingest();
  await a.json('POST', '/devices/fcm', { token: TOKEN, body: { device: 'pixel-8', token: 'reg_' + 'b'.repeat(40) } });
  const sent = await a.json('POST', '/commands', { token: VIEW, body: { type: 'start' } });
  assert.equal(sent.body.via, 'fcm');
  assert.equal(g.sends.length, 1);
  assert.equal(g.sends[0].auth, 'Bearer at-1');
  assert.deepEqual(g.sends[0].body.message.data, { kind: 'commands', id: sent.body.command.id, type: 'start' });
  assert.equal(g.sends[0].body.message.android.priority, 'high');
  assert.equal((await a.json('GET', '/commands?device=pixel-8', { token: TOKEN })).body.commands.length, 1, 'still pollable');
  assert.ok(a.audit.list().some((e) => e.kind === 'gate_unknown' && e.provider === 'fcm'), 'no status source → unknown, recorded');

  g.setFail(true);
  const failed = await a.json('POST', '/commands', { token: VIEW, body: { type: 'ping' } });
  assert.equal(failed.body.via, 'poll');
  assert.ok(a.audit.list().some((e) => e.kind === 'fallback' && /HTTP 503/.test(e.reason)));
});

test('FCM dark (via DIS_URL lights) → no push, polling fallback, audited', async () => {
  const g = await fakeGoogle();
  const dis = await mock((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(req.url === '/lights/firebase-fcm/LIGHT' ? 'dark' : 'lit'); });
  const { sa } = serviceAccount(g.url + '/token');
  const gate = new Gate({ disUrl: dis.url, providers: { fcm: { disTarget: 'firebase-fcm', feed: null }, llm: { disTarget: null, feed: null } } });
  const a = await app({ fcm: new Fcm(sa, { apiBase: g.url }), gate });
  await a.ingest();
  await a.json('POST', '/devices/fcm', { token: TOKEN, body: { device: 'pixel-8', token: 'reg_' + 'c'.repeat(40) } });
  const t = (await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'tell me hello' } })).body;
  assert.equal(t.turns[0].result.via, 'poll');
  assert.equal(g.sends.length, 0);
  const dark = a.audit.list({ kind: 'gate_dark' })[0];
  assert.equal(dark.source, 'dis:firebase-fcm');
  assert.equal(dark.fallback, 'poll');
});

test('gate: status feed (google format), DIS unreachable → unknown, caching', async () => {
  let hits = 0;
  const now = Date.now();
  const feed = await mock((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([{ id: 'i', begin: new Date(now - 3600_000).toISOString(), end: null, status_impact: 'SERVICE_OUTAGE', external_desc: 'FCM down', affected_products: [{ title: 'Cloud Messaging' }] }]));
  });
  const g = new Gate({ providers: { fcm: { disTarget: null, feed: { format: 'google', url: feed.url + '/incidents.json', product: 'Cloud Messaging' } } } });
  assert.equal((await g.check('fcm')).light, 'dark');
  assert.equal((await g.check('fcm')).cached, true);
  assert.equal(hits, 1);
  const down = new Gate({ disUrl: 'http://127.0.0.1:1', providers: { fcm: { disTarget: 'firebase-fcm' } } });
  assert.equal((await down.check('fcm')).light, 'unknown');
  assert.equal((await new Gate().check('nope')).light, 'unknown');
});

// ---------- audit ----------

test('audit: append-only, hash-chained, tamper-evident; GET /audit needs the view token', async () => {
  const a = await app();
  await a.ingest();
  await a.json('POST', '/tasks', { token: VIEW, body: { goal: 'where is the phone' } });
  assert.equal((await a.json('GET', '/audit', { token: TOKEN })).status, 401);
  const r = await a.json('GET', '/audit?verify=1&limit=5', { token: VIEW });
  assert.equal(r.status, 200);
  assert.equal(r.body.entries.length, 5);
  assert.equal(r.body.chain.ok, true);
  const seqs = r.body.entries.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));

  const file = join(a.dir, 'audit.ndjson');
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  const e = JSON.parse(lines[1]);
  e.kind = 'edited';
  lines[1] = JSON.stringify(e);
  writeFileSync(file, lines.join('\n') + '\n');
  const v = new Audit(a.dir).verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
});

test('rate limits: sliding window', () => {
  let t = 0;
  const rl = new RateLimits({ x: { max: 2, windowMs: 1000 } }, { now: () => t });
  assert.ok(rl.take('x').ok); assert.ok(rl.take('x').ok);
  const no = rl.take('x');
  assert.equal(no.ok, false);
  assert.equal(no.retryAfterS, 1);
  t = 1001;
  assert.ok(rl.take('x').ok);
  assert.throws(() => rl.take('y'), /no rate limit/);
});

test('backward compatible: milestone-1 upload unchanged, features endpoint describes M2', async () => {
  const a = await app();
  const r = await a.ingest();
  assert.deepEqual(r.body, { ok: true, stored: 1 });
  const f = await a.json('GET', '/api/features', { token: VIEW });
  assert.deepEqual(f.body, { fcm: false, planner: 'rules', maxTurns: 4, tools: ['report_location', 'notify_user', 'stop'] });
});
