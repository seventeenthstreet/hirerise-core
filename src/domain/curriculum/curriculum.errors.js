'use strict';

/**
 * @file src/domain/curriculum/curriculum.errors.js
 *
 * HireRise Curriculum Architecture — Phase 2 / P2.1
 * Curriculum Version Resolution — error hierarchy.
 *
 * Follows the same standalone-hierarchy convention already established by
 * domain/permission/permission.errors.js and
 * domain/studentProfile/studentProfile.errors.js: a named class per
 * failure category, extending a module-local base rather than the
 * HTTP-status-coupled `AppError` — this is a pure domain module with no
 * HTTP awareness. A future HTTP boundary (a route/controller) is expected
 * to translate these into `AppError` instances itself.
 *
 * Unlike the Permission domain, this module does NOT split domain-entity
 * errors from repository-boundary errors into two separate files. The
 * Permission domain's split reflects its much larger surface (creation,
 * update, search, multiple lookup shapes, contract-compliance checking).
 * P2.1's surface is a single read-only resolver over one table, so one
 * error file covering both "bad input to the resolver" and "the
 * persistence layer failed" is proportionate scope — not an omission.
 */

/**
 * Base class for every error this module throws. Never thrown directly —
 * always one of the named subclasses below.
 */
class CurriculumDomainError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   * @param {object} [metadata]
   */
  constructor(message, code, metadata = {}) {
    super(message);
    this.name = 'CurriculumDomainError';
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, CurriculumDomainError);
  }
}

/**
 * Thrown when resolveCurriculumVersion() is called with a malformed
 * argument — missing/empty boardId, a non-date-parseable asOfDate, a
 * malformed regionId — before any query is issued. Distinct from
 * CurriculumConfigurationMissingError: this means the *request* itself is
 * unusable, not that a well-formed request simply has no matching
 * configuration.
 */
class InvalidCurriculumResolutionInputError extends CurriculumDomainError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[Curriculum] invalid resolution input: ${message}`, 'CURRICULUM_INVALID_RESOLUTION_INPUT', metadata);
    this.name = 'InvalidCurriculumResolutionInputError';
    Error.captureStackTrace?.(this, InvalidCurriculumResolutionInputError);
  }
}

/**
 * The controlled "curriculum configuration missing" result required by
 * the architecture lock (rule 7): thrown when the request is well-formed
 * but no published/archived curriculum_versions row is effective for the
 * given board/region/date. Callers MUST NOT catch this and substitute an
 * invented/default curriculum — the correct handling is to surface a
 * "curriculum not configured" condition upstream (e.g. a 409/422 at a
 * future HTTP boundary), which is exactly why this is a distinctly named,
 * catchable type rather than a generic thrown Error or a silent null
 * return.
 */
class CurriculumConfigurationMissingError extends CurriculumDomainError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[Curriculum] configuration missing: ${message}`, 'CURRICULUM_CONFIGURATION_MISSING', metadata);
    this.name = 'CurriculumConfigurationMissingError';
    Error.captureStackTrace?.(this, CurriculumConfigurationMissingError);
  }
}

/**
 * Thrown when the persistence layer (Supabase/PostgREST) itself fails.
 * Nothing in curriculumVersion.repository.js lets a raw Supabase error
 * escape the repository boundary — every failure is translated into this
 * class first, mirroring PermissionRepositoryError's role for the
 * Permission domain.
 */
class CurriculumVersionRepositoryError extends CurriculumDomainError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[Curriculum] repository error: ${message}`, 'CURRICULUM_VERSION_REPOSITORY_ERROR', metadata);
    this.name = 'CurriculumVersionRepositoryError';
    Error.captureStackTrace?.(this, CurriculumVersionRepositoryError);
  }
}

module.exports = {
  CurriculumDomainError,
  InvalidCurriculumResolutionInputError,
  CurriculumConfigurationMissingError,
  CurriculumVersionRepositoryError,
};
