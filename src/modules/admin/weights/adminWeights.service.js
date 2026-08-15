'use strict';

/**
 * adminWeights.service.js — Signal Weight / Model Version Registry
 * (read-only business logic)
 *
 * WP-ADMIN-COMP-08-R23
 *
 * Thin orchestration layer over adminWeights.repository.js. Contains
 * exactly two operations, both read-only:
 *   - listVersions()  — registry listing (Capability A)
 *   - getActiveVersion() — authoritative active-version resolution
 *     (Capability B)
 *
 * No write, approval, activation, deactivation, or deprecation operation
 * exists in this file or anywhere in this module (see adminWeights.routes.js
 * module docstring for the full R23 scope boundary).
 */

const weightsRepo = require('./adminWeights.repository');
const { AppError, ErrorCodes } = require('../../../middleware/errorHandler');

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

module.exports = { listVersions, getActiveVersion };
