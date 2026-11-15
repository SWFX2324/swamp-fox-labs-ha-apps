'use strict';
// Reads a UniFi Network application directly (a UniFi OS console, or a
// self-hosted UniFi Network server) with a local account.
// It only sends GET requests after signing in, so a View Only account is
// enough and is what DOCS.md recommends.
//
// Home Assistant's UniFi integration has no per-network (VLAN) data or WAN
// throughput, which is why the app asks the console itself.
//
// The password stays in the app; nothing from here reaches the browser except
// the summarised figures model.js builds.

const https = require('https');

class UnifiError extends Error {
  constructor(message, status = 0) { super(message); this.name = 'UnifiError'; this.status = status; }
}

// One HTTPS request. Replaced by tests/fixtures/fake-world.js.
function httpsRequest({ host, port, method, path, headers, body, verifySsl, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, port, method, path, headers, rejectUnauthorized: verifySsl, timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const transport = { request: httpsRequest };

class UniFi {
  constructor({ host, port = 443, username, password, site = 'default', verifySsl = false, timeoutMs = 15_000 } = {}) {
    const h = String(host || '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const m = h.match(/^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
    this.host = m ? m[1].replace(/^\[|\]$/g, '') : h;
    this.port = Number(m?.[2]) || Number(port) || 443;
    Object.assign(this, { username: String(username || ''), password: String(password || ''), site: String(site || 'default').trim() || 'default', verifySsl: Boolean(verifySsl), timeoutMs });
    this.configured = Boolean(this.host && this.username && this.password);
    this.cookie = null;
    this.csrf = null;
    this.unifiOs = null; // true: UniFi OS console; false: classic self-hosted server
  }

  async raw(method, path, body, extraHeaders = {}) {
    const headers = { Accept: 'application/json', ...extraHeaders };
    if (body) headers['Content-Type'] = 'application/json';
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.csrf) headers['X-CSRF-Token'] = this.csrf;
    try {
      return await transport.request({ host: this.host, port: this.port, method, path, headers, body: body ? JSON.stringify(body) : undefined, verifySsl: this.verifySsl, timeoutMs: this.timeoutMs });
    } catch (e) {
      if (e.name === 'TimeoutError') throw new UnifiError(`The UniFi console at ${this.host} did not answer in time.`);
      if (/self[- ]signed|certificate|CERT_/i.test(`${e.code} ${e.message}`)) throw new UnifiError('The UniFi console\'s certificate isn\'t trusted. Turn off "Verify SSL certificate" in the app\'s settings, or give the console a trusted certificate.');
      throw new UnifiError(`Can't reach the UniFi console at ${this.host} (${e.code || e.message}).`);
    }
  }

  async login() {
    this.cookie = null;
    this.csrf = null;
    const creds = { username: this.username, password: this.password, rememberMe: false };
    let r = await this.raw('POST', '/api/auth/login', creds);
    this.unifiOs = true;
    if (r.status === 404) { // classic UniFi Network server
      r = await this.raw('POST', '/api/login', creds);
      this.unifiOs = false;
    }
    if (r.status === 401 || r.status === 403) throw new UnifiError('The UniFi console refused the username or password. Check them in the app\'s settings; the account must be a local one, not a Ubiquiti cloud account.', r.status);
    if (r.status === 429) throw new UnifiError('The UniFi console is rate-limiting sign-ins. The app will try again in a few minutes.', 429);
    if (r.status < 200 || r.status >= 300) throw new UnifiError(`The UniFi console answered HTTP ${r.status} to the sign-in.`, r.status);
    const cookies = [].concat(r.headers['set-cookie'] || []).map(c => String(c).split(';')[0]).filter(Boolean);
    if (!cookies.length) throw new UnifiError('The UniFi console accepted the sign-in but sent no session.');
    this.cookie = cookies.join('; ');
    this.csrf = r.headers['x-csrf-token'] || r.headers['x-updated-csrf-token'] || null;
  }

  async get(endpoint, retry = true) {
    if (!this.cookie) await this.login();
    const base = this.unifiOs ? '/proxy/network' : '';
    const r = await this.raw('GET', `${base}/api/s/${encodeURIComponent(this.site)}/${endpoint}`);
    if ((r.status === 401 || r.status === 403) && retry) { this.cookie = null; return this.get(endpoint, false); }
    if (r.status === 404 || r.status === 400) throw new UnifiError(`The UniFi console has no site "${this.site}". Check the site setting (usually "default").`, r.status);
    if (r.status < 200 || r.status >= 300) throw new UnifiError(`The UniFi console answered HTTP ${r.status}.`, r.status);
    let j;
    try { j = JSON.parse(r.body); } catch { throw new UnifiError('The UniFi console sent something that isn\'t JSON.'); }
    if (j?.meta?.rc && j.meta.rc !== 'ok') throw new UnifiError(`The UniFi console said: ${j.meta.msg || 'error'}.`);
    return Array.isArray(j?.data) ? j.data : [];
  }

  async snapshot() {
    if (!this.configured) throw new UnifiError('Not set up.');
    if (!this.cookie) await this.login();
    const [health, networks, clients, devices] = await Promise.all(['stat/health', 'rest/networkconf', 'stat/sta', 'stat/device'].map(e => this.get(e)));
    return { health, networks, clients, devices, at: Date.now() };
  }
}

module.exports = { UniFi, UnifiError, transport };
