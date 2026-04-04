'use strict';

const { supabase } = require('../config/supabase');
const logger = require('../utils/logger');

const DEFAULT_LIMIT = 50;
const MAX_BATCH_SIZE = 500;

class ChangeLogRepository {
  constructor(db = supabase) {
    this.db = db;
    this.table = 'change_logs';
  }

  // ─────────────────────────────────────────────────────────────
  // CREATE LOG
  // ─────────────────────────────────────────────────────────────

  async logChange(changeData = {}) {
    try {
      const record = this.#normalizeRecord(changeData);

      if (!record) return;

      const { error } = await this.db
        .from(this.table)
        .insert(record);

      this.#logDbError(error, 'logChange', record);
    } catch (error) {
      logger.error('[ChangeLogRepository] logChange failed (non-fatal)', {
        message: error.message,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────
  // BATCH LOG
  // ─────────────────────────────────────────────────────────────

  async logChangesBatch(changes = [], userId = 'system') {
    try {
      if (!Array.isArray(changes) || changes.length === 0) {
        return;
      }

      const timestamp = this.#now();

      for (let i = 0; i < changes.length; i += MAX_BATCH_SIZE) {
        const chunk = changes.slice(i, i + MAX_BATCH_SIZE);

        const records = chunk
          .map(change =>
            this.#normalizeRecord(
              { ...change, userId },
              timestamp
            )
          )
          .filter(Boolean);

        if (!records.length) continue;

        const { error } = await this.db
          .from(this.table)
          .insert(records);

        this.#logDbError(error, 'logChangesBatch', {
          chunkSize: records.length,
        });
      }
    } catch (error) {
      logger.error(
        '[ChangeLogRepository] logChangesBatch failed (non-fatal)',
        { message: error.message }
      );
    }
  }

  // ─────────────────────────────────────────────────────────────
  // GETTERS
  // ─────────────────────────────────────────────────────────────

  async getDocumentHistory(
    collectionName,
    documentId,
    limit = DEFAULT_LIMIT
  ) {
    const { data, error } = await this.db
      .from(this.table)
      .select('*')
      .eq('collection_name', collectionName)
      .eq('document_id', documentId)
      .order('timestamp', { ascending: false })
      .limit(this.#safeLimit(limit));

    this.#throwIfError(error, 'getDocumentHistory');
    return data ?? [];
  }

  async getUserActivity(userId, limit = DEFAULT_LIMIT) {
    const { data, error } = await this.db
      .from(this.table)
      .select('*')
      .eq('user_id', userId)
      .order('timestamp', { ascending: false })
      .limit(this.#safeLimit(limit));

    this.#throwIfError(error, 'getUserActivity');
    return data ?? [];
  }

  async getRecentChanges(limit = 100) {
    const { data, error } = await this.db
      .from(this.table)
      .select('*')
      .order('timestamp', { ascending: false })
      .limit(this.#safeLimit(limit, 500));

    this.#throwIfError(error, 'getRecentChanges');
    return data ?? [];
  }

  // ─────────────────────────────────────────────────────────────
  // INTERNAL HELPERS
  // ─────────────────────────────────────────────────────────────

  #normalizeRecord(changeData = {}, timestamp = this.#now()) {
    const {
      collectionName,
      collection_name,
      documentId,
      document_id,
      operation,
      changedFields = {},
      changed_fields,
      previousValue = null,
      previous_value = null,
      newValue = null,
      new_value = null,
      userId = 'system',
      user_id,
      metadata = {},
    } = changeData;

    const finalCollection =
      collectionName ?? collection_name;
    const finalDocument =
      documentId ?? document_id;

    if (!finalCollection || !finalDocument || !operation) {
      logger.warn(
        '[ChangeLogRepository] Missing required fields',
        {
          collectionName: finalCollection,
          documentId: finalDocument,
          operation,
        }
      );
      return null;
    }

    return {
      collection_name: finalCollection,
      document_id: finalDocument,
      operation,
      changed_fields: changedFields ?? changed_fields ?? {},
      previous_value: previousValue ?? previous_value,
      new_value: newValue ?? new_value,
      user_id: userId ?? user_id ?? 'system',
      metadata,
      timestamp,
    };
  }

  #safeLimit(limit, max = DEFAULT_LIMIT) {
    const value = Number(limit);
    if (!Number.isInteger(value) || value <= 0) {
      return DEFAULT_LIMIT;
    }
    return Math.min(value, max);
  }

  #now() {
    return new Date().toISOString();
  }

  #logDbError(error, operation, meta = {}) {
    if (!error) return;

    logger.error(`[ChangeLogRepository] ${operation} DB error`, {
      ...meta,
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
  }

  #throwIfError(error, operation) {
    if (!error) return;

    logger.error(`[ChangeLogRepository] ${operation} failed`, {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });

    throw error;
  }
}

module.exports = new ChangeLogRepository();