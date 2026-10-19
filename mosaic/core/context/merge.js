'use strict';

/** Locale-independent canonical JSON supplies a final tie break for identical clocks. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}
function compareEntries(a, b) {
  const time = Date.parse(a.timestamp) - Date.parse(b.timestamp);
  if (time) return time < 0 ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  if (a.version !== b.version) return a.version < b.version ? -1 : 1;
  const left = canonical(a), right = canonical(b);
  return left === right ? 0 : left < right ? -1 : 1;
}
function mergeEntry(existing, incoming) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (existing.id !== incoming.id || existing.topic !== incoming.topic) throw new TypeError('Cannot merge different entry identities');
  return compareEntries(existing, incoming) >= 0 ? existing : incoming;
}
/** LWW element set: union by (topic,id), then total-order maximum. ACI merge. */
function mergeEntries(...collections) {
  const entries = new Map();
  for (const collection of collections) for (const entry of collection) {
    const key = JSON.stringify([entry.topic, entry.id]);
    entries.set(key, mergeEntry(entries.get(key), entry));
  }
  return [...entries.values()].sort((a, b) => compareEntries(a, b) || (a.topic < b.topic ? -1 : a.topic > b.topic ? 1 : 0));
}
function mergeTopic(existing, incoming) {
  if (existing.topic !== incoming.topic) throw new TypeError('Topic mismatch');
  return { schemaVersion: 1, topic: existing.topic, entries: mergeEntries(existing.entries, incoming.entries) };
}
module.exports = { canonical, compareEntries, mergeEntry, mergeEntries, mergeTopic };
