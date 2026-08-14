'use strict';

/**
 * adminBootstrap.service.js — WP-ADMIN-04F-18D
 *
 * Enterprise Administrator Bootstrap.
 *
 * Solves exactly one problem: securely establishing the *first* trusted
 * Administrator (MASTER_ADMIN) for a fresh HireRise deployment. It is not
 * an Administrator management API, not a promotion flow, and not a
 * replacement for the certified Administrator Lifecycle
 * (adminPrincipal.repository.js / adminLifecycle.states.js) — it is a
 * thin, one-time-use caller of that same repository.
 *
 * Design (per WP-ADMIN-04F-18D Phase 3):
 *   - Reuses adminPrincipal.repository.js's `grant()` for the actual
 *     write, so the created principal goes through the exact same
 *     lifecycle state machine (none -> ACTIVE) and the exact same
 *     ADMIN_GRANTED lifecycle audit event as any other grant. No direct
 *     database access, no bypass of `assertValidTransition`.
 *   - Adds ONE extra, additive audit event (ADMIN_BOOTSTRAPPED) purely
 *     for traceability of *how* the very first admin came to exist —
 *     it records no state and makes no decision.
 *   - Bootstrap eligibility ("has this deployment already been
 *     bootstrapped?") is decided by asking the repository whether ANY
 *     active Administrator already exists — not by a separate
 *     bootstrap-only flag/table. This is deliberate: it means bootstrap
 *     is inherently a no-op (never overwrites, never resurrects) the
 *     moment a first Administrator exists, without introducing new
 *     bootstrap-specific state that could itself drift from reality.
 *   - A row already existing for the target uid (in ANY status —
 *     including suspended/revoked/expired) also blocks bootstrap. Those
 *     are lifecycle decisions (reactivate/grant-by-an-admin) for an
 *     authenticated Administrator to make deliberately, not something a
 *     one-time deployment script should do on their behalf.
 */

const repository = require('../../../modules/admin/repository/adminPrincipal.repository');
const { logAdminAction } = require('../../../utils/adminAuditLogger');
const {
  ACTIONS: AUDIT_ACTIONS,
  buildLifecycleAuditEvent,
} = require('../../../domain/admin/lifecycle/adminLifecycle.audit');

const MASTER_ADMIN_ROLE = 'MASTER_ADMIN';
const BOOTSTRAP_ACTOR = 'system:bootstrap';

class BootstrapAlreadyCompletedError extends Error {
  constructor(reason) {
    super(`Administrator bootstrap refused: ${reason}`);
    this.name = 'BootstrapAlreadyCompletedError';
    this.reason = reason;
  }
}

class BootstrapInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BootstrapInputError';
  }
}

/**
 * Determine whether bootstrap is currently eligible to run.
 *
 * @param {string} uid - target uid for the Administrator being bootstrapped
 * @returns {Promise<{eligible: boolean, reason?: string}>}
 */
async function checkEligibility(uid) {
  if (!uid || typeof uid !== 'string') {
    throw new BootstrapInputError('A target uid is required to bootstrap an Administrator.');
  }

  // Deployment-level guard: bootstrap only ever creates the FIRST
  // Administrator. If any Administrator is already active, this
  // deployment has already been bootstrapped (or has grown organically
  // past that point) — bootstrap must never silently overwrite that.
  const activePrincipals = await repository.listActive();
  if (activePrincipals.length > 0) {
    return {
      eligible: false,
      reason: `${activePrincipals.length} active Administrator(s) already exist. Use the certified Administrator Lifecycle (grant) to add more.`,
    };
  }

  // Target-uid guard: never resurrect/repurpose an existing row
  // (suspended/revoked/expired) via bootstrap. That is a deliberate
  // lifecycle action for an authenticated Administrator, not a
  // one-time deployment script.
  const existing = await repository.getPrincipal(uid);
  if (existing) {
    return {
      eligible: false,
      reason: `An admin_principals row already exists for this uid (status: ${existing.status}). Use the certified Administrator Lifecycle instead of bootstrap.`,
    };
  }

  return { eligible: true };
}

/**
 * Bootstrap the first Administrator for a fresh deployment.
 *
 * @param {{ uid: string, email?: string|null }} params
 * @returns {Promise<{ success: true, uid: string, role: string }>}
 * @throws {BootstrapInputError} invalid input
 * @throws {BootstrapAlreadyCompletedError} bootstrap is not eligible to run
 */
async function bootstrapMasterAdmin({ uid, email = null }) {
  const eligibility = await checkEligibility(uid);
  if (!eligibility.eligible) {
    throw new BootstrapAlreadyCompletedError(eligibility.reason);
  }

  // The actual write: identical repository call any certified caller of
  // grant() would make. This is what produces the lifecycle-state
  // transition and the standard ADMIN_GRANTED audit event.
  await repository.grant(uid, MASTER_ADMIN_ROLE, BOOTSTRAP_ACTOR);

  // Additive, bootstrap-specific audit trail entry (see file header).
  // Never blocks or reverses the grant above — matches the existing
  // fail-open-on-audit convention used throughout this repository.
  await logAdminAction(
    buildLifecycleAuditEvent(AUDIT_ACTIONS.BOOTSTRAPPED, BOOTSTRAP_ACTOR, uid, {
      email,
      role: MASTER_ADMIN_ROLE,
    })
  ).catch(() => {});

  return { success: true, uid, role: MASTER_ADMIN_ROLE };
}

module.exports = {
  bootstrapMasterAdmin,
  checkEligibility,
  BootstrapAlreadyCompletedError,
  BootstrapInputError,
};
