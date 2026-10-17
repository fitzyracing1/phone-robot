// Validate one upload from the app. Returns { device, samples } or throws { status, message }.
export const LIMITS = Object.freeze({ maxSamples: 500, maxTransitions: 20 });

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const DEVICE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ACTIVITIES = ['IN_VEHICLE', 'ON_BICYCLE', 'ON_FOOT', 'RUNNING', 'STILL', 'TILTING', 'WALKING', 'UNKNOWN'];

function stats(s, where) {
  if (s == null) return null;
  if (typeof s !== 'object') throw bad(`${where} must be an object`);
  const out = {};
  for (const k of ['n', 'mean', 'rms', 'peak', 'min', 'max']) {
    if (s[k] != null) { if (!num(s[k])) throw bad(`${where}.${k} must be a number`); out[k] = s[k]; }
  }
  return out;
}

/** Normalise one sample. Unknown fields are dropped so the store only holds what we expect. */
export function cleanSample(s, i) {
  const where = `samples[${i}]`;
  if (!s || typeof s !== 'object') throw bad(`${where} must be an object`);
  if (!num(s.t) || s.t < 1.5e12 || s.t > Date.now() + 10 * 60_000) throw bad(`${where}.t must be a unix time in ms`);
  const out = { t: Math.round(s.t) };
  if (s.loc != null) {
    const l = s.loc;
    if (!num(l.lat) || l.lat < -90 || l.lat > 90 || !num(l.lon) || l.lon < -180 || l.lon > 180) throw bad(`${where}.loc needs lat (-90..90) and lon (-180..180)`);
    out.loc = { lat: l.lat, lon: l.lon };
    for (const k of ['acc', 'alt', 'speed', 'bearing', 't']) if (l[k] != null) { if (!num(l[k])) throw bad(`${where}.loc.${k} must be a number`); out.loc[k] = l[k]; }
  }
  if (s.activity != null) {
    if (!ACTIVITIES.includes(s.activity)) throw bad(`${where}.activity must be one of ${ACTIVITIES.join(', ')}`);
    out.activity = s.activity;
  }
  if (s.transitions != null) {
    if (!Array.isArray(s.transitions) || s.transitions.length > LIMITS.maxTransitions) throw bad(`${where}.transitions must be an array (max ${LIMITS.maxTransitions})`);
    out.transitions = s.transitions.map((tr, j) => {
      if (!tr || !ACTIVITIES.includes(tr.activity) || !['ENTER', 'EXIT'].includes(tr.type) || !num(tr.t)) throw bad(`${where}.transitions[${j}] needs activity, type ENTER|EXIT and t`);
      return { activity: tr.activity, type: tr.type, t: tr.t };
    });
  }
  if (s.motion != null) {
    if (typeof s.motion !== 'object') throw bad(`${where}.motion must be an object`);
    out.motion = { accel: stats(s.motion.accel, `${where}.motion.accel`), gyro: stats(s.motion.gyro, `${where}.motion.gyro`) };
  }
  if (s.battery != null) {
    if (!num(s.battery) || s.battery < 0 || s.battery > 100) throw bad(`${where}.battery must be 0-100`);
    out.battery = s.battery;
  }
  if (s.charging != null) out.charging = Boolean(s.charging);
  return out;
}

export function validateBatch(body) {
  if (!body || typeof body !== 'object') throw bad('body must be a JSON object');
  const device = String(body.device ?? '');
  if (!DEVICE_RE.test(device)) throw bad('device must be 1-64 chars: letters, digits, . _ -');
  if (!Array.isArray(body.samples) || body.samples.length === 0) throw bad('samples must be a non-empty array');
  if (body.samples.length > LIMITS.maxSamples) throw bad(`at most ${LIMITS.maxSamples} samples per batch`);
  return { device, samples: body.samples.map(cleanSample) };
}
