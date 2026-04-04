'use strict';

/**
 * src/modules/roles/roles.routes.js
 *
 * Supabase-ready route definitions for the Roles module.
 *
 * Mounted in server.js:
 *   app.use(`${API_PREFIX}/roles`, authenticate, require('./modules/roles/roles.routes'));
 *
 * Responsibilities:
 *   - Route registration only
 *   - Query validation middleware
 *   - Controller delegation
 *
 * Notes:
 *   - No business logic
 *   - No auth logic
 *   - Search route must be declared before /:roleId
 */

const { Router } = require('express');

const {
  validateQuery,
  ListRolesQuerySchema,
} = require('./roles.validator');

const rolesController = require('./controllers/roles.controller');

const router = Router();

/**
 * GET /api/v1/roles
 * Query:
 *   search?: string
 *   category?: string
 *   limit?: number
 */
router.get(
  '/',
  validateQuery(ListRolesQuerySchema),
  rolesController.listRoles
);

/**
 * GET /api/v1/roles/search
 *
 * Onboarding-optimized role search with:
 *   - text matching
 *   - job family grouping
 *   - relevance scoring
 *
 * IMPORTANT:
 * Must stay before /:roleId
 */
router.get(
  '/search',
  rolesController.searchRolesForOnboarding
);

/**
 * GET /api/v1/roles/:roleId
 */
router.get(
  '/:roleId',
  rolesController.getRoleById
);

module.exports = router;