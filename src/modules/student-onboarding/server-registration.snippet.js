'use strict';

/**
 * server.js — Phase 3D Route Registration Snippet
 *
 * Add these lines to the existing server.js route registration block,
 * alongside the existing /api/v1/student-onboarding mount.
 *
 * The intelligence routes are admin-only (RequireAdmin guard is
 * enforced at the router level in intelligence.routes.js).
 *
 * ─────────────────────────────────────────────────────────────────
 * EXISTING PATTERN (example — matches your current server.js):
 * ─────────────────────────────────────────────────────────────────
 *
 *   const studentOnboarding = require('./modules/student-onboarding');
 *
 *   app.use(
 *     '/api/v1/student-onboarding',
 *     authenticate,
 *     studentOnboarding.routes,
 *   );
 *
 * ─────────────────────────────────────────────────────────────────
 * ADD BELOW (Phase 3D — intelligence diagnostic routes):
 * ─────────────────────────────────────────────────────────────────
 */

// ── Phase 3D: Cross-Domain Intelligence Layer ─────────────────────────────────
// Mounted at /api/v1/intelligence
// Auth: JWT (authenticate) + Admin role (enforced in intelligence.routes.js)
// Purpose: Internal diagnostics only — not student-facing

app.use(
  '/api/v1/intelligence',
  authenticate,
  studentOnboarding.intelligenceRoutes,
);

/**
 * ROUTE SUMMARY
 *
 * GET  /api/v1/intelligence/registry
 *   Returns all active signals in the canonical registry.
 *
 * GET  /api/v1/intelligence/student/:userId/vector
 *   Returns the aggregated signal vector for a student.
 *   404 if pipeline has not run for this user.
 *
 * GET  /api/v1/intelligence/student/:userId/confidence
 *   Returns all signal confidence placeholder models for a student.
 *
 * GET  /api/v1/intelligence/student/:userId/evidence/:signalKey
 *   Returns all evidence records for a specific signal for a student.
 *
 * POST /api/v1/intelligence/student/:userId/trigger
 *   Body: { dry_run?: boolean }  (default: true)
 *   Triggers the cross-domain intelligence aggregation pipeline.
 *   When dry_run=false, writes to student_signal_vectors,
 *   student_signal_evidence, and signal_confidence_models.
 */
