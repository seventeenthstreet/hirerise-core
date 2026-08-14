'use strict';

/**
 * administrators.repository.js — WP-ADMIN-05A
 *
 * Enterprise Administrator Management — Directory & Audit reads.
 *
 * This file does NOT reimplement the certified Administrator Lifecycle.
 * All lifecycle mutations (grant/suspend/reactivate/revoke) are performed
 * exclusively by ../repository/adminPrincipal.repository.js (WP-ADMIN-04F-18B)
 * — see administrators.service.js, which is the only caller of that
 * repository's write methods.
 *
 * What this file adds (the verified Phase 2 gaps — see WP-ADMIN-05A):
 *   - listPrincipals()        — paginated/searchable/filterable read across
 *                                ALL lifecycle statuses. The certified
 *                                repository only exposes listByStatus(status)
 *                                for a single status with no search and a
 *                                fixed limit(200) — there was no directory
 *                                read before this WP.
 *   - getUserProfiles(uids)   — batch-resolves display name/email for a
 *                                page of principals from public.users
 *                                (admin_principals has no email/name column
 *                                of its own; uid is a foreign reference to
 *                                public.users.id).
 *   - findUserIdsByTerm(term) — resolves a free-text search term against
 *                                public.users (email/display_name) into a
 *                                bounded set of uids, so listPrincipals()
 *                                can filter admin_principals by uid.
 *   - listLifecycleAuditEvents(uid) — read-only query against the existing,
 *                                certified `admin_logs` table (the same
 *                                table adminLifecycle.audit.js already
 *                                writes to via utils/adminAuditLogger.js).
 *                                No new audit mechanism, no new table —
 *                                this is the first reader of that data.
 *
 * No table, column, or migration is introduced. No write method is defined
 * in this file.
 */

function getSupabase() {
  return require('../../../config/supabase').supabase;
}

const PRINCIPALS_TABLE = 'admin_principals';
const USERS_TABLE = 'users';
const AUDIT_TABLE = 'admin_logs';
const AUDIT_ENTITY_TYPE = 'admin_principal';

// Bounds mirror the existing HARDENING T3 precedent in
// adminPrincipal.repository.js#listByStatus (.limit(200)) — admin counts
// are small but must never be unbounded.
const MAX_SEARCH_MATCH_UIDS = 200;
const MAX_PAGE_LIMIT = 200;

class AdministratorsRepository {
  /**
   * Paginated/searchable/filterable read across the full Administrator
   * directory (any lifecycle status).
   *
   * @param {object}  opts
   * @param {string}  [opts.status]  — restrict to one lifecycle status
   * @param {string}  [opts.search]  — matched against the linked user's
   *                                   email / display_name (case-insensitive)
   * @param {number}  [opts.limit=50]
   * @param {number}  [opts.offset=0]
   * @returns {Promise<{ items: object[], total: number }>}
   */
  async listPrincipals({ status, search, limit = 50, offset = 0 } = {}) {
    const supabase = getSupabase();
    const boundedLimit = Math.min(limit, MAX_PAGE_LIMIT);

    let matchedUids = null;
    if (search && search.trim()) {
      matchedUids = await this.findUserIdsByTerm(search.trim());
      // No user matches the search term at all — short-circuit to an
      // empty page rather than issuing a query that would (correctly)
      // return everything unfiltered.
      if (matchedUids.length === 0) {
        return { items: [], total: 0 };
      }
    }

    let q = supabase
      .from(PRINCIPALS_TABLE)
      .select('*', { count: 'exact' })
      .order('granted_at', { ascending: false })
      .range(offset, offset + boundedLimit - 1);

    if (status) {
      q = q.eq('status', status);
    }
    if (matchedUids) {
      q = q.in('uid', matchedUids);
    }

    const { data, error, count } = await q;
    if (error) throw error;

    return { items: data || [], total: count ?? 0 };
  }

  /**
   * Batch-resolve display profile (email/displayName) for a page of
   * principals. Read-only; only pre-existing public.users columns.
   *
   * @param {string[]} uids
   * @returns {Promise<Map<string, {email: string|null, displayName: string|null}>>}
   */
  async getUserProfiles(uids) {
    const map = new Map();
    if (!uids || uids.length === 0) return map;

    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(USERS_TABLE)
      .select('id, email, display_name')
      .in('id', uids);

    if (error || !data) return map;

    for (const row of data) {
      map.set(row.id, {
        email: row.email ?? null,
        displayName: row.display_name ?? null,
      });
    }
    return map;
  }

  /**
   * Resolves a free-text search term to a bounded list of public.users
   * ids whose email or display_name matches (case-insensitive).
   *
   * @param {string} term
   * @returns {Promise<string[]>}
   */
  async findUserIdsByTerm(term) {
    const supabase = getSupabase();
    const like = `%${term}%`;
    const { data, error } = await supabase
      .from(USERS_TABLE)
      .select('id')
      .or(`email.ilike.${like},display_name.ilike.${like}`)
      .limit(MAX_SEARCH_MATCH_UIDS);

    if (error || !data) return [];
    return data.map((r) => r.id);
  }

  /**
   * Read-only lifecycle audit history for one Administrator, most recent
   * first. Reads the existing, certified admin_logs table — the same one
   * adminLifecycle.audit.js / utils/adminAuditLogger.js already write to.
   * Never writes.
   *
   * @param {string} uid
   * @param {number} [limit=50]
   * @returns {Promise<object[]>}
   */
  async listLifecycleAuditEvents(uid, limit = 50) {
    if (!uid) return [];
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(AUDIT_TABLE)
      .select('*')
      .eq('entity_type', AUDIT_ENTITY_TYPE)
      .eq('entity_id', uid)
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, MAX_PAGE_LIMIT));

    if (error || !data) return [];
    return data;
  }
}

module.exports = new AdministratorsRepository();
