'use strict';

/**
 * src/modules/source-intelligence/errors/sim.errors.js
 *
 * SIM-scoped error types. Mirrors the lightweight createError() pattern
 * already used across src/modules (see university.service.js) so SIM
 * plugs into the existing errorHandler middleware without changes to
 * any frozen runtime component.
 */

const SIM_ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 'SIM_VALIDATION_ERROR',
  NOT_FOUND: 'SIM_SOURCE_NOT_FOUND',
  DUPLICATE_SOURCE: 'SIM_DUPLICATE_SOURCE',
  INVALID_TRANSITION: 'SIM_INVALID_STATUS_TRANSITION',
  GOVERNANCE_VIOLATION: 'SIM_GOVERNANCE_VIOLATION',
  INTERNAL_ERROR: 'SIM_INTERNAL_ERROR',
});

class SimError extends Error {
  constructor(message, statusCode = 500, code = SIM_ERROR_CODES.INTERNAL_ERROR, details = null) {
    super(message);
    this.name = 'SimError';
    this.statusCode = statusCode;
    this.code = code;
    if (details) this.details = details;
  }
}

const badRequest = (message, details) =>
  new SimError(message, 400, SIM_ERROR_CODES.VALIDATION_ERROR, details);

const notFound = (message = 'Source not found.') =>
  new SimError(message, 404, SIM_ERROR_CODES.NOT_FOUND);

const conflict = (message, code = SIM_ERROR_CODES.DUPLICATE_SOURCE, details) =>
  new SimError(message, 409, code, details);

const invalidTransition = (fromStatus, toStatus) =>
  new SimError(
    `Cannot transition source from '${fromStatus}' to '${toStatus}'.`,
    409,
    SIM_ERROR_CODES.INVALID_TRANSITION,
    { fromStatus, toStatus }
  );

const governanceViolation = (message, details) =>
  new SimError(message, 403, SIM_ERROR_CODES.GOVERNANCE_VIOLATION, details);

module.exports = {
  SIM_ERROR_CODES,
  SimError,
  badRequest,
  notFound,
  conflict,
  invalidTransition,
  governanceViolation,
};
