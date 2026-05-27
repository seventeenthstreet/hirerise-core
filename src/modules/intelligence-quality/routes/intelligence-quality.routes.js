'use strict';

/**
 * src/modules/intelligence-quality/routes/intelligence-quality.routes.js
 *
 * Mounted at: /api/v1/intelligence-quality
 * Authentication: applied at server.js level (authenticate middleware)
 *
 * Endpoints:
 *
 *   GET  /report            — full quality report (coverage + reliability + stability + drift)
 *   GET  /coverage          — signal coverage profile only
 *   GET  /stability         — cluster stability profiles only
 *   GET  /drift             — latest drift event + history
 *   GET  /sparsity          — current sparsity status + suppression state
 *   GET  /explainability    — human-readable quality narratives
 *
 * Design constraints:
 *   - Read-only endpoints (GET only) — quality scoring is computed by the pipeline
 *   - No scoring triggered here — route is display/reporting layer only
 *   - Governance-safe: no raw answer data exposed
 *   - Standard { success, data } response envelope
 */

const { Router } = require('express');
const intelligenceQualityController = require('../controllers/intelligence-quality.controller');

const router = Router();

// ── Full quality report (most common endpoint — dashboard widget) ──────────────
router.get('/report',         intelligenceQualityController.getQualityReport);

// ── Individual quality dimensions ──────────────────────────────────────────────
router.get('/coverage',       intelligenceQualityController.getCoverageProfile);
router.get('/stability',      intelligenceQualityController.getStabilityProfiles);
router.get('/drift',          intelligenceQualityController.getDriftHistory);
router.get('/explainability', intelligenceQualityController.getExplainability);

module.exports = Object.freeze(router);
