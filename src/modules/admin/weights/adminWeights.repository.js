'use strict';

/**
 * adminWeights.repository.js — Signal Weight / Model Version Registry
 * (read-only, Supabase)
 *
 * WP-ADMIN-COMP-08-R23
 *
 * Reads from the existing, certified `public.signal_weight_versions`
 * registry (supabase/migrations/20260601000001_governance_foundation_
 * RECONSTRUCTED.sql, extended by .../20260601000004_governance_
 * refinements.sql) and calls the existing, authoritative
 * `public.fn_get_active_model_version(p_intelligence_domain, p_model_type)`
 * RPC. No new table, column, or migration is introduced. No row in this
 * table is ever written by this repository — see module docstring in
 * adminWeights.routes.js for the full read-only scope boundary.
 *
 * Pattern note: this mirrors modules/admin/cms/roles/adminCmsRoles.repository.js
 * and modules/admin/users/adminUsers.repository.js (plain class, direct
 * Supabase client, `_toCamel` row mapper) rather than extending
 * BaseRepository, for the same reason WP-ADMIN-COMP-08-R22 already
 * documented for `intelligence_entity_snapshots`: `signal_weight_versions`
 * has no `soft_deleted`, `status`, `version`, `created_by`, or `updated_by`
 * columns (confirmed against the migration's CREATE TABLE), so
 * BaseRepository's generic governed-table assumptions (unconditional
 * `WHERE soft_deleted = false` filtering, injected audit columns on
 * create) do not hold for this table either.
 *
 * JSONB scope (R23 §10): `weights`, `domain_overrides`, and
 * `weight_rationale` are deliberately excluded from every mapped response
 * in this repository (list AND active-version lookup) — R23 is not a
 * model editor, and returning large configuration JSONB payloads by
 * default is explicitly discouraged. A detailed single-version JSONB
 * inspection endpoint is out of this WP's scope.
 *
 * "Active" scope (R23 §9): this repository never computes "is this row
 * active" in JavaScript. `getActiveModelVersion()` calls
 * `fn_get_active_model_version()` — the single authoritative resolution
 * function — and returns exactly what it resolves. `list()` returns the
 * raw governance fields (`approvedAt`, `deprecatedAt`, `effectiveFrom`)
 * plus two per-row, zero-ambiguity derived booleans (`isApproved`,
 * `isDeprecated`) that need no cross-row comparison to compute. It does
 * NOT derive a cross-row "is this the currently active one" flag, since
 * that would require re-implementing the function's own
 * domain/model_type/effective_from/deprecated_at resolution logic in
 * JavaScript — exactly what R23 §9 prohibits.
 */

const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const { supabase } = require('../../../config/supabase');

const TABLE = 'signal_weight_versions';
const ACTIVE_VERSION_RPC = 'fn_get_active_model_version';

// Lightweight registry metadata only — deliberately excludes weights,
// domain_overrides, weight_rationale (see module docstring, R23 §10).
const LIST_COLUMNS =
  'id, version_tag, model_type, intelligence_domain, description, ' +
  'approved_by, approved_at, effective_from, deprecated_at, created_at';

class AdminWeightsRepository {
  /**
   * List registry versions, most recently effective first.
   *
   * @param {object}  [opts]
   * @param {string}  [opts.intelligenceDomain] — exact match filter
   * @param {string}  [opts.modelType]          — exact match filter
   * @returns {Promise<object[]>}
   */
  async list({ intelligenceDomain, modelType } = {}) {
    let query = supabase
      .from(TABLE)
      .select(LIST_COLUMNS)
      // Most recently effective first — mirrors the DB's own
      // idx_signal_weight_versions_active partial index ordering
      // (effective_from DESC), the ordering the governance foundation
      // migration itself treats as the natural "most current" ordering.
      .order('effective_from', { ascending: false });

    if (intelligenceDomain) {
      query = query.eq('intelligence_domain', intelligenceDomain);
    }
    if (modelType) {
      query = query.eq('model_type', modelType);
    }

    const { data, error } = await query;
    if (error) throw this._handleError(error, 'list');

    return (data || []).map((row) => this._toCamel(row));
  }

  /**
   * Resolve the currently active model version via the existing
   * authoritative database function. Does not query the table directly
   * and does not reimplement the function's resolution logic.
   *
   * @param {object}  [opts]
   * @param {string}  [opts.intelligenceDomain] — forwarded as
   *   p_intelligence_domain; omitted entirely (not passed as
   *   undefined/null) when not provided, so the function's own SQL
   *   DEFAULT 'student' applies — this repository never hard-codes that
   *   default in JavaScript.
   * @param {string}  [opts.modelType] — forwarded as p_model_type, same
   *   omit-if-absent rule (function DEFAULT 'signal_weights').
   * @returns {Promise<object|null>} the active version row, or null if
   *   the function resolves no active version for the given domain/type.
   */
  async getActiveModelVersion({ intelligenceDomain, modelType } = {}) {
    const params = {};
    if (intelligenceDomain) params.p_intelligence_domain = intelligenceDomain;
    if (modelType) params.p_model_type = modelType;

    const { data, error } = await supabase.rpc(ACTIVE_VERSION_RPC, params);
    if (error) throw this._handleError(error, 'getActiveModelVersion');

    // fn_get_active_model_version() is not a SETOF function — it returns
    // at most one composite row (or SQL NULL when no approved,
    // non-deprecated, effective row exists). PostgREST/Supabase surfaces
    // that as a single JSON object or null, never an array.
    return data ? this._toCamel(data) : null;
  }

  // ─────────────────────────────────────────────────────────────
  // INTERNAL HELPERS
  // ─────────────────────────────────────────────────────────────

  _handleError(error, operation) {
    // Never let a raw Postgrest/Postgres error object reach the HTTP
    // response (R23 §8: "Avoid returning ... database errors"). Wrapped
    // in AppError with a real ErrorCodes entry — INTERNAL_ERROR, not the
    // undefined `ErrorCodes.DATABASE_ERROR` referenced by
    // adminCmsRoles.repository.js (that key does not exist on the
    // ErrorCodes object exported by middleware/errorHandler.js; it
    // silently collapses to the constructor's 'APP_ERROR' fallback
    // there). Deliberately not replicated here.
    return new AppError(
      error?.message || 'Signal weight/model version registry query failed',
      500,
      { operation, details: error?.details ?? null },
      ErrorCodes.INTERNAL_ERROR
    );
  }

  _toCamel(row) {
    if (!row) return null;

    return {
      id: row.id,
      versionTag: row.version_tag,
      modelType: row.model_type,
      intelligenceDomain: row.intelligence_domain,
      description: row.description,
      approvedBy: row.approved_by,
      approvedAt: row.approved_at,
      effectiveFrom: row.effective_from,
      deprecatedAt: row.deprecated_at,
      createdAt: row.created_at,
      // Per-row, zero-ambiguity derived flags only — see module docstring
      // for why a cross-row "is active" flag is deliberately NOT computed
      // here.
      isApproved: row.approved_at !== null && row.approved_at !== undefined,
      isDeprecated: row.deprecated_at !== null && row.deprecated_at !== undefined,
    };
  }
}

module.exports = new AdminWeightsRepository();
module.exports.AdminWeightsRepository = AdminWeightsRepository;
