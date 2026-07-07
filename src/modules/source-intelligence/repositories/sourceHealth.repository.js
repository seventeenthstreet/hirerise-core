'use strict';

/**
 * src/modules/source-intelligence/repositories/sourceHealth.repository.js
 *
 * Persistence-only repository for SIM health snapshots. Health is modeled
 * as an append-only time series (one row per observation) rather than a
 * single mutable column set, so reliability trend / alerting can be
 * computed without losing history. The "current" health fields mirrored
 * onto sim_sources (health_status, last_successful_access_at, ...) are a
 * denormalized cache maintained by sourceHealth.service.js for fast reads.
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const { TABLES } = require('../models/source.model');

function throwIfError(error, context, meta = {}) {
  if (!error) return;

  logger.error(`[SourceHealthRepository] ${context}`, {
    ...meta,
    message: error.message,
    details: error.details,
    hint: error.hint,
    code: error.code,
  });

  throw error;
}

async function recordSnapshot(sourceId, snapshot) {
  const row = {
    id: snapshot.id || undefined,
    source_id: sourceId,
    observed_at: snapshot.observedAt || new Date().toISOString(),
    available: snapshot.available ?? null,
    response_success_rate: snapshot.responseSuccessRate ?? null,
    latency_ms: snapshot.latencyMs ?? null,
    succeeded: snapshot.succeeded ?? null,
    failure_reason: snapshot.failureReason ?? null,
    health_status: snapshot.healthStatus ?? null,
    raw_metadata: snapshot.rawMetadata ?? null,
  };

  const { data, error } = await supabase
    .from(TABLES.SOURCE_HEALTH_SNAPSHOTS)
    .insert(row)
    .select('*')
    .single();

  throwIfError(error, 'recordSnapshot', { sourceId });
  return data;
}

async function listRecent(sourceId, { limit = 50 } = {}) {
  const { data, error } = await supabase
    .from(TABLES.SOURCE_HEALTH_SNAPSHOTS)
    .select('*')
    .eq('source_id', sourceId)
    .order('observed_at', { ascending: false })
    .limit(limit);

  throwIfError(error, 'listRecent', { sourceId });
  return data ?? [];
}

async function getLatest(sourceId) {
  const { data, error } = await supabase
    .from(TABLES.SOURCE_HEALTH_SNAPSHOTS)
    .select('*')
    .eq('source_id', sourceId)
    .order('observed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  throwIfError(error, 'getLatest', { sourceId });
  return data || null;
}

/**
 * Failure/success counters + last-access timestamps, computed from the
 * snapshot history. Kept as a single query rather than pulling all rows
 * into app memory.
 */
async function getRollup(sourceId, { windowSize = 100 } = {}) {
  const { data, error } = await supabase
    .from(TABLES.SOURCE_HEALTH_SNAPSHOTS)
    .select('succeeded, observed_at')
    .eq('source_id', sourceId)
    .order('observed_at', { ascending: false })
    .limit(windowSize);

  throwIfError(error, 'getRollup', { sourceId });

  const rows = data ?? [];
  const successes = rows.filter((r) => r.succeeded === true);
  const failures = rows.filter((r) => r.succeeded === false);

  return {
    sampleSize: rows.length,
    successCount: successes.length,
    failureCount: failures.length,
    lastSuccessfulAccess: successes[0]?.observed_at ?? null,
    lastFailure: failures[0]?.observed_at ?? null,
  };
}

module.exports = {
  recordSnapshot,
  listRecent,
  getLatest,
  getRollup,
};
