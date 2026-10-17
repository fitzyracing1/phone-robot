// Append-only NDJSON store: one file per UTC day (points-YYYY-MM-DD.ndjson), plus an in-memory ring of recent
// points for the page. Each line: {device, t, receivedAt, ...sample}.
import { mkdirSync, appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export class Store {
  constructor(dir, { recentMax = 5000 } = {}) {
    this.dir = dir;
    this.recentMax = recentMax;
    this.recent = [];
    mkdirSync(dir, { recursive: true });
    this.load();
  }

  files() {
    return readdirSync(this.dir).filter((f) => /^points-\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)).sort();
  }

  /** Warm the ring from the newest files so a restart doesn't blank the page. */
  load() {
    const out = [];
    for (const f of this.files().reverse()) {
      const lines = readFileSync(join(this.dir, f), 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && out.length < this.recentMax; i--) {
        try { out.push(JSON.parse(lines[i])); } catch { /* skip a torn last line */ }
      }
      if (out.length >= this.recentMax) break;
    }
    this.recent = out.reverse().sort((a, b) => a.t - b.t);
  }

  append(device, samples, now = Date.now()) {
    const byDay = new Map();
    const rows = samples.map((s) => ({ device, ...s, receivedAt: now }));
    for (const r of rows) {
      const day = new Date(r.t).toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(JSON.stringify(r));
    }
    for (const [day, lines] of byDay) appendFileSync(join(this.dir, `points-${day}.ndjson`), lines.join('\n') + '\n');
    this.recent.push(...rows);
    this.recent.sort((a, b) => a.t - b.t);
    if (this.recent.length > this.recentMax) this.recent.splice(0, this.recent.length - this.recentMax);
    return rows.length;
  }

  devices() {
    return [...new Set(this.recent.map((r) => r.device))];
  }

  latest(device) {
    for (let i = this.recent.length - 1; i >= 0; i--) {
      const r = this.recent[i];
      if (!device || r.device === device) return r;
    }
    return null;
  }

  /** Points for the map: recent samples that carry a location. */
  track({ device, minutes = 60, limit = 2000, now = Date.now() } = {}) {
    const since = now - minutes * 60_000;
    const pts = this.recent.filter((r) => r.loc && r.t >= since && (!device || r.device === device));
    return pts.slice(-limit);
  }
}
