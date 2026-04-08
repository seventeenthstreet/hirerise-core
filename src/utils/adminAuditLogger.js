'use strict';

/**
 * adminAuditLogger.js — Admin Action Audit Trail
 *
 * Supabase production-ready audit logger.
 *
 * Design goals:
 * - Never breaks request flow
 * - Safe in test / missing-env environments
 * - Structured snake_case Postgres payloads
 * - JSONB-safe metadata
 * - Non-blocking async writes
 * - Reusable singleton Supabase client
 */

const { supabase } = require('../config/supabase');
const logger = require('./logger');

/**
 * Safely normalize metadata into JSONB-safe object.
 *
 * @param {unknown} metadata
 * @returns {object}
 */
function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return {};
  }

  try {
    return JSON.parse(JSON.stringify(metadata));
  } catch {
    return {
      serialization_error: true,
    };
  }
}

/**
 * Build final insert payload.
 *
 * @param {object} params
 * @returns {object}
 */
function buildAuditPayload({
  adminId,
  action,
  entityType,
  entityId = null,
  metadata = {},
  ipAddress = null,
}) {
  return {
    admin_id: adminId || 'unknown',
    action: action || 'UNKNOWN_ACTION',
    entity_type: entityType || 'unknown',
    entity_id: entityId,
    metadata: normalizeMetadata(metadata),
    ip_address: ipAddress,
    created_at: new Date().toISOString(),
  };
}

/**
 * Write an audit log entry.
 *
 * Never throws.
 * Safe for fire-and-forget usage:
 *   void logAdminAction(...)
 *
 * @param {{
 *   adminId?: string,
 *   action?: string,
 *   entityType?: string,
 *   entityId?: string | null,
 *   metadata?: object,
 *   ipAddress?: string | null,
 * }} params
 * @returns {Promise<void>}
 */
async function logAdminAction(params = {}) {
  try {
    if (!supabase) {
      return;
    }

    const payload = buildAuditPayload(params);

    const { error } = await supabase
      .from('admin_logs')
      .insert(payload);

    if (error) {
      throw error;
    }
  } catch (error) {
    logger.error('[AdminAuditLogger] Failed to write audit log', {
      admin_id: params?.adminId || 'unknown',
      action: params?.action || 'UNKNOWN_ACTION',
      entity_type: params?.entityType || 'unknown',
      error: error.message,
    });
  }
}

module.exports = {
  logAdminAction,
};