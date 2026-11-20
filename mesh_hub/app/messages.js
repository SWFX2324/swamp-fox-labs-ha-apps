'use strict';
// Every message heard or sent, for both networks, kept across restarts in
// /data/messages.json (the newest 1,000 per network). Each change bumps a
// revision number, so the page asks only for what changed since its last look.

const fs = require('fs');

const KEEP_PER_NETWORK = 1000;
const SAVE_DELAY_MS = 2000;

class MessageStore {
  constructor({ file = null, log = console } = {}) {
    this.file = file;
    this.log = log;
    this.rev = 0;
    this.byId = new Map();
    this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const m of Array.isArray(saved.messages) ? saved.messages : []) {
        if (!m || typeof m.id !== 'string') continue;
        // Anything still on its way when the app stopped won't hear back now.
        if (m.status === 'queued') m.status = 'unknown';
        m.rev = ++this.rev;
        this.byId.set(m.id, m);
      }
    } catch { /* first start */ }
  }

  scheduleSave() {
    if (!this.file || this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.save(), SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    if (!this.file) return;
    try {
      const messages = [...this.byId.values()].map(({ rev, ...m }) => m);
      fs.writeFileSync(this.file + '.tmp', JSON.stringify({ messages }));
      fs.renameSync(this.file + '.tmp', this.file);
    } catch (e) { this.log.warn('[messages] saving:', e.message); }
  }

  add(m) {
    if (this.byId.has(m.id)) return this.byId.get(m.id);   // the radio sent it again
    const msg = { ...m, rev: ++this.rev };
    this.byId.set(msg.id, msg);
    this.trim(msg.network);
    this.scheduleSave();
    return msg;
  }

  update(id, patch) {
    const m = this.byId.get(id);
    if (!m) return;
    // A message never goes back from delivered to sent.
    if (m.status === 'delivered' && patch.status && patch.status !== 'delivered') return;
    Object.assign(m, patch, { rev: ++this.rev });
    this.scheduleSave();
  }

  trim(network) {
    const mine = [...this.byId.values()].filter(m => m.network === network);
    if (mine.length <= KEEP_PER_NETWORK) return;
    mine.sort((a, b) => a.time - b.time);
    for (const m of mine.slice(0, mine.length - KEEP_PER_NETWORK)) this.byId.delete(m.id);
    this.trimmedAt = ++this.rev;   // tells pages to reload the full list
  }

  // Messages changed after `since`. A page that's never seen any, or one that
  // missed a trim, gets the whole list (full: true).
  since(since) {
    const full = !(since > 0) || (this.trimmedAt && since < this.trimmedAt) || since > this.rev;
    const list = [...this.byId.values()].filter(m => full || m.rev > since).sort((a, b) => a.time - b.time);
    return { rev: this.rev, full, messages: list.map(({ rev, ...m }) => m) };
  }

  directChats(network) {
    const out = new Map();
    for (const m of this.byId.values()) {
      if (m.network !== network || !m.chat.startsWith('dm:')) continue;
      const prev = out.get(m.chat) || { key: m.chat, network, kind: 'dm', peer: m.chat.slice(3), last: 0, fallbackName: null };
      prev.last = Math.max(prev.last, m.time);
      if (!m.outgoing && m.fromName) prev.fallbackName = m.fromName;
      out.set(m.chat, prev);
    }
    return [...out.values()];
  }
}

module.exports = { MessageStore, KEEP_PER_NETWORK };
