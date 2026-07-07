'use strict';

/**
 * src/modules/source-intelligence/repositories/sourceAudit.repository.js
 *
 * Persistence-only, append-only audit trail for the SIM registry.
 * Every governance-relevant action (create, metadata change, status
 * transition, approval decision, health-triggered auto-status-change)
 * is written here by the service layer. Rows are never updated or
 * deleted — the audit log is the compliance record for "who changed
 * what, when, and why" per deliverable #17 (Audit Strategy).
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');
const { TABLES } = require('../models/source.model');

function throwIfError(error, context, meta = {}) {
  if (!error) return;

  logger.error(`[SourceAuditRepository] ${context}`, {
    ...meta,
    message: error.message,
    details: error.details,
    hint: error.hint,
    code: error.code,
  });

  throw error;
}

async function record({
  sourceId,
  action,
  actorId = 'system',
  beforeState = null,
  afterState = null,
  reason = null,
  metadata = null,
}) {
  const row = {
    source_id: sourceId,
    action,
    actor_id: actorId,
    before_state: beforeState,
    after_state: afterState,
    reason,
    metadata,
    occurred_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from(TABLES.SOURCE_AUDIT_LOG)
    .insert(row)
    .select('*')
    .single();

  throwIfError(error, 'record', { sourceId, action });
  return data;
}

async function listForSource(sourceId, { limit = 100 } = {}) {
  const { data, error } = await supabase
    .from(TABLES.SOURCE_AUDIT_LOG)
    .select('*')
    .eq('source_id', sourceId)
    .order('occurred_at', { ascending: false })
    .limit(limit);

  throwIfError(error, 'listForSource', { sourceId });
  return data ?? [];
}

module.exports = {
  record,
  listForSource,
};
