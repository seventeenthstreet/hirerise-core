'use strict';

/**
 * adminPrincipal.repository.js — Admin Principals (Supabase)
 *
 * Two-factor admin verification store.
 * Every admin must have an active row in the admin_principals table
 * with verifiedAt refreshed within the last 24 hours.
 *
 * Methods:
 *   verify(uid)                 → principal | null  (checks isActive + 24h TTL)
 *   refreshSession(uid)         → upserts the principal, resets verifiedAt
 *   recordAction(uid)           → updates lastActionAt (non-blocking)
 *   grant(uid, role, grantedBy) → creates / re-activates a principal
 *   revoke(uid, revokedBy)      → sets isActive = false
 *   listActive()                → returns all active principals
 */

require('dotenv').config();

function getSupabase() {
  return require('../../../core/supabaseClient');
}

const TABLE = 'admin_principals';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

class AdminPrincipalRepository {

  /**
   * Verify an admin session.
   * Returns the principal if the user is active and session is fresh.
   * MASTER_ADMIN bypasses the 24h TTL check.
   */
  async verify(uid) {
    if (!uid) return null;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('uid', uid)
      .eq('is_active', true)
      .maybeSingle();

    if (error || !data) return null;

    // MASTER_ADMIN always passes (no session TTL)
    if (data.role === 'MASTER_ADMIN') return data;

    // Check 24h TTL on verified_at
    const verifiedAt = data.verified_at ? new Date(data.verified_at).getTime() : 0;
    if (Date.now() - verifiedAt > SESSION_TTL_MS) return null;

    return data;
  }

  /**
   * Refresh (or create) an admin session.
   * Sets verified_at = now, is_active = true.
   * Auto-provisions the record if it doesn't exist yet.
   */
  async refreshSession(uid) {
    if (!uid) throw new Error('uid is required');

    const supabase = getSupabase();
    const now = new Date().toISOString();

    const { data: existing } = await supabase
      .from(TABLE)
      .select('uid, role')
      .eq('uid', uid)
      .maybeSingle();

    if (existing) {
      await supabase
        .from(TABLE)
        .update({ verified_at: now, last_action_at: now, is_active: true })
        .eq('uid', uid);
    } else {
      // Auto-provision — role defaults to 'admin' until explicitly granted
      await supabase.from(TABLE).insert({
        uid,
        role:           'admin',
        granted_by:     'auto_provision',
        granted_at:     now,
        verified_at:    now,
        last_action_at: now,
        is_active:      true,
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
   * Creates or re-activates the principal.
   */
  async grant(uid, role, grantedBy) {
    if (!uid || !role) throw new Error('uid and role are required');

    const supabase = getSupabase();
    const now = new Date().toISOString();

    const { data: existing } = await supabase
      .from(TABLE)
      .select('uid')
      .eq('uid', uid)
      .maybeSingle();

    if (existing) {
      await supabase
        .from(TABLE)
        .update({
          role,
          is_active:      true,
          granted_by:     grantedBy,
          granted_at:     now,
          verified_at:    now,
          last_action_at: now,
        })
        .eq('uid', uid);
    } else {
      await supabase.from(TABLE).insert({
        uid,
        role,
        granted_by:     grantedBy,
        granted_at:     now,
        verified_at:    now,
        last_action_at: now,
        is_active:      true,
      });
    }
  }

  /**
   * Revoke admin access — sets is_active = false.
   */
  async revoke(uid, revokedBy) {
    if (!uid) throw new Error('uid is required');
    const supabase = getSupabase();
    await supabase
      .from(TABLE)
      .update({ is_active: false, last_action_at: new Date().toISOString() })
      .eq('uid', uid);
  }

  /**
   * List all active admin principals.
   */
  async listActive() {
    const supabase = getSupabase();
    // HARDENING T3: added .limit(200) — admin count is bounded but must not be unbounded
    const { data, error } = await supabase
      .from(TABLE)
      .select('*')
      .eq('is_active', true)
      .order('granted_at', { ascending: false })
      .limit(200);

    if (error) return [];
    return data || [];
  }
}

module.exports = new AdminPrincipalRepository();