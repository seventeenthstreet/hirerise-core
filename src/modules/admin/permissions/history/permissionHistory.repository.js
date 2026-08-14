'use strict';

/**
 * @file src/modules/admin/permissions/history/permissionHistory.repository.js
 *
 * WP-ADMIN-05D — Enterprise Permission Audit & Governance History
 *
 * Read-only reader of the existing, certified `admin_logs` table — the
 * same table WP-ADMIN-05B's `logAdminAction()` / `adminAuditLogger.js`
 * already writes to for every Permission Assignment and Governance
 * mutation. No new table, no new audit mechanism, no write method is
 * defined here — this file mirrors the established convention set by
 * `../administrators/administrators.repository.js`'s
 * `listLifecycleAuditEvents(uid)` (WP-ADMIN-05A), the first reader of
 * this table, applied to `entity_type = 'permission'` instead of
 * `'admin_principal'`.
 *
 * Per WP-ADMIN-05D's Phase 1 Repository Audit, both Permission
 * sub-domains that write to this table use the same `entity_id` format
 * (the Permission Identity, `${resource}:${action}` — see
 * `permission.model.js#buildPermissionName`), so a single query already
 * produces a unified Assignment + Governance timeline for one Permission
 * with no join and no per-sub-domain special-casing:
 *
 *   permissionAssignment.controller.js  -> PERMISSION_ASSIGNED / PERMISSION_REVOKED
 *   permissionGovernance.integration.js -> PERMISSION_APPROVED / PUBLISHED / ADOPTED /
 *                                           DEPRECATED / RETIRED
 *
 * No table, column, or migration is introduced. No write method is
 * defined in this file.
 */

const { ACTIONS: PERMISSION_AUDIT_ACTIONS, ENTITY_TYPE } = require('../audit/permissionAudit.constants');

const AUDIT_TABLE = 'admin_logs';

// Mirrors administrators.repository.js's MAX_PAGE_LIMIT precedent — audit
// history pages must never be unbounded, even though this WP's own
// validators.js already rejects `limit` above this value before a
// request reaches here. Defense in depth, not a second source of truth:
// the validator is what the caller sees; this is the floor this
// repository will never exceed even if called directly (e.g. by a
// future internal caller that bypasses HTTP validation).
const MAX_PAGE_LIMIT = 200;

const KNOWN_ACTIONS = new Set(Object.values(PERMISSION_AUDIT_ACTIONS));

function getSupabase() {
  return require('../../../../config/supabase').supabase;
}

class PermissionHistoryRepository {
  /**
   * Read-only, paginated, filterable query against `admin_logs`, scoped
   * to `entity_type = 'permission'`.
   *
   * @param {object}      [opts]
   * @param {string}      [opts.entityId]  — restrict to one Permission's
   *   Identity (`resource:action`). Omitted for the cross-Permission
   *   `GET /permissions/history` listing; provided for
   *   `GET /permissions/:id/history` (after id -> identity resolution,
   *   which this repository never performs itself — that is the
   *   Integration Service's job, per the certified architecture's
   *   "no business logic here" boundary).
   * @param {string}      [opts.action]    — one of PERMISSION_AUDIT_ACTIONS;
   *   silently ignored if not a recognized Permission audit action,
   *   rather than returning a confusing empty page for a typo'd value
   *   the validator already should have rejected.
   * @param {string}      [opts.adminId]   — restrict to one acting administrator.
   * @param {string}      [opts.dateFrom]  — ISO date/datetime, inclusive lower bound on created_at.
   * @param {string}      [opts.dateTo]    — ISO date/datetime, inclusive upper bound on created_at.
   * @param {'asc'|'desc'} [opts.sort='desc'] — order by created_at.
   * @param {number}      [opts.limit=50]
   * @param {number}      [opts.offset=0]
   * @returns {Promise<{ items: object[], total: number }>}
   */
  async listPermissionHistory({
    entityId,
    action,
    adminId,
    dateFrom,
    dateTo,
    sort = 'desc',
    limit = 50,
    offset = 0,
  } = {}) {
    const supabase = getSupabase();
    const boundedLimit = Math.min(limit, MAX_PAGE_LIMIT);
    const ascending = sort === 'asc';

    let q = supabase
      .from(AUDIT_TABLE)
      .select('*', { count: 'exact' })
      .eq('entity_type', ENTITY_TYPE)
      .order('created_at', { ascending })
      .range(offset, offset + boundedLimit - 1);

    if (entityId) {
      q = q.eq('entity_id', entityId);
    }
    if (action && KNOWN_ACTIONS.has(action)) {
      q = q.eq('action', action);
    }
    if (adminId) {
      q = q.eq('admin_id', adminId);
    }
    if (dateFrom) {
      q = q.gte('created_at', dateFrom);
    }
    if (dateTo) {
      q = q.lte('created_at', dateTo);
    }

    const { data, error, count } = await q;
    if (error) throw error;

    return { items: data || [], total: count ?? 0 };
  }
}

module.exports = {
  PermissionHistoryRepository,
  permissionHistoryRepository: new PermissionHistoryRepository(),
};
