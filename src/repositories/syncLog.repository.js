'use strict';

/**
 * syncLog.repository.js
 * ---------------------
 * Production-grade data access layer for sync_logs.
 *
 * Features:
 * - structured sync result writes
 * - dashboard-safe recent log queries
 * - failure trend analysis
 *
 * path: src/repositories/syncLog.repository.js
 */

const { getSupabaseClient } = require('../lib/supabaseClient');

const TABLE = 'sync_logs';
const DEFAULT_RECENT_LIMIT = 50;
const DEFAULT_FAILURE_LIMIT = 100;
const MAX_QUERY_LIMIT = 500;

function normalizeLimit(limit, fallback) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, MAX_QUERY_LIMIT);
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Insert a structured sync log row.
 */
async function createLog(row = {}) {
  if (!row.source_type) {
    throw new Error('syncLog.createLog: source_type is required');
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
    throw new Error(`syncLog.createLog failed: ${error.message}`);
  }

  return data;
}

/**
 * Fetch recent logs for dashboard / debugging.
 */
async function getRecentLogs({
  sourceType,
  limit = DEFAULT_RECENT_LIMIT,
} = {}) {
  const supabase = getSupabaseClient();
  const safeLimit = normalizeLimit(limit, DEFAULT_RECENT_LIMIT);

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
    throw new Error(`syncLog.getRecentLogs failed: ${error.message}`);
  }

  return data || [];
}

/**
 * Fetch failure logs for trend analysis.
 */
async function getFailureLogs({
  sinceHours = 168,
  limit = DEFAULT_FAILURE_LIMIT,
} = {}) {
  const supabase = getSupabaseClient();

  const safeLimit = normalizeLimit(limit, DEFAULT_FAILURE_LIMIT);
  const safeHours =
    Number.isFinite(sinceHours) && sinceHours > 0
      ? sinceHours
      : 168;

  const since = new Date(
    Date.now() - safeHours * 60 * 60 * 1000
  ).toISOString();

  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .gt('fail_count', 0)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(safeLimit);

  if (error) {
    throw new Error(`syncLog.getFailureLogs failed: ${error.message}`);
  }

  return data || [];
}

module.exports = {
  createLog,
  getRecentLogs,
  getFailureLogs,
};