// Puts a command in the phone's queue and, if FCM is configured and the gate says it's lit, nudges the phone.
// FCM dark, not configured, no token yet, or the push fails → the phone still gets it on its next poll.
export class Dispatcher {
  constructor({ commands, audit, gate, fcm = null }) {
    Object.assign(this, { commands, audit, gate, fcm });
  }

  async send(device, type, args = {}, meta = {}) {
    const c = this.commands.add(device, type, args, meta);
    this.audit.write('command', { taskId: meta.taskId, actor: meta.source || 'owner', device, type, commandId: c.id, args: type === 'notify' ? args : undefined });
    let via = 'poll';
    const token = this.fcm && this.commands.fcmToken(device);
    if (!this.fcm) {
      // FCM not configured: polling is the normal path, nothing to record beyond the command.
    } else if (!token) {
      this.audit.write('fallback', { taskId: meta.taskId, commandId: c.id, provider: 'fcm', to: 'poll', reason: 'device has not registered an FCM token' });
    } else {
      const g = await this.gate.check('fcm');
      if (g.light === 'dark') {
        this.audit.write('gate_dark', { taskId: meta.taskId, commandId: c.id, provider: 'fcm', source: g.source, detail: g.detail, fallback: 'poll' });
      } else {
        if (g.light === 'unknown') this.audit.write('gate_unknown', { taskId: meta.taskId, provider: 'fcm', source: g.source, detail: g.detail });
        const r = await this.fcm.nudge(token, { kind: 'commands', id: c.id, type });
        if (r.ok) { via = 'fcm'; this.commands.markVia(c.id, 'fcm'); this.audit.write('fcm_nudge', { taskId: meta.taskId, commandId: c.id, ok: true }); }
        else this.audit.write('fallback', { taskId: meta.taskId, commandId: c.id, provider: 'fcm', to: 'poll', reason: `FCM send failed: HTTP ${r.status} ${r.error || ''}`.trim() });
      }
    }
    return { command: c, via };
  }
}
