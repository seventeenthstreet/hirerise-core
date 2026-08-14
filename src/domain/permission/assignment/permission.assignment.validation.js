'use strict';

/**
 * @file src/domain/permission/assignment/permission.assignment.validation.js
 *
 * WP-ADMIN-04F-06 — Enterprise Permission Assignment Services
 *
 * Assignment-specific request validation only: is this something the
 * Service can even attempt to assign/revoke/look up, before Registry or
 * Evaluation are consulted. Does not duplicate Evaluation's own request
 * validation (../evaluation/permission.evaluation.validation.js) — that
 * still runs, unchanged, inside Evaluation when the Service calls
 * `evaluate()`; this module only catches malformed Assignment requests
 * early, with an Assignment-specific error.
 */

const { InvalidAssignmentError } = require('./permission.assignment.errors');

/**
 * Validates the raw shape of an assignment/revocation/lookup request
 * naming a Principal and a Permission (`{ principalId, resource, action }`).
 *
 * @param {*} request
 */
function validatePermissionRequestShape(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new InvalidAssignmentError('request must be a non-null object', {
      received: request === null ? 'null' : typeof request,
    });
  }

  const { principalId, resource, action } = request;

  if (typeof principalId !== 'string' || principalId.length === 0) {
    throw new InvalidAssignmentError('request requires a non-empty string "principalId"', { received: principalId });
  }
  if (typeof resource !== 'string' || resource.length === 0) {
    throw new InvalidAssignmentError('request requires a non-empty string "resource"', { received: resource });
  }
  if (typeof action !== 'string' || action.length === 0) {
    throw new InvalidAssignmentError('request requires a non-empty string "action"', { received: action });
  }
}

/**
 * Validates the raw shape of a principal-scoped lookup request
 * (`getAssignments`), which names only a Principal.
 *
 * @param {*} request
 */
function validatePrincipalRequestShape(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new InvalidAssignmentError('request must be a non-null object', {
      received: request === null ? 'null' : typeof request,
    });
  }
  if (typeof request.principalId !== 'string' || request.principalId.length === 0) {
    throw new InvalidAssignmentError('request requires a non-empty string "principalId"', { received: request.principalId });
  }
}

module.exports = {
  validatePermissionRequestShape,
  validatePrincipalRequestShape,
};
