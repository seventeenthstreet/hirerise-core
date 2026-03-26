'use strict';

/**
 * encryption.js — AES-256-GCM Secrets Encryption Utility
 *
 * Security design:
 *   - Algorithm : AES-256-GCM  (authenticated encryption — detects tampering)
 *   - Key source: MASTER_ENCRYPTION_KEY env var (must be exactly 32 bytes)
 *   - IV        : 16 random bytes generated fresh per encryption call
 *   - Auth tag  : 16-byte GCM tag stored separately for integrity verification
 *   - HMAC      : SHA-256 HMAC over (name + iv + ciphertext) for tamper detection
 *   - Storage   : { encryptedValue, iv, authTag, hmac } — all hex-encoded
 *
 * The MASTER_ENCRYPTION_KEY must be stored as a secure environment variable
 * and NEVER committed to source control. Rotate via key-rotation script only.
 *
 * Separation from apiKeyCrypto.js:
 *   apiKeyCrypto  — uses API_KEY_ENCRYPTION_SECRET, single-string format
 *   encryption.js — uses MASTER_ENCRYPTION_KEY, structured Firestore fields,
 *                   adds HMAC tamper-protection and secret-name binding
 *
 * @module utils/crypto/encryption
 */

const crypto = require('crypto');
const logger = require('../logger');

const ALGORITHM    = 'aes-256-gcm';
const IV_LENGTH    = 16;   // bytes
const TAG_LENGTH   = 16;   // bytes (GCM auth tag)
const KEY_LENGTH   = 32;   // bytes (256 bits)
const HMAC_ALG     = 'sha256';

// ─── Key management ──────────────────────────────────────────────────────────

/**
 * Validate and return the master encryption key buffer.
 * Key is loaded fresh each call so env var hot-rotation is supported.
 *
 * @returns {Buffer} 32-byte key
 * @throws  {Error}  if key is missing or wrong length
 */
function getMasterKey() {
  const raw = process.env.MASTER_ENCRYPTION_KEY;

  if (!raw) {
    throw new Error(
      '[Encryption] MASTER_ENCRYPTION_KEY is not set. ' +
      'Set it in your environment. Must be exactly 32 ASCII characters (256 bits).'
    );
  }

  const buf = Buffer.from(raw, 'utf8');

  if (buf.length !== KEY_LENGTH) {
    throw new Error(
      `[Encryption] MASTER_ENCRYPTION_KEY must be exactly ${KEY_LENGTH} bytes. ` +
      `Got ${buf.length}. Pad or trim to exactly 32 ASCII characters.`
    );
  }

  return buf;
}

/**
 * Derive a separate HMAC key from the master key to prevent key reuse
 * across different cryptographic operations (domain separation).
 *
 * @returns {Buffer} 32-byte HMAC key
 */
function getHmacKey() {
  const masterKey = getMasterKey();
  // HKDF-like derivation: HMAC(masterKey, "hmac-key-v1")
  return crypto.createHmac(HMAC_ALG, masterKey)
    .update('hmac-key-v1')
    .digest();
}

// ─── Core encrypt / decrypt ──────────────────────────────────────────────────

/**
 * Encrypt a secret value.
 * The secret name is bound into the HMAC to prevent substitution attacks
 * (an encrypted value for "STRIPE_KEY" cannot be swapped to "ANTHROPIC_KEY").
 *
 * @param {string} plaintext  — raw secret value
 * @param {string} secretName — logical name of the secret (for HMAC binding)
 * @returns {{
 *   encryptedValue: string,  // hex
 *   iv:             string,  // hex
 *   authTag:        string,  // hex
 *   hmac:           string,  // hex  (tamper-detection signature)
 * }}
 */
function encryptSecret(plaintext, secretName) {
  if (!plaintext || typeof plaintext !== 'string') {
    throw new Error('[Encryption] plaintext must be a non-empty string');
  }
  if (!secretName || typeof secretName !== 'string') {
    throw new Error('[Encryption] secretName is required for HMAC binding');
  }

  const key    = getMasterKey();
  const iv     = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // HMAC over: secretName + ':' + iv + ciphertext  (name-bound tamper seal)
  const hmacKey  = getHmacKey();
  const hmacData = Buffer.concat([
    Buffer.from(secretName.toLowerCase(), 'utf8'),
    Buffer.from(':'),
    iv,
    encrypted,
  ]);
  const hmac = crypto.createHmac(HMAC_ALG, hmacKey).update(hmacData).digest();

  return {
    encryptedValue: encrypted.toString('hex'),
    iv:             iv.toString('hex'),
    authTag:        authTag.toString('hex'),
    hmac:           hmac.toString('hex'),
  };
}

/**
 * Decrypt a secret value.
 * Verifies HMAC tamper-seal before decryption.
 *
 * @param {{
 *   encryptedValue: string,
 *   iv:             string,
 *   authTag:        string,
 *   hmac:           string,
 * }} stored        — fields from Firestore document
 * @param {string} secretName — must match the name used during encryption
 * @returns {string} plaintext secret value
 * @throws  {Error}  on tamper detection, wrong key, or malformed input
 */
function decryptSecret(stored, secretName) {
  const { encryptedValue, iv: ivHex, authTag: authTagHex, hmac: storedHmac } = stored;

  if (!encryptedValue || !ivHex || !authTagHex || !storedHmac) {
    throw new Error('[Encryption] Stored secret is missing required fields (encryptedValue, iv, authTag, hmac)');
  }
  if (!secretName) {
    throw new Error('[Encryption] secretName is required to verify HMAC');
  }

  const encrypted = Buffer.from(encryptedValue, 'hex');
  const iv        = Buffer.from(ivHex,           'hex');
  const authTag   = Buffer.from(authTagHex,       'hex');

  // ── Step 1: Verify HMAC before attempting decryption ────────────────────
  const hmacKey  = getHmacKey();
  const hmacData = Buffer.concat([
    Buffer.from(secretName.toLowerCase(), 'utf8'),
    Buffer.from(':'),
    iv,
    encrypted,
  ]);
  const expectedHmac = crypto.createHmac(HMAC_ALG, hmacKey).update(hmacData).digest();
  const storedHmacBuf = Buffer.from(storedHmac, 'hex');

  if (!crypto.timingSafeEqual(expectedHmac, storedHmacBuf)) {
    logger.error('[Encryption] HMAC verification failed — secret may have been tampered with', {
      secretName,
    });
    throw new Error('[Encryption] Tamper detection: HMAC mismatch. Secret integrity compromised.');
  }

  // ── Step 2: Decrypt ────────────────────────────────────────────────────
  const key      = getMasterKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  try {
    const plaintext = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);
    return plaintext.toString('utf8');
  } catch (err) {
    // GCM auth tag failure — wrong key or corrupted ciphertext
    logger.error('[Encryption] AES-GCM authentication failed — wrong key or corrupted data', {
      secretName,
      error: err.message,
    });
    throw new Error('[Encryption] Decryption failed: authentication tag mismatch.');
  }
}

// ─── Display helpers ─────────────────────────────────────────────────────────

/**
 * Generate a masked preview of a plaintext secret for safe UI display.
 * Only the first 4 characters are revealed; the rest are masked.
 *
 * Examples:
 *   "sk_live_abc123xyz"   → "sk_l************"
 *   "AIzaSy..."           → "AIza************"
 *   "short"               → "****"
 *
 * @param {string} plaintext — decrypted secret value
 * @returns {string} masked preview
 */
function maskSecret(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return '****';
  const show = Math.min(4, Math.floor(plaintext.length / 4));
  return `${plaintext.substring(0, show)}${'*'.repeat(12)}`;
}

/**
 * Validate that MASTER_ENCRYPTION_KEY is set and well-formed.
 * Call at server startup to fail fast before any request is served.
 *
 * @throws {Error} if key is absent or malformed
 */
function validateEncryptionKeyPresent() {
  getMasterKey(); // throws if missing or wrong length
}

module.exports = {
  encryptSecret,
  decryptSecret,
  maskSecret,
  validateEncryptionKeyPresent,
};








