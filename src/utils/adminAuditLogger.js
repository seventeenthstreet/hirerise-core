'use strict';

/**
 * adminAuditLogger.js — Admin Action Audit Trail
 *
 * Production-hardened:
 * - never breaks request flow
 * - JSONB-safe metadata
 * - reusable singleton Supabase client
 * - centralized schema constants
 */

const { supabase } = require('../config/supabase');
const logger = require('./logger');
const crypto = require('crypto');

const TABLES = Object.freeze({
  ADMIN_LOGS: 'admin_logs',
});

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
 * WP-ADMIN-IMP-07 follow-up: `admin_logs.id` is a TEXT PRIMARY KEY with no
 * database default/identity generation, so a value must be supplied on
 * every insert or Postgres rejects it with a not-null violation. Uses the
 * same crypto.randomUUID() convention already used throughout this
 * codebase (e.g. requireMasterAdmin.middleware.js, BaseRepository.js) for
 * generating TEXT/string primary key values — a UUID string is valid for
 * a TEXT column. No other field's semantics changed.
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
    id: crypto.randomUUID(),
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
 * Safe for fire-and-forget usage.
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
      .from(TABLES.ADMIN_LOGS)
      .insert(payload);

    if (error) {
      throw error;
    }
  } catch (error) {
    logger.error(
      '[AdminAuditLogger] Failed to write audit log',
      {
        admin_id: params?.adminId || 'unknown',
        action: params?.action || 'UNKNOWN_ACTION',
        entity_type: params?.entityType || 'unknown',
        error: error.message,
      }
    );
  }
}

module.exports = {
  logAdminAction,
};