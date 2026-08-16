'use strict';

/**
 * adminWeights.service.js — Signal Weight / Model Version Registry
 *
 * WP-ADMIN-COMP-08-R23 (read-only foundation) + R24 (draft creation)
 *
 * Thin orchestration layer over adminWeights.repository.js. Contains
 * three operations:
 *   - listVersions()   — registry listing (Capability A, read-only)
 *   - getActiveVersion() — authoritative active-version resolution
 *     (Capability B, read-only)
 *   - createVersion()  — draft (unapproved) version creation (R24)
 *
 * No approval, activation, or deprecation operation exists in this file
 * or anywhere in this module. createVersion() can only ever produce a
 * draft — see its doc comment and adminWeights.repository.js's create().
 */

const weightsRepo = require('./adminWeights.repository');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

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

module.exports = { listVersions, getActiveVersion, createVersion };