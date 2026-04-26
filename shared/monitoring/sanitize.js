'use strict';

/**
 * shared/monitoring/sanitize.js
 * Production-grade sanitizer
 */

const SENSITIVE_KEYS = new Set([
  'password','token','access_token','refresh_token','authorization',
  'api_key','secret','private_key','client_secret','credit_card',
  'card_number','cvv','ssn','otp','mfa_code','stripe_key'
]);

const PII_KEYS = new Set([
  'email','phone','mobile','contact','address','dob','date_of_birth'
]);

const SENSITIVE_PATTERNS = [
  /token/i, /secret/i, /password/i, /auth/i, /key/i, /private/i
];

const MAX_BODY_DEPTH = 4;
const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_LENGTH = 10;
const MAX_OBJECT_KEYS = 50;

const seen = new WeakSet();

/* ---------------- HELPERS ---------------- */

function isSensitiveKey(key) {
  const k = String(key).toLowerCase();
  return SENSITIVE_KEYS.has(k) ||
         PII_KEYS.has(k) ||
         SENSITIVE_PATTERNS.some(p => p.test(k));
}

/* ---------------- CORE SCRUB ---------------- */

function scrub(value, depth = 0) {
  if (depth > MAX_BODY_DEPTH) return '[truncated]';
  if (value === null || value === undefined) return value;

  if (Buffer.isBuffer(value)) return '[BUFFER]';

  if (typeof value === 'string') {
    if (/^Bearer\s/i.test(value)) return '[REDACTED_TOKEN]';

    return value.length > MAX_STRING_LENGTH
      ? value.slice(0, MAX_STRING_LENGTH) + '…[truncated]'
      : value;
  }

  if (typeof value !== 'object') return value;

  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    const slice = value.slice(0, MAX_ARRAY_LENGTH);
    const result = slice.map(item => scrub(item, depth + 1));

    if (value.length > MAX_ARRAY_LENGTH) {
      result.push(`…[${value.length - MAX_ARRAY_LENGTH} more]`);
    }

    return result;
  }

  const clean = {};
  const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);

  for (const [k, v] of entries) {
    clean[k] = isSensitiveKey(k)
      ? '[REDACTED]'
      : scrub(v, depth + 1);
  }

  if (Object.keys(value).length > MAX_OBJECT_KEYS) {
    clean._truncated = true;
  }

  return clean;
}

/* ---------------- PUBLIC API ---------------- */

function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return null;

  try {
    seen.clear();
    return scrub(body, 0);
  } catch {
    return { _error: 'Failed to sanitize body' };
  }
}

function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};

  const safe = {};

  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();

    if (
      key === 'authorization' ||
      key === 'cookie' ||
      key === 'set-cookie'
    ) {
      safe[k] = '[REDACTED]';
    } else {
      safe[k] =
        typeof v === 'string' && v.length > 200
          ? v.slice(0, 200) + '…'
          : v;
    }
  }

  return safe;
}

module.exports = { sanitizeBody, sanitizeHeaders };