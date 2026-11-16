'use strict';
// The printer's file storage, over implicit FTPS on port 990 (user "bblp", the
// LAN access code as the password), the same way the Bambu Lab integration and
// Bambu Studio reach it. Used to list the printer's files, send a .3mf to it
// and download one. Each operation opens its own short session, one at a time.
//
// The printer's certificate is issued by Bambu Lab's own authority, not one the
// system trusts. It's checked against Bambu Lab's authorities (certs/bambu.pem),
// and its name must be the printer's serial number, before the access code is
// sent. The address is the one the Bambu Lab integration reports.
// Data connections reuse the control connection's TLS session, which the
// printer requires.

const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');

class FtpError extends Error {
  constructor(message, code = 0) { super(message); this.name = 'FtpError'; this.code = code; }
}

const SAFE_PATH = /^\/[^\x00-\x1f\x7f]{0,300}$/;

const BAMBU_CA = fs.readFileSync(path.join(__dirname, 'certs', 'bambu.pem'), 'utf8');

// The printer's certificate is issued to its serial number, not to its address.
function checkPrinter(serial) {
  return (_host, cert) => {
    const cn = String(cert?.subject?.CN || '');
    if (!serial || cn.toUpperCase() !== String(serial).toUpperCase()) {
      return new FtpError(`The printer's certificate is for "${cn || 'nothing'}", not this printer (${serial || 'no serial'}).`, 'WRONG_PRINTER');
    }
    return undefined;
  };
}

const tlsOptions = serial => ({
  ca: BAMBU_CA, rejectUnauthorized: true, checkServerIdentity: checkPrinter(serial),
  maxVersion: 'TLSv1.2', minVersion: 'TLSv1.2',
});

// Real use: TLS from the first byte, data channels wrapped after the server's
// 150 reply with the control session. Tests pass plain TCP instead.
const TLS_TRANSPORT = {
  control: (host, port, serial) => tls.connect({ host, port, ...tlsOptions(serial) }),
  // host must be given even with an existing socket: without it Node treats
  // the connection as one to "localhost", and the printer (vsFTPd with
  // require_ssl_reuse) refuses a data connection that doesn't resume the session.
  wrapData: (raw, control, host, serial) => new Promise((resolve, reject) => {
    const s = tls.connect({ socket: raw, host, session: control.getSession?.(), ...tlsOptions(serial) }, () => resolve(s));
    s.on('error', reject);
  }),
};

class Session {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buf = '';
    this.lines = [];
    this.waiters = [];
    this.replies = [];
    this.closedErr = null;
    socket.setEncoding?.('utf8');
    socket.on('data', d => { this.buf += d; this.parse(); });
    const end = err => {
      this.closedErr = err || new FtpError('The printer closed the connection.');
      for (const w of this.waiters.splice(0)) w.reject(this.closedErr);
    };
    socket.on('error', e => end(new FtpError(friendly(e))));
    socket.on('close', () => end());
  }

  parse() {
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      // A reply ends with "ddd " (multi-line replies start with "ddd-").
      if (/^\d{3}( |$)/.test(line)) {
        const text = this.lines.join('\n');
        this.lines = [];
        const r = { code: Number(line.slice(0, 3)), text };
        const w = this.waiters.shift();
        if (w) { clearTimeout(w.timer); w.resolve(r); } else this.replies.push(r);
      }
    }
  }

  reply() {
    if (this.replies.length) return Promise.resolve(this.replies.shift());
    if (this.closedErr) return Promise.reject(this.closedErr);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new FtpError('The printer did not answer in time.')), this.timeoutMs);
      this.waiters.push({ resolve, reject, timer });
    });
  }

  async cmd(line, ...okCodes) {
    if (/[\r\n\0]/.test(line)) throw new FtpError('Refused: bad characters in a file name.');
    const p = this.reply();
    this.socket.write(line + '\r\n');
    const r = await p;
    if (okCodes.length && !okCodes.includes(r.code)) {
      if (r.code === 530) throw new FtpError('The printer refused the access code. Check it on the printer\'s screen and in the app\'s Configuration tab.', 530);
      if (r.code === 550) throw new FtpError('The printer says that file or folder is not there.', 550);
      if (r.code === 552 || r.code === 452) throw new FtpError('The printer\'s storage is full.', r.code);
      throw new FtpError(`The printer answered "${r.text.split('\n').pop()}".`, r.code);
    }
    return r;
  }
}

function friendly(e) {
  if (e.code === 'ECONNREFUSED') return 'The printer refused the file connection (port 990). Is LAN access turned on in its network settings?';
  if (e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH') return "Can't reach the printer on the network.";
  if (e.code === 'ECONNRESET') return 'The printer dropped the connection.';
  if (e.code === 'WRONG_PRINTER') return e.message;
  if (/CERT|SELF_SIGNED|ISSUER|SIGNATURE/.test(String(e.code || ''))) return `The printer's certificate isn't one Bambu Lab issued (${e.code}), so the app won't send it the access code.`;
  return `Can't talk to the printer (${e.code || e.message}).`;
}

class PrinterFiles {
  constructor({ host, accessCode, serial, port = 990, transport = TLS_TRANSPORT, timeoutMs = 20_000 } = {}) {
    Object.assign(this, { host, accessCode, serial, port, transport, timeoutMs });
    this.queue = Promise.resolve();
  }

  get configured() { return Boolean(this.host && this.accessCode); }

  // One session at a time: the printer only takes a couple of connections.
  run(fn) {
    const job = this.queue.then(() => this.session(fn));
    this.queue = job.catch(() => {});
    return job;
  }

  async session(fn) {
    if (!this.configured) throw new FtpError('Add the printer\'s access code on the app\'s Configuration tab to use its files.');
    const socket = this.transport.control(this.host, this.port, this.serial);
    const s = new Session(socket, this.timeoutMs);
    socket.setTimeout?.(this.timeoutMs * 3, () => socket.destroy(new FtpError('The printer stopped answering.')));
    try {
      const hello = await s.reply();
      if (hello.code !== 220) throw new FtpError(`The printer answered "${hello.text}".`);
      await s.cmd('USER bblp', 331, 230);
      await s.cmd(`PASS ${this.accessCode}`, 230);
      await s.cmd('PBSZ 0', 200);
      await s.cmd('PROT P', 200);
      await s.cmd('TYPE I', 200);
      return await fn(s);
    } finally {
      try { socket.write('QUIT\r\n'); } catch { /* closing anyway */ }
      setTimeout(() => socket.destroy(), 200).unref?.();
    }
  }

  // Opens a passive data connection for a command and returns it once the
  // printer has said it is ready (150/125).
  async data(s, command) {
    const r = await s.cmd('PASV', 227);
    const m = r.text.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/);
    if (!m) throw new FtpError('The printer gave no data port.');
    const port = Number(m[5]) * 256 + Number(m[6]);
    // Always the printer's own address, whatever address the reply names.
    const raw = await new Promise((resolve, reject) => {
      const c = net.connect({ host: this.host, port }, () => resolve(c));
      c.on('error', e => reject(new FtpError(friendly(e))));
      c.setTimeout(this.timeoutMs, () => c.destroy(new FtpError('The printer stopped sending.')));
    });
    try {
      await s.cmd(command, 150, 125);
    } catch (e) { raw.destroy(); throw e; }
    return this.transport.wrapData ? this.transport.wrapData(raw, s.socket, this.host, this.serial) : raw;
  }

  list(dir = '/') {
    if (!SAFE_PATH.test(dir)) return Promise.reject(new FtpError('Refused: bad folder name.'));
    return this.run(async s => {
      const d = await this.data(s, `LIST ${dir}`);
      const text = await collect(d);
      await s.reply().then(r => { if (r.code >= 400) throw new FtpError(`The printer answered "${r.text}".`, r.code); });
      return parseList(text.toString('utf8'), dir);
    });
  }

  // Streams a file into `onStream(readable, size)`; resolves when it's done.
  download(file, onStream) {
    if (!SAFE_PATH.test(file)) return Promise.reject(new FtpError('Refused: bad file name.'));
    return this.run(async s => {
      let size = null;
      try { const r = await s.cmd(`SIZE ${file}`, 213); size = Number(r.text.slice(4)) || null; } catch (e) { if (e.code === 550) throw e; }
      const d = await this.data(s, `RETR ${file}`);
      await onStream(d, size);
      const r = await s.reply();
      if (r.code >= 400) throw new FtpError(`The printer answered "${r.text}".`, r.code);
    });
  }

  downloadBuffer(file, maxBytes) {
    let out;
    return this.download(file, async d => { out = await collect(d, maxBytes); }).then(() => out);
  }

  // Sends a readable stream to the printer as `file`.
  upload(file, readable) {
    if (!SAFE_PATH.test(file)) return Promise.reject(new FtpError('Refused: bad file name.'));
    return this.run(async s => {
      if (readable.errored || readable.destroyed) throw readable.errored || new FtpError('The upload was cancelled.');
      const d = await this.data(s, `STOR ${file}`);
      await new Promise((resolve, reject) => {
        if (readable.errored) { d.destroy(); return reject(readable.errored); }
        readable.on('error', e => { d.destroy(); reject(e); });
        d.on('error', e => reject(new FtpError(friendly(e))));
        readable.pipe(d);
        d.on('finish', resolve);
      });
      d.end();
      const r = await s.reply();
      if (r.code >= 400) throw new FtpError(`The printer answered "${r.text}".`, r.code);
    });
  }
}

function collect(stream, maxBytes = Infinity) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    stream.on('data', c => {
      n += c.length;
      if (n > maxBytes) { stream.destroy(); reject(new FtpError('That file is too big.')); return; }
      chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('close', () => resolve(Buffer.concat(chunks)));
    stream.on('error', e => reject(new FtpError(friendly(e))));
  });
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Unix-style LIST lines: "-rw-rw-rw- 1 root root 1234 Mar 03 14:20 name.3mf".
function parseList(text, dir, now = new Date()) {
  const base = dir.endsWith('/') ? dir : dir + '/';
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([d-])[rwxs-]{9}\S*\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}:\d{2}|\d{4})\s+(.+)$/);
    if (!m) continue;
    const [, kind, size, mon, day, timeOrYear, name] = m;
    if (name === '.' || name === '..') continue;
    let t = null;
    const mi = MONTHS[mon.toLowerCase()];
    if (mi !== undefined) {
      if (timeOrYear.includes(':')) {
        const [h, mm] = timeOrYear.split(':').map(Number);
        let y = now.getUTCFullYear();
        if (Date.UTC(y, mi, Number(day)) > now.getTime() + 2 * 86400_000) y--;
        t = Date.UTC(y, mi, Number(day), h, mm);
      } else t = Date.UTC(Number(timeOrYear), mi, Number(day));
    }
    out.push({ name, path: base + name, dir: kind === 'd', size: Number(size), mtime: t });
  }
  return out;
}

module.exports = { PrinterFiles, FtpError, parseList, TLS_TRANSPORT, SAFE_PATH, BAMBU_CA, checkPrinter, friendly };
