'use strict';

/**
 * apiKeyCrypto.js — AES-256-GCM Encryption for External API Keys
 *
 * Uses Node.js built-in crypto module — no external dependencies.
 * Algorithm: AES-256-GCM (authenticated encryption — detects tampering)
 *
 * Environment variable required:
 *   API_KEY_ENCRYPTION_SECRET — must be exactly 32 characters (256 bits)
 *
 * Format of encrypted output (stored in Firestore):
 *   enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 *
 * The "enc:" prefix lets us distinguish encrypted values from legacy
 * plaintext values during a migration period.
 *
 * Usage:
 *   const { encryptApiKey, decryptApiKey } = require('../../utils/apiKeyCrypto');
 *   const stored  = encryptApiKey('sk_live_abc123');
 *   const original = decryptApiKey(stored);
 */

const crypto = require('crypto');
const logger = require('./logger');

const ALGORITHM   = 'aes-256-gcm';
const IV_LENGTH   = 16; // bytes
const TAG_LENGTH  = 16; // bytes (GCM auth tag)
const PREFIX      = 'enc:';

/**
 * Get and validate the encryption key from environment.
 * Throws at call time (not module load) so the error surfaces with context.
 *
 * @returns {Buffer} 32-byte key buffer
 */
function getEncryptionKey() {
  const secret = process.env.API_KEY_ENCRYPTION_SECRET;

  if (!secret) {
    throw new Error(
      '[apiKeyCrypto] API_KEY_ENCRYPTION_SECRET is not set. ' +
      'Add it to your .env file. Must be exactly 32 characters.'
    );
  }

  if (secret.length !== 32) {
    throw new Error(
      `[apiKeyCrypto] API_KEY_ENCRYPTION_SECRET must be exactly 32 characters. ` +
      `Got ${secret.length}.`
    );
  }

  return Buffer.from(secret, 'utf8');
}

/**
 * Encrypt an API key using AES-256-GCM.
 * A fresh random IV is generated for every encryption call.
 *
 * @param {string} plaintext — raw API key
 * @returns {string} — "enc:<iv>:<authTag>:<ciphertext>" (all hex)
 */
function encryptApiKey(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('[apiKeyCrypto] plaintext must be a non-empty string');
  }

  const key    = getEncryptionKey();
  const iv     = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt an API key encrypted by encryptApiKey().
 * Returns plaintext for plaintext inputs (migration safety).
 *
 * @param {string} stored — value from Firestore
 * @returns {string} — decrypted API key
 */
function decryptApiKey(stored) {
  if (!stored || typeof stored !== 'string') {
    throw new Error('[apiKeyCrypto] stored value must be a non-empty string');
  }

  // Legacy plaintext value (not yet encrypted) — return as-is
  if (!stored.startsWith(PREFIX)) {
    logger.warn('[apiKeyCrypto] Decrypting unencrypted legacy API key — migrate this record');
    return stored;
  }

  const parts = stored.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('[apiKeyCrypto] Invalid encrypted format');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;
  const key        = getEncryptionKey();
  const iv         = Buffer.from(ivHex, 'hex');
  const authTag    = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

/**
 * Mask an API key for safe display in API responses.
 * Works on both encrypted stored values and plaintext keys.
 *
 * @param {string} stored — value from Firestore (may be encrypted)
 * @returns {string} — e.g. "sk_l****"
 */
function maskApiKey(stored) {
  if (!stored) return null;

  // For encrypted values, show the prefix to indicate it's encrypted
  if (stored.startsWith(PREFIX)) {
    return 'enc:****';
  }

  // For legacy plaintext, show first 4 chars
  return `${stored.substring(0, 4)}****`;
}

module.exports = { encryptApiKey, decryptApiKey, maskApiKey };








