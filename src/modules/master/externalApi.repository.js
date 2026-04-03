'use strict';

/**
 * src/modules/master/repositories/externalApi.repository.js
 *
 * Data access layer for external_salary_apis table.
 *
 * FULL SUPABASE MIGRATION:
 * - Removes all Firestore/Firebase collection + doc assumptions
 * - Uses BaseRepository row-based CRUD semantics
 * - Preserves API behavior exactly
 * - API keys remain AES-256-GCM encrypted at rest
 * - API responses always return masked keys
 * - Internal worker reads decrypted keys only
 *
 * SECURITY:
 * Requires:
 *   API_KEY_ENCRYPTION_SECRET (32 chars)
 *
 * TABLE:
 *   external_salary_apis
 *
 * SCHEMA:
 *   id           text        PRIMARY KEY DEFAULT gen_random_uuid()::text
 *   name         text
 *   base_url     text
 *   api_key      text        AES-256-GCM encrypted at rest
 *   enabled      boolean     NOT NULL DEFAULT false
 *   soft_deleted boolean     NOT NULL DEFAULT false
 *   last_sync    timestamptz
 *   created_at   timestamptz DEFAULT now()
 *   updated_at   timestamptz DEFAULT now() — auto-stamped by trigger
 *   created_by   text
 *   updated_by   text
 *
 * INDEXES:
 *   idx_external_salary_apis_active_sync
 *     ON (enabled, soft_deleted, created_at DESC)
 *     WHERE soft_deleted = false
 *     — covers listEnabled() and listAll() queries
 *
 * TRIGGER:
 *   trg_external_salary_apis_updated_at
 *     — auto-stamps updated_at on every UPDATE
 */

const BaseRepository = require('../../repositories/BaseRepository');
const logger = require('../../utils/logger');
const {
  encryptApiKey,
  decryptApiKey,
  maskApiKey,
} = require('../../utils/apiKeyCrypto');

const TABLE = 'external_salary_apis';

class ExternalApiRepository extends BaseRepository {
  constructor() {
    super(TABLE);
  }

  /**
   * List all registered external APIs.
   * Safe for API responses (masked keys).
   *
   * Query plan: uses idx_external_salary_apis_active_sync
   * for created_at DESC ordering on active rows.
   *
   * @returns {Promise<object[]>}
   */
  async listAll() {
    try {
      const { docs = [] } = await super.find([], {
        orderBy: { field: 'created_at', direction: 'desc' },
      });

      return docs.map(maskRecord);
    } catch (error) {
      logger.error('ExternalApiRepository.listAll failed', {
        table: TABLE,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * List only enabled + active APIs for sync workers.
   * INTERNAL USE ONLY — returns decrypted keys.
   *
   * Query plan: uses idx_external_salary_apis_active_sync
   * partial index — WHERE soft_deleted = false predicate
   * matches index condition exactly for optimal scan.
   *
   * NOTE: Filter uses soft_deleted = false (not != true)
   * to match the partial index predicate exactly and
   * exclude NULL soft_deleted rows from results.
   *
   * @returns {Promise<object[]>}
   */
  async listEnabled() {
    try {
      const { docs = [] } = await super.find([
        { field: 'enabled',      op: '==', value: true  },
        { field: 'soft_deleted', op: '==', value: false },
      ]);

      return docs.map(decryptRecord);
    } catch (error) {
      logger.error('ExternalApiRepository.listEnabled failed', {
        table: TABLE,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Create new external API integration.
   * Encrypts apiKey before persistence.
   *
   * @param {object} data
   * @param {string} adminId
   * @returns {Promise<object>}
   */
  async create(data, adminId) {
    try {
      const payload = {
        ...data,
        api_key: data?.apiKey ? encryptApiKey(data.apiKey) : null,
      };

      delete payload.apiKey;

      const created = await super.create(payload, adminId);

      return maskRecord(normalizeRecord(created));
    } catch (error) {
      logger.error('ExternalApiRepository.create failed', {
        table: TABLE,
        adminId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Update existing external API.
   * Re-encrypts apiKey only if provided.
   *
   * @param {string} id
   * @param {object} updates
   * @param {string} adminId
   * @returns {Promise<object>}
   */
  async update(id, updates, adminId) {
    try {
      const payload = { ...updates };

      if (Object.prototype.hasOwnProperty.call(payload, 'apiKey')) {
        payload.api_key = payload.apiKey
          ? encryptApiKey(payload.apiKey)
          : null;

        delete payload.apiKey;
      }

      const updated = await super.update(id, payload, adminId);

      return maskRecord(normalizeRecord(updated));
    } catch (error) {
      logger.error('ExternalApiRepository.update failed', {
        table: TABLE,
        id,
        adminId,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Update sync timestamp after worker execution.
   * updated_at is auto-stamped by trg_external_salary_apis_updated_at.
   *
   * @param {string} id
   * @returns {Promise<void>}
   */
  async updateLastSync(id) {
    try {
      await super.update(id, {
        last_sync: new Date().toISOString(),
      });

      logger.info('External API last sync updated', {
        table: TABLE,
        id,
      });
    } catch (error) {
      logger.error('ExternalApiRepository.updateLastSync failed', {
        table: TABLE,
        id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Enable or disable an external API.
   *
   * @param {string} id
   * @param {boolean} enabled
   * @param {string} adminId
   * @returns {Promise<object>}
   */
  async setEnabled(id, enabled, adminId) {
    try {
      const updated = await super.update(
        id,
        { enabled: Boolean(enabled) },
        adminId
      );

      return maskRecord(normalizeRecord(updated));
    } catch (error) {
      logger.error('ExternalApiRepository.setEnabled failed', {
        table: TABLE,
        id,
        enabled,
        adminId,
        error: error.message,
      });
      throw error;
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Private Helpers                                                            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * Normalize DB row to API shape.
 * Handles snake_case ↔ camelCase compatibility safely.
 *
 * @param {object|null} record
 * @returns {object}
 */
function normalizeRecord(record) {
  if (!record || typeof record !== 'object') {
    return {};
  }

  return {
    ...record,
    apiKey: record.apiKey ?? record.api_key ?? null,
  };
}

/**
 * Decrypt record for internal workers only.
 *
 * @param {object} record
 * @returns {object}
 */
function decryptRecord(record) {
  const normalized = normalizeRecord(record);

  return {
    ...normalized,
    apiKey: normalized.apiKey
      ? decryptApiKey(normalized.apiKey)
      : null,
  };
}

/**
 * Mask API key for safe outbound responses.
 *
 * @param {object} record
 * @returns {object}
 */
function maskRecord(record) {
  const normalized = normalizeRecord(record);

  return {
    ...normalized,
    apiKey: maskApiKey(normalized.apiKey),
  };
}

module.exports = new ExternalApiRepository();