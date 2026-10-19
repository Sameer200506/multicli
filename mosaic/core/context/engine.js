'use strict';

const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { SCHEMA_VERSION, validateTopicId, createEntryEnvelope, validateEntryEnvelope, isPlainObject } = require('./schema');
const { assertJson, redactSecrets, checkEntrySize, checkTopicSize, ENTRY_MAX_BYTES, TOPIC_MAX_BYTES } = require('./validation');
const { mergeEntries, canonical } = require('./merge');
const { TOPICS } = require('./topics');

const DEFAULTS = Object.freeze({ maxEntryBytes: ENTRY_MAX_BYTES, maxTopicBytes: TOPIC_MAX_BYTES, lockTimeoutMs: 10000 });
function requireValid(result) { if (!result.ok) throw new TypeError(result.error); }

class ContextStore {
  constructor(options = {}) {
    if (typeof options.workspaceRoot !== 'string' || !path.isAbsolute(options.workspaceRoot)) throw new TypeError('workspaceRoot must be an absolute path');
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.contextDir = path.join(this.workspaceRoot, '.mosaic/context');
    this.maxEntryBytes = options.maxEntryBytes ?? DEFAULTS.maxEntryBytes;
    this.maxTopicBytes = options.maxTopicBytes ?? DEFAULTS.maxTopicBytes;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULTS.lockTimeoutMs;
    for (const n of [this.maxEntryBytes, this.maxTopicBytes, this.lockTimeoutMs]) if (!Number.isSafeInteger(n) || n < 1) throw new TypeError('Limits must be positive safe integers');
    this.paneId = options.paneId || process.env.MOSAIC_PANE_ID || 'unknown';
    this.subscribers = new Map();
    this.watcher = null;
    this.initialized = false;
  }

  async _safe(file, directory = false) {
    try {
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`Unsafe context path: ${file}`);
      return stat;
    } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }
  async _directories() {
    await fs.access(this.workspaceRoot);
    for (const dir of [path.join(this.workspaceRoot, '.mosaic'), this.contextDir]) {
      await this._safe(dir, true);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await this._safe(dir, true);
    }
  }
  async init() {
    if (this.initialized) return this;
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      await this._directories();
      for (const { id } of TOPICS) await this._withLock(id, () => this._create(id));
      this.initialized = true;
      return this;
    })();
    try { return await this.initializing; } finally { this.initializing = null; }
  }
  _paths(topic) {
    requireValid(validateTopicId(topic));
    return { log: path.join(this.contextDir, `${topic}.log.jsonl`), snapshot: path.join(this.contextDir, `${topic}.json`), lock: path.join(this.contextDir, topic + '.lock') };
  }
  async _withLock(topic, callback) {
    const { lock } = this._paths(topic);
    const deadline = Date.now() + this.lockTimeoutMs;
    // mkdir is exclusive across processes. Lock is never stolen on an age heuristic:
    // a paused live writer could otherwise append simultaneously with a new owner.
    while (true) {
      try { await fs.mkdir(lock, { mode: 0o700 }); break; }
      catch (err) {
        // On Windows, a mkdir racing the owner's rmdir reports EPERM (pending
        // delete) or ENOENT (delete already landed) instead of EEXIST. Both are
        // contention, and the deadline below still bounds the wait, so retry
        // them rather than failing the write.
        const contended = err.code === 'EEXIST' || (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'ENOENT'));
        if (!contended) throw err;
        await this._safe(lock, true);
        if (Date.now() >= deadline) {
          const error = new Error(`Context lock timeout: ${lock}. If a writer crashed, remove this lock only after all writers have stopped.`);
          error.code = 'CONTEXT_LOCK_TIMEOUT'; throw error;
        }
        await delay(10 + Math.floor(Math.random() * 20));
        continue;
      }
    }
    try { return await callback(); } finally { await fs.rmdir(lock); }
  }
  async _atomic(file, value) {
    await this._safe(file);
    const temp = `${file}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temp, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(value) + '\n');
      await handle.sync();
      await handle.close(); handle = null;
      await fs.rename(temp, file);
      if (process.platform !== 'win32') {
        const dir = await fs.open(this.contextDir, 'r');
        try { await dir.sync(); } finally { await dir.close(); }
      }
    } finally { if (handle) await handle.close(); await fs.rm(temp, { force: true }); }
  }
  async _create(topic) {
    const { log, snapshot } = this._paths(topic);
    await this._safe(log);
    const handle = await fs.open(log, 'a', 0o600);
    await handle.close();
    const result = await this._replay(topic);
    await this._atomic(snapshot, result.document);
    return result.document;
  }
  async _replay(topic) {
    const { log } = this._paths(topic);
    const stat = await this._safe(log);
    if (!stat) return { document: { schemaVersion: SCHEMA_VERSION, topic, entries: [] }, logBytes: 0, validBytes: 0 };
    if (stat.size > this.maxTopicBytes) throw new Error('Topic log exceeds size limit');
    const bytes = await fs.readFile(log);
    const newline = bytes.lastIndexOf(10);
    const validBytes = newline + 1;
    const entries = [];
    // A torn final append is ignored. Complete malformed records fail closed.
    for (const line of bytes.subarray(0, validBytes).toString('utf8').split('\n')) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { throw new Error(`Corrupt context log: ${topic}`); }
      requireValid(validateEntryEnvelope(entry));
      requireValid(checkEntrySize(entry, this.maxEntryBytes));
      if (entry.topic !== topic) throw new Error('Entry topic mismatch in log');
      entries.push({ ...entry, payload: redactSecrets(entry.payload), meta: redactSecrets(entry.meta || {}) });
    }
    const document = { schemaVersion: SCHEMA_VERSION, topic, entries: mergeEntries(entries) };
    requireValid(checkTopicSize(document, this.maxTopicBytes));
    return { document, logBytes: bytes.length, validBytes };
  }
  async createTopic(topic) {
    this._paths(topic);
    await this.init();
    return this._withLock(topic, () => this._create(topic));
  }
  async read(topic) {
    this._paths(topic);
    await this.init();
    return this._withLock(topic, async () => (await this._replay(topic)).document);
  }
  async listTopics() {
    await this.init();
    const names = await fs.readdir(this.contextDir);
    return names.filter(name => name.endsWith('.log.jsonl')).map(name => name.slice(0, -10)).filter(name => validateTopicId(name).ok).sort();
  }
  async write(topic, payload, meta = {}) {
    this._paths(topic);
    assertJson(payload); assertJson(meta);
    if (!isPlainObject(meta)) throw new TypeError('meta must be a plain JSON object');
    requireValid(checkEntrySize({ payload, meta }, this.maxEntryBytes));
    const cleanPayload = redactSecrets(payload), cleanMeta = redactSecrets(meta);
    await this.init();
    const entry = await this._withLock(topic, async () => {
      const state = await this._replay(topic);
      const previous = meta.id ? state.document.entries.find(e => e.id === meta.id) : null;
      const next = createEntryEnvelope({ topic, id: meta.id, payload: cleanPayload,
        version: previous ? previous.version + 1 : 1,
        timestamp: new Date(Math.max(Date.now(), previous ? Date.parse(previous.timestamp) + 1 : 0)).toISOString(),
        meta: { ...cleanMeta, pane: cleanMeta.pane || this.paneId,
          redacted: canonical(payload) !== canonical(cleanPayload) || canonical(meta) !== canonical(cleanMeta) } });
      requireValid(validateEntryEnvelope(next));
      requireValid(checkEntrySize(next, this.maxEntryBytes));
      const document = { ...state.document, entries: mergeEntries(state.document.entries, [next]) };
      requireValid(checkTopicSize(document, this.maxTopicBytes));
      const line = Buffer.from(JSON.stringify(next) + '\n');
      if (state.validBytes + line.length > this.maxTopicBytes) throw new Error('Topic log size limit reached');
      const { log, snapshot } = this._paths(topic);
      await this._safe(log);
      // Truncate any torn tail through a plain fd first: Windows denies ftruncate
      // on handles opened with O_APPEND.
      if (state.logBytes !== state.validBytes) await fs.truncate(log, state.validBytes);
      const handle = await fs.open(log, 'a', 0o600);
      try {
        await handle.writeFile(line);
        await handle.sync();
      } finally { await handle.close(); }
      // The durable log is authoritative if snapshot publication is interrupted.
      await this._atomic(snapshot, document);
      return next;
    });
    this._notify(topic);
    return entry;
  }
  subscribe(topic, callback) {
    this._paths(topic);
    if (typeof callback !== 'function') throw new TypeError('callback must be a function');
    if (!this.initialized) throw new Error('Call init() before subscribe()');
    const listener = { callback, last: null, pending: false, dirty: false };
    if (!this.subscribers.has(topic)) this.subscribers.set(topic, new Set());
    this.subscribers.get(topic).add(listener);
    if (!this.watcher) {
      this.watcher = watch(this.contextDir, { persistent: false }, (_, filename) => {
        const name = filename && filename.toString();
        if (name && name.endsWith('.json')) this._notify(name.slice(0, -5));
      });
      this.watcher.on('error', () => { this.watcher?.close(); this.watcher = null; });
    }
    return () => {
      this.subscribers.get(topic)?.delete(listener);
      if (![...this.subscribers.values()].some(set => set.size)) { this.watcher?.close(); this.watcher = null; }
    };
  }
  _notify(topic) {
    for (const listener of this.subscribers.get(topic) || []) {
      listener.dirty = true;
      if (listener.pending) continue;
      listener.pending = true;
      (async () => {
        while (listener.dirty && this.subscribers.get(topic)?.has(listener)) {
          listener.dirty = false;
          const document = await this.read(topic);
          const value = canonical(document);
          if (value !== listener.last && this.subscribers.get(topic)?.has(listener)) {
            listener.last = value;
            try { listener.callback(document); } catch { /* isolate consumer callbacks */ }
          }
        }
      })().catch(() => { /* Reads still surface disk errors explicitly. */ }).finally(() => { listener.pending = false; });
    }
  }
  close() { this.watcher?.close(); this.watcher = null; this.subscribers.clear(); }
}
function createContextStore(options) { return new ContextStore(options); }
module.exports = { ContextStore, createContextStore, DEFAULTS };
