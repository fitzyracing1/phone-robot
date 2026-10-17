// Map page. The view key comes from the URL fragment (#key=..., never sent to the server in a URL) or the form,
// is kept in localStorage, and is sent as a bearer token to /api/*.
(() => {
  const $ = (id) => document.getElementById(id);
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('key');
  if (fromHash) { localStorage.setItem('prKey', fromHash); history.replaceState(null, '', location.pathname); }
  let key = localStorage.getItem('prKey') || '';

  const map = L.map('map').setView([39.5, -98.35], 4);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  const line = L.polyline([], { color: '#1f6feb', weight: 4, opacity: 0.8 }).addTo(map);
  const dot = L.circleMarker([0, 0], { radius: 8, color: '#fff', weight: 2, fillColor: '#1a7f37', fillOpacity: 1 });
  const ring = L.circle([0, 0], { radius: 0, color: '#1a7f37', weight: 1, fillOpacity: 0.08 });
  let fitted = false;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ago = (t) => { const s = Math.round((Date.now() - t) / 1000); return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  const fmt = (v, d = 1) => (typeof v === 'number' ? v.toFixed(d) : '—');

  async function api(path, body) {
    const init = { headers: { authorization: `Bearer ${key}` }, cache: 'no-store' };
    if (body !== undefined) { init.method = 'POST'; init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    const r = await fetch(path, init);
    if (r.status === 401) throw Object.assign(new Error('wrong view key'), { auth: true });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }

  const fmtTime = (t) => new Date(t).toLocaleTimeString();
  async function refreshControl() {
    const dev = $('device').value;
    const q = dev ? `device=${encodeURIComponent(dev)}` : '';
    const [cmds, audit, features] = await Promise.all([api(`/api/commands?${q}`), api('/audit?limit=15'), api('/api/features')]);
    $('control').hidden = false;
    $('features').textContent = `planner: ${features.planner} · max ${features.maxTurns} turns · push: ${features.fcm ? 'FCM + polling' : 'polling'}` +
      (cmds.lastPollAt ? ` · phone last polled ${ago(cmds.lastPollAt)}` : '');
    $('commands').innerHTML = cmds.commands.slice().reverse().slice(0, 8).map((c) =>
      `<li>${esc(fmtTime(c.createdAt))} <b>${esc(c.type)}</b> → ${esc(c.device)} · <span class="${c.status === 'acked' ? 'ok' : 'muted'}">${esc(c.status)}</span>` +
      `${c.result ? ` <span class="muted">${esc(JSON.stringify(c.result).slice(0, 80))}</span>` : ''}</li>`).join('') || '<li class="muted">none yet</li>';
    $('audit').innerHTML = audit.entries.slice().reverse().map((e) =>
      `<li>#${e.seq} ${esc(new Date(e.at).toLocaleTimeString())} <b>${esc(e.kind)}</b> ${esc([e.tool, e.type, e.verdict, e.provider, e.reason || e.detail || e.summary].filter(Boolean).join(' · ').slice(0, 120))}</li>`).join('');
  }

  function showTranscript(t) {
    const lines = [`goal: ${t.goal}`, `planner: ${t.planner}`];
    for (const x of t.turns) lines.push(`${x.n}. ${x.tool}(${JSON.stringify(x.args)}) → ${x.verdict}${x.reason ? `: ${x.reason}` : x.result ? ` ${JSON.stringify(x.result).slice(0, 140)}` : ''}`);
    lines.push(`end (${t.endedBy}): ${t.summary}`);
    $('transcript').textContent = lines.join('\n');
    $('transcript').hidden = false;
  }

  document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', async () => {
    const dev = $('device').value;
    try { const r = await api('/commands', { type: b.dataset.cmd, ...(dev ? { device: dev } : {}) }); $('transcript').textContent = `${r.command.type} queued for ${r.command.device} via ${r.via}`; $('transcript').hidden = false; }
    catch (e) { $('transcript').textContent = `error: ${e.message}`; $('transcript').hidden = false; }
    refreshControl().catch(() => {});
  }));
  $('taskform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const goal = $('goal').value.trim();
    if (!goal) return;
    const dev = $('device').value;
    try { showTranscript(await api('/tasks', { goal, ...(dev ? { device: dev } : {}) })); }
    catch (err) { $('transcript').textContent = `error: ${err.message}`; $('transcript').hidden = false; }
    refreshControl().catch(() => {});
  });
  $('verify').addEventListener('click', async () => {
    try { const r = await api('/audit?limit=1&verify=1'); $('verify').textContent = r.chain.ok ? `chain ok (${r.chain.entries})` : `BROKEN at #${r.chain.brokenAt}`; }
    catch (e) { $('verify').textContent = e.message; }
  });

  function showKeyForm(msg) {
    $('keyform').hidden = false; $('forget').hidden = true;
    $('control').hidden = true;
    $('latest').innerHTML = `<p class="${msg ? 'err' : 'muted'}">${esc(msg || 'Enter the view key to load data.')}</p>`;
  }

  function renderLatest(p) {
    if (!p) { $('latest').innerHTML = '<p class="muted">No data yet. Start the app on the phone.</p>'; return; }
    const m = p.motion || {};
    const rows = [
      ['device', p.device], ['time', `${new Date(p.t).toLocaleString()} (${ago(p.t)})`],
      ['activity', p.activity || '—'],
      ['lat, lon', p.loc ? `${p.loc.lat.toFixed(5)}, ${p.loc.lon.toFixed(5)}` : 'no fix'],
      ['accuracy', p.loc ? `${fmt(p.loc.acc, 0)} m` : '—'], ['speed', p.loc && typeof p.loc.speed === 'number' ? `${(p.loc.speed * 3.6).toFixed(1)} km/h` : '—'],
      ['accel rms / peak', m.accel ? `${fmt(m.accel.rms, 2)} / ${fmt(m.accel.peak, 2)} m/s² (n=${m.accel.n ?? 0})` : '—'],
      ['gyro rms / peak', m.gyro ? `${fmt(m.gyro.rms, 2)} / ${fmt(m.gyro.peak, 2)} rad/s` : '—'],
      ['battery', typeof p.battery === 'number' ? `${p.battery}%${p.charging ? ' (charging)' : ''}` : '—'],
    ];
    const tr = (p.transitions || []).map((x) => `${x.type} ${x.activity}`).join(', ');
    if (tr) rows.push(['transitions', tr]);
    $('latest').innerHTML = `<h2>Latest</h2><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
  }

  async function refresh() {
    if (!key) return showKeyForm();
    try {
      const dev = $('device').value;
      const q = dev ? `device=${encodeURIComponent(dev)}&` : '';
      const [latest, track] = await Promise.all([api(`/api/latest?${q}`), api(`/api/track?${q}minutes=${$('minutes').value}`)]);
      $('keyform').hidden = true; $('forget').hidden = false;
      refreshControl().catch((err) => { $('features').textContent = `control unavailable: ${err.message}`; });
      const sel = $('device');
      const opts = ['', ...latest.devices];
      if (sel.options.length !== opts.length) sel.innerHTML = opts.map((d) => `<option value="${esc(d)}">${d ? esc(d) : 'all'}</option>`).join('');
      renderLatest(latest.latest);
      const pts = track.points.map((p) => [p.loc.lat, p.loc.lon]);
      line.setLatLngs(pts);
      const last = latest.latest && latest.latest.loc ? latest.latest : track.points.at(-1);
      if (last && last.loc) {
        dot.setLatLng([last.loc.lat, last.loc.lon]).addTo(map);
        ring.setLatLng([last.loc.lat, last.loc.lon]).setRadius(last.loc.acc || 0).addTo(map);
        if (!fitted) { pts.length > 1 ? map.fitBounds(line.getBounds(), { padding: [30, 30] }) : map.setView([last.loc.lat, last.loc.lon], 16); fitted = true; }
      }
    } catch (e) {
      if (e.auth) { localStorage.removeItem('prKey'); key = ''; return showKeyForm('Wrong view key.'); }
      $('latest').insertAdjacentHTML('afterbegin', `<p class="err">${esc(e.message)}</p>`);
    }
  }

  $('keyform').addEventListener('submit', (e) => { e.preventDefault(); key = $('key').value.trim(); localStorage.setItem('prKey', key); $('key').value = ''; refresh(); });
  $('forget').addEventListener('click', () => { localStorage.removeItem('prKey'); key = ''; line.setLatLngs([]); dot.remove(); ring.remove(); showKeyForm(); });
  $('minutes').addEventListener('change', () => { fitted = false; refresh(); });
  $('device').addEventListener('change', () => { fitted = false; refresh(); });
  refresh();
  setInterval(refresh, 15000);
})();
