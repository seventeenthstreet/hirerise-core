'use strict';

/**
 * syncLog.repository.js — Job Sync Log (Supabase)
 * MIGRATED: Firestore syncLogs → Supabase sync_logs table
 */

const logger = require('../../../../utils/logger');
const MAX_STORED_ERRORS = 100;

function getSupabase() { return require('../../../../core/supabaseClient'); }

class SyncLogRepository {

  async create(payload) {
    const { sourceType, sourceUrl, totalRecords, successCount,
            failCount, initiatedBy, errors = [], requestId, durationMs } = payload;

    if (!Number.isFinite(totalRecords) || !Number.isFinite(successCount) || !Number.isFinite(failCount)) {
      throw new Error('Invalid numeric values in sync log payload');
    }

    let safeOrigin = 'invalid-url';
    try { safeOrigin = new URL(sourceUrl).origin; } catch {}

    const supabase = getSupabase();
    const { data, error } = await supabase.from('sync_logs').insert({
      type:          'JOB_SYNC',
      source_type:   sourceType || null,
      source_origin: safeOrigin,
      total_records: totalRecords,
      success_count: successCount,
      fail_count:    failCount,
      duration_ms:   durationMs || null,
      errors:        errors.slice(0, MAX_STORED_ERRORS),
      initiated_by:  initiatedBy || null,
      request_id:    requestId   || null,
    }).select().single();

    if (error) {
      logger.error('[SyncLog] Failed to create log entry', { error: error.message });
      return null;
    }
    return data;
  }

  async list({ limit = 20 } = {}) {
    const supabase = getSupabase();
    const { data } = await supabase.from('sync_logs')
      .select('*').order('created_at', { ascending: false }).limit(limit);
    return data || [];
  }
}

module.exports = new SyncLogRepository();








