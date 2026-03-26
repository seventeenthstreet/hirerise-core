'use strict';

/**
 * adminAuditLogger.js — Admin Action Audit Trail
 *
 * MIGRATION: Removed the lazy require('../config/supabase') inside logAdminAction().
 * The check `if (!db) return` (test-mode guard) is replaced by a try/catch which
 * was already there — behaviour is unchanged in test environments where SUPABASE_URL
 * is unset (the client throw is caught and logged as a warn, never rethrown).
 *
 * Write change:
 *   OLD: db.collection('admin_logs').add({ adminId, action, ... })
 *   NEW: supabase.from('admin_logs').insert({ admin_id, action, ... })
 *
 * Schema note: Postgres column names are snake_case.
 *   adminId    → admin_id
 *   entityType → entity_type
 *   entityId   → entity_id
 *   ipAddress  → ip_address
 *   createdAt  → created_at
 */

const supabase = require('../config/supabase');
const logger   = require('./logger');

/**
 * Write an audit log entry to the admin_logs table.
 * Fire-and-forget — never throws, never blocks the calling request.
 *
 * @param {{
 *   adminId:    string,
 *   action:     string,
 *   entityType: string,
 *   entityId?:  string,
 *   metadata?:  object,
 *   ipAddress?: string,
 * }} params
 * @returns {Promise<void>}
 */
async function logAdminAction({
  adminId,
  action,
  entityType,
  entityId  = null,
  metadata  = {},
  ipAddress = null,
}) {
  try {
    const { error } = await supabase.from('admin_logs').insert({
      admin_id:    adminId    || 'unknown',
      action:      action     || 'UNKNOWN_ACTION',
      entity_type: entityType || 'unknown',
      entity_id:   entityId,
      metadata:    metadata   || {},
      ip_address:  ipAddress  || null,
      created_at:  new Date().toISOString(),
    });

    if (error) throw error;

  } catch (err) {
    // Never let audit logging failure break the main request flow.
    // Elevated to error: a failed audit write is a compliance gap, not a minor warning.
    logger.error('[AdminAuditLogger] Failed to write audit log', {
      action,
      entityType,
      adminId,
      error:  err.message,
      stack:  err.stack,
    });
  }
}

module.exports = { logAdminAction };