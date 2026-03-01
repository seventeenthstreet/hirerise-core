'use strict';

/**
 * roles.routes.js — Route definitions for the Roles module.
 *
 * Mounted in server.js as:
 *   app.use(`${API_PREFIX}/roles`, authenticate, require('./modules/roles/roles.routes'));
 *
 * Onboarding roles endpoint mounted separately at:
 *   app.use(`${API_PREFIX}/onboarding`, authenticate, require('./modules/onboarding/onboarding.routes'));
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Method  │  Path                      │  Auth  │  Description        │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │  GET     │  /roles                    │  ✓     │  List/search roles  │
 * │  GET     │  /roles/:roleId            │  ✓     │  Single role        │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Onboarding roles routes live in onboarding.routes.js (added via patch below).
 */

const { Router } = require('express');
const {
  validateQuery,
  ListRolesQuerySchema,
} = require('./roles.validator');
const {
  listRoles,
  getRoleById,
  searchRolesForOnboarding,
} = require('./controllers/roles.controller');

const router = Router();

// GET /api/v1/roles?search=engineer&category=engineering&limit=20
router.get(
  '/',
  validateQuery(ListRolesQuerySchema),
  listRoles
);

// GET /api/v1/roles/search  (FIX G-06)
// Onboarding-optimised role search with text matching, family grouping, relevance scoring.
// Query params: q (text), jobFamilyId (filter), limit (max 100, default 30)
// IMPORTANT: Must be registered BEFORE /:roleId to avoid shadowing by the param route.
router.get('/search', searchRolesForOnboarding);

// GET /api/v1/roles/:roleId
router.get('/:roleId', getRoleById);

module.exports = router;