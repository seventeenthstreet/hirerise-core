'use strict';

/**
 * syncLog.repository.js — Production Analytics-Ready Supabase Log Repository
 */

const logger = require('../../../../utils/logger');

const MAX_STORED_ERRORS = 100;
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 100;

function getSupabase() {
  return require('../../../../config/supabase');
}

class SyncLogRepository {
  async create(payload) {
    const {
      sourceType,
      sourceUrl,
      totalRecords,
      successCount,
      failCount,
      initiatedBy,
      errors = [],
      requestId,
      durationMs,
    } = payload;

    if (
      !Number.isFinite(totalRecords) ||
      !Number.isFinite(successCount) ||
      !Number.isFinite(failCount)
    ) {
      throw new Error('Invalid numeric values in sync log payload');
    }

    const safeOrigin = this._safeOrigin(sourceUrl);

    const row = {
      type: 'JOB_SYNC',
      source_type: sourceType || null,
      source_origin: safeOrigin,
      total_records: totalRecords,
      success_count: successCount,
      fail_count: failCount,
      success_rate:
        totalRecords > 0
          ? Number(((successCount / totalRecords) * 100).toFixed(2))
          : 0,
      duration_ms: Number.isFinite(durationMs) ? durationMs : null,
      errors: Array.isArray(errors)
        ? errors.slice(0, MAX_STORED_ERRORS)
        : [],
      initiated_by: initiatedBy || null,
      request_id: requestId || null,
    };

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('sync_logs')
      .insert(row)
      .select('*')
      .single();

    if (error) {
      logger.error('[SyncLogRepository.create] failed', {
        error: error.message,
      });

      return null;
    }

    return data;
  }

  async list({ limit = DEFAULT_LIST_LIMIT } = {}) {
    const safeLimit = Math.min(
      Math.max(Number(limit) || DEFAULT_LIST_LIMIT, 1),
      MAX_LIST_LIMIT
    );

    const supabase = getSupabase();

    const { data, error } = await supabase
      .from('sync_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(safeLimit);

    if (error) {
      logger.error('[SyncLogRepository.list] failed', {
        error: error.message,
      });

      return [];
    }

    return data || [];
  }

  async getFailureSummary({ days = 7 } = {}) {
    const supabase = getSupabase();

    const since = new Date(
      Date.now() - Number(days) * 24 * 60 * 60 * 1000
    ).toISOString();

    const { data, error } = await supabase
      .from('sync_logs')
      .select('source_type, fail_count, created_at')
      .gte('created_at', since)
      .gt('fail_count', 0);

    if (error) {
      logger.error('[SyncLogRepository.getFailureSummary] failed', {
        error: error.message,
      });

      return [];
    }

    return data || [];
  }

  _safeOrigin(sourceUrl) {
    try {
      return new URL(sourceUrl).origin;
    } catch {
      return 'invalid-url';
    }
  }
}

module.exports = new SyncLogRepository();