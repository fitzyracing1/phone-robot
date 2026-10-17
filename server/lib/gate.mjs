// DIS dependency gate. Before the server uses an outside provider (FCM, the LLM endpoint) it asks whether that
// provider is lit:
//   - DIS_URL set:   GET {DIS_URL}/lights/{target}/LIGHT  → "lit" | "dark" | "pending"  (a DIS you run with
//                    examples/phone-providers.config.json; targets default to firebase-fcm and $DIS_LLM_TARGET)
//   - otherwise:     read the provider's public status feed directly with DIS's status logic (status-feeds.mjs).
// Answers are cached for GATE_CACHE_S (120 s). "dark" means: don't use it, fall back. If the status can't be
// determined ("unknown"), the provider is used and that is recorded.
import { checkStatus } from './status-feeds.mjs';

export const PROVIDERS_DEFAULT = {
  fcm: { disTarget: 'firebase-fcm', feed: { format: 'google', url: 'https://status.firebase.google.com/incidents.json', product: 'Cloud Messaging' } },
  llm: { disTarget: null, feed: null },
};

export function providersFromEnv(env = process.env) {
  const p = structuredClone(PROVIDERS_DEFAULT);
  if (env.DIS_FCM_TARGET) p.fcm.disTarget = env.DIS_FCM_TARGET;
  if (env.DIS_LLM_TARGET) p.llm.disTarget = env.DIS_LLM_TARGET;
  if (env.PLANNER_STATUS_URL) {
    p.llm.feed = { format: env.PLANNER_STATUS_FORMAT || 'statuspage', url: env.PLANNER_STATUS_URL };
    if (env.PLANNER_STATUS_COMPONENT) p.llm.feed.component = env.PLANNER_STATUS_COMPONENT;
  }
  return p;
}

export class Gate {
  constructor({ disUrl = '', providers = PROVIDERS_DEFAULT, fetchImpl = globalThis.fetch, cacheMs = 120_000, now = () => Date.now() } = {}) {
    this.disUrl = disUrl.replace(/\/+$/, '');
    this.providers = providers;
    this.fetch = fetchImpl;
    this.cacheMs = cacheMs;
    this.now = now;
    this.cache = new Map();
  }

  /** Returns { provider, light: 'lit'|'dark'|'unknown', source, detail }. Never throws. */
  async check(provider) {
    const hit = this.cache.get(provider);
    if (hit && this.now() - hit.at < this.cacheMs) return { ...hit.result, cached: true };
    const result = await this.#check(provider);
    this.cache.set(provider, { at: this.now(), result });
    return result;
  }

  async #check(provider) {
    const cfg = this.providers[provider];
    if (!cfg) return { provider, light: 'unknown', source: 'none', detail: 'unknown provider' };
    if (this.disUrl && cfg.disTarget) {
      try {
        const r = await this.fetch(`${this.disUrl}/lights/${encodeURIComponent(cfg.disTarget)}/LIGHT`, { signal: AbortSignal.timeout(8000) });
        const text = (await r.text()).trim();
        if (r.ok && (text === 'lit' || text === 'dark')) return { provider, light: text, source: `dis:${cfg.disTarget}`, detail: `DIS says ${text}` };
        return { provider, light: 'unknown', source: `dis:${cfg.disTarget}`, detail: `DIS answered HTTP ${r.status} ${text.slice(0, 40)}` };
      } catch (e) {
        return { provider, light: 'unknown', source: `dis:${cfg.disTarget}`, detail: `DIS unreachable: ${e.message}` };
      }
    }
    if (cfg.feed) {
      const r = await checkStatus({ ...cfg.feed, type: 'status', timeoutMs: 8000, maxLatencyMs: 8000 }, { fetchImpl: this.fetch });
      // A feed we couldn't read is "unknown", not "dark": only the provider saying it's down blocks it.
      const unreadable = /request failed|HTTP \d|not valid JSON|timeout|too slow/.test(r.detail) && !r.ok;
      return { provider, light: unreadable ? 'unknown' : r.light, source: `feed:${cfg.feed.url}`, detail: r.detail };
    }
    return { provider, light: 'unknown', source: 'none', detail: 'no status source configured' };
  }
}
