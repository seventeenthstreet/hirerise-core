'use strict';

/**
 * apiKeyCrypto.js — AES-256-GCM Encryption for External API Keys
 *
 * Supabase-safe, database-agnostic encrypted string format:
 *   enc:<iv_hex>:<authTag_hex>:<ciphertext_hex>
 *
 * Supported secret formats:
 * - 32-byte UTF-8 raw string
 * - 64-char hex string
 * - base64-encoded 32-byte key
 */

const crypto = require('crypto');
const logger = require('./logger');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const PREFIX = 'enc:';

/**
 * Parse API_KEY_ENCRYPTION_SECRET from supported formats.
 *
 * @returns {Buffer}
 */
function getEncryptionKey() {
  const secret = process.env.API_KEY_ENCRYPTION_SECRET;

  if (!secret) {
    throw new Error(
      '[apiKeyCrypto] API_KEY_ENCRYPTION_SECRET is not set.'
    );
  }

  // hex
  if (/^[a-fA-F0-9]{64}$/.test(secret)) {
    return Buffer.from(secret, 'hex');
  }

  // base64
  try {
    const base64Buf = Buffer.from(secret, 'base64');
    if (base64Buf.length === KEY_LENGTH) {
      return base64Buf;
    }
  } catch (_) {
    // ignore
  }

  // utf8 raw
  const utf8Buf = Buffer.from(secret, 'utf8');
  if (utf8Buf.length === KEY_LENGTH) {
    return utf8Buf;
  }

  throw new Error(
    `[apiKeyCrypto] API_KEY_ENCRYPTION_SECRET must decode to ${KEY_LENGTH} bytes`
  );
}

/**
 * Encrypt API key.
 *
 * @param {string} plaintext
 * @returns {string}
 */
function encryptApiKey(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('[apiKeyCrypto] plaintext must be a non-empty string');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

/**
 * Decrypt stored API key.
 *
 * Backward compatible with legacy plaintext rows.
 *
 * @param {string} stored
 * @returns {string}
 */
function decryptApiKey(stored) {
  if (typeof stored !== 'string' || stored.length === 0) {
    throw new Error('[apiKeyCrypto] stored value must be a non-empty string');
  }

  // Legacy plaintext support during migration
  if (!stored.startsWith(PREFIX)) {
    logger.warn('[apiKeyCrypto] Legacy plaintext API key encountered');
    return stored;
  }

  const parts = stored.slice(PREFIX.length).split(':');

  if (parts.length !== 3) {
    throw new Error('[apiKeyCrypto] Invalid encrypted API key format');
  }

  const [ivHex, authTagHex, ciphertextHex] = parts;

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  if (
    iv.length !== IV_LENGTH ||
    authTag.length !== TAG_LENGTH ||
    ciphertext.length === 0
  ) {
    throw new Error('[apiKeyCrypto] Corrupted encrypted API key payload');
  }

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      getEncryptionKey(),
      iv
    );

    decipher.setAuthTag(authTag);

    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return plaintext.toString('utf8');
  } catch (error) {
    logger.error('[apiKeyCrypto] API key decryption failed', {
      error: error.message,
    });

    throw new Error('[apiKeyCrypto] Failed to decrypt API key');
  }
}

/**
 * Safe masked preview.
 *
 * @param {string} stored
 * @returns {string|null}
 */
function maskApiKey(stored) {
  if (typeof stored !== 'string' || stored.length === 0) {
    return null;
  }

  if (stored.startsWith(PREFIX)) {
    return 'enc:****';
  }

  return `${stored.slice(0, 4)}****`;
}

/**
 * Validate encryption key during app startup.
 */
function validateApiKeyEncryptionSecret() {
  getEncryptionKey();
}

module.exports = {
  encryptApiKey,
  decryptApiKey,
  maskApiKey,
  validateApiKeyEncryptionSecret,
};