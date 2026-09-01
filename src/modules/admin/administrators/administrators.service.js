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
 *
 * Admin Authorization Role Reconciliation — Auth projection:
 *   grantAdministrator() and reactivateAdministrator() now project the
 *   resulting admin_principals role onto Supabase Auth app_metadata via
 *   the existing adminAuthSync.js#syncAdminRoleToAuth() — the same
 *   projection adminBootstrap.service.js already uses, reused verbatim
 *   (no duplicate sync logic). This is necessary because
 *   requireAdmin/requireMasterAdmin authorize primarily from JWT claims
 *   built from Auth app_metadata (auth.middleware.js), not from
 *   admin_principals directly — without this projection, a freshly
 *   granted principal's existing JWT (or the next one issued before any
 *   other write touches Auth) would never actually carry the granted
 *   role/claim. The sync only ever runs AFTER the admin_principals
 *   mutation has already committed (never before, never as a substitute
 *   for it), it never throws, and a failure is recorded as its own
 *   ADMIN_AUTH_SYNC_FAILED audit event and surfaced on the response as
 *   `authSynchronized` / `authSyncError` — mirroring
 *   adminBootstrap.service.js#bootstrapMasterAdmin()'s established
 *   convention exactly, rather than inventing a new one.
 *
 *   suspendAdministrator() and revokeAdministrator() deliberately do NOT
 *   touch Auth app_metadata. Two reasons, not one:
 *     (1) There is no real role to project — inventing a substitute value
 *         (e.g. a "suspended_admin" claim, or blanking app_metadata.role)
 *         would be fabricating Auth-layer state that has no corresponding
 *         admin_principals role, which is explicitly out of scope.
 *     (2) It would not improve enforcement even if we tried: Auth
 *         app_metadata only affects claims on a NEW token; it cannot
 *         revoke an already-issued, still-unexpired JWT. The actual
 *         enforcement for suspended/revoked principals is
 *         requireAdmin.middleware.js / requireMasterAdmin.middleware.js's
 *         own admin_principals.status check (SHOULD_VERIFY_DB — always on
 *         in production, opt-in via ADMIN_HARDENING_ENABLED elsewhere),
 *         which fails closed on any non-'active' status regardless of
 *         what a stale JWT claims. That check is unmodified by this WP.
 */

const principalRepo = require('../repository/adminPrincipal.repository');
const directoryRepo = require('./administrators.repository');
const {
  InvalidLifecycleTransitionError,
} = require('../../../domain/admin/lifecycle/adminLifecycle.states');
const {
  ACTIONS: AUDIT_ACTIONS,
  buildLifecycleAuditEvent,
} = require('../../../domain/admin/lifecycle/adminLifecycle.audit');
const { logAdminAction } = require('../../../utils/adminAuditLogger');
const { syncAdminRoleToAuth } = require('../bootstrap/adminAuthSync');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const logger = require('../../../utils/logger');

// Mirrors the local `MASTER_ADMIN_ROLE` constant already duplicated in
// administrators.routes.js and requireMasterAdmin.middleware.js — kept
// local here rather than imported so this file has no new coupling.
const MASTER_ADMIN_ROLE = 'MASTER_ADMIN';

/**
 * Runs the existing adminAuthSync projection after a lifecycle mutation has
 * already committed, and — on failure only — records the same
 * ADMIN_AUTH_SYNC_FAILED audit event adminBootstrap.service.js already
 * writes for this exact situation. Never throws (syncAdminRoleToAuth()
 * itself never throws; logAdminAction() never throws either).
 *
 * @returns {Promise<{synchronized: boolean, error: string|null}>}
 */
async function syncAndAuditAuth(uid, role, actorId) {
  const syncResult = await syncAdminRoleToAuth(uid, role);

  if (!syncResult.synchronized) {
    void logAdminAction(
      buildLifecycleAuditEvent(AUDIT_ACTIONS.AUTH_SYNC_FAILED, actorId, uid, {
        stage: 'auth_metadata_sync',
        role,
        error: syncResult.error,
      })
    ).catch(() => {});
  }

  return syncResult;
}

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

/**
 * MASTER_ADMIN target protection (Master Admin > Admin authoritative
 * policy).
 *
 * MASTER_ADMIN is the system's highest authority and MUST NOT be treated
 * as a subordinate Administrator target. This guard closes a gap the
 * previous MASTER_ADMIN-only route placement did not: requireMasterAdmin
 * verifies who the OPERATOR is, never who the TARGET is, so without this
 * check a MASTER_ADMIN operator could suspend, reactivate, or revoke a
 * *different* MASTER_ADMIN principal through the ordinary Admin Lifecycle
 * routes — accidentally or otherwise stripping the system's highest
 * authority. This is distinct from (and in addition to) the existing
 * self-lockout guard above, which only ever compares `uid === actorId`.
 *
 * There is no separate emergency/root-level mechanism for changing
 * MASTER_ADMIN status in this codebase, so — per policy — no such
 * mechanism is introduced here. If a MASTER_ADMIN principal genuinely
 * needs to be revoked, that is out of scope for the ordinary
 * Administrator Lifecycle surface this service implements.
 *
 * Mirrors the self-lockout guard's rejection shape exactly (AppError.forbidden,
 * no repository call, no audit event) — a rejected attempt here is not a
 * new kind of event, just a different reason for the same 403.
 *
 * @param {string} uid
 * @param {string} actionLabel - past-tense verb for the error message
 *   (e.g. 'suspended', 'reactivated', 'revoked')
 */
async function assertNotMasterAdminTarget(uid, actionLabel) {
  const target = await principalRepo.getPrincipal(uid);
  if (target && target.role === MASTER_ADMIN_ROLE) {
    throw AppError.forbidden(
      `MASTER_ADMIN is the system's highest authority and cannot be ${actionLabel} through ordinary Administrator Lifecycle actions.`,
      ErrorCodes.FORBIDDEN,
      { uid, role: target.role }
    );
  }
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
  // Self-lockout guard — mirrors suspendAdministrator()/revokeAdministrator()
  // below exactly. grant() is otherwise the only lifecycle mutation in this
  // file without one: unlike suspend/revoke, it is not a no-op-safe action
  // on yourself — a MASTER_ADMIN (the only role requireMasterAdmin permits
  // to reach this route) could otherwise grant() their own uid a different
  // role and silently strip their own MASTER_ADMIN status with a single
  // call. No privilege *escalation* is possible here (the actor must
  // already hold the ceiling role to reach this endpoint at all), but this
  // closes the same self-lockout category suspend/revoke already close.
  if (uid === actorId) {
    throw AppError.forbidden(
      'You cannot change your own Administrator role.',
      ErrorCodes.FORBIDDEN,
      { uid }
    );
  }

  try {
    await principalRepo.grant(uid, role, actorId);
  } catch (err) {
    rethrowAsAppError(err);
  }
  logger.info('[AdministratorManagement] Granted Administrator access', { actorId, targetUid: uid, role });

  // Auth projection happens only after the admin_principals mutation above
  // has already succeeded — see the module doc comment for why this exists
  // and why it can never throw or block the response.
  const syncResult = await syncAndAuditAuth(uid, role, actorId);

  const detail = await getAdministrator(uid);
  return { ...detail, authSynchronized: syncResult.synchronized, authSyncError: syncResult.error };
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
  await assertNotMasterAdminTarget(uid, 'suspended');
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
  await assertNotMasterAdminTarget(uid, 'reactivated');
  try {
    await principalRepo.reactivate(uid, actorId);
  } catch (err) {
    rethrowAsAppError(err);
  }
  logger.info('[AdministratorManagement] Reactivated Administrator', { actorId, targetUid: uid });

  // reactivate() does not change `role` — it is read back from the
  // now-active principal so Auth app_metadata is re-asserted to match
  // whatever role this principal actually holds (see module doc comment).
  const principal = await principalRepo.getPrincipal(uid);
  const syncResult = principal?.role
    ? await syncAndAuditAuth(uid, principal.role, actorId)
    : { synchronized: false, error: 'Administrator principal not found after reactivation' };

  const detail = await getAdministrator(uid);
  return { ...detail, authSynchronized: syncResult.synchronized, authSyncError: syncResult.error };
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
  await assertNotMasterAdminTarget(uid, 'revoked');
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
