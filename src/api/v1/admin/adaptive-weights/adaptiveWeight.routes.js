'use strict';

/**
 * adaptiveWeight.routes.js
 *
 * Mounted at: /api/v1/admin/adaptive-weights
 * Auth:       authenticate + requireAdmin applied by server.js at mount.
 *             Admin-only — never expose to regular users.
 *
 * Route chain:
 *   authenticate → requireAdmin (server.js) → controller method
 *
 * DI wiring:
 *   AdaptiveWeightRepository(db) → AdaptiveWeightService({ repo }) → AdaptiveWeightController({ service })
 *
 * Routes:
 *   GET    /               — fetch weights for a roleFamily/experienceBucket/industryTag combo
 *   POST   /outcome        — record a hiring outcome and trigger weight learning
 *   POST   /override       — apply a manual weight override (freezes learning)
 *   POST   /override/release — release a manual override (resumes learning)
 *
 * CHANGED: require('../../config/supabase') → require('../../config/supabase')
 */

const { Router } = require('express');

const AdaptiveWeightController  = require('./adaptiveWeight.controller');
const { AdaptiveWeightService } = require('./adaptiveWeight.service');
const AdaptiveWeightRepository  = require('./adaptiveWeight.repository');
const { db }                    = require('../../config/supabase');

// ── Dependency injection ──────────────────────────────────────────────────────
const adaptiveWeightRepo    = new AdaptiveWeightRepository(db);
const adaptiveWeightService = new AdaptiveWeightService({ adaptiveWeightRepo });
const controller            = new AdaptiveWeightController({ adaptiveWeightService });

const router = Router();

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/v1/admin/adaptive-weights
// Fetch current adaptive weights for a scoring key.
// Query: ?roleFamily=software_engineer&experienceBucket=3-5&industryTag=fintech
router.get('/', controller.getWeights);

// POST /api/v1/admin/adaptive-weights/outcome
// Record a hiring outcome to update weights via reinforcement learning.
// Body: { roleFamily, experienceBucket, industryTag, predictedScore, actualOutcome }
router.post('/outcome', controller.recordOutcome);

// POST /api/v1/admin/adaptive-weights/override
// Apply a manual weight override — freezes learning for this key.
// Body: { roleFamily, experienceBucket, industryTag, weights: { skills, experience, education, projects } }
router.post('/override', controller.applyOverride);

// POST /api/v1/admin/adaptive-weights/override/release
// Release a manual override — resumes adaptive learning.
// Body: { roleFamily, experienceBucket, industryTag }
router.post('/override/release', controller.releaseOverride);

module.exports = router;









