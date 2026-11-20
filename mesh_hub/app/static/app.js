/* Mesh Hub page: polls api/state, draws the radios, the map, the node list and
 * the messages, and sends what you type through api/send. All URLs are
 * relative, so it works under any ingress prefix. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const NETS = ['meshtastic', 'meshcore'];
  const NET_NAME = { meshtastic: 'Meshtastic', meshcore: 'MeshCore' };
  const POLL_MS = 3000, POLL_HIDDEN_MS = 15000;

  const store = {
    get(k, d) { try { const v = localStorage.getItem('meshhub-' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('meshhub-' + k, JSON.stringify(v)); } catch { /* optional */ } },
  };

  // ---- appearance -------------------------------------------------------------
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_ICONS = {
    auto: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20m0 18V4a8 8 0 0 1 0 16',
    light: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10M11 1h2v3h-2zm0 19h2v3h-2zM3.5 4.9l1.4-1.4L7 5.6 5.6 7zm12.9 12.9 1.4-1.4 2.1 2.1-1.4 1.4zM1 11h3v2H1zm19 0h3v2h-3zM3.5 19.1 5.6 17 7 18.4l-2.1 2.1zM16.4 5.6l2.1-2.1 1.4 1.4L17.8 7z',
    dark: 'M12.3 2a9.5 9.5 0 1 0 9.7 12.2A8 8 0 0 1 12.3 2',
  };
  let theme = THEMES.includes(store.get('theme')) ? store.get('theme') : 'auto';
  function applyTheme() {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
    const label = `Appearance: ${theme === 'auto' ? 'automatic' : theme}`;
    $('theme').title = label;
    $('theme').setAttribute('aria-label', label);
    $('theme').querySelector('path').setAttribute('d', THEME_ICONS[theme]);
    if (map) drawMap(true);
  }
  $('theme').onclick = () => { theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]; store.set('theme', theme); applyTheme(); };
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => map && drawMap(true));

  // ---- formatting -------------------------------------------------------------
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const titleCase = s => (s ? String(s).toLowerCase().split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : '');
  const fmtKind = k => (!k ? '—' : /^[A-Z0-9_]+$/.test(k) ? titleCase(k) : k);
  const fmtHw = h => (!h ? null : /^[A-Z0-9_]+$/.test(h) ? h.replace(/_/g, ' ') : h);
  function ago(ms) {
    if (!ms) return '—';
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86400) return `${Math.floor(s / 3600)} h`;
    return `${Math.floor(s / 86400)} d`;
  }
  const clock = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayLabel = ms => {
    const d = new Date(ms), today = new Date();
    const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  };
  function battery(pct, volts) {
    if (pct === null || pct === undefined) return volts ? `${volts.toFixed(2)} V` : '—';
    if (pct > 100) return '<span class="batt plug" title="Plugged in"><i style="--lvl:1"></i>⚡</span>';
    const cls = pct <= 20 ? 'batt low' : 'batt';
    return `<span class="${cls}"><i style="--lvl:${Math.max(0.05, pct / 100)}"></i>${pct}%</span>`;
  }
  const km = (a, b) => {
    const r = Math.PI / 180;
    const h = Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lon - a.lon) * r) / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(h)));
  };
  const hasPos = n => Number.isFinite(n.lat) && Number.isFinite(n.lon);

  // ---- state ------------------------------------------------------------------
  let data = null;
  let rev = 0;
  let webRev = '';
  let web = null;
  const messages = new Map();
  let tab = NETS.includes(store.get('tab')) ? store.get('tab') : 'all';
  let activeChat = store.get('chat', null);
  let lastRead = store.get('read', {});
  let selected = null;
  let showPublic = store.get('public', true);
  let scope = ['radio', 'all', 'web'].includes(store.get('scope')) ? store.get('scope') : 'radio';
  let sort = store.get('sort', { key: 'lastHeard', dir: -1 });
  const extraDms = new Map();   // direct chats opened from a node, before any message
  const tabNets = () => (tab === 'all' ? NETS : [tab]);

  // ---- tabs and controls ------------------------------------------------------
  function setTab(t) {
    tab = t;
    store.set('tab', t);
    document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
    fitted = false;
    render();
  }
  document.querySelectorAll('[data-tab]').forEach(b => { b.onclick = () => setTab(b.dataset.tab); });
  $('public').setAttribute('aria-pressed', String(showPublic));
  $('public').onclick = () => { showPublic = !showPublic; store.set('public', showPublic); $('public').setAttribute('aria-pressed', String(showPublic)); drawMap(); };
  $('fit').onclick = () => fitMap(true);
  $('scope').value = scope;
  $('scope').onchange = () => { scope = $('scope').value; store.set('scope', scope); drawNodes(); };
  $('filter').oninput = () => drawNodes();
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.onclick = () => {
      const k = th.dataset.sort;
      sort = sort.key === k ? { key: k, dir: -sort.dir } : { key: k, dir: k === 'name' || k === 'kind' || k === 'hops' || k === 'distance' ? 1 : -1 };
      store.set('sort', sort);
      drawNodes();
    };
  });

  // ---- nodes ------------------------------------------------------------------
  function allNodes() {
    if (!data) return [];
    const out = [];
    const radioIds = new Set();
    for (const net of tabNets()) {
      for (const n of data.networks[net]?.nodes || []) { out.push(n); radioIds.add(`${net}|${n.id}`); }
    }
    if (web) {
      for (const net of tabNets()) {
        for (const n of web[net]?.nodes || []) if (!radioIds.has(`${net}|${n.id}`)) out.push(n);
      }
    }
    for (const n of out) n.distance = data.home && hasPos(n) ? km(data.home, n) : null;
    return out;
  }
  const nodeKey = n => `${n.network}|${n.id}|${n.source}`;

  function nodeRow(n) {
    const id = n.network === 'meshcore' ? n.id.slice(0, 8) : n.id;
    return `<tr data-key="${esc(nodeKey(n))}"${selected === nodeKey(n) ? ' class="selected"' : ''}>
      <td><span class="nm" data-net="${n.network}"><i class="dot${n.source === 'web' ? ' web' : ''}"></i><b>${esc(n.name)}</b>${n.isSelf ? ' <span class="tag">You</span>' : ''}</span><span class="id">${esc(n.short && n.network === 'meshtastic' ? `${n.short} · ${id}` : id)}</span></td>
      <td class="hide-sm">${esc(fmtKind(n.kind))}</td>
      <td class="num">${n.isSelf ? '—' : n.hops ?? '—'}</td>
      <td class="num hide-sm">${n.snr !== null && n.snr !== undefined ? n.snr.toFixed(1) : '—'}</td>
      <td class="num">${battery(n.battery, n.voltage)}</td>
      <td class="num hide-sm">${n.distance !== null ? n.distance.toFixed(n.distance < 10 ? 1 : 0) : '—'}</td>
      <td class="num">${n.source === 'web' && !n.lastHeard ? '—' : ago(n.lastHeard)}</td>
    </tr>`;
  }

  function drawNodes() {
    const q = $('filter').value.trim().toLowerCase();
    let list = allNodes().filter(n => (scope === 'all' ? true : scope === 'web' ? n.source === 'web' : n.source === 'radio'));
    const total = list.length;
    if (q) list = list.filter(n => [n.name, n.short, n.id, n.kind, n.hw].some(v => v && String(v).toLowerCase().includes(q)));
    const val = (n, k) => (k === 'name' ? n.name.toLowerCase() : k === 'kind' ? fmtKind(n.kind) : n[k]);
    list.sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      const x = val(a, sort.key), y = val(b, sort.key);
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (x < y ? -1 : 1) * sort.dir;
    });
    document.querySelectorAll('th[data-sort]').forEach(th => {
      if (th.dataset.sort === sort.key) th.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
    });
    $('rows').innerHTML = list.slice(0, 600).map(nodeRow).join('');
    $('nodeCounts').textContent = q ? `${list.length} of ${total}` : `${total}`;
    const anyRadio = tabNets().some(net => data?.networks[net]?.configured);
    $('empty').textContent = list.length ? '' : q ? 'No node matches that filter.'
      : scope === 'radio' ? (anyRadio ? 'Your radio hasn’t told us about any nodes yet.' : 'No radio is set up for this tab. Public nodes are under “Radios + public maps”.')
        : web?.enabled === false ? 'Public maps are turned off in the app’s settings.' : 'No public nodes nearby yet.';
  }
  $('rows').onclick = e => {
    const tr = e.target.closest('tr[data-key]');
    if (!tr) return;
    selected = tr.dataset.key;
    drawNodes();
    const m = markers.get(selected);
    if (m) {
      if (!map.hasLayer(m)) { showPublic = true; $('public').setAttribute('aria-pressed', 'true'); drawMap(); }
      map.setView(m.getLatLng(), Math.max(map.getZoom(), 11));
      m.openPopup();
      $('map').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else {
      const n = allNodes().find(x => nodeKey(x) === selected);
      if (n && canMessage(n)) openDm(n);
    }
  };

  // ---- map --------------------------------------------------------------------
  let map = null, homeRing = null, fitted = false;
  const markers = new Map();
  const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  try {
    map = L.map('map', { worldCopyJump: true, zoomSnap: 0.5 });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com/" target="_blank" rel="noopener noreferrer">Leaflet</a>');
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © <a href="https://www.esri.com/" target="_blank" rel="noopener noreferrer">Esri</a> — Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCAN, METI, TomTom and the GIS User Community',
      maxZoom: 18,
    }).addTo(map);
    map.setView([39.5, -98.35], 4);
    map.on('popupopen', e => { if (e.popup._source?._meshKey) selected = e.popup._source._meshKey; });
    if (window.ResizeObserver) {
      new ResizeObserver(() => { map.invalidateSize(false); if (!fitted && markers.size) fitMap(false); }).observe($('map'));
    }
  } catch (e) {
    console.error('map', e);
    map = null;
  }

  function canMessage(n) {
    if (n.source !== 'radio' || n.isSelf || !data?.sending) return false;
    return data.networks[n.network]?.state === 'connected';
  }

  function popup(n) {
    const rows = [];
    const add = (k, v) => { if (v !== null && v !== undefined && v !== '' && v !== '—') rows.push(`<dt>${k}</dt><dd>${v}</dd>`); };
    add('Type', esc(fmtKind(n.kind)));
    add('Hardware', esc(fmtHw(n.hw)));
    add('Heard', n.lastHeard ? `${ago(n.lastHeard)}${ago(n.lastHeard) === 'now' ? '' : ' ago'}` : null);
    if (!n.isSelf) add('Hops', n.hops ?? null);
    add('SNR', n.snr !== null && n.snr !== undefined ? `${n.snr.toFixed(1)} dB` : null);
    add('RSSI', n.rssi ? `${n.rssi} dBm` : null);
    add('Battery', n.battery !== null && n.battery !== undefined ? battery(n.battery, n.voltage) + (n.voltage ? ` · ${n.voltage.toFixed(2)} V` : '') : n.voltage ? `${n.voltage.toFixed(2)} V` : null);
    add('Channel use', n.chUtil !== null && n.chUtil !== undefined ? `${n.chUtil}% · TX ${n.airUtil ?? 0}%` : null);
    if (n.env) add('Weather', [n.env.temperature !== undefined && n.env.temperature !== null ? `${n.env.temperature} °C` : '', n.env.humidity ? `${n.env.humidity}%` : '', n.env.pressure ? `${n.env.pressure} hPa` : ''].filter(Boolean).join(' · '));
    add('Altitude', n.alt ? `${n.alt} m` : null);
    add('Distance', n.distance !== null ? `${n.distance.toFixed(1)} km` : null);
    if (n.radio) add('Radio', `${n.radio.freq} MHz · BW ${n.radio.bw} · SF ${n.radio.sf}`);
    if (n.preset) add('Preset', esc(titleCase(n.preset)));
    add('Firmware', esc(n.firmware));
    if (n.viaMqtt) add('Via', 'MQTT');
    const id = n.network === 'meshcore' ? `${n.id.slice(0, 12)}…` : n.id;
    const actions = canMessage(n) ? `<div class="pop-actions"><button type="button" class="primary" data-dm="${esc(n.network)}|${esc(n.id)}">Message</button></div>` : '';
    return `<div class="pop" data-net="${n.network}"><h3><i class="dot"></i>${esc(n.name)}</h3>
      <div class="sub">${NET_NAME[n.network]} · ${esc(id)}${n.source === 'web' ? ' · public map' : n.isSelf ? ' · your radio' : ''}</div>
      <dl>${rows.join('')}</dl>${actions}</div>`;
  }

  function style(n) {
    const color = cssVar(n.network === 'meshtastic' ? '--mt' : '--mc');
    // Your own radio: its network's colour with a thick ring in the text colour.
    if (n.isSelf) return { radius: 9, color: cssVar('--text') || '#fff', weight: 3, fillColor: color, fillOpacity: 1 };
    if (n.source === 'web') return { radius: 5.5, color, weight: 2, fillColor: color, fillOpacity: 0.12, dashArray: null };
    const fresh = n.lastHeard && Date.now() - n.lastHeard < 2 * 3600_000;
    return { radius: 7, color: cssVar('--card') || '#fff', weight: 1.5, fillColor: color, fillOpacity: fresh ? 0.95 : 0.5 };
  }

  function drawMap(restyle = false) {
    if (!map || !data) return;
    const seen = new Set();
    for (const n of allNodes()) {
      if (!hasPos(n)) continue;
      if (n.source === 'web' && !showPublic) continue;
      const key = nodeKey(n);
      seen.add(key);
      let m = markers.get(key);
      if (!m) {
        m = L.circleMarker([n.lat, n.lon], style(n));
        m._meshKey = key;
        // Leaflet puts tooltip strings in as HTML, and node names come from the air.
        m.bindTooltip(esc(n.name), { direction: 'top', offset: [0, -6] });
        m.bindPopup(() => popup(m._node), { maxWidth: 300 });
        markers.set(key, m);
        m.addTo(map);
      } else {
        m.setLatLng([n.lat, n.lon]);
        m.setStyle(style(n));
        if (!map.hasLayer(m)) m.addTo(map);
        if (m._node?.name !== n.name) m.setTooltipContent(esc(n.name));
      }
      m._node = n;
      if (n.isSelf || n.source === 'radio') m.bringToFront();
    }
    for (const [key, m] of markers) if (!seen.has(key)) { m.remove(); markers.delete(key); }
    if (data.home && web?.enabled && showPublic) {
      const r = (web.radiusKm || 100) * 1000;
      if (!homeRing) homeRing = L.circle([data.home.lat, data.home.lon], { radius: r, color: cssVar('--accent'), weight: 1.2, dashArray: '5 6', fillOpacity: 0.03, interactive: false }).addTo(map);
      else { homeRing.setLatLng([data.home.lat, data.home.lon]); homeRing.setRadius(r); if (restyle) homeRing.setStyle({ color: cssVar('--accent') }); if (!map.hasLayer(homeRing)) homeRing.addTo(map); }
    } else if (homeRing) homeRing.remove();
    const radioPts = [...markers.values()].filter(m => m._node.source === 'radio').length;
    const webPts = [...markers.values()].length - radioPts;
    $('mapinfo').textContent = `${radioPts} from your radios${showPublic && web?.enabled ? ` · ${webPts} public` : ''}`;
    if (!fitted) fitMap(false);
  }

  function fitMap(force) {
    if (!map) return;
    // A map with no size yet (a hidden tab, a panel still opening) would fit to
    // zoom 0; wait for the resize observer below to try again.
    map.invalidateSize(false);
    const size = map.getSize();
    if (!size.x || !size.y) return;
    const pts = [...markers.values()].filter(m => force || m._node.source === 'radio').map(m => m.getLatLng());
    if (!pts.length && data?.home) pts.push(L.latLng(data.home.lat, data.home.lon));
    if (!pts.length) return;
    fitted = true;
    if (pts.length === 1) map.setView(pts[0], 11);
    else map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 13 });
  }

  $('map').addEventListener('click', e => {
    const b = e.target.closest('button[data-dm]');
    if (!b) return;
    const [net, id] = b.dataset.dm.split('|');
    const n = (data.networks[net]?.nodes || []).find(x => x.id === id);
    if (n) openDm(n);
    map.closePopup();
  });

  // ---- radios -----------------------------------------------------------------
  const STATE_LABEL = { off: 'Not set up', connecting: 'Connecting…', syncing: 'Loading…', connected: 'Connected', error: 'Offline' };

  function drawRadios() {
    const html = tabNets().map(net => {
      const r = data.networks[net];
      if (!r?.configured) {
        return `<div class="radio" data-net="${net}"><div class="radio-head"><i class="dot"></i><b>${NET_NAME[net]}</b><span class="state">${STATE_LABEL.off}</span></div>
          <div class="hint">Add its address on the app’s Configuration tab to connect over Wi-Fi.</div></div>`;
      }
      const s = r.self || {};
      const facts = [];
      if (s.battery !== null && s.battery !== undefined || s.voltage) facts.push(battery(s.battery, s.voltage));
      if (net === 'meshtastic' && r.radio?.preset) facts.push(esc(`${r.radio.region || ''} ${r.radio.preset}`.trim()));
      if (net === 'meshcore' && r.radio?.freq) facts.push(esc(`${r.radio.freq.toFixed(3)} MHz · SF${r.radio.sf} · BW${r.radio.bw}`));
      const others = (r.nodes || []).filter(n => !n.isSelf);
      if (r.state === 'connected') facts.push(`${others.length} ${net === 'meshcore' ? 'contacts' : 'nodes'}`);
      if (net === 'meshcore' && r.radio?.lastRx) facts.push(`last packet ${r.radio.lastRx.rssi} dBm / ${r.radio.lastRx.snr} dB`);
      if (s.firmware) facts.push(esc(s.firmware));
      facts.push(`<span class="muted">${esc(r.host)}:${r.port}</span>`);
      return `<div class="radio" data-net="${net}"><div class="radio-head"><i class="dot"></i><b>${esc(s.name || NET_NAME[net])}</b><span class="state" data-state="${r.state}">${STATE_LABEL[r.state] || r.state}</span></div>
        <div class="facts">${facts.map(f => `<span>${f}</span>`).join('')}</div>
        ${r.state === 'error' && r.error ? `<div class="err">${esc(r.error)}</div>` : ''}</div>`;
    }).join('');
    $('radios').innerHTML = html;
    for (const net of NETS) {
      const r = data.networks[net];
      const b = $(`badge-${net}`);
      b.dataset.state = r?.configured ? r.state : 'off';
      b.title = `${NET_NAME[net]}: ${r?.configured ? STATE_LABEL[r.state] || r.state : 'not set up'}`;
      b.hidden = !r?.configured;
    }
  }

  // ---- chats ------------------------------------------------------------------
  const chatId = (net, key) => `${net}|${key}`;

  function chatList() {
    const out = [];
    for (const net of tabNets()) {
      const r = data.networks[net];
      if (!r) continue;
      const have = new Set();
      for (const c of r.chats || []) { out.push({ ...c, id: chatId(net, c.key) }); have.add(c.key); }
      for (const [id, c] of extraDms) if (c.network === net && !have.has(c.key)) out.push({ ...c, id });
      // Messages kept from a channel the radio no longer reports (or before it reconnects).
      for (const m of messages.values()) {
        if (m.network === net && !have.has(m.chat) && m.chat.startsWith('ch:')) {
          have.add(m.chat);
          out.push({ key: m.chat, network: net, kind: 'channel', name: `Channel ${m.chat.slice(3)}`, id: chatId(net, m.chat), stale: true });
        }
      }
    }
    return out;
  }

  function unread(c) {
    const since = lastRead[c.id] || 0;
    let n = 0;
    for (const m of messages.values()) if (m.network === c.network && m.chat === c.key && !m.outgoing && m.time > since) n++;
    return n;
  }

  function markRead() {
    if (!activeChat) return;
    const [net, key] = splitChat(activeChat);
    let last = lastRead[activeChat] || 0;
    for (const m of messages.values()) if (m.network === net && m.chat === key && m.time > last) last = m.time;
    if (last !== lastRead[activeChat]) { lastRead[activeChat] = last; store.set('read', lastRead); }
  }
  const splitChat = id => { const i = id.indexOf('|'); return [id.slice(0, i), id.slice(i + 1)]; };

  function drawChats() {
    const list = chatList();
    if (!list.find(c => c.id === activeChat)) activeChat = list[0]?.id || null;
    if (!document.hidden) markRead();
    $('chats').innerHTML = list.map(c => {
      const u = c.id === activeChat ? 0 : unread(c);
      return `<button type="button" role="tab" data-chat="${esc(c.id)}" data-net="${c.network}" aria-selected="${c.id === activeChat}">
        ${tab === 'all' ? '<i class="dot"></i>' : ''}${c.kind === 'dm' ? '<span class="dm-mark">@</span>' : c.name.startsWith('#') ? '' : '#'}${esc(c.name)}${u ? `<span class="unread">${u > 99 ? '99+' : u}</span>` : ''}</button>`;
    }).join('') || '<span class="muted">No channels yet.</span>';
    const active = list.find(c => c.id === activeChat);
    $('chatNet').textContent = active ? `${NET_NAME[active.network]} · ${active.kind === 'dm' ? 'direct' : 'channel'}` : '';
    drawLog(active);
    drawComposer(active);
  }
  $('chats').onclick = e => {
    const b = e.target.closest('button[data-chat]');
    if (!b) return;
    activeChat = b.dataset.chat;
    store.set('chat', activeChat);
    logSig = '';
    drawChats();
    $('text').focus({ preventScroll: true });
  };

  function openDm(n) {
    const key = `dm:${n.id}`;
    const id = chatId(n.network, key);
    if (!(data.networks[n.network]?.chats || []).some(c => c.key === key)) extraDms.set(id, { key, network: n.network, kind: 'dm', name: n.name });
    if (tab !== 'all' && tab !== n.network) setTab(n.network);
    activeChat = id;
    store.set('chat', id);
    logSig = '';
    drawChats();
    document.querySelector('.chat').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    $('text').focus({ preventScroll: true });
  }

  let logSig = '';
  function drawLog(active) {
    const log = $('log');
    if (!active) { log.innerHTML = '<p class="none">Messages appear here once a radio is connected.</p>'; logSig = ''; return; }
    const list = [...messages.values()].filter(m => m.network === active.network && m.chat === active.key).sort((a, b) => a.time - b.time);
    const sig = `${active.id}|${list.length}|${list.map(m => m.status || '').join('')}|${list.at(-1)?.id || ''}|${Math.floor(Date.now() / 60000)}`;
    if (sig === logSig) return;
    logSig = sig;
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    if (!list.length) {
      log.innerHTML = `<p class="none">${active.kind === 'dm' ? `No messages with ${esc(active.name)} yet.` : `Nothing on ${esc(active.name)} yet. Messages heard from now on show up here.`}</p>`;
      return;
    }
    const nodes = data.networks[active.network]?.nodes || [];
    let lastDay = '';
    const html = [];
    for (const m of list.slice(-300)) {
      const day = dayLabel(m.time);
      if (day !== lastDay) { html.push(`<div class="day">${esc(day)}</div>`); lastDay = day; }
      const meta = [clock(m.time)];
      if (!m.outgoing) {
        if (m.hops !== null && m.hops !== undefined) meta.push(m.hops === 0 ? 'direct' : `${m.hops} hop${m.hops === 1 ? '' : 's'}`);
        if (m.snr !== null && m.snr !== undefined) meta.push(`SNR ${m.snr}`);
        if (m.rssi) meta.push(`${m.rssi} dBm`);
        if (m.viaMqtt) meta.push('MQTT');
      } else {
        const st = { queued: 'Sending…', sent: '✓ Sent', delivered: '✓✓ Delivered', failed: `Failed${m.error ? `: ${m.error}` : ''}`, unknown: 'Sent' }[m.status] || '';
        meta.push(`<span class="st-${esc(m.status)}">${esc(st)}</span>`);
      }
      const sender = !m.outgoing && active.kind === 'channel'
        ? (() => {
          const n = m.from && nodes.find(x => x.id === m.from);
          const name = esc(n?.name || m.fromName || 'Unknown');
          return `<div class="who">${n && canMessage(n) ? `<button type="button" data-dm-from="${esc(n.id)}" title="Message ${name} directly">${name}</button>` : name}</div>`;
        })() : '';
      html.push(`<div class="msg${m.outgoing ? ' out' : ''}" data-net="${m.network}">${sender}<div class="text">${esc(m.text)}</div><div class="meta">${meta.join(' · ')}</div></div>`);
    }
    log.innerHTML = html.join('');
    if (atBottom || log.dataset.chat !== active.id) log.scrollTop = log.scrollHeight;
    log.dataset.chat = active.id;
  }
  $('log').onclick = e => {
    const b = e.target.closest('button[data-dm-from]');
    if (!b) return;
    const [net] = splitChat(activeChat);
    const n = (data.networks[net]?.nodes || []).find(x => x.id === b.dataset.dmFrom);
    if (n) openDm(n);
  };

  // ---- composer ---------------------------------------------------------------
  const enc = new TextEncoder();
  let composerError = '';
  function drawComposer(active) {
    const r = active && data.networks[active.network];
    let why = '';
    if (!data.sending) why = 'Sending is turned off in the app’s settings.';
    else if (!active) why = 'No chat selected.';
    else if (r?.state !== 'connected') why = `The ${NET_NAME[active.network]} radio isn’t connected.`;
    else if (active.stale) why = 'That channel isn’t on the radio any more.';
    $('composer').hidden = !data.sending;
    $('text').disabled = !!why;
    $('text').placeholder = why || `Message ${active.kind === 'dm' || active.name.startsWith('#') ? active.name : '#' + active.name} on ${NET_NAME[active.network]}`;
    const max = r?.maxTextBytes || 200;
    const used = enc.encode($('text').value).length;
    $('count').textContent = composerError || (used ? `${used} / ${max} bytes` : '');
    $('count').className = composerError || used > max ? 'over' : 'muted';
    $('sendBtn').disabled = !!why || !used || used > max || sending;
  }
  $('text').oninput = () => { composerError = ''; drawComposer(chatList().find(c => c.id === activeChat)); };
  $('text').onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); }
  };
  let sending = false;
  $('composer').onsubmit = async e => {
    e.preventDefault();
    const active = chatList().find(c => c.id === activeChat);
    const text = $('text').value.trim();
    if (!active || !text || sending) return;
    sending = true;
    drawComposer(active);
    try {
      const res = await fetch('api/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ network: active.network, chat: active.key, text }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error?.message || `Not sent (HTTP ${res.status}).`);
      messages.set(body.message.id, body.message);
      $('text').value = '';
      composerError = '';
      logSig = '';
      $('log').scrollTop = $('log').scrollHeight;
    } catch (err) {
      composerError = err.message || 'Not sent.';
    } finally {
      sending = false;
      drawChats();
      $('log').scrollTop = $('log').scrollHeight;
    }
  };

  // ---- status line ------------------------------------------------------------
  function drawStatus() {
    const notes = [];
    let tone = '';
    const configured = NETS.filter(n => data.networks[n]?.configured);
    if (!configured.length) {
      notes.push('No radio is set up yet. Add your Meshtastic node’s or MeshCore radio’s address on the app’s <b>Configuration</b> tab, then restart the app. Public nodes still show on the map.');
    }
    if (web?.enabled) {
      for (const net of tabNets()) if (web[net]?.error) { notes.push(`${NET_NAME[net]} public map: ${esc(web[net].error)}`); tone = 'warn'; }
      if (!data.home) notes.push('Public nodes appear once Home Assistant’s home location (or a radio’s position) is known.');
    }
    $('status').innerHTML = notes.map(n => `<p>${n}</p>`).join('');
    $('status').dataset.tone = tone;
    const nodes = allNodes();
    const radioCount = nodes.filter(x => x.source === 'radio' && !x.isSelf).length;
    const webCount = nodes.filter(x => x.source === 'web').length;
    $('summary').textContent = `${radioCount} heard by your radios${web?.enabled ? ` · ${webCount} more on the public maps within ${web.radiusKm} km` : ''}`;
  }

  // ---- polling ----------------------------------------------------------------
  function render() {
    if (!data) return;
    drawRadios();
    drawStatus();
    drawChats();
    drawNodes();
    drawMap();
  }

  let pollTimer = null;
  async function poll() {
    clearTimeout(pollTimer);
    try {
      const res = await fetch(`api/state?rev=${rev}&web=${encodeURIComponent(webRev)}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const s = await res.json();
      $('offline').hidden = true;
      if (s.messages.full) messages.clear();
      for (const m of s.messages.messages) messages.set(m.id, m);
      rev = s.messages.rev;
      if (s.web) { web = s.web; webRev = s.webRev; }
      data = s;
      render();
    } catch {
      $('offline').hidden = false;
    }
    pollTimer = setTimeout(poll, document.hidden ? POLL_HIDDEN_MS : POLL_MS);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

  setTab(tab);
  applyTheme();
  poll();
})();
