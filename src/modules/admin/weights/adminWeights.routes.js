'use strict';

/**
 * adminWeights.routes.js — Signal Weight / Model Version Registry
 * Admin Endpoints
 *
 * WP-ADMIN-COMP-08-R23 — Signal Weight / Model Version Read-Only Admin
 * Backend Foundation.
 * WP-ADMIN-COMP-08-R24 — Draft (unapproved) Version Creation.
 * WP-ADMIN-COMP-08-R25 — Version Approval (Draft → Approved).
 *
 * Follows WP-ADMIN-COMP-08-R22 (verdict C — Dormant infrastructure): the
 * `public.signal_weight_versions` governance registry and its resolution
 * functions (`fn_get_active_weight_version()`, `fn_get_active_model_version()`)
 * are fully built and certified but had no runtime caller anywhere in this
 * repository. R23's purpose was to expose that existing, certified
 * registry as a READ-ONLY admin surface. R24 adds exactly one write
 * capability on top of that: creating a new draft row. Nothing else.
 *
 * ── SCOPE BOUNDARY (R24, updated for R25) ─────────────────────────────────
 * This module implements two GET endpoints (R23) and two POST endpoints
 * (R24 create, R25 approve) and nothing else. It deliberately does NOT
 * implement: edit version, delete version, activate version, deactivate
 * version, deprecate version, restore version, bulk mutation, or
 * automatic runtime adoption of an active version. There is no explicit
 * activation operation — R25's approval only sets `approved_by`/
 * `approved_at`; whether an approved version is ever resolvable as active
 * remains entirely governed by the pre-existing, untouched
 * `fn_get_active_model_version()` (its `effective_from <= now()` check in
 * particular). A version created but never approved here can never
 * resolve as active — `fn_get_active_model_version()` hard-requires
 * `approved_at IS NOT NULL` (see adminWeights.repository.js `create()`
 * and, for the approval path, `approve()`). It also does NOT modify,
 * mount, or integrate with:
 *   - src/modules/adaptiveWeight/*        (separate live system — a
 *     different registry, different keyspace, no version/approval/
 *     deprecation lifecycle; see R22 §3/§7)
 *   - src/modules/admin/intelligence/adminSignalLineage.*  (separate
 *     table/workflow, `signal_lineage`, coded but intentionally left
 *     unmounted — R23 does not mount it)
 *   - StudentIntelligenceRepository.insertSnapshot() or any onboarding
 *     signal computation (student intelligence runtime remains untouched)
 *   - The governance migrations themselves (20260601000001_..._
 *     RECONSTRUCTED.sql, 20260601000004_governance_refinements.sql,
 *     20260601000005_migration_1a_04_weight_versions_amendment.sql) or
 *     either resolution function's SQL body
 *   - The frontend /admin/weights page (front/src/pages/admin/WeightsPage.tsx
 *     remains the pre-existing placeholder; R24, like R23, is backend-only —
 *     no frontend mutation UI is added here)
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
 * All routes — including the new POST — inherit authenticate +
 * requireAdmin + requireElevatedSession from the mount point, the
 * identical chain used by /admin/users, /admin/cms/*, and /admin/jobs
 * (NOT the older, route-level `verifyAdmin` middleware pattern used by
 * modules/adaptiveWeight/, which is deliberately not reused here — see
 * the R23 implementation report, §2, for why the mount-level chain was
 * chosen over that older pattern). R24's pre-implementation assessment
 * confirmed this same mount-level chain — without an additional
 * `requirePermission()` gate — is the established, repo-wide pattern for
 * this class of admin configuration mutation (adminCmsRoles, adminCmsSkills,
 * career-domains, job-families, education-levels, salary-benchmarks all
 * follow it identically; `requirePermission()` itself has exactly one
 * caller in the whole repository, and it governs the permission-admin
 * module itself, not a comparable config-mutation module). No admin
 * identity is accepted from the request body or query string — it is
 * always taken from `req.user` (set by `authenticate`).
 *
 * ┌────────────────────────────────────────────────────────────────────────┐
 * │ Method │ Path                        │ Description                     │
 * ├────────────────────────────────────────────────────────────────────────┤
 * │ GET    │ /admin/weights              │ List registry versions          │
 * │ GET    │ /admin/weights/active       │ Resolve the active version      │
 * │ POST   │ /admin/weights              │ Create a draft (unapproved)     │
 * │ POST   │ /admin/weights/:id/approve  │ Approve an eligible draft (R25) │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Filtering (R23 §4): both GET routes accept the same two optional query
 * params — `intelligenceDomain` and `modelType` — validated against the
 * exact enum values `signal_weight_versions.intelligence_domain` and
 * `.model_type`'s own CHECK constraints allow (see
 * supabase/migrations/20260601000004_governance_refinements.sql,
 * `chk_model_type_valid` / the `intelligence_domain IN (...)` constraint).
 * No pagination is implemented — the registry is a low-volume, versioned
 * configuration table, not a high-cardinality directory like `public.users`;
 * introducing offset/limit here would be speculative, not evidence-driven.
 *
 * POST body validation (R24): `modelType` is validated against
 * CREATE_MODEL_TYPES below, which includes `lineage_model` — added by
 * 20260601000005_migration_1a_04_weight_versions_amendment.sql to
 * `chk_model_type_valid` after R23 shipped. The pre-existing GET-side
 * `MODEL_TYPES` constant (used only by the two GET routes' filter
 * validation) is deliberately left as its original 6 values — reconciling
 * that pre-existing drift is out of R24's scope; POST validates against
 * the full, current DB constraint since accepting a client-supplied value
 * the CHECK constraint would then reject is strictly worse than a route
 * that under-accepts on a read-only filter.
 */

const express = require('express');
const { query, body, param } = require('express-validator');
const { validate } = require('../../../middleware/requestValidator');
const ctrl = require('./adminWeights.controller');

const router = express.Router();

// Exact values allowed by signal_weight_versions.model_type's
// chk_model_type_valid CHECK constraint as of 20260601000004_governance_
// refinements.sql (R23's original 6-value vocabulary). Single source of
// truth for the two GET routes' filter validation — mirrors
// adminUsers.routes.js's `isIn(usersRepo.ROLES)` precedent of validating
// against the DB's own allowed-value set. Left unchanged by R24 — see
// module docstring's "POST body validation (R24)" note for why POST uses
// CREATE_MODEL_TYPES instead.
const MODEL_TYPES = Object.freeze([
  'signal_weights',
  'confidence_model',
  'recommendation_model',
  'matching_model',
  'clustering_model',
  'explainability_model',
]);

// Exact values chk_model_type_valid allows as of
// 20260601000005_migration_1a_04_weight_versions_amendment.sql — MODEL_TYPES
// above plus 'lineage_model' (reserved for Phase 2A.1+; the amendment's own
// comment notes no row uses it yet). Used only by the R24 POST route.
const CREATE_MODEL_TYPES = Object.freeze([...MODEL_TYPES, 'lineage_model']);

// Exact values allowed by signal_weight_versions.intelligence_domain's
// CHECK constraint (20260601000004_governance_refinements.sql) — no later
// migration amends this constraint, so the same list is correct for both
// GET filtering and POST creation.
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

// R24: create (draft) body validation. `weights`/`domainOverrides`/
// `weightRationale` are validated only for "is this a JSON object" —
// matching the DB's own chk_weights_is_object / chk_domain_overrides_is_object
// / chk_weight_rationale_is_object constraints; no per-model_type payload
// shape is validated anywhere in the DB or code, so none is invented here.
const createValidators = [
  body('versionTag').isString().trim().isLength({ min: 1, max: 200 }),

  body('modelType')
    .isIn(CREATE_MODEL_TYPES)
    .withMessage(`modelType must be one of: ${CREATE_MODEL_TYPES.join(', ')}`),

  body('intelligenceDomain')
    .isIn(INTELLIGENCE_DOMAINS)
    .withMessage(`intelligenceDomain must be one of: ${INTELLIGENCE_DOMAINS.join(', ')}`),

  body('description').isString().trim().isLength({ min: 1 }),

  body('weights')
    .isObject()
    .withMessage('weights must be a JSON object'),

  body('domainOverrides')
    .optional()
    .isObject()
    .withMessage('domainOverrides must be a JSON object'),

  body('weightRationale')
    .optional()
    .isObject()
    .withMessage('weightRationale must be a JSON object'),

  body('effectiveFrom')
    .optional()
    .isISO8601()
    .withMessage('effectiveFrom must be an ISO 8601 timestamp'),

  // Draft-only, R24 §non-goals: reject any attempt to set lifecycle
  // fields at creation time, whether camelCase (API shape) or snake_case
  // (DB column shape) — the repository also independently forces these
  // to null (defense in depth, not the sole guard).
  body('approvedBy').not().exists().withMessage('approvedBy cannot be set on creation'),
  body('approvedAt').not().exists().withMessage('approvedAt cannot be set on creation'),
  body('deprecatedAt').not().exists().withMessage('deprecatedAt cannot be set on creation'),
  body('approved_by').not().exists().withMessage('approved_by cannot be set on creation'),
  body('approved_at').not().exists().withMessage('approved_at cannot be set on creation'),
  body('deprecated_at').not().exists().withMessage('deprecated_at cannot be set on creation'),
  body('id').not().exists(),
];

// R25: approval body — the version id comes only from the path
// (req.params.id, validated below) and the approving actor only from
// req.user.id; no request-body field is read by the approval handler at
// all (see adminWeights.controller.js's approveVersion()), so there is
// nothing to validate on the body here.
const approveValidators = [
  param('id').isUUID().withMessage('id must be a valid UUID'),
];

// ── GET /admin/weights ───────────────────────────────────────────────────
router.get('/', validate(filterValidators), ctrl.listVersions);

// ── GET /admin/weights/active ────────────────────────────────────────────
router.get('/active', validate(filterValidators), ctrl.getActiveVersion);

// ── POST /admin/weights ──────────────────────────────────────────────────
router.post('/', validate(createValidators), ctrl.createVersion);

// ── POST /admin/weights/:id/approve — WP-ADMIN-COMP-08-R25 ──────────────
router.post('/:id/approve', validate(approveValidators), ctrl.approveVersion);

module.exports = router;