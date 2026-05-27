'use strict';

/**
 * src/modules/student-onboarding/routes/cognitive.routes.js
 *
 * EXPRESS ROUTES — Cognitive Step (Phase 3C)
 *
 * BASE: /api/v1/student-onboarding/v2/step/cognitive
 * MOUNT: See route-registration.snippet.js
 *
 * Middleware stack applied at the parent mount point (not in this file):
 *   1. requireAuth      — validates Bearer token, attaches req.user
 *   2. requireSession   — attaches req.onboardingSession + req.sessionService
 *
 * Per-route middleware in this file:
 *   3. validate*Middleware — payload validation
 *   4. controller          — delegates to service
 *
 * AUTH MODEL:
 *   requireAuth and requireSession are applied at the app.use() mount in server.js,
 *   mirroring the Phase 3B activities pattern exactly. This file assumes req.user
 *   and req.supabase are already populated.
 *
 * PROGRESSIVE PERSISTENCE:
 *   Every POST /response and POST /responses/batch persists immediately.
 *   is_partial = true on individual saves; false after /commit.
 *
 * SESSION ADVANCEMENT:
 *   POST /commit does NOT advance the session. page.tsx handles session
 *   advancement via useUpdateOnboardingStep after onComplete() is called.
 *   This mirrors the 'academics' step pattern, not 'activities'.
 */

const express = require('express');
const router  = express.Router();

const ctrl = require('../controllers/cognitive.controller');
const {
  validateSaveResponseMiddleware,
  validateBatchResponsesMiddleware,
} = require('../validators/cognitive.validator');

// ─────────────────────────────────────────────────────────────────────────────
// GET /
// Returns: { ok, taxonomy, responses, signals, signal_quality }
// Safe to call on mount and on refresh — drives full recovery.
// ─────────────────────────────────────────────────────────────────────────────

router.get('/', ctrl.getCognitiveStep);

// ─────────────────────────────────────────────────────────────────────────────
// POST /response
// Body:    { question_id: uuid, selected_option_keys: string[], is_partial?: boolean }
// Returns: { ok, response, signal_quality }
// Progressive persistence — fires on every option tap.
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/response',
  validateSaveResponseMiddleware,
  ctrl.saveResponse,
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /responses/batch
// Body:    { responses: [{ question_id, selected_option_keys }] }
// Returns: { ok, responses, signal_quality }
// ─────────────────────────────────────────────────────────────────────────────

router.post(
  '/responses/batch',
  validateBatchResponsesMiddleware,
  ctrl.batchSaveResponses,
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /commit
// Body:    {}
// Returns: { ok, signals, signal_quality }
// Errors:  422 COGNITIVE_SIGNAL_INSUFFICIENT — required questions not answered
// Extracts cognitive signals and marks all responses as committed.
// Does NOT advance the session — page.tsx useUpdateOnboardingStep handles that.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/commit', ctrl.commitStep);

module.exports = router;
