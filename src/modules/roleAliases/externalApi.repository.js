'use strict';

/**
 * externalApi.repository.js — Data Access for external_salary_apis collection
 *
 * Collection: external_salary_apis
 *
 * Schema:
 *   {
 *     id,
 *     providerName: string,
 *     baseUrl:      string,
 *     apiKey:       string   (encrypted at rest — store encrypted, decrypt on use)
 *     enabled:      boolean,
 *     rateLimit:    number   (requests per day),
 *     lastSync:     Timestamp | null,
 *     createdAt, updatedAt, softDeleted
 *   }
 *
 * Security note:
 *   apiKey is stored as-is here. In production, encrypt before storing
 *   using Cloud KMS or Secret Manager. Decrypt on retrieval for sync worker.
 *
 * @module modules/master/externalApi.repository
 */

const BaseRepository = require('../../repositories/BaseRepository');

const COLLECTION = 'external_salary_apis';

class ExternalApiRepository extends BaseRepository {
  constructor() {
    super(COLLECTION);
  }

  /**
   * List all registered external APIs.
   * @returns {Promise<object[]>}
   */
  async listAll() {
    const { docs } = await super.find([], { orderBy: { field: 'createdAt', direction: 'desc' } });
    return docs;
  }

  /**
   * List only enabled APIs (for the sync worker).
   * @returns {Promise<object[]>}
   */
  async listEnabled() {
    const { docs } = await super.find([
      { field: 'enabled',      op: '==', value: true },
      { field: 'softDeleted',  op: '==', value: false },
    ]);
    return docs;
  }

  /**
   * Update lastSync timestamp after worker run.
   * @param {string} id
   * @returns {Promise<void>}
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
   * @returns {Promise<object>}
   */
  async setEnabled(id, enabled, adminId) {
    return await super.update(id, { enabled }, adminId);
  }
}

module.exports = new ExternalApiRepository();








