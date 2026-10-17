// Optional Firebase Cloud Messaging (HTTP v1) sender. Zero dependencies: the OAuth token is minted from the service
// account with an RS256 JWT signed by node:crypto. Configure with FCM_SERVICE_ACCOUNT_JSON (the JSON itself, or
// base64 of it). Without it, FCM is simply off and the app gets commands by polling.
//
// Pushes are only wake-up nudges ({kind:"commands", id, type}); the command itself always stays in the queue, so a
// lost push costs one poll interval, never a command.
import { createSign } from 'node:crypto';

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export function parseServiceAccount(raw) {
  if (!raw || !String(raw).trim()) return null;
  let text = String(raw).trim();
  if (!text.startsWith('{')) text = Buffer.from(text, 'base64').toString('utf8');
  const sa = JSON.parse(text);
  for (const k of ['client_email', 'private_key', 'project_id']) if (!sa[k]) throw new Error(`FCM service account is missing ${k}`);
  return { client_email: sa.client_email, private_key: sa.private_key, project_id: sa.project_id, token_uri: sa.token_uri || 'https://oauth2.googleapis.com/token' };
}

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export function signJwt(sa, nowS = Math.floor(Date.now() / 1000)) {
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const claims = b64url({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri, iat: nowS, exp: nowS + 3600 });
  const sig = createSign('RSA-SHA256').update(`${head}.${claims}`).sign(sa.private_key).toString('base64url');
  return `${head}.${claims}.${sig}`;
}

export class Fcm {
  constructor(sa, { fetchImpl = globalThis.fetch, apiBase = 'https://fcm.googleapis.com', now = () => Date.now() } = {}) {
    this.sa = sa;
    this.fetch = fetchImpl;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.now = now;
    this.token = null;
  }

  async accessToken() {
    if (this.token && this.now() < this.token.exp - 60_000) return this.token.value;
    const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signJwt(this.sa, Math.floor(this.now() / 1000)) });
    const r = await this.fetch(this.sa.token_uri, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`FCM auth failed: HTTP ${r.status}`);
    const j = await r.json();
    this.token = { value: j.access_token, exp: this.now() + (Number(j.expires_in) || 3600) * 1000 };
    return this.token.value;
  }

  /** Send a data-only, high-priority wake-up to one registration token. Returns { ok, status, error? }. */
  async nudge(registrationToken, data) {
    try {
      const at = await this.accessToken();
      const msg = { message: { token: registrationToken, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])), android: { priority: 'high', ttl: '600s' } } };
      const r = await this.fetch(`${this.apiBase}/v1/projects/${encodeURIComponent(this.sa.project_id)}/messages:send`, {
        method: 'POST', headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' }, body: JSON.stringify(msg), signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) return { ok: false, status: r.status, error: (await r.text()).slice(0, 200) };
      return { ok: true, status: r.status };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }
}
