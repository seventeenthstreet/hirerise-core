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
 *   - Bootstrap eligibility ("has this deployment already established its
 *     first MASTER_ADMIN?") is decided by asking the repository whether an
 *     active MASTER_ADMIN already exists (WP-ADMIN-IMP-07 — corrected from
 *     the prior "ANY active Administrator" check; see that method's doc
 *     comment for why this is a distinct, fail-closed query rather than a
 *     filter over listActive()). This is deliberate: it means bootstrap is
 *     inherently a no-op (never overwrites, never resurrects) the moment a
 *     first MASTER_ADMIN exists, without introducing new bootstrap-specific
 *     state that could itself drift from reality, and it no longer treats
 *     the pre-existing presence of ordinary ADMIN principals as a reason to
 *     refuse establishing the first MASTER_ADMIN.
 *   - A row already existing for the target uid (in ANY status —
 *     including suspended/revoked/expired) also blocks bootstrap. Those
 *     are lifecycle decisions (reactivate/grant-by-an-admin) for an
 *     authenticated Administrator to make deliberately, not something a
 *     one-time deployment script should do on their behalf.
 *   - Concurrency (WP-ADMIN-IMP-07 §8): eligibility is checked before the
 *     write, but two bootstrap processes racing each other could both pass
 *     that check before either writes. The database enforces the true
 *     invariant (see migration
 *     20260824010000_wp_admin_imp_07_master_admin_bootstrap.sql — a partial
 *     unique index allowing at most one row with role='MASTER_ADMIN' AND
 *     status='active'); the loser's insert/update is rejected by Postgres
 *     with a unique_violation, which this module maps back to
 *     BootstrapAlreadyCompletedError rather than letting a raw DB error
 *     surface. Application-level eligibility remains the fast, common-case
 *     check — the DB constraint is the actual safety guarantee.
 *   - Authority synchronization (WP-ADMIN-IMP-07 §10): after the DB write
 *     succeeds, the granted role is projected onto the target Auth user's
 *     app_metadata via adminAuthSync.js so the new MASTER_ADMIN's JWT
 *     actually carries the claim after their next session refresh. A
 *     synchronization failure does NOT undo or fail the bootstrap (the DB
 *     authority record is already correct and canonical) — it is reported
 *     back explicitly via the `authSynchronized` / `authSyncError` fields
 *     and recorded in the audit trail, never silently swallowed as success
 *     (WP-ADMIN-IMP-07 §12).
 */

const repository = require('../../../modules/admin/repository/adminPrincipal.repository');
const { syncAdminRoleToAuth } = require('./adminAuthSync');
const { logAdminAction } = require('../../../utils/adminAuditLogger');
const {
  ACTIONS: AUDIT_ACTIONS,
  buildLifecycleAuditEvent,
} = require('../../../domain/admin/lifecycle/adminLifecycle.audit');

const MASTER_ADMIN_ROLE = 'MASTER_ADMIN';
const BOOTSTRAP_ACTOR = 'system:bootstrap';

// Postgres unique_violation SQLSTATE — raised by the partial unique index
// (see migration referenced above) when a second concurrent bootstrap
// attempt loses the race after both passed the application-level
// eligibility check.
const PG_UNIQUE_VIOLATION = '23505';

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
  // MASTER_ADMIN. If one is already active, this deployment has already
  // been bootstrapped — bootstrap must never silently overwrite that.
  // WP-ADMIN-IMP-07: this is deliberately scoped to MASTER_ADMIN, not
  // "any active Administrator" — a deployment can have active ADMIN
  // principals (e.g. granted before this fix, or otherwise) with no
  // MASTER_ADMIN at all (the exact deadlock this work package resolves),
  // and that must remain bootstrap-eligible.
  const masterAdminExists = await repository.hasActiveMasterAdmin();
  if (masterAdminExists) {
    return {
      eligible: false,
      reason: 'An active MASTER_ADMIN already exists. Use the certified Administrator Lifecycle (grant) to add more Administrators.',
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
  //
  // WP-ADMIN-IMP-07 §8 concurrency: two bootstrap processes can both pass
  // the eligibility check above before either writes. The database-level
  // partial unique index (see migration referenced in the file header) is
  // the actual safety guarantee — it allows only one row with
  // role='MASTER_ADMIN' AND status='active' to exist. The loser of that
  // race gets a Postgres unique_violation here, which is mapped to the
  // same BootstrapAlreadyCompletedError an eligibility-check failure
  // would produce, so callers see one consistent, safe outcome either
  // way rather than a raw 500-style DB error.
  try {
    await repository.grant(uid, MASTER_ADMIN_ROLE, BOOTSTRAP_ACTOR);
  } catch (err) {
    if (err?.code === PG_UNIQUE_VIOLATION) {
      throw new BootstrapAlreadyCompletedError(
        'Another bootstrap attempt established the MASTER_ADMIN concurrently. This attempt was safely rejected.'
      );
    }
    throw err;
  }

  // Additive, bootstrap-specific audit trail entry (see file header).
  // Never blocks or reverses the grant above — matches the existing
  // fail-open-on-audit convention used throughout this repository.
  await logAdminAction(
    buildLifecycleAuditEvent(AUDIT_ACTIONS.BOOTSTRAPPED, BOOTSTRAP_ACTOR, uid, {
      email,
      role: MASTER_ADMIN_ROLE,
    })
  ).catch(() => {});

  // WP-ADMIN-IMP-07 §10/§12 — project the newly established authority
  // onto Auth app_metadata. This runs strictly AFTER the DB write above
  // has already committed: admin_principals is authoritative regardless
  // of whether this projection succeeds. A failure here is never
  // swallowed or reported as success — it is surfaced on the return
  // value (so the CLI reports it and exits informatively) and recorded
  // as its own audit event, distinct from ADMIN_BOOTSTRAPPED, so the
  // audit trail can show "authority established" and "authority
  // synchronized to Auth" as two separately verifiable facts.
  const syncResult = await syncAdminRoleToAuth(uid, MASTER_ADMIN_ROLE);

  if (!syncResult.synchronized) {
    await logAdminAction(
      buildLifecycleAuditEvent(AUDIT_ACTIONS.AUTH_SYNC_FAILED, BOOTSTRAP_ACTOR, uid, {
        stage: 'auth_metadata_sync',
        role: MASTER_ADMIN_ROLE,
        error: syncResult.error,
      })
    ).catch(() => {});
  }

  return {
    success: true,
    uid,
    role: MASTER_ADMIN_ROLE,
    authSynchronized: syncResult.synchronized,
    authSyncError: syncResult.error,
  };
}

module.exports = {
  bootstrapMasterAdmin,
  checkEligibility,
  BootstrapAlreadyCompletedError,
  BootstrapInputError,
};
