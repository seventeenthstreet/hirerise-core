'use strict';

/**
 * @file src/modules/admin/cms/curriculum/adminCmsCurriculum.errors.js
 *
 * HireRise Curriculum Architecture — Phase 2 / P2.2
 * Admin Configuration Layer — error hierarchy.
 *
 * These are internal/domain-shaped errors thrown by
 * ./adminCmsCurriculum.repository.js and ./adminCmsCurriculum.service.js.
 * ./adminCmsCurriculum.controller.js is responsible for translating them
 * into the project's AppError/sendError HTTP envelope — this file has no
 * HTTP awareness, mirroring domain/curriculum/curriculum.errors.js's
 * (P2.1) rationale for the same split.
 */

class CurriculumAdminError extends Error {
  constructor(message, code, metadata = {}) {
    super(message);
    this.name = 'CurriculumAdminError';
    this.code = code;
    this.metadata = metadata;
    Error.captureStackTrace?.(this, CurriculumAdminError);
  }
}

/** A Postgres/Supabase failure not caused by a governance-guard rejection. */
class CurriculumAdminRepositoryError extends CurriculumAdminError {
  constructor(message, metadata = {}) {
    super(message, 'CURRICULUM_ADMIN_REPOSITORY_ERROR', metadata);
    this.name = 'CurriculumAdminRepositoryError';
  }
}

/**
 * Raised whenever `fn_curriculum_version_lifecycle_guard()` (or any other
 * deployed governance trigger) rejects a write with a
 * "GOVERNANCE_VIOLATION:"-prefixed Postgres exception. Distinct from
 * CurriculumAdminRepositoryError so the service/controller can map this
 * to a 409 Conflict rather than a generic 500 — the request was
 * well-formed, it's the *lifecycle state* that forbids it.
 */
class CurriculumGovernanceViolationError extends CurriculumAdminError {
  constructor(message, metadata = {}) {
    super(message, 'CURRICULUM_GOVERNANCE_VIOLATION', metadata);
    this.name = 'CurriculumGovernanceViolationError';
  }
}

/** The requested curriculum_versions / stream / pathway / group / etc. row does not exist. */
class CurriculumNotFoundError extends CurriculumAdminError {
  constructor(message, metadata = {}) {
    super(message, 'CURRICULUM_NOT_FOUND', metadata);
    this.name = 'CurriculumNotFoundError';
  }
}

/**
 * Raised by the service layer (not the DB) when an Admin action targets a
 * curriculum_versions row, or a row scoped to one, that is not `draft` —
 * i.e. rule 6 ("Published/archived records must not be editable through
 * Admin CRUD") caught before ever reaching the DB, so the caller gets a
 * clean 409 instead of the guard trigger's raw Postgres exception text.
 */
class CurriculumNotEditableError extends CurriculumAdminError {
  constructor(message, metadata = {}) {
    super(message, 'CURRICULUM_NOT_EDITABLE', metadata);
    this.name = 'CurriculumNotEditableError';
  }
}

/** Malformed input to a P2.2 Admin operation — caught before any DB call. */
class CurriculumAdminValidationError extends CurriculumAdminError {
  constructor(message, metadata = {}) {
    super(message, 'CURRICULUM_ADMIN_VALIDATION_ERROR', metadata);
    this.name = 'CurriculumAdminValidationError';
  }
}

/**
 * Raised by publishCurriculumVersion() when pre-publish validation (H)
 * finds the draft configuration invalid. Carries the full list of
 * validation failures in metadata.errors.
 */
class CurriculumDraftInvalidError extends CurriculumAdminError {
  constructor(message, errors, metadata = {}) {
    super(message, 'CURRICULUM_DRAFT_INVALID', { errors, ...metadata });
    this.name = 'CurriculumDraftInvalidError';
    this.errors = errors;
  }
}

module.exports = {
  CurriculumAdminError,
  CurriculumAdminRepositoryError,
  CurriculumGovernanceViolationError,
  CurriculumNotFoundError,
  CurriculumNotEditableError,
  CurriculumAdminValidationError,
  CurriculumDraftInvalidError,
};
