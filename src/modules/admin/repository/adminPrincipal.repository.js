'use strict';

/**
 * adminPrincipal.repository.js — Admin Principals (Supabase)
 *
 * Two-factor admin verification store, now lifecycle-aware
 * (WP-ADMIN-04F-18B). Every admin must have a row in admin_principals
 * whose lifecycle `status` is 'active' and whose verifiedAt was
 * refreshed within the last 24 hours.
 *
 * Lifecycle states: active | suspended | revoked | expired
 * (see src/domain/admin/lifecycle/adminLifecycle.states.js for the
 * authoritative state machine).
 *
 * Methods:
 *   verify(uid)                       → principal | null  (active + fresh + not expired)
 *   refreshSession(uid)               → upserts the principal, resets verifiedAt
 *   recordAction(uid)                 → updates lastActionAt (non-blocking)
 *   grant(uid, role, grantedBy)       → creates / re-activates a principal (-> active)
 *   suspend(uid, suspendedBy, reason) → active -> suspended
 *   reactivate(uid, reactivatedBy)    → suspended -> active
 *   revoke(uid, revokedBy)            → active|suspended -> revoked
 *   expire(uid)                       → active|suspended -> expired (system-initiated)
 *   getPrincipal(uid)                 → raw row | null
 *   listActive()                      → returns all active principals
 *   listByStatus(status)              → returns principals in a given lifecycle state
 *
 * BUGFIX (WP-ADMIN-04F-18B): getSupabase() previously returned the whole
 * config/supabase.js exports object ({ supabase, getClient, withRetry,
 * verifyConnection }) rather than the Supabase client itself, so every
 * `supabase.from(...)` call in this file threw `supabase.from is not a
 * function` at runtime. This was a pre-existing defect unrelated to the
 * lifecycle model; it is fixed here because lifecycle enforcement cannot
 * be verified against a repository that cannot reach the database. No
 * other behavior of getSupabase()'s callers was changed.
 */

require('dotenv').config();

const {
  STATES,
  assertValidTransition,
  InvalidLifecycleTransitionError,
} = require('../../../domain/admin/lifecycle/adminLifecycle.states');
const {
  ACTIONS: AUDIT_ACTIONS,
  buildLifecycleAuditEvent,
} = require('../../../domain/admin/lifecycle/adminLifecycle.audit');
const { logAdminAction } = require('../../../utils/adminAuditLogger');

/**
 * Fire-and-forget lifecycle audit write (WP-ADMIN-04F-18C).
 *
 * Mirrors the existing repository-layer convention already used elsewhere
 * in this codebase (see adminUsers.service.js#updateUserRole): the
 * lifecycle mutation has already been committed by the time this is
 * called, and logAdminAction() never throws — so a persistence failure in
 * the audit trail can never fail, block, retry, or reverse the lifecycle
 * operation itself, and can never grant or preserve Administrator access.
 * This is an intentional fail-open-on-audit / fail-closed-on-authorization
 * design: authorization already happened via the (already-tested)
 * lifecycle state machine before this line is ever reached.
 */
function emitLifecycleAudit(action, actorId, targetUid, metadata) {
  // logAdminAction() already catches its own errors internally and never
  // rejects by contract; the extra .catch() below is a defense-in-depth
  // safety net only (e.g. against an unhandled promise rejection if that
  // contract is ever violated upstream) — it does not change, retry, or
  // surface audit failures, matching the fail-open-on-audit behaviour
  // documented above.
  void logAdminAction(buildLifecycleAuditEvent(action, actorId, targetUid, metadata)).catch(() => {});
}

function getSupabase() {
  // BUGFIX: config/supabase.js exports { supabase, getClient, ... } — the
  // client itself lives on the `supabase` property, not on the module's
  // top-level exports object.
  return require('../../../config/supabase').supabase;
}

const TABLE = 'admin_principals';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

class AdminPrincipalRepository {

  /**
   * Fetch the raw principal row (any lifecycle status), or null.
   */
  async getPrincipal(uid) {
    if (!uid) return null;
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('uid', uid)
      .maybeSingle();

    if (error || !data) return null;
    return data;
  }

  /**
   * Verify an admin session.
   * Returns the principal if status='active', the session is fresh,
   * and (if set) expires_at has not passed. Lazily transitions a
   * past-expiry principal to 'expired' before returning null.
   * MASTER_ADMIN bypasses the 24h TTL check but NOT lifecycle status.
   */
  async verify(uid) {
    if (!uid) return null;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('uid', uid)
      .maybeSingle();

    if (error || !data) return null;

    // Lazy expiry: if expires_at has passed on an otherwise-live
    // principal, transition it to 'expired' and fail verification.
    if (
      (data.status === STATES.ACTIVE || data.status === STATES.SUSPENDED) &&
      data.expires_at &&
      new Date(data.expires_at).getTime() <= Date.now()
    ) {
      await this.expire(uid).catch(() => {});
      return null;
    }

    if (data.status !== STATES.ACTIVE) return null;

    // MASTER_ADMIN always passes (no session TTL)
    if (data.role === 'MASTER_ADMIN') return data;

    // Check 24h TTL on verified_at
    const verifiedAt = data.verified_at ? new Date(data.verified_at).getTime() : 0;
    if (Date.now() - verifiedAt > SESSION_TTL_MS) return null;

    return data;
  }

  /**
   * Refresh (or create) an admin session.
   * Sets verified_at = now, status = active.
   * Auto-provisions the record if it doesn't exist yet.
   */
  async refreshSession(uid) {
    if (!uid) throw new Error('uid is required');

    const supabase = getSupabase();
    const now = new Date().toISOString();

    const { data: existing } = await supabase
      .from(TABLE)
      .select('uid, role, status')
      .eq('uid', uid)
      .maybeSingle();

    if (existing) {
      // Refreshing a session does not resurrect a suspended/revoked/
      // expired principal — that requires an explicit lifecycle action.
      if (existing.status && existing.status !== STATES.ACTIVE) {
        return;
      }

      await supabase
        .from(TABLE)
        .update({ verified_at: now, last_action_at: now, status: STATES.ACTIVE })
        .eq('uid', uid);

      emitLifecycleAudit(AUDIT_ACTIONS.SESSION_REFRESHED, uid, uid, {
        autoProvisioned: false,
      });
    } else {
      // Auto-provision — role defaults to 'admin' until explicitly granted
      await supabase.from(TABLE).insert({
        uid,
        role:           'admin',
        granted_by:     'auto_provision',
        granted_at:     now,
        verified_at:    now,
        last_action_at: now,
        status:         STATES.ACTIVE,
      });

      emitLifecycleAudit(AUDIT_ACTIONS.SESSION_REFRESHED, uid, uid, {
        autoProvisioned: true,
      });
    }
  }

  /**
   * Update last_action_at — call non-blocking via setImmediate.
   */
  async recordAction(uid) {
    if (!uid) return;
    const supabase = getSupabase();
    await supabase
      .from(TABLE)
      .update({ last_action_at: new Date().toISOString() })
      .eq('uid', uid);
  }

  /**
   * Grant admin access to a user (MASTER_ADMIN only).
   * Creates or re-activates the principal. Valid from any status,
   * including no existing row (see adminLifecycle.states ACTIONS.grant).
   */
  async grant(uid, role, grantedBy) {
    if (!uid || !role) throw new Error('uid and role are required');

    const supabase = getSupabase();
    const now = new Date().toISOString();

    const existing = await this.getPrincipal(uid);
    assertValidTransition(existing?.status ?? null, 'grant');

    // WP-ADMIN-04F-18C: a grant onto an existing principal whose role is
    // actually changing is audited as a role change, not a grant, even
    // though the underlying state-machine transition (-> ACTIVE) and the
    // repository write are identical. This does not change lifecycle
    // behaviour — it only changes which audit action name is recorded.
    const isRoleChange = Boolean(existing) && existing.role !== role;

    if (existing) {
      await supabase
        .from(TABLE)
        .update({
          role,
          status:            STATES.ACTIVE,
          granted_by:        grantedBy,
          granted_at:        now,
          verified_at:       now,
          last_action_at:    now,
          revoked_at:        null,
          revoked_by:        null,
          suspended_at:      null,
          suspended_by:      null,
          suspension_reason: null,
          reactivated_at:    existing.status === STATES.SUSPENDED ? now : existing.reactivated_at,
          reactivated_by:    existing.status === STATES.SUSPENDED ? grantedBy : existing.reactivated_by,
          expires_at:        null,
        })
        .eq('uid', uid);
    } else {
      await supabase.from(TABLE).insert({
        uid,
        role,
        status:         STATES.ACTIVE,
        granted_by:     grantedBy,
        granted_at:     now,
        verified_at:    now,
        last_action_at: now,
      });
    }

    emitLifecycleAudit(
      isRoleChange ? AUDIT_ACTIONS.ROLE_CHANGED : AUDIT_ACTIONS.GRANTED,
      grantedBy,
      uid,
      {
        previousStatus: existing?.status ?? null,
        newStatus: STATES.ACTIVE,
        previousRole: existing?.role ?? null,
        newRole: role,
      }
    );
  }

  /**
   * Suspend admin access — active -> suspended. Reversible via reactivate().
   */
  async suspend(uid, suspendedBy, reason = null) {
    if (!uid) throw new Error('uid is required');
    if (!suspendedBy) throw new Error('suspendedBy is required');

    const existing = await this.getPrincipal(uid);
    if (!existing) {
      throw new InvalidLifecycleTransitionError('suspend', null);
    }
    assertValidTransition(existing.status, 'suspend');

    const supabase = getSupabase();
    const now = new Date().toISOString();

    await supabase
      .from(TABLE)
      .update({
        status:            STATES.SUSPENDED,
        suspended_at:      now,
        suspended_by:      suspendedBy,
        suspension_reason: reason,
        last_action_at:    now,
      })
      .eq('uid', uid);

    emitLifecycleAudit(AUDIT_ACTIONS.SUSPENDED, suspendedBy, uid, {
      previousStatus: existing.status,
      newStatus: STATES.SUSPENDED,
      reason,
    });
  }

  /**
   * Reactivate a suspended admin — suspended -> active.
   */
  async reactivate(uid, reactivatedBy) {
    if (!uid) throw new Error('uid is required');
    if (!reactivatedBy) throw new Error('reactivatedBy is required');

    const existing = await this.getPrincipal(uid);
    if (!existing) {
      throw new InvalidLifecycleTransitionError('reactivate', null);
    }
    assertValidTransition(existing.status, 'reactivate');

    const supabase = getSupabase();
    const now = new Date().toISOString();

    await supabase
      .from(TABLE)
      .update({
        status:            STATES.ACTIVE,
        reactivated_at:    now,
        reactivated_by:    reactivatedBy,
        suspended_at:      null,
        suspended_by:      null,
        suspension_reason: null,
        verified_at:       now,
        last_action_at:    now,
      })
      .eq('uid', uid);

    emitLifecycleAudit(AUDIT_ACTIONS.REACTIVATED, reactivatedBy, uid, {
      previousStatus: existing.status,
      newStatus: STATES.ACTIVE,
    });
  }

  /**
   * Revoke admin access — active|suspended -> revoked. Terminal.
   */
  async revoke(uid, revokedBy) {
    if (!uid) throw new Error('uid is required');

    const existing = await this.getPrincipal(uid);
    if (!existing) {
      throw new InvalidLifecycleTransitionError('revoke', null);
    }
    assertValidTransition(existing.status, 'revoke');

    const supabase = getSupabase();
    const now = new Date().toISOString();

    await supabase
      .from(TABLE)
      .update({
        status:         STATES.REVOKED,
        revoked_at:     now,
        revoked_by:     revokedBy,
        last_action_at: now,
      })
      .eq('uid', uid);

    emitLifecycleAudit(AUDIT_ACTIONS.REVOKED, revokedBy, uid, {
      previousStatus: existing.status,
      newStatus: STATES.REVOKED,
    });
  }

  /**
   * Expire admin access — active|suspended -> expired. Terminal.
   * System-initiated (called from verify() when expires_at has passed,
   * or from a scheduled sweep); revokedBy semantics do not apply.
   */
  async expire(uid, { expiryReason = 'expires_at_passed' } = {}) {
    if (!uid) throw new Error('uid is required');

    const existing = await this.getPrincipal(uid);
    if (!existing) {
      throw new InvalidLifecycleTransitionError('expire', null);
    }
    assertValidTransition(existing.status, 'expire');

    const supabase = getSupabase();
    const now = new Date().toISOString();

    await supabase
      .from(TABLE)
      .update({
        status:         STATES.EXPIRED,
        last_action_at: now,
      })
      .eq('uid', uid);

    // System-initiated by default (called from verify() on lazy expiry,
    // or a future scheduled sweep) — there is no human "expiredBy" actor
    // for this transition, matching the existing docstring/semantics.
    emitLifecycleAudit(AUDIT_ACTIONS.EXPIRED, 'system', uid, {
      previousStatus: existing.status,
      newStatus: STATES.EXPIRED,
      expiryReason,
    });
  }

  /**
   * List all active admin principals.
   */
  async listActive() {
    return this.listByStatus(STATES.ACTIVE);
  }

  /**
   * List all admin principals in a given lifecycle state.
   */
  async listByStatus(status) {
    const supabase = getSupabase();
    // HARDENING T3: added .limit(200) — admin count is bounded but must not be unbounded
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('status', status)
      .order('granted_at', { ascending: false })
      .limit(200);

    if (error) return [];
    return data || [];
  }
}

module.exports = new AdminPrincipalRepository();
