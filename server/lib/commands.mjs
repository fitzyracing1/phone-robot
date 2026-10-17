// Command queue for the phone: start / stop / ping (from the owner) and notify (from the planner).
// Persisted to DATA_DIR/commands.json (rewritten atomically; small). The app fetches pending commands with
// GET /commands on its upload cycle and acknowledges them; an FCM push, if configured, only makes it fetch sooner.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const COMMAND_TYPES = ['start', 'stop', 'ping', 'notify'];
export const OWNER_COMMANDS = ['start', 'stop', 'ping'];
const KEEP = 500;

function load(file, fallback) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}
function save(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, file);
}

export class Commands {
  constructor(dir, { now = () => Date.now(), ttlMs = 24 * 3600_000 } = {}) {
    this.file = join(dir, 'commands.json');
    this.devFile = join(dir, 'devices.json');
    this.now = now;
    this.ttlMs = ttlMs;
    this.items = load(this.file, []);
    this.devices = load(this.devFile, {}); // device → { fcmToken?, fcmAt?, lastPollAt? }
  }

  #persist() { save(this.file, this.items.slice(-KEEP)); this.items = this.items.slice(-KEEP); }
  #persistDevices() { save(this.devFile, this.devices); }

  add(device, type, args = {}, { source = 'owner', taskId } = {}) {
    if (!COMMAND_TYPES.includes(type)) throw Object.assign(new Error(`type must be one of ${COMMAND_TYPES.join(', ')}`), { status: 400 });
    const c = { id: randomUUID(), device, type, args, source, taskId, status: 'pending', createdAt: this.now(), via: ['poll'] };
    this.items.push(c);
    this.#persist();
    return c;
  }

  get(id) { return this.items.find((c) => c.id === id) || null; }

  markVia(id, via) {
    const c = this.get(id);
    if (c && !c.via.includes(via)) { c.via.push(via); this.#persist(); }
  }

  /** Pending (and delivered-but-unacked) commands for a device, oldest first. Expired ones are marked expired. */
  pendingFor(device) {
    const t = this.now();
    let changed = false;
    const out = [];
    for (const c of this.items) {
      if (c.device !== device || (c.status !== 'pending' && c.status !== 'delivered')) continue;
      if (t - c.createdAt > this.ttlMs) { c.status = 'expired'; changed = true; continue; }
      if (c.status === 'pending') { c.status = 'delivered'; c.deliveredAt = t; changed = true; }
      out.push({ id: c.id, type: c.type, args: c.args, createdAt: c.createdAt });
    }
    this.devices[device] = { ...(this.devices[device] || {}), lastPollAt: t };
    this.#persistDevices();
    if (changed) this.#persist();
    return out;
  }

  /** Acknowledge commands. Only the device a command was addressed to can ack it. Returns how many were updated. */
  ack(device, acks) {
    let n = 0;
    for (const a of acks) {
      const c = this.get(a.id);
      if (!c || c.device !== device || c.status === 'acked') continue;
      c.status = 'acked';
      c.ackedAt = this.now();
      c.ok = a.ok !== false;
      if (a.result !== undefined) c.result = a.result;
      n++;
    }
    if (n) this.#persist();
    return n;
  }

  recent({ device, limit = 50 } = {}) {
    return this.items.filter((c) => !device || c.device === device).slice(-limit);
  }

  setFcmToken(device, token) {
    this.devices[device] = { ...(this.devices[device] || {}), fcmToken: token, fcmAt: this.now() };
    this.#persistDevices();
  }

  fcmToken(device) { return this.devices[device]?.fcmToken || null; }
  lastPollAt(device) { return this.devices[device]?.lastPollAt || null; }
  knownDevices() { return Object.keys(this.devices); }
}
