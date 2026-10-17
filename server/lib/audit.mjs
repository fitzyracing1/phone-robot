// Append-only audit log: DATA_DIR/audit.ndjson. Every planner turn, safety verdict, command, gate decision and
// fallback is one line. Lines are hash-chained (each carries sha256(prev hash + line body)), so an edited or
// deleted line is detectable with verify(). Nothing is ever rewritten.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const hash = (prev, body) => createHash('sha256').update(prev + '\n' + body).digest('hex');

export class Audit {
  constructor(dir, { now = () => Date.now(), keepInMemory = 2000 } = {}) {
    this.file = join(dir, 'audit.ndjson');
    this.now = now;
    this.keep = keepInMemory;
    this.recent = [];
    this.seq = 0;
    this.prev = 'genesis';
    if (existsSync(this.file)) {
      for (const line of readFileSync(this.file, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          this.seq = e.seq;
          this.prev = e.hash;
          this.recent.push(e);
          if (this.recent.length > this.keep) this.recent.shift();
        } catch { /* torn last line: ignored, chain continues from the last good entry */ }
      }
    }
  }

  /** Record one event. Returns the stored entry. */
  write(kind, fields = {}) {
    const entry = { ...fields, seq: this.seq + 1, at: new Date(this.now()).toISOString(), kind };
    const body = JSON.stringify(entry);
    entry.hash = hash(this.prev, body);
    appendFileSync(this.file, JSON.stringify(entry) + '\n', { flag: 'a' });
    this.seq = entry.seq;
    this.prev = entry.hash;
    this.recent.push(entry);
    if (this.recent.length > this.keep) this.recent.shift();
    return entry;
  }

  list({ limit = 200, taskId, kind } = {}) {
    let out = this.recent;
    if (taskId) out = out.filter((e) => e.taskId === taskId);
    if (kind) out = out.filter((e) => e.kind === kind);
    return out.slice(-limit);
  }

  /** Re-check the whole chain on disk. Returns { ok, entries, brokenAt? }. */
  verify() {
    if (!existsSync(this.file)) return { ok: true, entries: 0 };
    let prev = 'genesis';
    let n = 0;
    for (const line of readFileSync(this.file, 'utf8').split('\n')) {
      if (!line) continue;
      const e = JSON.parse(line);
      const { hash: h, ...rest } = e;
      if (hash(prev, JSON.stringify(rest)) !== h) return { ok: false, entries: n, brokenAt: e.seq };
      prev = h;
      n++;
    }
    return { ok: true, entries: n };
  }
}
