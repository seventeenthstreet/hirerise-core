'use strict';

/**
 * src/utils/adminCrypto.js
 *
 * Shared AES-256-GCM encrypt/decrypt helpers for admin-owned secrets at rest.
 *
 * WP-ADMIN-02C: extracted from modules/secrets/secrets.service.js (previously
 * defined only privately inside that file) so TOTP secret storage
 * (modules/admin/mfa/mfa.service.js) can reuse the exact same encryption
 * scheme and key (MASTER_ENCRYPTION_KEY) instead of a second crypto
 * implementation. secrets.service.js now imports from here too — its
 * behavior is unchanged, only the code's location moved.
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';

function getEncryptionKey() {
  const key = process.env.MASTER_ENCRYPTION_KEY;

  if (!key || Buffer.byteLength(key, 'utf8') !== 32) {
    throw new Error(
      'MASTER_ENCRYPTION_KEY must be exactly 32 ASCII characters.'
    );
  }

  return Buffer.from(key, 'utf8');
}

function validateEncryptionKeyPresent() {
  getEncryptionKey();
}

function encrypt(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  return {
    ciphertext: encrypted.toString('hex'),
    iv: iv.toString('hex'),
    auth_tag: cipher.getAuthTag().toString('hex'),
  };
}

function decrypt(ciphertext, iv, authTag) {
  const key = getEncryptionKey();

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'hex')
  );

  decipher.setAuthTag(Buffer.from(authTag, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'hex')),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

module.exports = {
  getEncryptionKey,
  validateEncryptionKeyPresent,
  encrypt,
  decrypt,
};
