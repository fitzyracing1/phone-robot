// Task planner. Each turn a planner proposes ONE tool call (or finishes); the safety layer decides; the tool runs;
// the result feeds the next turn. Hard limit: MAX_TURNS (4).
//   - RulePlanner (default): deterministic keyword rules.
//   - LlmPlanner (optional): any OpenAI-compatible /chat/completions endpoint (PLANNER_BASE_URL, PLANNER_API_KEY,
//     PLANNER_MODEL). It is offered only the 3 tools as JSON function tools; anything else it says is ignored or
//     rejected by the safety layer. If the endpoint is dark (DIS gate), rate-limited, or errors, the task continues
//     with the rule planner and the fallback is audited.
import { randomUUID } from 'node:crypto';
import { TOOLS, TOOL_NAMES } from './safety.mjs';

const fmtAge = (s) => (s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`);

/** Human sentence for a report_location result. */
export function describeLocation(r) {
  if (!r || !r.found) return 'No location has been logged yet.';
  if (!r.loc) return `Last sample ${fmtAge(r.ageS)} ago had no GPS fix${r.activity ? ` (${r.activity})` : ''}.`;
  return `Phone at ${r.loc.lat.toFixed(5)}, ${r.loc.lon.toFixed(5)} (±${Math.round(r.loc.acc ?? 0)} m), ${fmtAge(r.ageS)} ago` +
    `${r.activity ? `, ${r.activity.toLowerCase().replace('_', ' ')}` : ''}${typeof r.battery === 'number' ? `, battery ${r.battery}%` : ''}.`;
}

export class RulePlanner {
  name = 'rules';

  async next({ goal, history }) {
    const g = goal.toLowerCase();
    const ok = (t) => history.find((h) => h.tool === t && h.verdict === 'ok');
    const rejected = history.find((h) => h.verdict === 'rejected');
    if (rejected) return { done: true, summary: `Stopped: ${rejected.tool} was rejected (${rejected.reason}).` };

    if (/\b(stop|pause|halt|quit|end)\b/.test(g) && /\b(log|logging|track|tracking|record|recording|it|robot|phone)\b|^\s*(stop|pause)\s*$/.test(g)) {
      if (!ok('notify_user')) return { tool: 'notify_user', args: { title: 'phone-robot', body: 'Pausing location logging as requested.' } };
      if (!ok('stop')) return { tool: 'stop', args: { reason: `owner asked: ${goal.slice(0, 100)}` } };
      return { done: true, summary: 'Logging paused.' };
    }
    if (/\bwhere\b|locat|\bfind\b|position|\bgps\b/.test(g)) {
      const rep = ok('report_location');
      if (!rep) return { tool: 'report_location', args: {} };
      if (!ok('notify_user')) return { tool: 'notify_user', args: { title: 'Where is the phone?', body: describeLocation(rep.result) } };
      return { done: true, summary: describeLocation(rep.result) };
    }
    if (/\b(notify|tell|remind|say|message|alert)\b/.test(g)) {
      if (!ok('notify_user')) {
        const body = goal.replace(/^\s*(please\s+)?(notify|tell|remind|alert|message)\s+(me\s+)?(to\s+|that\s+)?/i, '').replace(/^say\s+/i, '').trim() || goal;
        return { tool: 'notify_user', args: { title: 'phone-robot', body: body.slice(0, 240) } };
      }
      return { done: true, summary: 'Notification sent to your phone.' };
    }
    if (/status|battery|how is|how's/.test(g)) {
      const rep = ok('report_location');
      if (!rep) return { tool: 'report_location', args: {} };
      return { done: true, summary: describeLocation(rep.result) };
    }
    return { done: true, summary: 'No rule matched. Try "where is the phone?", "tell me <text>", or "stop logging".' };
  }
}

/** OpenAI tool definitions generated from the safety schema (the same allowlist the safety layer enforces). */
export function openAiTools() {
  return TOOL_NAMES.map((name) => {
    const props = {};
    const required = [];
    for (const [k, r] of Object.entries(TOOLS[name].args)) {
      props[k] = { type: 'string', maxLength: r.max };
      if (!r.optional) required.push(k);
    }
    return { type: 'function', function: { name, description: TOOLS[name].description, parameters: { type: 'object', properties: props, required, additionalProperties: false } } };
  });
}

const SYSTEM = [
  "You control a phone-logging robot for the phone's owner. You can ONLY call these tools: report_location, notify_user, stop.",
  'Call at most one tool per reply. You have at most 4 turns. When the goal is met, reply with a short plain-text summary and no tool call.',
  'notify_user can only reach the phone owner. Never try to contact anyone else, and never invent tools.',
].join(' ');

export class LlmPlanner {
  name = 'llm';

  constructor({ baseUrl, apiKey = '', model, fetchImpl = globalThis.fetch, timeoutMs = 20_000 }) {
    this.url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    this.apiKey = apiKey;
    this.model = model;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  /** Builds the chat from the goal and the turn history; returns {tool,args,raw} or {done,summary}. Throws on API/format errors. */
  async next({ goal, device, history }) {
    const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Goal: ${goal}\nDevice: ${device}\nTime: ${new Date().toISOString()}` }];
    history.forEach((h, i) => {
      if (!h.tool) return;
      const id = `call_${i + 1}`;
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: h.tool, arguments: JSON.stringify(h.args ?? {}) } }] });
      messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(h.verdict === 'ok' ? h.result ?? {} : { error: `rejected by safety layer: ${h.reason}` }) });
    });
    const r = await this.fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, messages, tools: openAiTools(), tool_choice: 'auto', temperature: 0, max_tokens: 300 }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!r.ok) throw new Error(`LLM endpoint HTTP ${r.status}`);
    const j = await r.json();
    const msg = j?.choices?.[0]?.message;
    if (!msg) throw new Error('LLM response has no message');
    const call = msg.tool_calls?.[0];
    if (!call) return { done: true, summary: String(msg.content || 'Done.').slice(0, 300) };
    let args;
    try { args = call.function?.arguments ? JSON.parse(call.function.arguments) : {}; } catch { args = { __invalid_json__: String(call.function.arguments).slice(0, 80) }; }
    return { tool: String(call.function?.name || ''), args, extraCalls: (msg.tool_calls.length || 1) - 1 };
  }
}

export function llmFromEnv(env = process.env, fetchImpl) {
  if (!env.PLANNER_BASE_URL || !env.PLANNER_MODEL) return null;
  return new LlmPlanner({ baseUrl: env.PLANNER_BASE_URL, apiKey: env.PLANNER_API_KEY || '', model: env.PLANNER_MODEL, fetchImpl });
}

/**
 * Run one task. deps: { store, dispatcher, safety, audit, gate, limits, llm (LlmPlanner|null), rules }.
 * Returns the transcript.
 */
export async function runTask({ goal, device }, deps) {
  const { store, dispatcher, safety, audit, gate, limits, llm } = deps;
  const rules = deps.rules || new RulePlanner();
  const taskId = randomUUID();
  const transcript = { taskId, goal, device, planner: rules.name, turns: [], done: false, summary: '', endedBy: '' };
  audit.write('task_start', { taskId, goal, device });

  let planner = rules;
  if (llm) {
    const g = await gate.check('llm');
    if (g.light === 'dark') {
      audit.write('gate_dark', { taskId, provider: 'llm', source: g.source, detail: g.detail, fallback: 'rules' });
    } else {
      if (g.light === 'unknown') audit.write('gate_unknown', { taskId, provider: 'llm', source: g.source, detail: g.detail });
      planner = llm;
    }
  }
  transcript.planner = planner.name;

  const history = [];
  for (let turn = 1; turn <= safety.maxTurns; turn++) {
    let proposal;
    if (planner === llm) {
      const rl = limits.take('llm');
      if (!rl.ok) {
        audit.write('fallback', { taskId, turn, provider: 'llm', to: 'rules', reason: 'LLM rate limit reached' });
        planner = rules;
      } else {
        try { proposal = await llm.next({ goal, device, history }); }
        catch (e) {
          audit.write('fallback', { taskId, turn, provider: 'llm', to: 'rules', reason: e.message.slice(0, 200) });
          planner = rules;
        }
      }
    }
    if (!proposal) proposal = await planner.next({ goal, device, history });
    if (planner === rules && transcript.planner === 'llm') transcript.planner = 'llm→rules';

    if (proposal.done) {
      transcript.done = true;
      transcript.summary = proposal.summary;
      transcript.endedBy = 'planner';
      break;
    }
    const v = safety.check({ taskId, turn, tool: proposal.tool, args: proposal.args, planner: planner.name });
    const entry = { n: turn, planner: planner.name, tool: String(proposal.tool).slice(0, 40), args: v.ok ? v.args : proposal.args };
    if (!v.ok) {
      Object.assign(entry, { verdict: 'rejected', reason: v.reason });
      history.push(entry);
      transcript.turns.push(entry);
      continue;
    }
    const result = await execute(proposal.tool, v.args, { taskId, device, store, dispatcher });
    Object.assign(entry, { verdict: 'ok', result });
    audit.write('tool', { taskId, turn, tool: proposal.tool, args: v.args, result });
    history.push(entry);
    transcript.turns.push(entry);
    if (proposal.tool === 'stop') {
      transcript.done = true;
      transcript.endedBy = 'stop';
      transcript.summary = 'Logging paused; task ended.';
      break;
    }
  }
  if (!transcript.done) {
    transcript.endedBy = 'max_turns';
    transcript.summary = `Stopped after ${safety.maxTurns} turns (maxTurns).`;
    audit.write('max_turns', { taskId, maxTurns: safety.maxTurns });
  }
  audit.write('task_end', { taskId, planner: transcript.planner, endedBy: transcript.endedBy, turns: transcript.turns.length, summary: transcript.summary });
  return transcript;
}

async function execute(tool, args, { taskId, device, store, dispatcher }) {
  if (tool === 'report_location') {
    const p = store.latest(device);
    if (!p) return { found: false };
    return { found: true, ageS: Math.max(0, Math.round((Date.now() - p.t) / 1000)), loc: p.loc ? { lat: p.loc.lat, lon: p.loc.lon, acc: p.loc.acc } : null, activity: p.activity ?? null, battery: p.battery ?? null };
  }
  if (tool === 'notify_user') {
    const { command, via } = await dispatcher.send(device, 'notify', { title: args.title || 'phone-robot', body: args.body }, { source: 'planner', taskId });
    return { queued: true, commandId: command.id, via };
  }
  if (tool === 'stop') {
    const { command, via } = await dispatcher.send(device, 'stop', { reason: args.reason || '' }, { source: 'planner', taskId });
    return { queued: true, commandId: command.id, via };
  }
  throw new Error(`no executor for ${tool}`); // unreachable: safety allowlist
}
