'use strict';
// One TCP connection to a node, kept open: reconnects with a growing delay
// (5 s up to 2 min) when the node drops it, reboots or isn't there yet. The
// Meshtastic and MeshCore clients extend this and only parse frames.

const net = require('net');
const { EventEmitter } = require('events');

const MIN_RETRY_MS = 5_000;
const MAX_RETRY_MS = 120_000;
const CONNECT_TIMEOUT_MS = 10_000;
// Nothing at all from a node for this long means the link is dead even if TCP
// hasn't noticed (a node that lost power, a Wi-Fi drop). Only for a client that
// asks the node something regularly, so a quiet mesh isn't taken for a dead link.
const SILENCE_MS = 16 * 60_000;

class TcpLink extends EventEmitter {
  constructor({ network, host, port, log = console, silenceMs = SILENCE_MS }) {
    super();
    this.silenceMs = silenceMs;
    this.network = network;
    this.host = host;
    this.port = port;
    this.log = log;
    this.state = host ? 'connecting' : 'off';
    this.error = null;
    this.connectedAt = null;
    this.lastRx = null;
    this.socket = null;
    this.retryMs = MIN_RETRY_MS;
    this.retryTimer = null;
    this.silenceTimer = null;
    this.stopped = false;
  }

  start() {
    if (!this.host) return;
    this.stopped = false;
    this.open();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.silenceTimer);
    this.onClosed?.();
    if (this.socket) { this.socket.destroy(); this.socket = null; }
    if (this.host) this.setState('off');
  }

  setState(state, error = null) {
    if (this.state === state && this.error === error) return;
    this.state = state;
    this.error = error;
    this.emit('change');
  }

  open() {
    clearTimeout(this.retryTimer);
    this.setState('connecting', this.error);
    const socket = net.connect({ host: this.host, port: this.port });
    this.socket = socket;
    this.rx = Buffer.alloc(0);
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);
    socket.setTimeout(CONNECT_TIMEOUT_MS, () => { if (!this.connectedAt) socket.destroy(new Error('timed out')); });
    socket.on('connect', () => {
      socket.setTimeout(0);
      this.connectedAt = Date.now();
      this.lastRx = Date.now();
      this.log.log(`[${this.network}] connected to ${this.host}:${this.port}`);
      clearInterval(this.silenceTimer);
      if (this.silenceMs) {
        this.silenceTimer = setInterval(() => {
          if (Date.now() - this.lastRx > this.silenceMs) socket.destroy(new Error('the node went quiet'));
        }, Math.min(60_000, this.silenceMs / 4));
        this.silenceTimer.unref?.();
      }
      this.onOpen();
    });
    socket.on('data', chunk => {
      this.lastRx = Date.now();
      this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
      try { this.onData(); } catch (e) {
        this.log.error(`[${this.network}] bad data from the node:`, e.message);
        this.rx = Buffer.alloc(0);
      }
      // A frame that fully parsed means the link works: start the retry
      // delay over next time it drops.
      if (this.state === 'connected') this.retryMs = MIN_RETRY_MS;
    });
    socket.on('error', e => { this.lastError = friendly(e, this.host, this.port); });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = null;
      clearInterval(this.silenceTimer);
      const wasUp = !!this.connectedAt;
      this.connectedAt = null;
      this.onClosed?.();
      if (this.stopped) return;
      const why = this.lastError || (wasUp ? 'The node closed the connection.' : 'Couldn’t connect.');
      this.lastError = null;
      this.log.warn(`[${this.network}] ${why} Retrying in ${Math.round(this.retryMs / 1000)} s.`);
      this.setState('error', why);
      this.retryTimer = setTimeout(() => this.open(), this.retryMs);
      this.retryTimer.unref?.();
      this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
    });
  }

  write(buf) {
    if (!this.socket || !this.connectedAt) return false;
    this.socket.write(buf);
    return true;
  }

  linkStatus() {
    return {
      network: this.network,
      configured: !!this.host,
      host: this.host || null,
      port: this.port,
      state: this.state,
      error: this.error,
      connectedAt: this.connectedAt,
      lastRx: this.lastRx,
    };
  }
}

function friendly(e, host, port) {
  switch (e.code) {
    case 'ECONNREFUSED': return `${host}:${port} refused the connection. Is the node’s Wi-Fi API on, and is the port right?`;
    case 'EHOSTUNREACH': case 'ENETUNREACH': return `Can’t reach ${host} on the network.`;
    case 'ENOTFOUND': case 'EAI_AGAIN': return `Can’t find the host name ${host}.`;
    case 'ECONNRESET': return 'The node reset the connection. Another app may have taken it over.';
    case 'ETIMEDOUT': return `${host}:${port} didn’t answer.`;
    default: return e.message === 'timed out' ? `${host}:${port} didn’t answer.` : e.message === 'the node went quiet' ? 'The node stopped sending anything.' : `Connection error: ${e.message}`;
  }
}

module.exports = { TcpLink, SILENCE_MS };
