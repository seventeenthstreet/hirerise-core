'use strict';

/**
 * adminLifecycle.audit.js — WP-ADMIN-04F-18C
 *
 * Audit action-name and entity-type constants for Administrator lifecycle
 * events, plus a tiny formatting helper for the shared, already-certified
 * admin audit log (adminAuditLogger.js / logAdminAction() / admin_logs).
 *
 * This module does NOT implement a new audit mechanism. It exists only so
 * that adminPrincipal.repository.js and requireAdmin.middleware.js call
 * logAdminAction() with the same action-name strings and the same
 * metadata shape, rather than each inventing their own.
 *
 * No I/O. No Supabase. Mirrors the "pure, dependency-free" convention set
 * by adminLifecycle.states.js.
 */

const ENTITY_TYPE = 'admin_principal';

const ACTIONS = Object.freeze({
  GRANTED: 'ADMIN_GRANTED',
  ROLE_CHANGED: 'ADMIN_ROLE_CHANGED',
  SUSPENDED: 'ADMIN_SUSPENDED',
  REACTIVATED: 'ADMIN_REACTIVATED',
  REVOKED: 'ADMIN_REVOKED',
  EXPIRED: 'ADMIN_EXPIRED',
  VERIFICATION_FAILED: 'ADMIN_VERIFICATION_FAILED',
  SESSION_REFRESHED: 'ADMIN_SESSION_REFRESHED',
  // WP-ADMIN-04F-18D — additive only. The underlying repository write is
  // an ordinary grant() (none -> ACTIVE), so this is NOT a new lifecycle
  // transition or a new state-machine action. It exists purely so the
  // audit trail can distinguish "this Administrator was created by the
  // one-time deployment bootstrap" from an ordinary ADMIN_GRANTED event
  // performed by another Administrator.
  BOOTSTRAPPED: 'ADMIN_BOOTSTRAPPED',
});

/**
 * Builds the {adminId, action, entityType, entityId, metadata, ipAddress}
 * payload shape expected by logAdminAction(), so every call site fills in
 * the same fields the same way.
 *
 * @param {string} action        - one of ACTIONS
 * @param {string} actorId       - the acting administrator (or the
 *                                 principal itself, for self-service
 *                                 events like session refresh)
 * @param {string} targetUid     - the admin_principals.uid this event is
 *                                 about
 * @param {object} [metadata]
 * @param {string|null} [ipAddress]
 */
function buildLifecycleAuditEvent(action, actorId, targetUid, metadata = {}, ipAddress = null) {
  return {
    adminId: actorId,
    action,
    entityType: ENTITY_TYPE,
    entityId: targetUid,
    metadata,
    ipAddress,
  };
}

module.exports = {
  ENTITY_TYPE,
  ACTIONS,
  buildLifecycleAuditEvent,
};
