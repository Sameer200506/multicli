'use strict';

const ENTRY_MAX_BYTES = 256 * 1024;
const TOPIC_MAX_BYTES = 10 * 1024 * 1024;
const REDACTION_MASK = '[REDACTED]';
const SECRET_KEY = /password|passwd|secret|token|api[_-]?key|private[_-]?key|authorization|credential|cookie|^pin$|^otp$/i;

// Reject rather than silently coerce values JSON cannot faithfully represent.
function assertJson(value, seen = new Set(), depth = 0) {
  if (depth > 64) throw new TypeError('JSON nesting exceeds 64 levels');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object') throw new TypeError('Expected a JSON value');
  if (seen.has(value)) throw new TypeError('Circular JSON value');
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new TypeError('Expected plain JSON object');
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Symbol keys are not JSON');
  seen.add(value);
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, 'value')) throw new TypeError('JSON accessors are not supported');
    assertJson(descriptor.value, seen, depth + 1);
  }
  if (Array.isArray(value) && Object.keys(value).length !== value.length) throw new TypeError('Sparse or extended arrays are not JSON');
  seen.delete(value);
}

function redactText(text) {
  return text
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g, REDACTION_MASK)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=:-]+/gi, REDACTION_MASK)
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16})\b/g, REDACTION_MASK)
    .replace(/\b((?:[A-Z0-9_]*(?:API_KEY|TOKEN|PASSWORD|SECRET)|password|api[_-]?key|token|secret)\s*[=:]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&]+)/gi, '$1' + REDACTION_MASK)
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1' + REDACTION_MASK + '@');
}

/** Returns a detached JSON value; heuristic redaction is not a secret scanner guarantee. */
function redactSecrets(payload) {
  assertJson(payload);
  function visit(value) {
    if (typeof value === 'string') return redactText(value);
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(visit);
    return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, SECRET_KEY.test(key) ? REDACTION_MASK : visit(val)]));
  }
  return visit(payload);
}

function checkSize(value, maxBytes) {
  try {
    assertJson(value);
    const bytes = Buffer.byteLength(JSON.stringify(value));
    return bytes <= maxBytes ? { ok: true, bytes } : { ok: false, bytes, error: `Size ${bytes} exceeds limit ${maxBytes}` };
  } catch (error) { return { ok: false, error: error.message }; }
}
function checkEntrySize(value, maxBytes = ENTRY_MAX_BYTES) { return checkSize(value, maxBytes); }
function checkTopicSize(value, maxBytes = TOPIC_MAX_BYTES) { return checkSize(value, maxBytes); }

function validateEntry(payload, options = {}) {
  const maxBytes = options.maxBytes || 256 * 1024;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: 'entry payload must be a plain object' };
  }
  if (!payload.id || typeof payload.id !== 'string') return { ok: false, error: 'entry.id required' };
  if (payload.pane && typeof payload.pane !== 'string') return { ok: false, error: 'pane must be a string' };
  if ('value' in payload) {
    const sz = checkSize(payload.value, maxBytes);
    if (!sz.ok) return { ok: false, error: sz.error };
  } else return { ok: false, error: 'entry.value required' };
  return { ok: true, value: payload, bytes: checkSize(payload.value, maxBytes).bytes || 0 };
}

function redactValue(value) {
  const result = redactSecrets(value);
  return { redacted: JSON.stringify(value) !== JSON.stringify(result), value: result };
}

module.exports = { ENTRY_MAX_BYTES, TOPIC_MAX_BYTES, REDACTION_MASK,
  DEFAULT_MAX_ENTRY_BYTES: ENTRY_MAX_BYTES, DEFAULT_MAX_TOPIC_BYTES: TOPIC_MAX_BYTES,
  assertJson, redactSecrets, redactText, checkSize, checkEntrySize, checkTopicSize,
  validateEntry, redactValue };
