'use strict';

/**
 * adminWeights.routes.js — Signal Weight / Model Version Registry
 * (read-only) Admin Endpoints
 *
 * WP-ADMIN-COMP-08-R23 — Signal Weight / Model Version Read-Only Admin
 * Backend Foundation.
 *
 * Follows WP-ADMIN-COMP-08-R22 (verdict C — Dormant infrastructure): the
 * `public.signal_weight_versions` governance registry and its resolution
 * functions (`fn_get_active_weight_version()`, `fn_get_active_model_version()`)
 * are fully built and certified but had no runtime caller anywhere in this
 * repository. R23's sole purpose is to expose that existing, certified
 * registry as a READ-ONLY admin surface — nothing more.
 *
 * ── R23 SCOPE BOUNDARY — READ-ONLY ONLY ─────────────────────────────────
 * This module implements exactly two GET endpoints and nothing else. It
 * deliberately does NOT implement: create version, edit version, delete
 * version, approve version, activate version, deactivate version,
 * deprecate version, restore version, bulk mutation, weight-value
 * changes, or automatic runtime adoption of an active version. It also
 * does NOT modify, mount, or integrate with:
 *   - src/modules/adaptiveWeight/*        (separate live system — a
 *     different registry, different keyspace, no version/approval/
 *     deprecation lifecycle; see R22 §3/§7)
 *   - src/modules/admin/intelligence/adminSignalLineage.*  (separate
 *     table/workflow, `signal_lineage`, coded but intentionally left
 *     unmounted — R23 does not mount it)
 *   - StudentIntelligenceRepository.insertSnapshot() or any onboarding
 *     signal computation (student intelligence runtime remains untouched)
 *   - The governance migrations themselves (20260601000001_..._
 *     RECONSTRUCTED.sql, 20260601000004_governance_refinements.sql) or
 *     either resolution function's SQL body
 *   - The frontend /admin/weights page (front/src/pages/admin/WeightsPage.tsx
 *     remains the pre-existing placeholder; this WP is backend-only)
 *
 * Mounted in server.js as:
 *   app.use(
 *     `${API_PREFIX}/admin/weights`,
 *     authenticate,
 *     requireAdmin,
 *     requireElevatedSession,
 *     require('./modules/admin/weights/adminWeights.routes')
 *   );
 *
 * All routes inherit authenticate + requireAdmin + requireElevatedSession
 * from the mount point — the identical chain used by
 * /admin/users, /admin/cms/*, and /admin/jobs (NOT the older, route-level
 * `verifyAdmin` middleware pattern used by modules/adaptiveWeight/, which
 * is deliberately not reused here — see the R23 implementation report,
 * §2, for why the mount-level chain was chosen over that older pattern).
 * No admin identity is accepted from the request body or query string.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                   │ Description                        │
 * ├──────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /admin/weights         │ List registry versions              │
 * │ GET    │ /admin/weights/active  │ Resolve the currently active version│
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Filtering (R23 §4): both routes accept the same two optional query
 * params — `intelligenceDomain` and `modelType` — validated against the
 * exact enum values `signal_weight_versions.intelligence_domain` and
 * `.model_type`'s own CHECK constraints allow (see
 * supabase/migrations/20260601000004_governance_refinements.sql,
 * `chk_model_type_valid` / the `intelligence_domain IN (...)` constraint).
 * No pagination is implemented — the registry is a low-volume, versioned
 * configuration table (a single seed row per R22's investigation), not a
 * high-cardinality directory like `public.users`; introducing offset/limit
 * here would be speculative, not evidence-driven.
 */

const express = require('express');
const { query } = require('express-validator');
const { validate } = require('../../../middleware/requestValidator');
const ctrl = require('./adminWeights.controller');

const router = express.Router();

// Exact values allowed by signal_weight_versions.model_type's
// chk_model_type_valid CHECK constraint (20260601000004_governance_
// refinements.sql). Single source of truth for this route's validation —
// mirrors adminUsers.routes.js's `isIn(usersRepo.ROLES)` precedent of
// validating against the DB's own allowed-value set.
const MODEL_TYPES = Object.freeze([
  'signal_weights',
  'confidence_model',
  'recommendation_model',
  'matching_model',
  'clustering_model',
  'explainability_model',
]);

// Exact values allowed by signal_weight_versions.intelligence_domain's
// CHECK constraint (same migration).
const INTELLIGENCE_DOMAINS = Object.freeze([
  'student',
  'professional',
  'institution',
  'employer',
  'workforce',
  'cross_domain',
]);

const filterValidators = [
  query('intelligenceDomain')
    .optional()
    .isIn(INTELLIGENCE_DOMAINS)
    .withMessage(`intelligenceDomain must be one of: ${INTELLIGENCE_DOMAINS.join(', ')}`),
  query('modelType')
    .optional()
    .isIn(MODEL_TYPES)
    .withMessage(`modelType must be one of: ${MODEL_TYPES.join(', ')}`),
];

// ── GET /admin/weights ───────────────────────────────────────────────────
router.get('/', validate(filterValidators), ctrl.listVersions);

// ── GET /admin/weights/active ────────────────────────────────────────────
router.get('/active', validate(filterValidators), ctrl.getActiveVersion);

module.exports = router;
