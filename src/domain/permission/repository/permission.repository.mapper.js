'use strict';

/**
 * @file src/domain/permission/repository/permission.repository.mapper.js
 *
 * WP-ADMIN-04F-02 — Permission Repository
 *
 * Deterministic mapping between persisted `permissions` table rows
 * (snake_case) and the certified domain Permission entity
 * (../permission.model.js), per WP-ADMIN-04F-02's "Repository Mapping —
 * map persisted records to Permission domain objects. Consume the
 * existing domain factories. Do NOT duplicate mapping logic." deliverable.
 *
 * `createPermission()`/`validatePermission()` (../permission.model.js,
 * ../permission.validation.js) remain the single source of truth for
 * what makes a well-formed Permission — this module never re-implements
 * an enum check or a shape check itself. Its only job is field
 * re-shaping (snake_case <-> camelCase) plus attaching the
 * repository-owned fields (`id`, `createdAt`, `updatedAt`) that the
 * frozen domain type intentionally does not carry (WP-ADMIN-04F-01 is a
 * pure domain module with no persistence awareness).
 */

const { createPermission } = require('../permission.model');
const { validatePermission, validatePermissionCategory, validatePermissionStatus } = require('../permission.validation');
const { PermissionDomainError, InvalidPermissionError } = require('../permission.errors');
const { PermissionMappingError, PermissionRepositoryValidationError } = require('./permission.repository.errors');

/**
 * Maps a raw `permissions` table row (snake_case) to a persisted domain
 * Permission — the certified Permission shape plus `id`/`createdAt`/
 * `updatedAt`. Delegates shape/enum validation entirely to
 * `validatePermission()`; if the row does not pass that validation (a
 * corrupt or out-of-band-written row), this throws PermissionMappingError
 * rather than handing a malformed object to a caller.
 *
 * @param {object} row - raw Supabase row
 * @returns {import('../permission.types').Permission & {id: string, createdAt: string, updatedAt: string}}
 * @throws {PermissionMappingError}
 */
function rowToPermission(row) {
  if (!row || typeof row !== 'object') {
    throw new PermissionMappingError('cannot map a null/non-object row to a Permission', { received: row });
  }

  const candidate = {
    name: row.name,
    resource: row.resource,
    action: row.action,
    category: row.category ?? null,
    status: row.status,
    description: row.description ?? null,
  };

  try {
    validatePermission(candidate);
  } catch (error) {
    if (error instanceof PermissionDomainError) {
      throw new PermissionMappingError(`persisted row failed domain validation: ${error.message}`, {
        rowId: row.id,
        cause: error,
      });
    }
    throw error;
  }

  return Object.freeze({
    ...candidate,
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

/**
 * Convenience wrapper for mapping a list of raw rows, preserving order.
 * @param {object[]} rows
 * @returns {Array<import('../permission.types').Permission & {id: string, createdAt: string, updatedAt: string}>}
 */
function rowsToPermissions(rows) {
  return (rows ?? []).map(rowToPermission);
}

/**
 * Maps repository create() input to an insert-ready row payload.
 * Delegates all validation and default-application (e.g. `status`
 * defaulting to PROPOSED, `name` derivation) to the certified domain
 * factory `createPermission()` — this function only re-shapes the
 * already-validated domain Permission into snake_case columns.
 *
 * @param {Object} input
 * @param {import('../permission.types').Resource} input.resource
 * @param {import('../permission.types').Action} input.action
 * @param {import('../permission.types').PermissionCategory} [input.category]
 * @param {import('../permission.types').PermissionStatus} [input.status]
 * @param {string} [input.description]
 * @returns {{row: object, permission: import('../permission.types').Permission}}
 * @throws {PermissionDomainError} via createPermission() for invalid domain input
 */
function createInputToRow(input) {
  const permission = createPermission(input ?? {});

  return {
    permission,
    row: {
      name: permission.name,
      resource: permission.resource,
      action: permission.action,
      category: permission.category,
      status: permission.status,
      description: permission.description,
    },
  };
}

const UPDATABLE_FIELDS = Object.freeze(['category', 'status', 'description']);

/**
 * Maps repository update() input to an update-ready row payload. Only
 * `category`, `status`, and `description` are updatable — `resource`/
 * `action`/`name` are immutable post-creation (see
 * ./permission.repository.contract.js's `update()` doc). Each present
 * field is validated with the matching domain validator before being
 * included, so an update() call can never persist an invalid enum value.
 *
 * @param {Object} updates
 * @param {import('../permission.types').PermissionCategory} [updates.category]
 * @param {import('../permission.types').PermissionStatus} [updates.status]
 * @param {string} [updates.description]
 * @returns {object} snake_case row payload containing only the provided, validated fields
 * @throws {PermissionRepositoryValidationError} if no updatable field is provided
 * @throws {PermissionDomainError} if a provided field value is invalid
 */
function updateInputToRow(updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new PermissionRepositoryValidationError('update() requires an updates object', { received: updates });
  }

  const providedFields = UPDATABLE_FIELDS.filter((field) => Object.prototype.hasOwnProperty.call(updates, field));

  if (providedFields.length === 0) {
    throw new PermissionRepositoryValidationError(
      `update() requires at least one of: ${UPDATABLE_FIELDS.join(', ')}`,
      { received: updates },
    );
  }

  // Each provided field is checked with the same exported validator
  // ../permission.model.js's createPermission() itself calls internally
  // (../permission.validation.js) — centralizing every enum/shape rule in
  // the domain layer, never re-implementing one here.
  const row = {};

  if (providedFields.includes('category')) {
    row.category = validatePermissionCategory(updates.category);
  }
  if (providedFields.includes('status')) {
    row.status = validatePermissionStatus(updates.status);
  }
  if (providedFields.includes('description')) {
    if (updates.description !== null && typeof updates.description !== 'string') {
      throw new InvalidPermissionError('description must be a string or null', { received: updates.description });
    }
    row.description = updates.description;
  }

  return row;
}

module.exports = {
  rowToPermission,
  rowsToPermissions,
  createInputToRow,
  updateInputToRow,
  UPDATABLE_FIELDS,
};
