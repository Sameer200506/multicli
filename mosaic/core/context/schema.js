'use strict';

/**
 * schema.js — entry envelope + identifier rules for the Mosaic shared context.
 *
 * Envelope (one entry, also one line in a topic's `.log.jsonl`):
 * {
 *   id: string,        // unique within the topic; explicit id => upsert/LWW, auto id => append
 *   topic: string,     // topic id this entry belongs to
 *   version: number,   // per-entry monotonic revision (>= 1), tie-break in LWW
 *   timestamp: string, // ISO-8601 UTC write time
 *   payload: any,      // JSON value (object recommended)
 *   meta: object       // writer metadata; `pane` injected, `redacted` flag set by engine
 * }
 */

const crypto = require('crypto');

const SCHEMA_VERSION = 1;

// Topic ids become file names: keep them filesystem-safe.
const TOPIC_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

let autoIdCounter = 0;

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && value.length >= 10 && !Number.isNaN(Date.parse(value));
}

/**
 * Validate a topic id (filesystem-safe, 1..64 chars).
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
function validateTopicId(topicId) {
  if (typeof topicId !== 'string') return { ok: false, error: 'topicId must be a string' };
  if (!TOPIC_ID_RE.test(topicId) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(topicId)) {
    return { ok: false, error: `invalid topicId ${JSON.stringify(topicId)}: must match ${TOPIC_ID_RE}` };
  }
  return { ok: true, value: topicId };
}

/**
 * Validate an entry id.
 */
function validateEntryId(entryId) {
  if (typeof entryId !== 'string') return { ok: false, error: 'entryId must be a string' };
  if (!ENTRY_ID_RE.test(entryId)) {
    return { ok: false, error: `invalid entryId ${JSON.stringify(entryId)}: must match ${ENTRY_ID_RE}` };
  }
  return { ok: true, value: entryId };
}

/**
 * Build a fresh entry envelope, filling in defaults.
 * Caller still validates the result with validateEntryEnvelope().
 */
function createEntryEnvelope({ topic, id, payload, meta, version, timestamp }) {
  return {
    id: id !== undefined ? id : autoEntryId(),
    topic,
    version: version !== undefined ? version : 1,
    timestamp: timestamp !== undefined ? timestamp : new Date().toISOString(),
    payload,
    meta: isPlainObject(meta) ? meta : {},
  };
}

/** Collision-resistant auto entry id (no coordination needed). */
function autoEntryId() {
  autoIdCounter = (autoIdCounter + 1) % 0xffff;
  return `e-${Date.now().toString(36)}-${autoIdCounter.toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * Validate an entry envelope (structure only; size limits live in validation.js).
 * @returns {{ok: true, value: object, bytes: number} | {ok: false, error: string}}
 */
function validateEntryEnvelope(entry, options = {}) {
  const { requireTopic = true, allowScalar = true } = options;

  if (!isPlainObject(entry)) return { ok: false, error: 'entry must be a plain object' };

  const idCheck = validateEntryId(entry.id);
  if (!idCheck.ok) return idCheck;

  if (requireTopic) {
    const topicCheck = validateTopicId(entry.topic);
    if (!topicCheck.ok) return topicCheck;
  } else if (entry.topic !== undefined) {
    const topicCheck = validateTopicId(entry.topic);
    if (!topicCheck.ok) return topicCheck;
  }

  if (typeof entry.version !== 'number' || !Number.isInteger(entry.version) || entry.version < 0) {
    return { ok: false, error: 'entry.version must be a non-negative integer' };
  }
  if (!isIsoTimestamp(entry.timestamp)) {
    return { ok: false, error: 'entry.timestamp must be an ISO-8601 date string' };
  }
  if (entry.payload === undefined) return { ok: false, error: 'entry.payload is required' };
  if (entry.meta !== undefined && !isPlainObject(entry.meta)) {
    return { ok: false, error: 'entry.meta must be a plain object when present' };
  }

  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(entry.payload), 'utf8');
  } catch (err) {
    return { ok: false, error: `entry.payload is not JSON-serializable: ${err.message}` };
  }

  return { ok: true, value: entry, bytes };
}

/** Loose check used when replaying a log from disk (be tolerant, skip garbage). */
function isEntryEnvelopeLoose(entry) {
  return (
    isPlainObject(entry) &&
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    typeof entry.topic === 'string' &&
    entry.payload !== undefined &&
    isIsoTimestamp(entry.timestamp) &&
    typeof entry.version === 'number'
  );
}

module.exports = {
  SCHEMA_VERSION,
  TOPIC_ID_RE,
  ENTRY_ID_RE,
  isPlainObject,
  isIsoTimestamp,
  validateTopicId,
  validateEntryId,
  createEntryEnvelope,
  validateEntryEnvelope,
  isEntryEnvelopeLoose,
  autoEntryId,
};
