'use strict';

/**
 * @file src/domain/permission/permission.errors.js
 *
 * WP-ADMIN-04F-01 — Permission Domain Foundation
 *
 * Named error classes for the Permission domain's lightweight validation
 * boundary. No anonymous `throw new Error(...)` is used anywhere else in
 * this module — every domain-validation failure below is one of these
 * typed subclasses.
 *
 * This mirrors the Student Repository's standalone error hierarchy
 * convention (src/domain/studentProfile/studentProfile.errors.js): a
 * named class per failure category, extending a module-local base rather
 * than the HTTP-status-coupled `AppError` — this is a pure domain module
 * with no HTTP awareness (per WP-ADMIN-04F-01's explicit exclusion of
 * middleware and APIs). Callers at a future HTTP boundary are expected to
 * translate these into `AppError` instances themselves.
 */

/**
 * Base class for every error this module throws. Never thrown directly —
 * always one of the named subclasses below.
 */
class PermissionDomainError extends Error {
  /**
   * @param {string} message
   * @param {string} code - machine-readable error code
   * @param {object} [metadata]
   */
  constructor(message, code, metadata = {}) {
    super(message);
    this.name = 'PermissionDomainError';
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, PermissionDomainError);
  }
}

/**
 * Thrown when a value is not one of the enterprise Resource constants
 * (AUTH-01 §3.4).
 */
class InvalidResourceError extends PermissionDomainError {
  /**
   * @param {*} value - the invalid Resource value
   * @param {object} [metadata]
   */
  constructor(value, metadata = {}) {
    super(`[Permission] invalid Resource: ${JSON.stringify(value)}`, 'PERMISSION_INVALID_RESOURCE', {
      value,
      ...metadata,
    });
    this.name = 'InvalidResourceError';
    Error.captureStackTrace?.(this, InvalidResourceError);
  }
}

/**
 * Thrown when a value is not one of the enterprise Action constants
 * (AUTH-01 §3.5).
 */
class InvalidActionError extends PermissionDomainError {
  /**
   * @param {*} value - the invalid Action value
   * @param {object} [metadata]
   */
  constructor(value, metadata = {}) {
    super(`[Permission] invalid Action: ${JSON.stringify(value)}`, 'PERMISSION_INVALID_ACTION', {
      value,
      ...metadata,
    });
    this.name = 'InvalidActionError';
    Error.captureStackTrace?.(this, InvalidActionError);
  }
}

/**
 * Thrown when a value is not one of the enterprise Permission Category
 * constants (AUTH-01 §3.7).
 */
class InvalidPermissionCategoryError extends PermissionDomainError {
  /**
   * @param {*} value - the invalid Permission Category value
   * @param {object} [metadata]
   */
  constructor(value, metadata = {}) {
    super(
      `[Permission] invalid Permission Category: ${JSON.stringify(value)}`,
      'PERMISSION_INVALID_CATEGORY',
      { value, ...metadata },
    );
    this.name = 'InvalidPermissionCategoryError';
    Error.captureStackTrace?.(this, InvalidPermissionCategoryError);
  }
}

/**
 * Thrown when a value is not one of the enterprise Permission Status
 * constants (AUTH-04 §4, §6).
 */
class InvalidPermissionStatusError extends PermissionDomainError {
  /**
   * @param {*} value - the invalid Permission Status value
   * @param {object} [metadata]
   */
  constructor(value, metadata = {}) {
    super(
      `[Permission] invalid Permission Status: ${JSON.stringify(value)}`,
      'PERMISSION_INVALID_STATUS',
      { value, ...metadata },
    );
    this.name = 'InvalidPermissionStatusError';
    Error.captureStackTrace?.(this, InvalidPermissionStatusError);
  }
}

/**
 * Thrown when a Permission object is malformed — missing a required
 * field, or carrying a field of the wrong shape — independent of whether
 * an individual field value is itself invalid (those raise the more
 * specific errors above).
 */
class InvalidPermissionError extends PermissionDomainError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(`[Permission] malformed Permission: ${message}`, 'PERMISSION_INVALID_PERMISSION', metadata);
    this.name = 'InvalidPermissionError';
    Error.captureStackTrace?.(this, InvalidPermissionError);
  }
}

/**
 * Thrown when an Authorization Context object is malformed (AUTH-01
 * §3.8).
 */
class InvalidAuthorizationContextError extends PermissionDomainError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(
      `[Permission] malformed Authorization Context: ${message}`,
      'PERMISSION_INVALID_AUTHORIZATION_CONTEXT',
      metadata,
    );
    this.name = 'InvalidAuthorizationContextError';
    Error.captureStackTrace?.(this, InvalidAuthorizationContextError);
  }
}

/**
 * Thrown when an Authorization Decision object is malformed (AUTH-03
 * §4).
 */
class InvalidAuthorizationDecisionError extends PermissionDomainError {
  /**
   * @param {string} message
   * @param {object} [metadata]
   */
  constructor(message, metadata = {}) {
    super(
      `[Permission] malformed Authorization Decision: ${message}`,
      'PERMISSION_INVALID_AUTHORIZATION_DECISION',
      metadata,
    );
    this.name = 'InvalidAuthorizationDecisionError';
    Error.captureStackTrace?.(this, InvalidAuthorizationDecisionError);
  }
}

module.exports = {
  PermissionDomainError,
  InvalidResourceError,
  InvalidActionError,
  InvalidPermissionCategoryError,
  InvalidPermissionStatusError,
  InvalidPermissionError,
  InvalidAuthorizationContextError,
  InvalidAuthorizationDecisionError,
};
