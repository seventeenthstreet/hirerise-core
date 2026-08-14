'use strict';

/**
 * @file src/modules/admin/permissions/validators/permissionAdmin.validators.js
 *
 * WP-ADMIN-04F-08 — Enterprise Permission Administration API
 *
 * Request-shape validation only (route params, query params, request
 * body). This never duplicates domain validation — the certified Domain
 * layer (permission.model.js's factories) and each certified service's
 * own request-shape validation still run unchanged when a controller
 * calls into them; these chains only reject a request early when it
 * cannot possibly be well-formed (missing fields, wrong primitive
 * types), following the same `express-validator` + `validate()`
 * convention already used by
 * `src/routes/admin/adminContributors.routes.js`.
 */

const { param, query, body } = require('express-validator');

const PAGE_LIMIT_MAX = 200;

const paginationQuery = [
  query('limit')
    .optional()
    .isInt({ min: 1, max: PAGE_LIMIT_MAX })
    .toInt()
    .withMessage(`limit must be between 1 and ${PAGE_LIMIT_MAX}`),
  query('offset')
    .optional()
    .isInt({ min: 0 })
    .toInt()
    .withMessage('offset must be a non-negative integer'),
];

// ── Registry ──────────────────────────────────────────────────────────

// WP-ADMIN-04F-13B — additive opt-in filter. Narrows a Registry Discovery
// response to Permissions the certified Assignment Policy currently
// considers assignable (see permissionRegistry.controller.js's
// `applyAssignableOnlyFilter`). Omitted entirely, every endpoint below
// behaves exactly as it did before this WP.
const assignableOnlyQuery = [
  query('assignableOnly')
    .optional()
    .isBoolean()
    .withMessage('assignableOnly must be a boolean')
    .toBoolean(),
];

const listPermissions = [...paginationQuery, ...assignableOnlyQuery];

const getPermissionById = [
  param('id').isString().trim().notEmpty().withMessage('id is required'),
];

const getPermissionByIdentity = [
  param('identity').isString().trim().notEmpty().withMessage('identity is required'),
];

const findByResource = [
  param('resource').isString().trim().notEmpty().withMessage('resource is required'),
  ...paginationQuery,
  ...assignableOnlyQuery,
];

const findByAction = [
  param('action').isString().trim().notEmpty().withMessage('action is required'),
  ...paginationQuery,
  ...assignableOnlyQuery,
];

const findByCategory = [
  param('category').isString().trim().notEmpty().withMessage('category is required'),
  ...paginationQuery,
  ...assignableOnlyQuery,
];

// ── Assignment ────────────────────────────────────────────────────────

const assignmentMutationBody = [
  body('principalId').isString().trim().notEmpty().withMessage('principalId is required'),
  body('resource').isString().trim().notEmpty().withMessage('resource is required'),
  body('action').isString().trim().notEmpty().withMessage('action is required'),
];

const checkAssignmentQuery = [
  query('principalId').isString().trim().notEmpty().withMessage('principalId is required'),
  query('resource').isString().trim().notEmpty().withMessage('resource is required'),
  query('action').isString().trim().notEmpty().withMessage('action is required'),
];

const listAssignmentsQuery = [
  query('resource').isString().trim().notEmpty().withMessage('resource is required'),
  query('action').isString().trim().notEmpty().withMessage('action is required'),
];

const assignmentsForPrincipal = [
  param('principalId').isString().trim().notEmpty().withMessage('principalId is required'),
];

// ── Governance ────────────────────────────────────────────────────────

const governanceTransition = [
  param('id').isString().trim().notEmpty().withMessage('id is required'),
];

// ── History (WP-ADMIN-05D) ───────────────────────────────────────────
//
// Read-only query-shape validation for the Permission History timeline.
// Reuses `paginationQuery` rather than redefining limit/offset — the
// same PAGE_LIMIT_MAX ceiling this file already enforces everywhere
// else. `action`/`adminId`/date-range/`sort` are additive filters; all
// optional, so the plain paginated timeline (no filter) is still just
// `GET /permissions/:id/history` with no query string.
//
// `action` is intentionally NOT restricted here to an enum of the 7
// Permission audit actions (permissionAudit.constants.js's ACTIONS) —
// this validator only rejects a request that cannot possibly be
// well-formed (wrong primitive type), per this file's own header
// convention. An unrecognized action value is handled one layer down,
// in permissionHistory.repository.js (silently ignored rather than
// producing a confusing empty page for a typo), not rejected with a 400
// here — that keeps this validators file free of a second copy of the
// Permission audit action vocabulary.
const PERMISSION_HISTORY_SORT_VALUES = ['asc', 'desc'];

const historyQuery = [
  ...paginationQuery,
  query('action').optional().isString().trim().notEmpty().withMessage('action must be a non-empty string'),
  query('adminId').optional().isString().trim().notEmpty().withMessage('adminId must be a non-empty string'),
  query('dateFrom').optional().isISO8601().withMessage('dateFrom must be an ISO 8601 date/datetime'),
  query('dateTo').optional().isISO8601().withMessage('dateTo must be an ISO 8601 date/datetime'),
  query('sort')
    .optional()
    .isIn(PERMISSION_HISTORY_SORT_VALUES)
    .withMessage(`sort must be one of: ${PERMISSION_HISTORY_SORT_VALUES.join(', ')}`),
];

const permissionHistoryById = [
  param('id').isString().trim().notEmpty().withMessage('id is required'),
  ...historyQuery,
];

// ── Evaluation ────────────────────────────────────────────────────────

const evaluate = [
  body('principalId').isString().trim().notEmpty().withMessage('principalId is required'),
  body('resource').isString().trim().notEmpty().withMessage('resource is required'),
  body('action').isString().trim().notEmpty().withMessage('action is required'),
  body('resourceId').optional().isString().trim(),
  body('metadata').optional().isObject().withMessage('metadata must be an object'),
];

module.exports = {
  listPermissions,
  getPermissionById,
  getPermissionByIdentity,
  findByResource,
  findByAction,
  findByCategory,
  assignmentMutationBody,
  checkAssignmentQuery,
  listAssignmentsQuery,
  assignmentsForPrincipal,
  governanceTransition,
  evaluate,
  historyQuery,
  permissionHistoryById,
};
