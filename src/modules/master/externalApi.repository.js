'use strict';

/**
 * externalApi.repository.js — Data Access for external_salary_apis collection
 *
 * SECURITY UPGRADE: apiKey is now encrypted at rest using AES-256-GCM.
 *
 * Encryption flow:
 *   WRITE (create/update): encryptApiKey(plaintext) before storing
 *   READ  (sync worker):   decryptApiKey(stored)    before using
 *   READ  (API response):  maskApiKey(stored)        — never expose plaintext
 *
 * Requires environment variable:
 *   API_KEY_ENCRYPTION_SECRET — exactly 32 characters
 *
 * @module modules/master/externalApi.repository
 */

const BaseRepository = require('../../repositories/BaseRepository');
const { encryptApiKey, decryptApiKey, maskApiKey } = require('../../utils/apiKeyCrypto');

const COLLECTION = 'external_salary_apis';

class ExternalApiRepository extends BaseRepository {
  constructor() {
    super(COLLECTION);
  }

  /**
   * List all registered external APIs.
   * apiKey is MASKED in returned records — safe for API responses.
   * @returns {Promise<object[]>}
   */
  async listAll() {
    const { docs } = await super.find([], { orderBy: { field: 'createdAt', direction: 'desc' } });
    return docs.map(maskRecord);
  }

  /**
   * List only enabled APIs (for the sync worker).
   * apiKey is DECRYPTED in returned records — for internal use only.
   * NEVER send these records to an API response.
   * @returns {Promise<object[]>}
   */
  async listEnabled() {
    const { docs } = await super.find([
      { field: 'enabled',     op: '==', value: true  },
      { field: 'softDeleted', op: '==', value: false },
    ]);
    return docs.map(decryptRecord);
  }

  /**
   * Create a new external API record.
   * apiKey is encrypted before storing.
   * Returns masked record (safe for API response).
   *
   * @param {object} data — must include apiKey (plaintext)
   * @param {string} adminId
   * @returns {Promise<object>} masked record
   */
  async create(data, adminId) {
    const payload = {
      ...data,
      apiKey: encryptApiKey(data.apiKey),
    };
    const created = await super.create(payload, adminId);
    return maskRecord(created);
  }

  /**
   * Update an external API record.
   * If apiKey is included in updates, it is re-encrypted.
   * Returns masked record (safe for API response).
   *
   * @param {string} id
   * @param {object} updates
   * @param {string} adminId
   * @returns {Promise<object>} masked record
   */
  async update(id, updates, adminId) {
    const payload = { ...updates };
    if (payload.apiKey) {
      payload.apiKey = encryptApiKey(payload.apiKey);
    }
    const updated = await super.update(id, payload, adminId);
    return maskRecord(updated);
  }

  /**
   * Update lastSync timestamp after worker run.
   * @param {string} id
   */
  async updateLastSync(id) {
    const col = this._getCollection();
    await col.doc(id).update({ lastSync: new Date(), updatedAt: new Date() });
  }

  /**
   * Enable or disable an external API.
   * @param {string} id
   * @param {boolean} enabled
   * @param {string} adminId
   * @returns {Promise<object>} masked record
   */
  async setEnabled(id, enabled, adminId) {
    const updated = await super.update(id, { enabled }, adminId);
    return maskRecord(updated);
  }
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Return record with apiKey decrypted.
 * For internal use only (sync worker). Never send to API response.
 */
function decryptRecord(record) {
  return {
    ...record,
    apiKey: record.apiKey ? decryptApiKey(record.apiKey) : null,
  };
}

/**
 * Return record with apiKey masked.
 * Safe for all API responses.
 */
function maskRecord(record) {
  return {
    ...record,
    apiKey: maskApiKey(record.apiKey),
  };
}

module.exports = new ExternalApiRepository();








