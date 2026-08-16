'use strict';

/**
 * adminWeights.repository.js — Signal Weight / Model Version Registry
 *
 * WP-ADMIN-COMP-08-R23 (read-only foundation) + R24 (draft creation) +
 * R25 (approval)
 *
 * Reads from, and — as of R24 — inserts draft rows into, and — as of R25
 * — transitions a draft to approved in, the existing, certified
 * `public.signal_weight_versions` registry
 * (supabase/migrations/20260601000001_governance_foundation_
 * RECONSTRUCTED.sql, extended by .../20260601000004_governance_
 * refinements.sql and .../20260601000005_migration_1a_04_weight_versions_
 * amendment.sql) and calls the existing, authoritative
 * `public.fn_get_active_model_version(p_intelligence_domain, p_model_type)`
 * RPC for active-version resolution. No new table, column, migration, or
 * RPC is introduced by R24 or R25. `create()` can only ever produce a
 * draft row — `approved_by`, `approved_at`, and `deprecated_at` are
 * never accepted from the caller and are always forced to `null` on
 * insert (see `create()` doc comment). `approve()` (R25) is the only
 * write path that can ever set `approved_by`/`approved_at`, and only on
 * a row that is still an eligible draft at the moment its conditional
 * UPDATE executes (see `approve()` doc comment). Neither write path — nor
 * anything else in this repository — sets `deprecated_at` or touches
 * `fn_get_active_model_version()`.
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
// Reused as the RETURNING shape for create() so a newly created draft is
// mapped identically to a row read back via list() — R23's JSONB-exclusion
// policy applies to every mapped response in this repository, creation
// included.
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
   *   the function resolves no active version for the given domain/type
   *   (whether the RPC returns a true SQL NULL, or a composite object
   *   with no valid row `id` — see normalization note below).
   */
  async getActiveModelVersion({ intelligenceDomain, modelType } = {}) {
    const params = {};
    if (intelligenceDomain) params.p_intelligence_domain = intelligenceDomain;
    if (modelType) params.p_model_type = modelType;

    const { data, error } = await supabase.rpc(ACTIVE_VERSION_RPC, params);
    if (error) throw this._handleError(error, 'getActiveModelVersion');

    // fn_get_active_model_version() is not a SETOF function — it returns
    // at most one composite row (or SQL NULL when no approved,
    // non-deprecated, effective row exists). PostgREST/Supabase *should*
    // surface that as a single JSON object or JSON null, never an array —
    // but a PL/pgSQL function that does `SELECT * INTO result FROM ...;
    // RETURN result;` without an explicit `IF result IS NULL THEN RETURN
    // NULL;` guard returns a composite value whose individual fields are
    // all NULL when the SELECT matches zero rows, not a true SQL NULL for
    // the composite itself (confirmed via a reproduced runtime response:
    // `{ success: true, data: { id: null, versionTag: null, ... } }` for
    // GET /admin/weights/active?intelligenceDomain=professional). Both
    // representations mean the same thing at this boundary — "no active
    // version resolved" — so both normalize to `null` here. This is a
    // result-shape normalization only: it does not decide which version
    // is active, does not query the table directly, and does not
    // reimplement any part of the function's own resolution logic. A
    // resolved row always has an `id`; anything without one is treated
    // as no result.
    if (!data || !data.id) return null;
    return this._toCamel(data);
  }

  /**
   * Insert a new draft (unapproved) model version row.
   *
   * WP-ADMIN-COMP-08-R24. This is the only write path this repository
   * exposes, and it can only ever produce a draft: `approved_by`,
   * `approved_at`, and `deprecated_at` are hard-coded to `null` here and
   * are never taken from `versionData`, regardless of what the caller
   * passes — draft-only is enforced at this layer, not just by the route
   * validator, so this method is safe to call from anywhere in the
   * service layer without re-deriving that guarantee.
   *
   * Does not implement approval, activation, or deprecation. Does not
   * change `fn_get_active_model_version()` or active-version resolution
   * — a freshly created draft is, by construction, never resolvable as
   * active (`approved_at IS NOT NULL` is a hard filter in that RPC).
   *
   * @param {object} versionData
   * @param {string} versionData.versionTag
   * @param {string} versionData.modelType
   * @param {string} versionData.intelligenceDomain
   * @param {string} versionData.description
   * @param {object} versionData.weights
   * @param {object} [versionData.domainOverrides] — omitted → DB default '{}'
   * @param {object} [versionData.weightRationale] — omitted → DB default '{}'
   * @param {string} [versionData.effectiveFrom] — omitted → DB default now()
   * @returns {Promise<object>} the created draft, mapped like list()/
   *   getActiveModelVersion() (see LIST_COLUMNS — weights/domainOverrides/
   *   weightRationale are not returned, consistent with R23 §10)
   */
  async create(versionData) {
    const payload = {
      version_tag: versionData.versionTag,
      model_type: versionData.modelType,
      intelligence_domain: versionData.intelligenceDomain,
      description: versionData.description,
      weights: versionData.weights,
      // Draft-only, enforced here regardless of caller input:
      approved_by: null,
      approved_at: null,
      deprecated_at: null,
    };

    // Optional fields: only set when supplied, so the DB's own defaults
    // ('{}' for both JSONB columns, now() for effective_from) apply
    // otherwise — this repository never hard-codes those defaults in
    // JavaScript (same omit-if-absent convention as getActiveModelVersion()).
    if (versionData.domainOverrides !== undefined) {
      payload.domain_overrides = versionData.domainOverrides;
    }
    if (versionData.weightRationale !== undefined) {
      payload.weight_rationale = versionData.weightRationale;
    }
    if (versionData.effectiveFrom !== undefined) {
      payload.effective_from = versionData.effectiveFrom;
    }

    const { data, error } = await supabase
      .from(TABLE)
      .insert(payload)
      .select(LIST_COLUMNS)
      .single();

    if (error) throw this._handleError(error, 'create');

    return this._toCamel(data);
  }

  /**
   * Fetch a single registry version by id.
   *
   * WP-ADMIN-COMP-08-R25. Read-only — used by the service layer to
   * distinguish "not found" from "found but ineligible" before the
   * approval mutation is attempted. Mapped identically to list() (same
   * LIST_COLUMNS — the R23 §10 JSONB-exclusion policy applies here too).
   *
   * @param {string} id
   * @returns {Promise<object|null>} the version, or null if no row has
   *   this id
   */
  async findById(id) {
    const { data, error } = await supabase
      .from(TABLE)
      .select(LIST_COLUMNS)
      .eq('id', id)
      .maybeSingle();

    if (error) throw this._handleError(error, 'findById');

    return this._toCamel(data);
  }

  /**
   * Approve an eligible draft version.
   *
   * WP-ADMIN-COMP-08-R25. The only write this method performs is setting
   * `approved_by`/`approved_at` on a row that, at the moment the UPDATE
   * actually executes, is still an eligible draft — enforced by the
   * `.is('approved_at', null).is('deprecated_at', null)` conditional
   * filter below, not merely by a prior read. This is the final
   * atomic-safety guard called out by the R25 contract: it is what
   * prevents a second, concurrent approval from double-approving (or
   * approving a since-deprecated) row between the service layer's
   * `findById()` eligibility check and this mutation. A caller should
   * always read the row first (via `findById()`) to distinguish 404
   * (row doesn't exist) from 409 (row exists but is ineligible) — this
   * method alone cannot tell those two cases apart, since both make the
   * conditional UPDATE match zero rows.
   *
   * `approved_at` is supplied by the application (`new Date()`), not by
   * a database default or trigger — the schema's `approved_at` column
   * has no default other than NULL, and the existing immutability
   * trigger (`fn_signal_weight_version_protect()`) only *protects*
   * `version_tag`/`model_type`/`weights`/`effective_from`/`created_at`
   * once `approved_at` is set; it does not itself set `approved_at`.
   *
   * Does not introduce activation, `is_active`, or any change to
   * `fn_get_active_model_version()` — a newly approved row simply
   * becomes eligible for that existing function's own resolution logic.
   *
   * @param {string} id
   * @param {string} approvedBy — the authenticated admin actor id
   *   (`req.user.id`); always taken from server-side identity, never
   *   from the request body (enforced by the caller, not re-validated
   *   here)
   * @returns {Promise<object|null>} the approved version, or null if no
   *   row both has this id AND is still an eligible (non-approved,
   *   non-deprecated) draft at UPDATE time
   */
  async approve(id, approvedBy) {
    const { data, error } = await supabase
      .from(TABLE)
      .update({
        approved_by: approvedBy,
        approved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .is('approved_at', null)
      .is('deprecated_at', null)
      .select(LIST_COLUMNS)
      .maybeSingle();

    if (error) throw this._handleError(error, 'approve');

    return this._toCamel(data);
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
    //
    // R24 note: a Postgres unique-violation (code '23505' — the
    // uq_model_version_per_domain_type composite key on
    // (intelligence_domain, model_type, version_tag)) is translated to a
    // real ErrorCodes.CONFLICT here, not left for the service layer to
    // detect via `err.code` after wrapping. adminCmsRoles.service.js's
    // `err.code === '23505'` check is the closest existing precedent for
    // duplicate handling, but that pattern only works there because — in
    // that module — the postgres error code happens to survive on the
    // wrapped error object; here, wrapping into AppError intentionally
    // does not preserve the raw Postgres `.code`, so detecting the
    // conflict has to happen at the point the raw error is still
    // available: right here, before it is wrapped.
    if (error?.code === '23505') {
      return new AppError(
        'A model version with this intelligence domain, model type, and version tag already exists.',
        409,
        { operation, details: error?.details ?? null },
        ErrorCodes.CONFLICT
      );
    }

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