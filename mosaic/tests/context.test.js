'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createContextStore } = require('../core/context');
const { TOPIC_IDS, getTopic } = require('../core/context/topics');
const { redactSecrets, checkEntrySize, checkTopicSize, ENTRY_MAX_BYTES, TOPIC_MAX_BYTES } = require('../core/context/validation');
const { mergeEntries, mergeEntry, canonical } = require('../core/context/merge');

const { validateTopicId, validateEntryId, validateEntryEnvelope } = require('../core/context/schema');

async function makeStore(t, extra = {}) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-context-'));
  const store = createContextStore({ workspaceRoot, ...extra });
  await store.init();
  t.after(() => store.close());
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));
  return { workspaceRoot, store };
}

test('schema: topic and entry envelope validation', () => {
  assert.ok(validateTopicId('goal').ok);
  assert.ok(validateTopicId('file-tree').ok);
  assert.ok(!validateTopicId('../evil').ok);
  assert.ok(!validateTopicId('UPPER').ok);
  assert.ok(!validateTopicId('con').ok);
  assert.ok(!validateTopicId('').ok);
  assert.ok(validateEntryEnvelope({ id: 'a', topic: 'note', version: 1, timestamp: new Date().toISOString(), payload: { x: 1 }, meta: {} }).ok);
  assert.ok(!validateEntryEnvelope({ id: 'a', topic: 'note', version: -1, timestamp: new Date().toISOString(), payload: 1 }).ok);
  assert.ok(!validateEntryEnvelope({ id: 'a b', topic: 'note', version: 1, timestamp: new Date().toISOString(), payload: 1 }).ok);
  assert.ok(!validateEntryEnvelope({ id: 'a', topic: 'note', version: 1, payload: 1 }).ok, 'timestamp required');
});

test('validation: redaction, deep redaction and size guards', () => {
  assert.deepEqual(redactSecrets({ apiKey: 'abc', note: 'x' }), { apiKey: '[REDACTED]', note: 'x' });
  assert.deepEqual(redactSecrets({ nested: { password: 'p', keep: 1 } }), { nested: { password: '[REDACTED]', keep: 1 } });
  assert.deepEqual(redactSecrets({ arr: [{ token: 't' }] }), { arr: [{ token: '[REDACTED]' }] });
  assert.equal(redactSecrets('Bearer abc.def.ghi'), '[REDACTED]');
  assert.equal(redactSecrets('https://user:secret@host'), 'https://[REDACTED]@host');
  assert.equal(redactSecrets('password=hunter2'), 'password=[REDACTED]');
  assert.equal(redactSecrets(42), 42);
  assert.ok(checkEntrySize('x'.repeat(ENTRY_MAX_BYTES + 1)).ok === false);
  assert.ok(checkEntrySize({ a: 1 }).ok);
  assert.ok(checkTopicSize({ a: 1 }).ok);
  assert.ok(!checkTopicSize('x'.repeat(TOPIC_MAX_BYTES + 1)).ok);
});

test('validation: non-JSON payloads rejected before persistence', () => {
  const store = createContextStore({ workspaceRoot: path.join(os.tmpdir(), 'mosaic-unused') });
  assert.rejects(() => store.write('note', () => {}), TypeError);
});

test('topics: built-in vocabulary exposed', () => {
  assert.deepEqual(TOPIC_IDS, ['goal', 'plan', 'file-tree', 'diff', 'test-results', 'error', 'note']);
  assert.equal(getTopic('goal').label, 'Goal');
});

test('merge: LWW deterministic and conflict-free', () => {
  const ts = (ms) => new Date(ms).toISOString();
  const a = { id: 'e1', topic: 'note', version: 1, timestamp: ts(1000), payload: { v: 'a' }, meta: {} };
  const b = { id: 'e1', topic: 'note', version: 2, timestamp: ts(2000), payload: { v: 'b' }, meta: {} };
  assert.equal(mergeEntry(a, b), b);
  assert.equal(mergeEntry(b, a), b);
  const tie1 = { id: 'x', topic: 'note', version: 1, timestamp: ts(1000), payload: 1, meta: {} };
  const tie2 = { id: 'y', topic: 'note', version: 1, timestamp: ts(1000), payload: 2, meta: {} };
  assert.throws(() => mergeEntry(tie1, tie2), TypeError); // different ids are different elements
  const sameClock = { id: 'z', topic: 'note', version: 1, timestamp: ts(1000), payload: { b: 1, a: 2 }, meta: {} };
  const sameClock2 = { id: 'z', topic: 'note', version: 1, timestamp: ts(1000), payload: { a: 2, b: 1 }, meta: {} };
  assert.equal(canonical(sameClock), canonical(sameClock2));
  // Distinct ids are distinct elements: union keeps both, deterministic order decides.
  assert.deepEqual(mergeEntries([tie1], [tie2]).map((e) => e.id), ['x', 'y']);
});

test('store: write, read, listTopics, persistence across reopen', async (t) => {
  const { workspaceRoot, store } = await makeStore(t);
  const entry = await store.write('note', { text: 'hello' }, { pane: 'pane-1' });
  assert.equal(entry.topic, 'note');
  assert.equal(entry.meta.pane, 'pane-1');
  assert.equal(entry.version, 1);
  const snapshot = await store.read('note');
  assert.deepEqual(snapshot.entries, [entry]);
  assert.deepEqual(await store.listTopics(), [...TOPIC_IDS].sort());

  const reopened = createContextStore({ workspaceRoot });
  await reopened.init();
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.read('note')).entries, [entry]);

  const persisted = JSON.parse(await fs.readFile(path.join(workspaceRoot, '.mosaic/context/note.json'), 'utf8'));
  assert.deepEqual(persisted.entries, [entry]);
  const log = await fs.readFile(path.join(workspaceRoot, '.mosaic/context/note.log.jsonl'), 'utf8');
  assert.match(log, /"text":"hello"/);
});

test('store: redaction applied on write', async (t) => {
  const { store } = await makeStore(t);
  const entry = await store.write('error', { message: 'auth failed', apiKey: 'sk-proj-abcdefghijklmnop' });
  assert.equal(entry.payload.apiKey, '[REDACTED]');
  assert.equal(entry.meta.redacted, true);
  const readBack = await store.read('error');
  assert.equal(readBack.entries[0].payload.apiKey, '[REDACTED]');
});

test('store: explicit id upsert bumps version, LWW keeps newest', async (t) => {
  const { store } = await makeStore(t);
  const e1 = await store.write('plan', { step: 'one' }, { id: 'plan-1' });
  const e2 = await store.write('plan', { step: 'two' }, { id: 'plan-1' });
  assert.equal(e2.version, e1.version + 1);
  const snapshot = await store.read('plan');
  assert.equal(snapshot.entries.length, 1);
  assert.deepEqual(snapshot.entries[0].payload, { step: 'two' });
});

test('store: distinct panes writing concurrently both persist (no lost update)', async (t) => {
  const { workspaceRoot, store } = await makeStore(t);
  const panes = ['pane-1', 'pane-2', 'pane-3'];
  const writes = [];
  for (let i = 0; i < 30; i++) {
    const pane = panes[i % panes.length];
    writes.push(store.write('note', { n: i, pane }, { pane, id: `n-${i}` }));
  }
  const entries = await Promise.all(writes);
  assert.equal(entries.length, 30);
  const snapshot = await store.read('note');
  assert.equal(snapshot.entries.length, 30);
  const panesSeen = new Set(snapshot.entries.map((e) => e.meta.pane));
  for (const pane of panes) assert.ok(panesSeen.has(pane));
  const reopened = createContextStore({ workspaceRoot });
  await reopened.init();
  t.after(() => reopened.close());
  assert.equal((await reopened.read('note')).entries.length, 30);
});

test('store: concurrent same-id upserts serialize without clobbering', async (t) => {
  const { store } = await makeStore(t);
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.write('goal', { attempt: i }, { id: 'single' })));
  const versions = results.map((r) => r.version).sort((a, b) => a - b);
  assert.deepEqual(versions, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const final = (await store.read('goal')).entries[0];
  assert.equal(final.id, 'single');
  assert.equal(final.version, 10);
});

test('store: append log survives torn tail (crash simulation)', async (t) => {
  const { workspaceRoot, store } = await makeStore(t);
  await store.write('note', { a: 1 }, { id: 'one' });
  const logPath = path.join(workspaceRoot, '.mosaic/context/note.log.jsonl');
  await fs.appendFile(logPath, '{"id":"torn","top'); // simulate crash mid-write
  const reopened = createContextStore({ workspaceRoot });
  await reopened.init();
  t.after(() => reopened.close());
  const snapshot = await reopened.read('note');
  assert.equal(snapshot.entries.length, 1);
  assert.equal(snapshot.entries[0].id, 'one');
  // Next write truncates the torn tail and appends cleanly.
  await reopened.write('note', { b: 2 }, { id: 'two' });
  assert.equal((await reopened.read('note')).entries.length, 2);
  const log = await fs.readFile(logPath, 'utf8');
  assert.ok(!log.includes('"torn"'));
});

test('store: subscribe fires on change and unsubscribe stops it', async (t) => {
  const { store } = await makeStore(t);
  const events = [];
  const unsubscribe = store.subscribe('note', (doc) => events.push(doc));
  await delay(30);
  await store.write('note', { hello: 1 }, { id: 'sub-1' });
  await delay(120);
  assert.ok(events.length >= 1);
  assert.equal(events[0].topic, 'note');
  assert.equal(events[0].entries[0].id, 'sub-1');
  unsubscribe();
  await store.write('note', { hello: 2 }, { id: 'sub-2' });
  await delay(120);
  assert.equal(events.filter((d) => d.entries.some((e) => e.id === 'sub-2')).length, 0);
});

test('store: rejects invalid topic ids and oversized payloads', async (t) => {
  const { store } = await makeStore(t);
  await assert.rejects(() => store.write('../evil', { a: 1 }), TypeError);
  await assert.rejects(() => store.write('note', 'x'.repeat(300 * 1024)), /exceeds limit/);
  const { store: small } = await makeStore(t, { maxEntryBytes: 64 });
  await assert.rejects(() => small.write('note', { blob: 'y'.repeat(100) }), /exceeds limit/);
});

test('store: unknown topic read falls back to empty document', async (t) => {
  const { store } = await makeStore(t);
  const doc = await store.read('note');
  assert.deepEqual(doc, { schemaVersion: 1, topic: 'note', entries: [] });
});

test('store: createTopic is idempotent and materializes an empty snapshot', async (t) => {
  const { workspaceRoot, store } = await makeStore(t);
  const doc = await store.createTopic('note');
  assert.deepEqual(doc.entries, []);
  const snapshot = JSON.parse(await fs.readFile(path.join(workspaceRoot, '.mosaic/context/note.json'), 'utf8'));
  assert.deepEqual(snapshot.entries, []);
});

const { setTimeout: delay } = require('node:timers/promises');
