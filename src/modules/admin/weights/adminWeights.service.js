'use strict';

/**
 * adminWeights.service.js — Signal Weight / Model Version Registry
 *
 * WP-ADMIN-COMP-08-R23 (read-only foundation) + R24 (draft creation) +
 * R25 (approval)
 *
 * Thin orchestration layer over adminWeights.repository.js. Contains
 * four operations:
 *   - listVersions()   — registry listing (Capability A, read-only)
 *   - getActiveVersion() — authoritative active-version resolution
 *     (Capability B, read-only)
 *   - createVersion()  — draft (unapproved) version creation (R24)
 *   - approveVersion() — governed Draft → Approved transition (R25)
 *   - deprecateVersion() — governed Approved → Deprecated transition (R26)
 *
 * No activation operation exists in this file or anywhere in this
 * module — per the R26 discovery report's Executive Summary, activation
 * remains fully and correctly handled by the pre-existing, untouched
 * `fn_get_active_model_version()` RPC as a pure function of
 * `approved_at`/`deprecated_at`/`effective_from`, so no explicit
 * activation mutation is needed or added here. createVersion() can only
 * ever produce a draft — see its doc comment and
 * adminWeights.repository.js's create(). approveVersion() implements
 * exactly the Draft → Approved transition and nothing further — it
 * never touches `fn_get_active_model_version()` or any active-version
 * resolution logic (see its doc comment). deprecateVersion() (R26)
 * implements exactly the Approved → Deprecated transition, closing the
 * one confirmed-missing lifecycle write identified by the R26 discovery
 * report — it likewise never touches `fn_get_active_model_version()`.
 */

const weightsRepo = require('./adminWeights.repository');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');
const { logAdminAction } = require('../../../utils/adminAuditLogger');

// Required to create a draft version. `domainOverrides`, `weightRationale`,
// and `effectiveFrom` are optional (DB supplies defaults — see
// repository.create()).
const REQUIRED_CREATE_FIELDS = [
  'versionTag',
  'modelType',
  'intelligenceDomain',
  'description',
  'weights',
];

/**
 * @param {object} [opts]
 * @param {string} [opts.intelligenceDomain]
 * @param {string} [opts.modelType]
 * @returns {Promise<{ items: object[] }>}
 */
async function listVersions({ intelligenceDomain, modelType } = {}) {
  const items = await weightsRepo.list({ intelligenceDomain, modelType });
  return { items };
}

/**
 * Resolves the currently active model version via the authoritative
 * fn_get_active_model_version() database function.
 *
 * No-active-version handling (R23 §4, Capability B): this codebase's
 * established convention for a single-resource lookup that resolves to
 * nothing is a 404 with ErrorCodes.NOT_FOUND — see
 * modules/admin/cms/roles/adminCmsRoles.service.js
 * ("throw new AppError('Role not found', 404, { roleId }, ErrorCodes.NOT_FOUND)")
 * and adminCmsRoles.repository.js's identical pattern for findById(). This
 * follows that existing, evidenced convention rather than inventing a new
 * "200 with null" contract.
 *
 * @param {object} [opts]
 * @param {string} [opts.intelligenceDomain]
 * @param {string} [opts.modelType]
 * @returns {Promise<object>} the active version
 * @throws {AppError} 404 NOT_FOUND when no active version resolves
 */
async function getActiveVersion({ intelligenceDomain, modelType } = {}) {
  const active = await weightsRepo.getActiveModelVersion({
    intelligenceDomain,
    modelType,
  });

  if (!active) {
    throw new AppError(
      'No active model version found for the given intelligence domain and model type',
      404,
      { intelligenceDomain: intelligenceDomain ?? null, modelType: modelType ?? null },
      ErrorCodes.NOT_FOUND
    );
  }

  return active;
}

/**
 * Creates a new draft (unapproved) model version.
 *
 * WP-ADMIN-COMP-08-R24. Validates that the required fields are present,
 * then strips `approvedBy`/`approvedAt`/`deprecatedAt` from whatever the
 * caller supplied before forwarding to the repository — defense in depth
 * alongside the route-level `.not().exists()` guards in
 * adminWeights.routes.js, since the repository itself also independently
 * forces those three fields to `null` regardless of input (see
 * adminWeights.repository.js `create()`).
 *
 * Does not approve, activate, or deprecate the created row. Does not
 * call or affect `fn_get_active_model_version()`.
 *
 * @param {object} payload — see REQUIRED_CREATE_FIELDS plus the optional
 *   `domainOverrides`, `weightRationale`, `effectiveFrom` fields.
 * @returns {Promise<object>} the created draft version
 * @throws {AppError} 400 VALIDATION_ERROR when a required field is missing
 * @throws {AppError} 409 CONFLICT when the (intelligenceDomain, modelType,
 *   versionTag) combination already exists (surfaced by the repository
 *   from the DB's uq_model_version_per_domain_type constraint)
 */
async function createVersion(payload = {}) {
  const missing = REQUIRED_CREATE_FIELDS.filter(
    (field) => payload[field] === undefined || payload[field] === null || payload[field] === ''
  );

  if (missing.length > 0) {
    throw new AppError(
      `Missing required field(s): ${missing.join(', ')}`,
      400,
      { fields: missing },
      ErrorCodes.VALIDATION_ERROR
    );
  }

  const {
    versionTag,
    modelType,
    intelligenceDomain,
    description,
    weights,
    domainOverrides,
    weightRationale,
    effectiveFrom,
  } = payload;

  // Draft-only: never forwarded even if present on `payload` (route-level
  // validation already rejects these, but the service does not trust
  // that as the sole guard).
  const created = await weightsRepo.create({
    versionTag,
    modelType,
    intelligenceDomain,
    description,
    weights,
    domainOverrides,
    weightRationale,
    effectiveFrom,
  });

  return created;
}

/**
 * Approves an existing, eligible draft model version.
 *
 * WP-ADMIN-COMP-08-R25. This is a governed lifecycle transition
 * (Draft → Approved) only — it does not activate the version.
 * `fn_get_active_model_version()` (untouched by R25) remains the sole
 * authority for whether an approved version is currently eligible as
 * active; that depends on `effective_from`, which this operation never
 * sets or changes.
 *
 * Lifecycle contract, in order:
 *   1. `id` does not resolve to any row           → 404 NOT_FOUND
 *   2. row exists but is already approved         → 409 CONFLICT
 *   3. row exists but is deprecated                → 409 CONFLICT
 *   4. row exists, is an eligible draft            → approve it
 *
 * Approval is not idempotent: a second approval attempt on an already-
 * approved row is rejected (409), and never re-writes `approvedBy`/
 * `approvedAt` — approval is a governance event, not an upsert.
 *
 * The `findById()` read above only decides which error to throw for an
 * already-ineligible row; it is not the mechanism that prevents a
 * concurrent double-approval. That protection is `weightsRepo.approve()`'s
 * own conditional UPDATE (`approved_at IS NULL AND deprecated_at IS
 * NULL`), which is re-checked here: if eligibility was lost between the
 * read and the mutation (a race with another concurrent approval/
 * deprecation), `approve()` resolves `null` even though the row was
 * found and eligible a moment ago, and that is likewise surfaced as 409
 * CONFLICT rather than silently succeeding or being misreported as 404.
 *
 * @param {string} id
 * @param {string} adminId — `req.user.id` of the authenticated actor;
 *   this is the only source of the approval actor identity (never taken
 *   from the request body)
 * @returns {Promise<object>} the approved version
 * @throws {AppError} 404 NOT_FOUND when no version has this id
 * @throws {AppError} 409 CONFLICT when the version is already approved,
 *   is deprecated, or lost eligibility to a concurrent request
 */
async function approveVersion(id, adminId) {
  const existing = await weightsRepo.findById(id);

  if (!existing) {
    throw new AppError(
      'Model version not found',
      404,
      { id },
      ErrorCodes.NOT_FOUND
    );
  }

  if (existing.approvedAt) {
    throw new AppError(
      'This model version has already been approved and cannot be approved again.',
      409,
      { id, approvedAt: existing.approvedAt, approvedBy: existing.approvedBy },
      ErrorCodes.CONFLICT
    );
  }

  if (existing.deprecatedAt) {
    throw new AppError(
      'This model version has been deprecated and can no longer be approved.',
      409,
      { id, deprecatedAt: existing.deprecatedAt },
      ErrorCodes.CONFLICT
    );
  }

  const approved = await weightsRepo.approve(id, adminId);

  if (!approved) {
    // Eligibility was lost between the read above and the repository's
    // own conditional UPDATE (concurrent approval/deprecation) — that
    // atomic guard, not this read, is the actual source of truth.
    throw new AppError(
      'This model version was approved or deprecated by another request. Refresh and try again.',
      409,
      { id },
      ErrorCodes.CONFLICT
    );
  }

  // Fire-and-forget — logAdminAction() never throws, so a logging
  // failure can never fail the request that already succeeded.
  void logAdminAction({
    adminId,
    action: 'MODEL_VERSION_APPROVED',
    entityType: 'signal_weight_version',
    entityId: id,
    metadata: {
      versionTag: approved.versionTag,
      modelType: approved.modelType,
      intelligenceDomain: approved.intelligenceDomain,
    },
  });

  return approved;
}

/**
 * Deprecates an existing, eligible (approved) model version.
 *
 * WP-ADMIN-COMP-08-R26. A governed lifecycle transition
 * (Approved → Deprecated) only — it does not delete the row, does not
 * create a new version, and does not explicitly activate any other row.
 * `fn_get_active_model_version()` (untouched by R26) simply stops
 * resolving this row as active on its very next call, since it filters
 * on `deprecated_at IS NULL`; whatever other row (if any) then resolves
 * as active is a pure, automatic consequence of that pre-existing RPC,
 * not something computed here (R26 discovery report §D, scenarios 1-3).
 *
 * Lifecycle contract, in order (R26 discovery report §E):
 *   1. `id` does not resolve to any row              → 404 NOT_FOUND
 *   2. row exists but was never approved (still draft) → 409 CONFLICT
 *      (deprecation is a post-approval concept only — see the
 *      registry's table comment: "Deprecation is the only permitted
 *      post-approval state change")
 *   3. row exists but is already deprecated           → 409 CONFLICT
 *   4. row exists, approved, not deprecated            → deprecate it
 *      (this includes a currently-active row, a superseded row, and an
 *      approved row with a future `effective_from` — none of these are
 *      distinguished at the deprecation layer; see eligibility matrix)
 *
 * Deprecation is not idempotent, matching approveVersion()'s contract —
 * a second deprecation attempt on an already-deprecated row is rejected
 * (409), never silently re-succeeds.
 *
 * The `findById()` read above only decides which error to throw for an
 * already-ineligible row; it is not the mechanism that prevents a
 * concurrent double-deprecation. That protection is
 * `weightsRepo.deprecate()`'s own conditional UPDATE (`approved_at IS
 * NOT NULL AND deprecated_at IS NULL`), which is re-checked here: if
 * eligibility was lost between the read and the mutation (a race with
 * another concurrent deprecation), `deprecate()` resolves `null` even
 * though the row was found and eligible a moment ago, and that is
 * likewise surfaced as 409 CONFLICT rather than silently succeeding or
 * being misreported as 404.
 *
 * @param {string} id
 * @param {string} adminId — `req.user.id` of the authenticated actor;
 *   used only for the audit log entry — no `deprecated_by` column
 *   exists on this table (R26 discovery report §C), so the audit log is
 *   the sole actor record for this action, same as it is for every
 *   other write in this module
 * @returns {Promise<object>} the deprecated version
 * @throws {AppError} 404 NOT_FOUND when no version has this id
 * @throws {AppError} 409 CONFLICT when the version was never approved,
 *   is already deprecated, or lost eligibility to a concurrent request
 */
async function deprecateVersion(id, adminId) {
  const existing = await weightsRepo.findById(id);

  if (!existing) {
    throw new AppError(
      'Model version not found',
      404,
      { id },
      ErrorCodes.NOT_FOUND
    );
  }

  if (!existing.approvedAt) {
    throw new AppError(
      'This model version has never been approved and cannot be deprecated.',
      409,
      { id },
      ErrorCodes.CONFLICT
    );
  }

  if (existing.deprecatedAt) {
    throw new AppError(
      'This model version has already been deprecated.',
      409,
      { id, deprecatedAt: existing.deprecatedAt },
      ErrorCodes.CONFLICT
    );
  }

  const deprecated = await weightsRepo.deprecate(id);

  if (!deprecated) {
    // Eligibility was lost between the read above and the repository's
    // own conditional UPDATE (concurrent deprecation) — that atomic
    // guard, not this read, is the actual source of truth.
    throw new AppError(
      'This model version was deprecated by another request. Refresh and try again.',
      409,
      { id },
      ErrorCodes.CONFLICT
    );
  }

  // Fire-and-forget — logAdminAction() never throws, so a logging
  // failure can never fail the request that already succeeded.
  void logAdminAction({
    adminId,
    action: 'MODEL_VERSION_DEPRECATED',
    entityType: 'signal_weight_version',
    entityId: id,
    metadata: {
      versionTag: deprecated.versionTag,
      modelType: deprecated.modelType,
      intelligenceDomain: deprecated.intelligenceDomain,
    },
  });

  return deprecated;
}

module.exports = {
  listVersions,
  getActiveVersion,
  createVersion,
  approveVersion,
  deprecateVersion,
};