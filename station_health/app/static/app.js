'use strict';
// Station Health page. Asks the app for one snapshot (api/state) every 30
// seconds while visible and renders it. Every name shown came from Home
// Assistant or the network (a client can call itself anything), so all text
// goes through esc().
//
// All URLs are relative, so the page works under Home Assistant's ingress
// prefix. View only: no control changes a device. The one write is the page's
// own "stored" mark for a UniFi device that's packed away (api/stored).

(() => {
  const $ = id => document.getElementById(id);
  const POLL_MS = 30_000;
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  let snap = null;
  let pollTimer = null;

  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const dash = '—';

  // ---- theme ------------------------------------------------------------------
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_ICONS = {
    auto: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 18V4a8 8 0 0 1 0 16',
    light: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M2 13h2a1 1 0 0 0 0-2H2a1 1 0 0 0 0 2m18 0h2a1 1 0 0 0 0-2h-2a1 1 0 0 0 0 2M11 2v2a1 1 0 0 0 2 0V2a1 1 0 0 0-2 0m0 18v2a1 1 0 0 0 2 0v-2a1 1 0 0 0-2 0M5.99 4.58a1 1 0 0 0-1.41 1.41l1.06 1.06a1 1 0 0 0 1.41-1.41zm12.37 12.37a1 1 0 0 0-1.41 1.41l1.06 1.06a1 1 0 0 0 1.41-1.41zm1.06-10.96a1 1 0 0 0-1.41-1.41l-1.06 1.06a1 1 0 0 0 1.41 1.41zM7.05 18.36a1 1 0 0 0-1.41-1.41l-1.06 1.06a1 1 0 0 0 1.41 1.41z',
    dark: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.39 5.39 0 0 1-4.4 2.26 5.4 5.4 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1',
  };
  let theme = 'auto';
  try { theme = THEMES.includes(localStorage.getItem('sh-theme')) ? localStorage.getItem('sh-theme') : 'auto'; } catch { /* optional */ }
  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
    const label = `Appearance: ${theme === 'auto' ? 'automatic' : theme}`;
    $('theme').title = label;
    $('theme').setAttribute('aria-label', label);
    $('theme').querySelector('path').setAttribute('d', THEME_ICONS[theme]);
  }
  $('theme').onclick = () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    try { localStorage.setItem('sh-theme', theme); } catch { /* optional */ }
    applyTheme();
  };
  applyTheme();

  // ---- formatting -----------------------------------------------------------------
  const zone = () => snap?.timeZone || undefined;
  function clock(t, opts = {}) {
    if (!isNum(t)) return dash;
    const o = { hour: 'numeric', minute: '2-digit', ...opts };
    try { return new Date(t).toLocaleString(undefined, { ...o, timeZone: zone() }); } catch { return new Date(t).toLocaleString(undefined, o); }
  }
  const dayKey = t => clock(t, { year: 'numeric', month: 'numeric', day: 'numeric', hour: undefined, minute: undefined });
  function when(t) {
    if (!isNum(t)) return dash;
    const now = Date.now();
    if (dayKey(t) === dayKey(now)) return `Today ${clock(t)}`;
    if (dayKey(t) === dayKey(now - DAY)) return `Yesterday ${clock(t)}`;
    if (dayKey(t) === dayKey(now + DAY)) return `Tomorrow ${clock(t)}`;
    return clock(t, { month: 'short', day: 'numeric' });
  }
  function span(ms) {
    if (!isNum(ms) || ms < 0) return dash;
    const m = Math.floor(ms / MIN), h = Math.floor(m / 60), d = Math.floor(h / 24);
    if (d >= 1) return `${d}d ${h % 24}h`;
    if (h >= 1) return `${h}h ${m % 60}m`;
    return `${Math.max(m, 1)}m`;
  }
  const ago = t => (isNum(t) ? span(Date.now() - t) : dash);
  function rate(bps) {
    if (!isNum(bps)) return { v: dash, u: '' };
    if (bps >= 1e9) return { v: (bps / 1e9).toFixed(bps >= 1e10 ? 0 : 1), u: 'Gbps' };
    if (bps >= 1e6) return { v: (bps / 1e6).toFixed(bps >= 1e8 ? 0 : bps >= 1e7 ? 0 : 1), u: 'Mbps' };
    if (bps >= 1e3) return { v: Math.round(bps / 1e3), u: 'kbps' };
    return { v: Math.round(bps), u: 'bps' };
  }
  const rateText = bps => { const r = rate(bps); return r.u ? `${r.v} ${r.u}` : r.v; };
  const fmt = (v, d = 0) => (isNum(v) ? v.toFixed(d) : dash);
  const mb = v => (!isNum(v) ? dash : v >= 1000 ? `${(v / 1000).toFixed(2)} GB` : `${Math.round(v)} MB`);
  const empty = (msg, problem = false) => `<div class="empty${problem ? ' problem' : ''}">${esc(msg)}</div>`;
  const pill = (level, text) => `<span class="pill ${esc(level)}">${esc(text)}</span>`;
  const head = (title, meta = '') => `<div class="card-head"><h2>${esc(title)}</h2>${meta ? `<span class="meta">${meta}</span>` : ''}</div>`;
  const srcError = key => {
    const s = snap?.sources?.[key];
    return s?.error ? `<p class="note warn-text">${esc(s.error)}${s.fetchedAt ? ` Showing data from ${esc(clock(s.fetchedAt))}.` : ''}</p>` : '';
  };
  const cap = s => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

  // ---- overview -------------------------------------------------------------------
  function renderOverview() {
    const s = snap.summary;
    const level = s.level === 'ok' ? 'ok' : s.level;
    const c = snap.containers, net = snap.network, b = snap.backups, u = snap.updates;
    const hostsUp = snap.hosts.filter(h => h.state === 'up').length;
    const tiles = [];
    if (c.total) tiles.push({ c: c.running === c.total ? 'ok' : 'bad', label: 'Containers', value: `${c.running}`, unit: `/ ${c.total} up`, sub: c.running === c.total ? 'All running' : `${c.total - c.running} not running` });
    tiles.push({ c: hostsUp === snap.hosts.length ? 'ok' : 'warn', label: 'Hosts reporting', value: `${hostsUp}`, unit: `/ ${snap.hosts.length}`, sub: snap.hosts.filter(h => h.state !== 'up').map(h => h.name).join(', ') || 'All reporting' });
    if (net.wan) tiles.push({ c: net.wan.up ? 'ok' : 'bad', label: 'Internet', value: net.wan.up ? rate(net.wan.downBps).v : 'Down', unit: net.wan.up ? `${rate(net.wan.downBps).u} ↓` : '', sub: net.wan.up ? `${isNum(net.wan.latencyMs) ? `${net.wan.latencyMs} ms` : ''}${net.wan.isp ? ` · ${net.wan.isp}` : ''}` : net.wan.status || '' });
    if (net.devices.length) {
      const active = net.devices.filter(d => !d.stored), storedN = net.devices.length - active.length;
      const upDev = active.filter(d => d.state === 'connected').length;
      tiles.push({ c: upDev === active.length ? 'ok' : 'warn', label: 'Network', value: isNum(net.clients) ? `${net.clients}` : `${upDev}`, unit: isNum(net.clients) ? 'clients' : `/ ${active.length} up`, sub: `${net.vlans ? `${net.vlans.length} networks · ` : ''}${upDev}/${active.length} UniFi devices up${storedN ? ` · ${storedN} stored` : ''}` });
    }
    if (b) tiles.push({ c: b.level, label: 'Last backup', value: b.lastOk ? clock(b.lastOk) : dash, unit: '', sub: `${b.lastOk ? `${when(b.lastOk).replace(/ \d.*$/, '')} · ` : ''}${isNum(b.sizeMB) ? mb(b.sizeMB) : ''}${b.next ? ` · next ${when(b.next)}` : ''}` });
    tiles.push({ c: u.pending.length ? 'info' : 'ok', label: 'Updates waiting', value: `${u.pending.length}`, unit: '', sub: u.pending.length ? u.pending.slice(0, 2).map(p => p.title).join(', ') + (u.pending.length > 2 ? '…' : '') : `${u.total} checked, all current` });

    $('overview').innerHTML = `
      <div class="banner ${esc(level)}">
        <span class="dot"></span>
        <div>
          <div class="big">${esc(s.headline)}</div>
          ${s.detail ? `<div class="sub">${esc(s.detail)}</div>` : ''}
        </div>
      </div>
      ${s.needs.length > 1 ? `<ul class="needs">${s.needs.map(n => `<li class="${esc(n.level)}">${esc(n.text)}</li>`).join('')}</ul>` : ''}
      <div class="tiles">${tiles.map(t => `<div class="tile ${esc(t.c)}" style="--c:var(--${t.c === 'ok' ? 'good' : t.c === 'warn' ? 'warning' : t.c === 'bad' ? 'critical' : 'accent'})"><span class="label">${esc(t.label)}</span><span class="value">${esc(t.value)}${t.unit ? `<span class="unit">${esc(t.unit)}</span>` : ''}</span><span class="sub">${esc(t.sub)}</span></div>`).join('')}</div>
      ${srcError('states')}`;
  }

  // ---- internet ---------------------------------------------------------------------
  function sparkPath(points, key, max, w = 300, h = 60) {
    const t0 = Date.now() - DAY;
    const pts = points.filter(p => isNum(p[key]));
    if (pts.length < 2) return null;
    const xy = pts.map(p => [((p.t - t0) / DAY) * w, h - 4 - (p[key] / max) * (h - 8)]);
    return { line: xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' '), first: xy[0][0], last: xy[xy.length - 1][0] };
  }
  function renderInternet() {
    const el = $('internet');
    const wan = snap.network.wan;
    if (!snap.unifiConfigured) { el.hidden = true; return; }
    el.hidden = false;
    if (!wan) { el.innerHTML = head('Internet') + (snap.sources.unifi?.error ? empty(snap.sources.unifi.error, true) : empty('Waiting for the UniFi console…')); return; }
    const hist = snap.wanHistory || [];
    const max = Math.max(1, ...hist.map(p => p.down || 0), ...hist.map(p => p.up || 0));
    const dn = sparkPath(hist, 'down', max), up = sparkPath(hist, 'up', max);
    const st = wan.speedtest;
    el.innerHTML = `
      ${head('Internet', wan.up ? pill('ok', `Up ${span(Date.now() - wan.uptimeSince)}`) : pill('bad', `Down${wan.status ? ` (${wan.status})` : ''}`))}
      <div class="wan">
        <div class="rate"><span class="arrow dn" aria-label="Download">↓</span><span class="value mono">${esc(rate(wan.downBps).v)}</span><span class="unit">${esc(rate(wan.downBps).u)}</span></div>
        <div class="rate"><span class="arrow up" aria-label="Upload">↑</span><span class="value mono">${esc(rate(wan.upBps).v)}</span><span class="unit">${esc(rate(wan.upBps).u)}</span></div>
      </div>
      ${dn ? `<svg class="spark" viewBox="0 0 300 60" preserveAspectRatio="none" role="img" aria-label="Download and upload over the last 24 hours">
        <path class="area" d="${dn.line} L${dn.last.toFixed(1)},60 L${dn.first.toFixed(1)},60 Z"/>
        <path class="line" d="${dn.line}"/>${up ? `<path class="line up" d="${up.line}"/>` : ''}
      </svg><div class="axis2"><span>24h ago</span><span>peak ${esc(rateText(max))}</span><span>now</span></div>` : '<p class="note">The 24-hour graph fills in as the app samples the connection every 5 minutes.</p>'}
      <dl class="kv">
        ${wan.isp ? `<dt>Provider</dt><dd>${esc(wan.isp)}</dd>` : ''}
        <dt>Latency</dt><dd class="mono">${isNum(wan.latencyMs) ? `${esc(wan.latencyMs)} ms` : dash}</dd>
        <dt>Drops</dt><dd class="mono">${isNum(wan.drops) ? esc(wan.drops) : dash}</dd>
        <dt>Last speed test</dt><dd class="mono">${st ? `${esc(st.downMbps)} / ${esc(st.upMbps)} Mbps · ${esc(when(st.at))}` : dash}</dd>
      </dl>
      ${srcError('unifi')}`;
  }

  // ---- networks (VLANs) -------------------------------------------------------------
  function renderNetworks() {
    const el = $('vlans');
    const net = snap.network;
    if (!net.source) { el.hidden = true; return; }
    el.hidden = false;
    if (!snap.unifiConfigured) {
      el.className = 'card span-12';
      el.innerHTML = `${head('Wi-Fi networks', 'From Home Assistant’s UniFi integration')}
        ${net.wlans.length ? `<div class="wlans">${net.wlans.map(w => `<span class="tag">${esc(w.name)} · ${isNum(w.clients) ? esc(w.clients) : dash} clients</span>`).join('')}</div>` : empty('No Wi-Fi networks reported.')}
        <p class="note">To see each network (VLAN) with its clients and traffic, and the internet connection, add a View Only UniFi login on the app’s Configuration tab. See the app’s Documentation.</p>`;
      return;
    }
    el.className = 'card span-8';
    if (!net.vlans) { el.innerHTML = head('Networks') + empty(snap.sources.unifi?.error || 'Waiting for the UniFi console…', Boolean(snap.sources.unifi?.error)); return; }
    el.innerHTML = `${head('Networks', 'Clients and traffic on each network, right now')}
      <div class="vlans">${net.vlans.map(v => {
        const wiredPct = v.clients ? (v.wired / v.clients) * 100 : 0;
        return `<div class="vlan">
          <div class="vh"><span class="vn">${esc(v.name)}</span>${v.vlan ? `<span class="tag">VLAN ${esc(v.vlan)}</span>` : ''}</div>
          <div class="subnet mono">${esc(v.subnet || (v.id === 'other' ? 'Clients on no known network' : ''))}${v.purpose === 'guest' ? ' · guest' : ''}</div>
          <div class="vstats">
            <div><span class="value mono">${esc(v.clients)}</span><span class="lbl">clients</span></div>
            <div><span class="value mono">${esc(rate(v.rateBps).v)}</span><span class="lbl">${esc(rate(v.rateBps).u || 'traffic')} now</span></div>
          </div>
          <div class="mix" aria-hidden="true">${v.wired ? `<i style="width:${wiredPct}%;background:var(--series-1)"></i>` : ''}${v.wifi ? `<i style="width:${100 - wiredPct}%;background:var(--series-3)"></i>` : ''}</div>
          <div class="mixl"><span><b style="background:var(--series-1)"></b>${esc(v.wired)} wired</span><span><b style="background:var(--series-3)"></b>${esc(v.wifi)} Wi-Fi</span></div>
          ${v.top.length ? `<div class="top"><div class="tl">Busiest</div>${v.top.map(t => `<div class="tc"><span>${esc(t.name)}</span><span class="mono">${esc(rateText(t.rateBps))}</span></div>`).join('')}</div>` : ''}
          ${v.newToday.length ? `<div class="top"><div class="tl">New today</div>${v.newToday.slice(0, 3).map(t => `<div class="tc"><span>${esc(t.name)}</span><span class="mono muted">${esc(clock(t.at))}</span></div>`).join('')}</div>` : ''}
        </div>`;
      }).join('')}</div>
      ${net.wlans.length ? `<div class="wlans">${net.wlans.map(w => `<span class="tag">Wi-Fi ${esc(w.name)} · ${isNum(w.clients) ? esc(w.clients) : dash}</span>`).join('')}</div>` : ''}`;
  }

  // ---- UniFi devices ------------------------------------------------------------------
  function renderUnifi() {
    const el = $('unifi');
    const net = snap.network;
    if (!net.devices.length) { el.hidden = true; return; }
    el.hidden = false;
    const api = net.source === 'api';
    const kind = { gateway: 'gateway', switch: 'switch', ap: 'access point' };
    el.innerHTML = `${head('UniFi devices', `Status only${api ? '' : ' · from Home Assistant'}. Firmware updates stay in UniFi.`)}
      <div class="tablewrap"><table class="devices">
        <thead><tr><th>Device</th><th>State</th>${api ? '<th class="r">Clients</th><th class="r">Traffic</th>' : ''}<th class="r">CPU · Mem</th><th class="r">Temp</th><th>Uptime</th><th>Firmware</th></tr></thead>
        <tbody>${net.devices.map(d => `<tr>
          <td class="n">${esc(d.name)} <span class="stack">${esc(kind[d.kind] || d.kind)}${d.poe ? ` · PoE ${esc(d.poe.usedW)} of ${esc(d.poe.maxW)} W` : ''}</span></td>
          <td class="st">${d.stored
            ? `${pill('off', 'Stored')} <button type="button" class="mini" data-store="${esc(d.name)}" data-on="0" title="Count ${esc(d.name)} again">Undo</button>`
            : `${pill(d.level, cap(String(d.state || 'unknown').replace(/_/g, ' ')))}${d.level !== 'ok' && d.level !== 'unknown' && d.state !== 'connected' ? ` <button type="button" class="mini" data-store="${esc(d.name)}" data-on="1" title="Packed away on purpose: stop counting it as an alert until it's back online">Mark stored</button>` : ''}`}</td>
          ${api ? `<td class="r mono" data-label="Clients">${isNum(d.clients) ? esc(d.clients) : dash}</td><td class="r mono" data-label="Traffic">${esc(rateText(d.rateBps))}</td>` : ''}
          <td class="r mono" data-label="CPU · Mem">${isNum(d.cpu) || isNum(d.mem) ? `${fmt(d.cpu)}% · ${fmt(d.mem)}%` : dash}</td>
          <td class="r mono" data-label="Temp">${isNum(d.temp) ? `${esc(d.temp)}${esc(d.tempUnit)}` : dash}</td>
          <td class="meta" data-label="Uptime">${d.state === 'connected' ? esc(ago(d.since)) : d.stored ? `stored ${esc(ago(d.storedSince))}` : d.since ? `down ${esc(ago(d.since))}` : dash}</td>
          <td data-label="Firmware">${d.firmware ? (d.firmware.update ? pill('warn', `Update ${d.firmware.latest && d.firmware.latest !== 'newer' ? d.firmware.latest : 'ready'}`) : pill('ok', d.firmware.installed || 'Current')) : dash}</td>
        </tr>`).join('')}</tbody>
      </table></div>`;
  }

  // Mark stored / Undo. The app answers with a fresh snapshot.
  $('unifi').addEventListener('click', async e => {
    const b = e.target.closest('[data-store]');
    if (!b) return;
    b.disabled = true;
    try {
      const r = await fetch('api/stored', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: b.dataset.store, stored: b.dataset.on === '1' }) });
      if (r.ok) { snap = await r.json(); render(); } else { b.disabled = false; b.title = (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`; }
    } catch (err) { console.warn('stored', err); b.disabled = false; }
  });

  // ---- hosts -----------------------------------------------------------------------------
  function renderHosts() {
    const list = snap.hosts;
    $('hosts').innerHTML = `${head('Hosts', 'CPU · memory · disk')}
      ${list.length ? `<div class="hosts">${list.map(h => {
        const st = h.state === 'up' ? pill(h.level === 'ok' ? 'ok' : h.level, h.since ? `Up ${span(Date.now() - h.since)}` : 'Up')
          : h.state === 'offline' ? pill('warn', `No data ${h.since ? ago(h.since) : ''}`.trim()) : pill('bad', `Down ${h.since ? ago(h.since) : ''}`.trim());
        const metrics = h.metrics.filter(m => m.value !== null);
        return `<div class="host">
          <span class="name">${esc(h.name)} <small>${esc(h.sub)}</small></span>${st}
          ${metrics.length ? `<div class="bars">${metrics.map(m => `<div class="bar"><div class="l"><span>${esc(m.label)}</span><span class="mono">${esc(m.value)}${esc(m.unit === '%' ? '%' : ` ${m.unit}`)}</span></div>${m.pct !== null ? `<div class="t"><i class="${m.pct >= 85 ? 'hot' : ''}" style="width:${Math.max(1, m.pct)}%"></i></div>` : ''}</div>`).join('')}</div>` : ''}
          ${h.note ? `<div class="why">${esc(h.note)}${h.fix && /^\/config\/[a-z0-9_/]+$/.test(h.fix.href) ? ` <a href="${esc(h.fix.href)}" target="_top">${esc(h.fix.label)}</a>` : ''}</div>` : ''}
        </div>`;
      }).join('')}</div>` : empty('No hosts found.')}
      ${srcError('supervisor')}`;
  }

  // ---- containers ---------------------------------------------------------------------------
  function renderContainers() {
    const c = snap.containers;
    $('containers').hidden = !c.total;
    $('hosts').className = `card ${c.total ? 'span-5' : 'span-12'}`;
    if (!c.total) return;
    const lastEvent = x => (x.lastEvent?.at ? `${cap(String(x.lastEvent.type || 'event').replace(/_/g, ' '))} ${when(x.lastEvent.at)}` : x.started ? `Started ${when(x.started)}` : dash);
    $('containers').innerHTML = `${head('Containers', `${c.running} of ${c.total} running · memory vs. limit`)}
      <div class="tablewrap"><table>
        <thead><tr><th>Name</th><th>State</th><th class="r hide-sm">CPU</th><th>Memory</th><th class="hide-sm">Last event</th></tr></thead>
        <tbody>${c.list.map(x => `<tr>
          <td class="n">${x.stack ? `${esc(cap(x.stack))} <span class="stack">${esc(x.short)}</span>` : esc(cap(x.name))}${x.update ? ' <span class="tag">update</span>' : ''}</td>
          <td>${pill(x.level, cap(x.state || 'unknown'))}</td>
          <td class="r mono hide-sm">${isNum(x.cpu) ? `${fmt(x.cpu, 1)}%` : dash}</td>
          <td><div class="membar"><div class="t"><i class="${x.memPct >= 80 ? 'hot' : ''}" style="width:${isNum(x.memPct) ? Math.max(0.5, x.memPct) : 0}%"></i></div><span class="mono">${esc(mb(x.memMB))}</span></div></td>
          <td class="meta hide-sm">${esc(lastEvent(x))}</td>
        </tr>`).join('')}</tbody>
      </table></div>`;
  }

  // ---- uptime ----------------------------------------------------------------------------------
  function renderUptime() {
    const u = snap.uptime;
    if (!u) { $('uptime').innerHTML = head('Uptime') + (snap.sources.history?.error ? empty(snap.sources.history.error, true) : empty('Reading history from Home Assistant…')); return; }
    const groups = [['wan', 'Internet'], ['host', 'Hosts'], ['pc', null], ['unifi', 'Network'], ['container', 'Containers']];
    const label = { x: 'no data', u: 'up', w: 'partly down', d: 'down' };
    let html = '';
    for (const [kind, title] of groups) {
      const rows = u.rows.filter(r => r.kind === kind);
      if (!rows.length) continue;
      if (title) html += `<div class="uptime-group">${esc(title)}</div>`;
      html += rows.map(r => `<div class="uprow${r.stored ? ' stored' : ''}"><span class="nm" title="${esc(r.name)}">${esc(r.name)}</span><div class="strip" style="--n:${r.blocks.length}">${r.blocks.map((b, i) => { const k = label[b] ? b : 'x'; return `<i class="${k === 'u' ? '' : k}" title="${esc(clock(u.start + i * u.blockMin * MIN))}: ${label[k]}"></i>`; }).join('')}</div><span class="pct mono">${r.stored ? 'Stored' : isNum(r.pct) ? `${r.pct}%` : dash}</span></div>`).join('');
    }
    $('uptime').innerHTML = `${head('Uptime', `Last 24 hours · ${u.blockMin}-minute blocks`)}
      ${html || empty('Uptime appears here for a NAS, PCs, UniFi devices and containers once Home Assistant has them.')}
      <div class="axis"><div></div><div><span>24h ago</span><span>12h</span><span>now</span></div><div></div></div>
      <div class="legend" style="margin-top:8px"><span><b style="background:var(--good)"></b>Up</span><span><b style="background:var(--warning)"></b>Partly down</span><span><b style="background:var(--critical)"></b>Down</span><span><b style="background:var(--border)"></b>No data (a PC asleep, or not recorded)</span></div>
      ${srcError('history')}`;
  }

  // ---- backups and updates --------------------------------------------------------------------
  function renderMaintenance() {
    const b = snap.backups, u = snap.updates;
    const backupHtml = b ? `<dl class="kv">
        <dt>Last good backup</dt><dd class="mono">${esc(when(b.lastOk))}</dd>
        <dt>Size</dt><dd class="mono">${esc(mb(b.sizeMB))}</dd>
        <dt>Next scheduled</dt><dd class="mono">${esc(when(b.next))}</dd>
        ${b.failed ? `<dt>Last attempt</dt><dd class="mono warn-text">${esc(when(b.lastTry))} · failed</dd>` : ''}
      </dl>` : '<p class="note">No automatic backups set up in Home Assistant.</p>';
    $('maintenance').innerHTML = `${head('Backups & updates')}
      ${backupHtml}
      <div class="divider"></div>
      ${u.pending.length ? `<div class="meta">${u.pending.length} update${u.pending.length === 1 ? '' : 's'} waiting. Install them where you normally do; nothing here installs anything.</div>
        <ul class="pending">${u.pending.map(p => `<li><span>${esc(p.title)} <span class="muted">· ${esc(p.group)}</span></span><span>${esc(p.installed || '')}${p.latest ? ` → ${esc(p.latest)}` : ''}</span></li>`).join('')}</ul>`
        : `<div class="meta">Everything is current.</div>`}
      <div class="updsecs">${[...new Set(u.groups.map(g => g.section || 'Devices'))].map(sec => `<div class="updsec-name">${esc(sec)}</div>
        <ul class="updrows">${u.groups.filter(g => (g.section || 'Devices') === sec).map(g => {
          const level = g.pending ? 'warn' : g.unknown === g.total ? 'off' : 'ok';
          const status = g.pending ? `${g.pending} waiting` : level === 'off' ? 'No data' : 'Current';
          return `<li><span class="pill ${level} dot" aria-hidden="true"></span><span class="nm">${esc(g.name)}</span><span class="ct">${g.total}</span><span class="st ${level}">${esc(status)}</span></li>`;
        }).join('')}</ul>`).join('')}</div>
      <p class="note"><a href="/config/updates" target="_top">Open Updates in Home Assistant</a></p>`;
  }

  // ---- log ---------------------------------------------------------------------------------------
  // Recent Activity can be collapsed; the choice is remembered in this browser.
  let logOpen = true;
  try { logOpen = localStorage.getItem('sh-log-open') !== 'false'; } catch { /* optional */ }
  function logHead(count) {
    const label = logOpen ? 'Collapse Recent Activity' : 'Expand Recent Activity';
    return `<div class="card-head">
      <button type="button" class="collapse-btn" id="log-toggle" aria-expanded="${logOpen}" aria-controls="log-body" title="${label}" aria-label="${label}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z"/></svg>
        <h2>Recent Activity</h2>${count ? `<span class="count">${count}</span>` : ''}
      </button>
      <span class="meta">Outages, updates and new devices over the last 7 days, with what changed just before</span>
    </div>`;
  }
  $('log').addEventListener('click', e => {
    if (!e.target.closest('#log-toggle')) return;
    logOpen = !logOpen;
    try { localStorage.setItem('sh-log-open', String(logOpen)); } catch { /* optional */ }
    renderLog();
  });

  function renderLog() {
    const list = snap.incidents;
    $('log').classList.toggle('collapsed', !logOpen);
    if (!list) { $('log').innerHTML = logHead(0) + (logOpen ? empty('Reading history from Home Assistant…') : ''); return; }
    const sev = { bad: 'bad', serious: 'serious', warn: 'warn', info: 'info', change: 'change', stored: 'off' };
    const title = i => {
      if (i.kind === 'down' && i.stored) return `${i.subject} is stored`;
      if (i.kind === 'down') return i.ongoing ? `${i.subject} is down` : `${i.subject} was down ${span(i.end - i.start)}`;
      if (i.kind === 'offline') return `${i.subject} stopped reporting`;
      if (i.kind === 'oom') return i.subject;
      return i.subject;
    };
    const time = i => (i.kind === 'down' || i.kind === 'offline'
      ? `${when(i.start)}${i.ongoing ? ` · ongoing ${span(Date.now() - i.start)}` : ` → ${dayKey(i.end) === dayKey(i.start) ? clock(i.end) : when(i.end)}`}`
      : when(i.start));
    $('log').innerHTML = `${logHead(list.length)}
      <div id="log-body"${logOpen ? '' : ' hidden'}>
      ${list.length ? `<ul class="log">${list.map(i => `<li class="${esc(sev[i.severity] || 'info')}"><span class="d"></span><div>
        <div class="h">${esc(title(i))}</div>
        <div class="t">${esc(time(i))}</div>
        ${i.detail ? `<div class="x">${esc(i.detail)}</div>` : ''}
        ${i.before?.length ? `<div class="x">Right before: <b>${i.before.map(esc).join('</b>, <b>')}</b></div>` : ''}
      </div></li>`).join('')}</ul>` : empty('Nothing went down in the last 7 days.')}
      </div>`;
  }

  // ---- data ----------------------------------------------------------------------------------------
  function render() {
    if (!snap.ready) {
      const err = snap.sources?.states?.error || snap.sources?.registry?.error;
      $('overview').innerHTML = err ? empty(err, true) : empty('Reading Home Assistant…');
      return;
    }
    for (const [name, fn] of [['overview', renderOverview], ['internet', renderInternet], ['vlans', renderNetworks], ['unifi', renderUnifi], ['hosts', renderHosts], ['containers', renderContainers], ['uptime', renderUptime], ['maintenance', renderMaintenance], ['log', renderLog]]) {
      try { fn(); } catch (e) { console.error(name, e); $(name).innerHTML = empty(`This panel couldn't be drawn (${e.message}).`, true); }
    }
    $('updated').textContent = `Updated ${clock(snap.generatedAt, { second: '2-digit' })}`;
    $('foot').textContent = `Station Health ${snap.version} · view only: nothing here can start, stop, restart or change any device`;
  }

  async function load(force = false) {
    clearTimeout(pollTimer);
    $('refresh').classList.toggle('spinning', force);
    try {
      const r = await fetch(force ? 'api/refresh' : 'api/state', force
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
        : { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      snap = await r.json();
      $('offline').hidden = true;
      render();
    } catch (e) {
      console.warn('load', e);
      $('offline').hidden = false;
    } finally {
      $('refresh').classList.remove('spinning');
      if (!document.hidden) pollTimer = setTimeout(load, snap && !snap.ready ? 3000 : POLL_MS);
    }
  }
  $('refresh').onclick = () => load(true);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); else clearTimeout(pollTimer); });
  load();
})();
