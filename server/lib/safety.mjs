// Safety layer. Plain code; the planner (rules or LLM) only proposes, this decides.
//   - fixed tool allowlist (report_location, notify_user, stop) and strict argument schemas
//   - hard max turns per task (4)
//   - rate limits (tasks, notifications, owner commands, LLM calls)
//   - one recipient only: the owner's own phone (a device that has uploaded or polled with the device token).
//     There is no tool that can reach a phone number, email address or anyone else.
export const MAX_TURNS = 4;

export const TOOLS = {
  report_location: {
    description: "Read the phone's latest logged position, activity and battery from the server. No arguments.",
    args: {},
  },
  notify_user: {
    description: "Show a notification on the owner's phone. The only person this can reach is the phone's owner.",
    args: { title: { type: 'string', max: 60, optional: true }, body: { type: 'string', max: 240 } },
  },
  stop: {
    description: 'Pause location logging on the phone and end the task.',
    args: { reason: { type: 'string', max: 120, optional: true } },
  },
};
export const TOOL_NAMES = Object.keys(TOOLS);

// Control characters out; whitespace collapsed. Keeps notification text plain.
const clean = (s) => String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();

/** Validate tool arguments against the schema. Returns { ok, args } or { ok:false, reason }. */
export function validateArgs(tool, args) {
  const spec = TOOLS[tool];
  if (!spec) return { ok: false, reason: `tool "${String(tool).slice(0, 40)}" is not allowed (allowed: ${TOOL_NAMES.join(', ')})` };
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return { ok: false, reason: 'arguments must be an object' };
  const out = {};
  for (const k of Object.keys(args)) if (!spec.args[k]) return { ok: false, reason: `unknown argument "${k.slice(0, 40)}" for ${tool}` };
  for (const [k, rule] of Object.entries(spec.args)) {
    const v = args[k];
    if (v == null || v === '') { if (!rule.optional) return { ok: false, reason: `${tool}.${k} is required` }; continue; }
    if (typeof v !== 'string') return { ok: false, reason: `${tool}.${k} must be a string` };
    const c = clean(v);
    if (!c && !rule.optional) return { ok: false, reason: `${tool}.${k} is empty` };
    if (c.length > rule.max) return { ok: false, reason: `${tool}.${k} is longer than ${rule.max} characters` };
    if (c) out[k] = c;
  }
  return { ok: true, args: out };
}

export class Safety {
  constructor({ limits, audit, maxTurns = MAX_TURNS }) {
    this.limits = limits;
    this.audit = audit;
    this.maxTurns = Math.min(maxTurns, MAX_TURNS); // can be lowered, never raised past 4
  }

  /** Decide on one proposed tool call. Every verdict is audited. */
  check({ taskId, turn, tool, args, planner }) {
    const verdict = (ok, extra) => {
      this.audit.write('safety', { taskId, turn, planner, tool: String(tool ?? '').slice(0, 40), verdict: ok ? 'allow' : 'reject', ...extra });
      return ok ? { ok: true, args: extra.args } : { ok: false, reason: extra.reason };
    };
    if (turn > this.maxTurns) return verdict(false, { reason: `turn ${turn} exceeds maxTurns ${this.maxTurns}` });
    const v = validateArgs(tool, args);
    if (!v.ok) return verdict(false, { reason: v.reason });
    if (tool === 'notify_user') {
      const r = this.limits.take('notify');
      if (!r.ok) return verdict(false, { reason: `notification rate limit reached; retry in ${r.retryAfterS}s` });
    }
    return verdict(true, { args: v.args });
  }
}
