// Sliding-window counters for the safety layer (in memory; a restart resets them, which only ever makes it stricter
// to abuse across restarts, not looser within one).
export class RateLimits {
  constructor(limits, { now = () => Date.now() } = {}) {
    this.limits = limits; // { key: { max, windowMs } }
    this.now = now;
    this.hits = new Map();
  }

  /** Try to use one unit of `key`. Returns { ok, remaining, retryAfterS }. */
  take(key) {
    const lim = this.limits[key];
    if (!lim) throw new Error(`no rate limit defined for ${key}`);
    const t = this.now();
    const arr = (this.hits.get(key) || []).filter((x) => t - x < lim.windowMs);
    if (arr.length >= lim.max) {
      this.hits.set(key, arr);
      return { ok: false, remaining: 0, retryAfterS: Math.ceil((lim.windowMs - (t - arr[0])) / 1000) };
    }
    arr.push(t);
    this.hits.set(key, arr);
    return { ok: true, remaining: lim.max - arr.length };
  }
}

export function limitsFromEnv(env = process.env) {
  const n = (k, d) => Math.max(1, Number(env[k]) || d);
  const H = 3600_000;
  return {
    tasks: { max: n('TASKS_PER_HOUR', 30), windowMs: H },
    notify: { max: n('NOTIFY_PER_HOUR', 10), windowMs: H },
    commands: { max: n('COMMANDS_PER_HOUR', 60), windowMs: H },
    llm: { max: n('LLM_CALLS_PER_HOUR', 60), windowMs: H },
  };
}
