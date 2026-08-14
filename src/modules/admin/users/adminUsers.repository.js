'use strict';

/**
 * adminUsers.repository.js — Admin User Directory (read-only, Supabase)
 *
 * WP-ADMIN-04 Phase 1B
 *
 * Reads from the existing `public.users` table only. No new tables or
 * columns are introduced.
 *
 * Pattern note: this mirrors src/modules/admin/cms/skills/adminCmsSkills.repository.js
 * (list() with search/offset/count, findById()) rather than extending
 * BaseRepository, because:
 *   - BaseRepository.find() has no ILIKE/OR search capability
 *   - BaseRepository always filters `.eq('soft_deleted', false)` unless
 *     `includeDeleted` is passed, but `public.users` has no `soft_deleted`
 *     column (confirmed against supabase/migrations/000_initial_schema.sql)
 *   - Per WP-ADMIN-04 Phase 1A audit, the CMS admin repositories are the
 *     established precedent for this exact shape of feature (admin list +
 *     search + detail), so this file follows that precedent rather than
 *     adding new capabilities to BaseRepository itself.
 *
 * WP-ADMIN-04C — Profile Enrichment (detail view only):
 *   DETAIL_COLUMNS now additionally selects user_type, career_goal,
 *   target_role, experience_years, industry, location and updated_at —
 *   all pre-existing columns on public.users (confirmed against
 *   supabase/migrations/000_initial_schema.sql, see the WP-ADMIN-04C
 *   Phase 1 repository audit). No new table, column, or migration.
 *   LIST_COLUMNS is intentionally left unchanged — the directory list view
 *   stays lean per the WP-ADMIN-04 Phase 1B precedent; only findById()'s
 *   payload grows.
 *
 * WP-ADMIN-04E — Role Management Foundation:
 *   Adds updateRole(id, role), the first write path on this repository.
 *   Mirrors modules/admin/cms/skills/adminCmsSkills.repository.js's
 *   updateSkill() shape (update by id, .select(...).single() the row back,
 *   map through the existing camelCase mapper) rather than introducing a
 *   new update pattern. `role` is validated against ROLES at the route
 *   layer (express-validator `isIn`, see adminUsers.routes.js) before this
 *   method is ever called; `public.users`' own `users_role_check` CHECK
 *   constraint (supabase/migrations/000_initial_schema.sql) is the
 *   authoritative second line of defense against an invalid value reaching
 *   the database.
 *
 * WP-ADMIN-COMP-04 — Edit Profile + Account Status + Audit History:
 *   Adds three read/write surfaces, all against already-certified sources —
 *   no new table, no new column, no new audit mechanism.
 *
 *   - updateProfile(id, fields): writes a fixed allow-list of pre-existing,
 *     application-level public.users columns (see PROFILE_FIELDS below).
 *     Deliberately excludes user_type (owned by the student/professional
 *     onboarding domains, not User Administration) and anything
 *     Auth-related.
 *
 *   - getAuthState(id) / setAccountStatus(id, action): public.users.id is
 *     confirmed (via the existing RLS policy "Users can access their own
 *     data" ON public.users USING (auth.uid() = id), see
 *     000_initial_schema.sql) to equal the Supabase Auth user id, so this
 *     id is used directly against supabase.auth.admin.*. This is the same
 *     privileged, server-side-only Admin Auth API already used by
 *     routes/admin/adminContributors.routes.js (db.auth.admin.updateUserById)
 *     and modules/school/services/school.service.js. public.users has no
 *     status/locked/disabled column (confirmed against the full table
 *     definition in 000_initial_schema.sql) and none is added here —
 *     Supabase Auth's banned_until remains the single authoritative
 *     account-status mechanism. There is intentionally no separate "lock"
 *     primitive — see the WP-ADMIN-COMP-04 Completion Report for why a
 *     second, parallel status concept was rejected rather than built.
 *
 *   - listAuditHistory(id): read-only reader of the existing, certified
 *     admin_logs table, mirroring administrators.repository.js's
 *     listLifecycleAuditEvents(uid) / permissionHistory.repository.js's
 *     reader, applied to entity_type = 'user' (the entity_type
 *     adminUsers.service.js's role-update audit write already uses).
 */

// WP-ADMIN-04E — the full set of values public.users.role accepts, per its
// `users_role_check` CHECK constraint. Single source of truth for role
// validation on this route — see adminUsers.routes.js `isIn(ROLES)`.
const ROLES = Object.freeze(['user', 'admin', 'super_admin', 'MASTER_ADMIN', 'contributor']);

function getSupabase() { return require('../../../config/supabase').supabase; }

const TABLE = 'users';
const AUDIT_TABLE = 'admin_logs';
const AUDIT_ENTITY_TYPE = 'user';
// Mirrors administrators.repository.js's MAX_PAGE_LIMIT precedent.
const MAX_AUDIT_PAGE_LIMIT = 200;

// WP-ADMIN-COMP-04 — Edit Profile allow-list. Every entry is a pre-existing
// public.users column already exposed read-only via DETAIL_COLUMNS above.
// display_name lives on the Identity card, not the Profile card, but is the
// same column and the same "application-level" classification, so it is
// included. user_type is intentionally excluded — see module doc comment.
const PROFILE_FIELDS = Object.freeze([
  'display_name',
  'career_goal',
  'target_role',
  'experience_years',
  'industry',
  'location',
]);

// Only columns that exist on public.users and are safe/appropriate to
// expose in an admin directory. Never select '*' here.
const LIST_COLUMNS = 'id, email, display_name, role, created_at';
const DETAIL_COLUMNS =
  'id, email, display_name, role, created_at, updated_at, ' +
  'user_type, career_goal, target_role, experience_years, industry, location';

class AdminUsersRepository {
  /**
   * @param {object}  opts
   * @param {string}  [opts.search]  — matched against email and display_name
   *                                   via case-insensitive OR (ILIKE)
   * @param {number}  [opts.limit=50]
   * @param {number}  [opts.offset=0]
   * @returns {Promise<{ items: object[], total: number }>}
   */
  async list({ search, limit = 50, offset = 0 } = {}) {
    const supabase = getSupabase();

    // select(..., { count: 'exact' }) so total reflects the full filtered
    // set, not just the current page — mirrors adminCmsSkills.repository.list().
    let q = supabase
      .from(TABLE)
      .select(LIST_COLUMNS, { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (search) {
      const term = search.trim();
      if (term) {
        const like = `%${term}%`;
        q = q.or(`email.ilike.${like},display_name.ilike.${like}`);
      }
    }

    const { data, error, count } = await q;
    if (error) throw error;

    return {
      items: (data || []).map((r) => this._toCamel(r)),
      total: count ?? 0,
    };
  }

  async findById(id) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(TABLE)
      .select(DETAIL_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error) throw error;
    return data ? this._toCamelDetail(data) : null;
  }

  // WP-ADMIN-04E — updates public.users.role only. Mirrors
  // adminCmsSkills.repository.updateSkill()'s update-by-id +
  // .select(...).single() shape. Returns null if no row matched id (caller
  // maps that to a 404, same convention as findById()).
  async updateRole(id, role) {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(TABLE)
      .update({ role, updated_at: new Date().toISOString() })
      .eq('id', id)
      .select(DETAIL_COLUMNS)
      .maybeSingle();

    if (error) throw error;
    return data ? this._toCamelDetail(data) : null;
  }

  // WP-ADMIN-COMP-04 — Edit Profile. Writes only PROFILE_FIELDS; any other
  // key on `fields` is dropped before it ever reaches the query, so this
  // method itself is a second line of defense behind the route-layer
  // whitelist validator (adminUsers.routes.js). Same update-by-id +
  // .select(...).single() shape as updateRole() above.
  async updateProfile(id, fields = {}) {
    const supabase = getSupabase();
    const patch = { updated_at: new Date().toISOString() };
    for (const key of PROFILE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        patch[key] = fields[key];
      }
    }

    const { data, error } = await supabase
      .from(TABLE)
      .update(patch)
      .eq('id', id)
      .select(DETAIL_COLUMNS)
      .maybeSingle();

    if (error) throw error;
    return data ? this._toCamelDetail(data) : null;
  }

  // WP-ADMIN-COMP-04 — reads the authoritative Supabase Auth record for
  // this user. public.users.id === auth user id (see module doc comment),
  // so no join/lookup table is needed. Returns null if Supabase Auth has
  // no matching user (e.g. row was created out-of-band and never signed
  // up) — callers treat that the same as "no auth data available", not an
  // error, mirroring the existing null-="Unavailable" contract this page
  // already uses for every other Auth-sourced field.
  async getAuthState(id) {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.admin.getUserById(id);

    // Supabase returns an error (not just a null user) for an id with no
    // matching auth user — treat that as "unavailable", not a 500, since
    // it is an expected state for orphaned/legacy rows, not a failure.
    if (error || !data?.user) return null;

    const u = data.user;
    const isBanned = Boolean(u.banned_until) && new Date(u.banned_until).getTime() > Date.now();

    return {
      accountStatus: isBanned ? 'disabled' : 'active',
      authenticationProvider: u.app_metadata?.provider ?? u.identities?.[0]?.provider ?? null,
      lastLogin: u.last_sign_in_at ?? null,
      bannedUntil: u.banned_until ?? null,
    };
  }

  // WP-ADMIN-COMP-04 — Enable/Disable Account. The single authoritative
  // account-status mutation, against Supabase Auth's own `banned_until`
  // (via auth.admin.updateUserById) — there is no application-level status
  // column to keep in sync (see module doc comment on why a second status
  // system was deliberately not built). `action` is validated to be
  // 'enable' | 'disable' at the route layer before this is called.
  //
  // Disabling also revokes the user's current sessions
  // (auth.admin.signOut) so a ban takes effect immediately rather than
  // only on the next token refresh — this is what makes "the UI status
  // must reflect the actual enforcement layer" (WP §12) true rather than
  // eventually-true.
  async setAccountStatus(id, action) {
    const supabase = getSupabase();

    // A ~100 year ban is Supabase's own documented idiom for "indefinite"
    // (there is no dedicated permanent-ban value in the Admin Auth API).
    const banPatch = action === 'disable' ? { ban_duration: '876000h' } : { ban_duration: 'none' };

    const { data, error } = await supabase.auth.admin.updateUserById(id, banPatch);
    if (error) throw error;
    if (!data?.user) return null;

    if (action === 'disable') {
      // Best-effort — a signOut failure should not block the ban itself
      // (the ban is already authoritative and will take effect on the
      // user's next token refresh regardless).
      try {
        await supabase.auth.admin.signOut(id, 'global');
      } catch {
        // intentionally swallowed — see comment above
      }
    }

    return this.getAuthState(id);
  }

  // WP-ADMIN-COMP-04 — View User Audit History. Read-only reader of the
  // existing, certified admin_logs table, mirroring
  // administrators.repository.js's listLifecycleAuditEvents(uid). No new
  // table, no new write path — role-update audit entries
  // (adminUsers.service.js's USER_ROLE_UPDATED) and the new
  // USER_PROFILE_UPDATED / USER_ACCOUNT_ENABLED / USER_ACCOUNT_DISABLED
  // entries this WP adds all already write entity_type: 'user',
  // entity_id: userId — this is simply the first reader of that data.
  async listAuditHistory(id, limit = 50) {
    if (!id) return [];
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from(AUDIT_TABLE)
      .select('*')
      .eq('entity_type', AUDIT_ENTITY_TYPE)
      .eq('entity_id', id)
      .order('created_at', { ascending: false })
      .limit(Math.min(limit, MAX_AUDIT_PAGE_LIMIT));

    if (error || !data) return [];
    return data;
  }

  _toCamel(row) {
    return {
      id: row.id,
      email: row.email,
      displayName: row.display_name ?? null,
      role: row.role,
      createdAt: row.created_at,
    };
  }

  // WP-ADMIN-04C — detail-only mapper. Extends _toCamel's shape with the
  // additional public.users columns now selected by DETAIL_COLUMNS. Kept
  // separate from _toCamel so list() output (LIST_COLUMNS) is unaffected.
  _toCamelDetail(row) {
    return {
      ...this._toCamel(row),
      updatedAt: row.updated_at ?? null,
      userType: row.user_type ?? null,
      careerGoal: row.career_goal ?? null,
      targetRole: row.target_role ?? null,
      experienceYears: row.experience_years ?? null,
      industry: row.industry ?? null,
      location: row.location ?? null,
    };
  }
}

module.exports = new AdminUsersRepository();
module.exports.ROLES = ROLES;
