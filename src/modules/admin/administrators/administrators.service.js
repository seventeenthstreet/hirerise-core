'use strict';

/**
 * administrators.service.js — WP-ADMIN-05A
 *
 * Enterprise Administrator Management — application-layer orchestration.
 *
 * This service implements NO lifecycle logic of its own. Every state
 * transition (grant/suspend/reactivate/revoke) is delegated verbatim to
 * the certified ../repository/adminPrincipal.repository.js (WP-ADMIN-04F-18B),
 * which is the sole owner of the lifecycle state machine
 * (domain/admin/lifecycle/adminLifecycle.states.js), its audit trail
 * (domain/admin/lifecycle/adminLifecycle.audit.js), and the two-factor
 * verification contract (verify()/refreshSession()). This file never
 * writes to admin_principals directly.
 *
 * Directory listing, detail composition (principal + profile + audit
 * history), and the self-lockout guard below are the only new behaviour
 * this WP introduces — see WP-ADMIN-05A Phase 2/3 gap analysis.
 */

const principalRepo = require('../repository/adminPrincipal.repository');
const directoryRepo = require('./administrators.repository');
const {
  InvalidLifecycleTransitionError,
} = require('../../../domain/admin/lifecycle/adminLifecycle.states');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const logger = require('../../../utils/logger');

/**
 * Maps the certified state machine's own rejection (InvalidLifecycleTransitionError)
 * onto the standard HTTP error envelope, without changing what the state
 * machine decided.
 */
function rethrowAsAppError(err) {
  if (err instanceof InvalidLifecycleTransitionError) {
    throw AppError.conflict(err.message, 'ADMIN_LIFECYCLE_INVALID_TRANSITION', {
      action: err.action,
      fromStatus: err.fromStatus,
    });
  }
  throw err;
}

function toDirectoryItem(principalRow, profile) {
  return {
    uid: principalRow.uid,
    role: principalRow.role,
    status: principalRow.status,
    email: profile?.email ?? null,
    displayName: profile?.displayName ?? null,
    grantedBy: principalRow.granted_by ?? null,
    grantedAt: principalRow.granted_at ?? null,
    verifiedAt: principalRow.verified_at ?? null,
    lastActionAt: principalRow.last_action_at ?? null,
  };
}

function toDetail(principalRow, profile, auditEvents) {
  return {
    ...toDirectoryItem(principalRow, profile),
    revokedAt: principalRow.revoked_at ?? null,
    revokedBy: principalRow.revoked_by ?? null,
    suspendedAt: principalRow.suspended_at ?? null,
    suspendedBy: principalRow.suspended_by ?? null,
    suspensionReason: principalRow.suspension_reason ?? null,
    reactivatedAt: principalRow.reactivated_at ?? null,
    reactivatedBy: principalRow.reactivated_by ?? null,
    expiresAt: principalRow.expires_at ?? null,
    lifecycleHistory: (auditEvents || []).map((e) => ({
      action: e.action,
      actorId: e.admin_id,
      createdAt: e.created_at,
      metadata: e.metadata ?? {},
    })),
  };
}

// ── Directory ────────────────────────────────────────────────────────────

/**
 * @param {object} opts — { status, search, limit, offset }
 * @returns {Promise<{ administrators: object[], total: number }>}
 */
async function listAdministrators({ status, search, limit = 50, offset = 0 } = {}) {
  const { items, total } = await directoryRepo.listPrincipals({ status, search, limit, offset });

  const uids = items.map((row) => row.uid);
  const profiles = await directoryRepo.getUserProfiles(uids);

  return {
    administrators: items.map((row) => toDirectoryItem(row, profiles.get(row.uid))),
    total,
  };
}

/**
 * @param {string} uid
 * @returns {Promise<object>}
 * @throws {AppError} 404 if no principal exists for uid
 */
async function getAdministrator(uid) {
  const principal = await principalRepo.getPrincipal(uid);
  if (!principal) {
    throw AppError.notFound('Administrator not found', ErrorCodes.NOT_FOUND, { uid });
  }

  const [profiles, auditEvents] = await Promise.all([
    directoryRepo.getUserProfiles([uid]),
    directoryRepo.listLifecycleAuditEvents(uid),
  ]);

  return toDetail(principal, profiles.get(uid), auditEvents);
}

// ── Lifecycle orchestration (delegates entirely to the certified repository) ──

/**
 * @param {string} uid
 * @param {string} role
 * @param {string} actorId
 */
async function grantAdministrator(uid, role, actorId) {
  try {
    await principalRepo.grant(uid, role, actorId);
  } catch (err) {
    rethrowAsAppError(err);
  }
  logger.info('[AdministratorManagement] Granted Administrator access', { actorId, targetUid: uid, role });
  return getAdministrator(uid);
}

/**
 * @param {string} uid
 * @param {string} actorId
 * @param {string|null} reason
 */
async function suspendAdministrator(uid, actorId, reason = null) {
  if (uid === actorId) {
    throw AppError.forbidden(
      'You cannot suspend your own Administrator access.',
      ErrorCodes.FORBIDDEN,
      { uid }
    );
  }
  try {
    await principalRepo.suspend(uid, actorId, reason);
  } catch (err) {
    rethrowAsAppError(err);
  }
  logger.info('[AdministratorManagement] Suspended Administrator', { actorId, targetUid: uid });
  return getAdministrator(uid);
}

/**
 * @param {string} uid
 * @param {string} actorId
 */
async function reactivateAdministrator(uid, actorId) {
  try {
    await principalRepo.reactivate(uid, actorId);
  } catch (err) {
    rethrowAsAppError(err);
  }
  logger.info('[AdministratorManagement] Reactivated Administrator', { actorId, targetUid: uid });
  return getAdministrator(uid);
}

/**
 * @param {string} uid
 * @param {string} actorId
 */
async function revokeAdministrator(uid, actorId) {
  if (uid === actorId) {
    throw AppError.forbidden(
      'You cannot revoke your own Administrator access.',
      ErrorCodes.FORBIDDEN,
      { uid }
    );
  }
  try {
    await principalRepo.revoke(uid, actorId);
  } catch (err) {
    rethrowAsAppError(err);
  }
  logger.info('[AdministratorManagement] Revoked Administrator', { actorId, targetUid: uid });
  return getAdministrator(uid);
}

module.exports = {
  listAdministrators,
  getAdministrator,
  grantAdministrator,
  suspendAdministrator,
  reactivateAdministrator,
  revokeAdministrator,
};
