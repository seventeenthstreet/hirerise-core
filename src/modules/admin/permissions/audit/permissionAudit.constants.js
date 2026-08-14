'use strict';

/**
 * permissionAudit.constants.js — WP-ADMIN-05B
 *
 * Audit action-name and entity-type constants for Enterprise Permission
 * events, plus a tiny formatting helper for the shared, already-certified
 * admin audit log (adminAuditLogger.js / logAdminAction() / admin_logs).
 *
 * This module does NOT implement a new audit mechanism — it exists only so
 * every Permission call site that emits an audit event uses the same
 * action-name strings and the same metadata shape, rather than each
 * inventing its own. Mirrors the established convention set by
 * ../../../../domain/admin/lifecycle/adminLifecycle.audit.js.
 *
 * Deliberately placed under modules/admin/permissions/ (the service
 * integration layer), NOT under domain/permission/ — per WP-ADMIN-05B,
 * "The Permission domain must remain independent of auditing." This file
 * has no I/O and emits nothing itself; only callers in this modules/
 * layer (controllers) invoke logAdminAction() with the shapes below.
 *
 * ACTIONS below covers the full Permission audit-event matrix named by
 * WP-ADMIN-05B Phase 5 (Assignment + Governance). Only the ASSIGNED and
 * REVOKED actions are wired to a live call site by this work package —
 * Assignment is the only Permission sub-domain with a reachable service
 * integration layer today (see permissionAssignment.controller.js). The
 * Governance actions are declared here so the work package that exposes
 * Governance through application APIs can reuse these exact names rather
 * than inventing a second action registry; they are not emitted by any
 * code path as of WP-ADMIN-05B.
 */

const ENTITY_TYPE = 'permission';

const ACTIONS = Object.freeze({
  ASSIGNED: 'PERMISSION_ASSIGNED',
  REVOKED: 'PERMISSION_REVOKED',
  // Reserved for the Governance service-integration work package.
  // Not emitted by WP-ADMIN-05B — see file header.
  APPROVED: 'PERMISSION_APPROVED',
  PUBLISHED: 'PERMISSION_PUBLISHED',
  ADOPTED: 'PERMISSION_ADOPTED',
  DEPRECATED: 'PERMISSION_DEPRECATED',
  RETIRED: 'PERMISSION_RETIRED',
});

/**
 * Builds the {adminId, action, entityType, entityId, metadata, ipAddress}
 * payload shape expected by logAdminAction(), so every Permission call
 * site fills in the same fields the same way.
 *
 * @param {string} action        - one of ACTIONS
 * @param {string} adminId       - the acting administrator (req.adminPrincipal.uid)
 * @param {string} entityId      - the Permission Identity (`${resource}:${action}`)
 * @param {object} [metadata]
 * @param {string|null} [ipAddress]
 */
function buildPermissionAuditEvent(action, adminId, entityId, metadata = {}, ipAddress = null) {
  return {
    adminId,
    action,
    entityType: ENTITY_TYPE,
    entityId,
    metadata,
    ipAddress,
  };
}

module.exports = {
  ENTITY_TYPE,
  ACTIONS,
  buildPermissionAuditEvent,
};
