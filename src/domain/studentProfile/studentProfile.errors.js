'use strict';

/**
 * @file src/domain/studentProfile/studentProfile.errors.js
 *
 * WP-STD-IMP-03A — Student Repository Foundation & Aggregate Reconstruction
 *
 * Named error classes for the Student Repository boundary. No anonymous
 * `throw new Error(...)` is used anywhere else in this module — every
 * failure mode below is one of these four types, per the work package's
 * Error Model requirement.
 *
 * This mirrors the professional side's `AppError`-derived convention in
 * spirit (a named class per failure category), but is implemented as a
 * standalone hierarchy rather than extending `middleware/errorHandler`'s
 * `AppError` — the Student Repository is a pure domain module with no HTTP
 * awareness (WP-STD-ARCH-02 §2.3: "does not render or format data for
 * presentation"), so it should not carry an HTTP-status-coupled base class.
 * Callers at the HTTP boundary (a future WP-STD-IMP-03B controller) are
 * expected to translate these into `AppError` instances themselves.
 */

/**
 * Base class for every error this module throws. Never thrown directly —
 * always one of the named subclasses below.
 */
class StudentRepositoryError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   * @param {object} [metadata]
   */
  constructor(message, code, metadata = {}) {
    super(message);
    this.name = 'StudentRepositoryError';
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, StudentRepositoryError);
  }
}

/**
 * Thrown when one of the wrapped subdomain adapters (academic.repository.js,
 * activity.repository.js, cognitive.repository.js, or the internal legacy
 * adapter) fails during the read pipeline. Per WP-STD-IMP-02 §18, the whole
 * read fails when this happens — no subdomain is silently defaulted to
 * empty, since that would be indistinguishable from a genuinely empty
 * subdomain (§6.6) and could corrupt SPCE's readiness evaluation.
 */
class RepositoryLoadError extends StudentRepositoryError {
  /**
   * @param {string} subdomain - which subdomain's loader failed
   * @param {Error} cause - the underlying adapter error
   * @param {object} [metadata]
   */
  constructor(subdomain, cause, metadata = {}) {
    super(
      `[StudentRepository] failed to load "${subdomain}" subdomain: ${cause?.message ?? cause}`,
      'STUDENT_REPOSITORY_LOAD_FAILED',
      { subdomain, ...metadata },
    );
    this.name = 'RepositoryLoadError';
    this.subdomain = subdomain;
    this.cause = cause;
    Error.captureStackTrace?.(this, RepositoryLoadError);
  }
}

/**
 * Thrown when aggregate assembly (mapping raw adapter output into canonical
 * shape, or merging subdomain results into one StudentProfile) fails for a
 * reason other than an adapter read itself failing — e.g. an adapter
 * returned a shape the mapper did not expect.
 */
class AggregateBuildError extends StudentRepositoryError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[StudentRepository] aggregate build failed: ${message}`, 'STUDENT_AGGREGATE_BUILD_FAILED', metadata);
    this.name = 'AggregateBuildError';
    Error.captureStackTrace?.(this, AggregateBuildError);
  }
}

/**
 * Thrown when structural validation fails — either the defensive read-time
 * check (WP-STD-IMP-02 §7, §15) or a future write-time structural check
 * (WP-STD-IMP-03B). Never used for business/sufficiency validation, which
 * is explicitly out of this repository's scope (WP-STD-ARCH-02 §2.3).
 */
class ValidationError extends StudentRepositoryError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[StudentRepository] validation failed: ${message}`, 'STUDENT_PROFILE_VALIDATION_FAILED', metadata);
    this.name = 'ValidationError';
    Error.captureStackTrace?.(this, ValidationError);
  }
}

/**
 * Thrown by a `write*`/`deleteAchievement` method when its payload fails
 * structural validation, or when the write cannot be routed at all — e.g.
 * `writeAchievement` called with an `activityKey` that doesn't correspond
 * to an existing activity (the real FK constraint surfacing as a
 * validation error at the boundary, per WP-STD-IMP-02 §18 and §6.5).
 * Distinct from the read-side `ValidationError` only by which pipeline
 * threw it — both share the same meaning ("shape/precondition failed
 * before any adapter was called").
 */
class MutationError extends StudentRepositoryError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[StudentRepository] mutation rejected: ${message}`, 'STUDENT_MUTATION_REJECTED', metadata);
    this.name = 'MutationError';
    Error.captureStackTrace?.(this, MutationError);
  }
}

/**
 * Thrown when a write cannot be persisted — either because the wrapped
 * adapter's own write call failed (WP-STD-IMP-02 §18: "an adapter's own
 * write fails ... propagates as a typed PersistenceError"), or because no
 * write adapter exists for the requested field/subdomain at all
 * (`currentGradeLevel`, and every `writeCareerAspirations` field — §10:
 * "no write adapter, since none exists to wrap"). In the second case this
 * error is thrown before any adapter call is attempted, so a request
 * combining a persistable field with a non-persistable one never produces
 * a partial write (WP-STD-IMP-02 §18's "no partial write is attempted"
 * principle, applied here to persistence-target availability as well as
 * to validation failures).
 */
class PersistenceError extends StudentRepositoryError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[StudentRepository] persistence failed: ${message}`, 'STUDENT_PERSISTENCE_FAILED', metadata);
    this.name = 'PersistenceError';
    Error.captureStackTrace?.(this, PersistenceError);
  }
}

module.exports = {
  StudentRepositoryError,
  RepositoryLoadError,
  AggregateBuildError,
  ValidationError,
  MutationError,
  PersistenceError,
};
