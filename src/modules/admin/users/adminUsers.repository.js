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
 */

// WP-ADMIN-04E — the full set of values public.users.role accepts, per its
// `users_role_check` CHECK constraint. Single source of truth for role
// validation on this route — see adminUsers.routes.js `isIn(ROLES)`.
const ROLES = Object.freeze(['user', 'admin', 'super_admin', 'MASTER_ADMIN', 'contributor']);

function getSupabase() { return require('../../../config/supabase').supabase; }

const TABLE = 'users';

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
