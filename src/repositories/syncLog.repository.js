'use strict';

const { getSupabaseClient } = require('../lib/supabaseClient');
const logger = require('../utils/logger');

const TABLE = 'sync_logs';
const DEFAULT_RECENT_LIMIT = 50;
const DEFAULT_FAILURE_LIMIT = 100;
const MAX_QUERY_LIMIT = 500;
const DEFAULT_FAILURE_HOURS = 168;

function normalizeLimit(limit, fallback) {
  const parsed = Number(limit);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, MAX_QUERY_LIMIT);
}

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function createLog(row = {}) {
  if (!row.source_type) {
    throw new Error(
      'syncLog.createLog: source_type is required'
    );
  }

  const supabase = getSupabaseClient();

  const payload = {
    source_type: row.source_type,
    status: row.status || 'success',
    success_count: safeNumber(row.success_count),
    fail_count: safeNumber(row.fail_count),
    success_rate: safeNumber(row.success_rate),
    duration_ms: safeNumber(row.duration_ms),
    error_message: row.error_message || null,
    notes: row.notes || null,
    request_id: row.request_id || null,
  };

  const { data, error } = await supabase
    .from(TABLE)
    .insert(payload)
    .select('*')
    .single();

  if (error) {
    logger.error('[syncLog] createLog failed', {
      sourceType: payload.source_type,
      requestId: payload.request_id,
      code: error.code,
      message: error.message,
    });

    throw new Error(
      `syncLog.createLog failed: ${error.message}`
    );
  }

  return data;
}

async function getRecentLogs({
  sourceType,
  limit = DEFAULT_RECENT_LIMIT,
} = {}) {
  const supabase = getSupabaseClient();
  const safeLimit = normalizeLimit(
    limit,
    DEFAULT_RECENT_LIMIT
  );

  let query = supabase
    .from(TABLE)
    .select('*')
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (sourceType) {
    query = query.eq('source_type', sourceType);
  }

  const { data, error } = await query;

  if (error) {
    logger.error('[syncLog] getRecentLogs failed', {
      sourceType,
      limit: safeLimit,
      code: error.code,
      message: error.message,
    });

    throw new Error(
      `syncLog.getRecentLogs failed: ${error.message}`
    );
  }

  return data ?? [];
}

async function getFailureLogs({
  sinceHours = DEFAULT_FAILURE_HOURS,
  limit = DEFAULT_FAILURE_LIMIT,
} = {}) {
  const supabase = getSupabaseClient();

  const safeLimit = normalizeLimit(
    limit,
    DEFAULT_FAILURE_LIMIT
  );

  const safeHours =
    Number.isFinite(Number(sinceHours)) &&
    Number(sinceHours) > 0
      ? Number(sinceHours)
      : DEFAULT_FAILURE_HOURS;

  const since = new Date(
    Date.now() - safeHours * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .gte('created_at', since)
    .or('fail_count.gt.0,status.eq.failed')
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) {
    logger.error('[syncLog] getFailureLogs failed', {
      sinceHours: safeHours,
      limit: safeLimit,
      code: error.code,
      message: error.message,
    });

    throw new Error(
      `syncLog.getFailureLogs failed: ${error.message}`
    );
  }

  return data ?? [];
}

module.exports = {
  createLog,
  getRecentLogs,
  getFailureLogs,
};