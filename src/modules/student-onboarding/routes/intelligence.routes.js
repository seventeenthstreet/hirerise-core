'use strict';

/**
 * src/modules/student-onboarding/routes/intelligence.routes.js
 *
 * Phase 3D — Cross-Domain Intelligence Layer
 * INTELLIGENCE DIAGNOSTIC ROUTES
 *
 * Mounted at: /api/v1/intelligence  (see server.js registration)
 *
 * Auth: All routes require:
 *   1. A valid JWT (authenticate middleware — same as all protected routes).
 *   2. Admin role (requireAdmin middleware — restricts to internal use only).
 *
 * These routes are NOT student-facing. They are internal diagnostics
 * for engineering, QA, and future counselor tooling scaffolding.
 *
 * Routes:
 *   GET  /registry                           — active signal registry
 *   GET  /student/:userId/vector             — signal vector for student
 *   GET  /student/:userId/confidence         — confidence models for student
 *   GET  /student/:userId/evidence/:signalKey — evidence for a signal
 *   POST /student/:userId/trigger            — trigger pipeline (dry_run default)
 */

const router       = require('express').Router();
const ctrl         = require('../controllers/intelligence.controller');
const { asyncHandler } = require('../../../utils/helpers');

// ─────────────────────────────────────────────────────────────────────────────
// Middleware: Admin guard
// Enforces that req.user.role === 'admin' before any intelligence route.
// All intelligence routes are admin-only in Phase 3D.
// ─────────────────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({
      ok:    false,
      error: 'Forbidden — intelligence endpoints require admin role.',
      code:  'INTELLIGENCE_ADMIN_REQUIRED',
    });
  }
  next();
}

// Apply admin guard to all routes in this router
router.use(requireAdmin);

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

// Signal registry — full list of active canonical signals
router.get('/registry', asyncHandler(ctrl.getRegistry));

// Per-student diagnostics
router.get('/student/:userId/vector',              asyncHandler(ctrl.getStudentVector));
router.get('/student/:userId/confidence',          asyncHandler(ctrl.getStudentConfidence));
router.get('/student/:userId/evidence/:signalKey', asyncHandler(ctrl.getSignalEvidence));

// Pipeline trigger (admin only, dry_run=true by default)
router.post('/student/:userId/trigger', asyncHandler(ctrl.triggerPipeline));

module.exports = router;
