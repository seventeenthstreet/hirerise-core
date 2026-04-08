'use strict';

/**
 * encryption.js — AES-256-GCM Secrets Encryption Utility
 *
 * Production-ready database-agnostic encryption helper for secure secret storage.
 *
 * Designed for Supabase/Postgres row storage:
 *   encrypted_value TEXT
 *   iv TEXT
 *   auth_tag TEXT
 *   hmac TEXT
 *
 * Security design:
 *   - Algorithm : AES-256-GCM
 *   - Key source: MASTER_ENCRYPTION_KEY
 *   - IV        : 16 random bytes per encryption
 *   - Auth tag  : 16 bytes
 *   - HMAC      : SHA-256 over (secretName + iv + ciphertext)
 *
 * Supported MASTER_ENCRYPTION_KEY formats:
 *   - 32-byte raw UTF-8 string
 *   - 64-char hex string
 *   - base64-encoded 32-byte key
 *
 * @module utils/crypto/encryption
 */

const crypto = require('crypto');
const logger = require('../logger');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const HMAC_ALGORITHM = 'sha256';

/**
 * @typedef {Object} EncryptedSecret
 * @property {string} encryptedValue
 * @property {string} iv
 * @property {string} authTag
 * @property {string} hmac
 */

// ─────────────────────────────────────────────
// Key Management
// ─────────────────────────────────────────────

/**
 * Safely parse MASTER_ENCRYPTION_KEY from supported formats.
 *
 * @returns {Buffer}
 */
function parseMasterKey() {
  const raw = process.env.MASTER_ENCRYPTION_KEY;

  if (!raw) {
    throw new Error(
      '[Encryption] MASTER_ENCRYPTION_KEY is missing from environment.'
    );
  }

  // HEX: 64 chars → 32 bytes
  if (/^[a-fA-F0-9]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  // BASE64 → 32 bytes
  try {
    const base64Buf = Buffer.from(raw, 'base64');
    if (base64Buf.length === KEY_LENGTH) {
      return base64Buf;
    }
  } catch (_) {
    // ignore parse attempt
  }

  // UTF-8 raw
  const utf8Buf = Buffer.from(raw, 'utf8');
  if (utf8Buf.length === KEY_LENGTH) {
    return utf8Buf;
  }

  throw new Error(
    `[Encryption] MASTER_ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH} bytes.`
  );
}

/**
 * Domain-separated HMAC key derivation.
 *
 * @returns {Buffer}
 */
function getHmacKey() {
  const masterKey = parseMasterKey();

  return crypto
    .createHmac(HMAC_ALGORITHM, masterKey)
    .update('hmac-key-v2')
    .digest();
}

// ─────────────────────────────────────────────
// Core Encryption
// ─────────────────────────────────────────────

/**
 * Encrypt a plaintext secret.
 *
 * @param {string} plaintext
 * @param {string} secretName
 * @returns {EncryptedSecret}
 */
function encryptSecret(plaintext, secretName) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('[Encryption] plaintext must be a non-empty string');
  }

  if (typeof secretName !== 'string' || secretName.length === 0) {
    throw new Error('[Encryption] secretName is required');
  }

  const key = parseMasterKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  const hmacPayload = Buffer.concat([
    Buffer.from(secretName.toLowerCase(), 'utf8'),
    Buffer.from(':'),
    iv,
    encrypted,
  ]);

  const hmac = crypto
    .createHmac(HMAC_ALGORITHM, getHmacKey())
    .update(hmacPayload)
    .digest();

  return {
    encryptedValue: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    hmac: hmac.toString('hex'),
  };
}

/**
 * Decrypt a stored secret payload.
 *
 * @param {EncryptedSecret} stored
 * @param {string} secretName
 * @returns {string}
 */
function decryptSecret(stored, secretName) {
  if (!stored || typeof stored !== 'object') {
    throw new Error('[Encryption] stored payload is required');
  }

  const { encryptedValue, iv, authTag, hmac } = stored;

  if (!encryptedValue || !iv || !authTag || !hmac) {
    throw new Error(
      '[Encryption] Stored payload missing encryptedValue, iv, authTag, or hmac'
    );
  }

  if (!secretName) {
    throw new Error('[Encryption] secretName is required');
  }

  const encryptedBuffer = Buffer.from(encryptedValue, 'hex');
  const ivBuffer = Buffer.from(iv, 'hex');
  const authTagBuffer = Buffer.from(authTag, 'hex');
  const storedHmacBuffer = Buffer.from(hmac, 'hex');

  const hmacPayload = Buffer.concat([
    Buffer.from(secretName.toLowerCase(), 'utf8'),
    Buffer.from(':'),
    ivBuffer,
    encryptedBuffer,
  ]);

  const expectedHmac = crypto
    .createHmac(HMAC_ALGORITHM, getHmacKey())
    .update(hmacPayload)
    .digest();

  // timingSafeEqual requires equal length
  if (storedHmacBuffer.length !== expectedHmac.length) {
    throw new Error('[Encryption] Tamper detection failed');
  }

  if (!crypto.timingSafeEqual(expectedHmac, storedHmacBuffer)) {
    logger.error('[Encryption] HMAC verification failed', { secretName });
    throw new Error('[Encryption] Tamper detection failed');
  }

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      parseMasterKey(),
      ivBuffer
    );

    decipher.setAuthTag(authTagBuffer);

    const plaintext = Buffer.concat([
      decipher.update(encryptedBuffer),
      decipher.final(),
    ]);

    return plaintext.toString('utf8');
  } catch (error) {
    logger.error('[Encryption] AES-GCM authentication failed', {
      secretName,
      error: error.message,
    });

    throw new Error('[Encryption] Decryption failed');
  }
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

/**
 * Generate a safe masked preview.
 *
 * @param {string} plaintext
 * @returns {string}
 */
function maskSecret(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    return '****';
  }

  const visibleChars = Math.min(4, Math.max(1, Math.floor(plaintext.length / 4)));

  return `${plaintext.slice(0, visibleChars)}${'*'.repeat(12)}`;
}

/**
 * Validate encryption key at startup.
 */
function validateEncryptionKeyPresent() {
  parseMasterKey();
}

module.exports = {
  encryptSecret,
  decryptSecret,
  maskSecret,
  validateEncryptionKeyPresent,
};