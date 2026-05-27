'use strict';

/**
 * core/src/modules/student-onboarding/routes/activities.routes.js
 *
 * EXPRESS ROUTES — Activities Step (Phase 3B)
 *
 * BASE: /api/v1/student-onboarding/v2/step/activities
 *
 * Middleware stack (applied before each route):
 *   1. requireAuth          — ensures req.user is set
 *   2. requireSession       — ensures req.onboardingSession is set
 *   3. validate*Middleware  — payload validation (per-route)
 *   4. controller           — delegates to service
 *
 * PROGRESSIVE PERSISTENCE:
 *   Every mutation endpoint persists immediately and returns signal_quality.
 *   There is no "save draft" vs "submit" distinction at the HTTP layer —
 *   is_partial in the body controls that distinction at the DB layer.
 */

const express = require('express');
const router  = express.Router();

const ctrl = require('../controllers/activities.controller');
const {
  validateActivityUpsertMiddleware,
  validateAchievementInsertMiddleware,
  validateReflectionMiddleware,
} = require('../validators/activities.validator');

// ── Prerequisite count middleware ─────────────────────────────────────────────
// Fetches current activity count and attaches to req before validation.
// Ensures per-student cap is enforced server-side.
const { fetchActivitySignalQuality } = require('../repositories/activity.repository');

async function attachActivityCounts(req, res, next) {
  try {
    const quality = await fetchActivitySignalQuality(req.supabase, req.user.id);
    req.currentActivityCount = quality.total_count;
    next();
  } catch (err) {
    next(err);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /step/activities
 * Returns: taxonomy, student activities, achievements, reflection, signal_quality
 */
router.get('/', ctrl.getActivities);

/**
 * POST /step/activities/add
 * Body: { activity_key, activity_category, ...optional depth fields }
 * Immediately persists as is_partial = true.
 */
router.post(
  '/add',
  attachActivityCounts,
  validateActivityUpsertMiddleware,
  ctrl.addActivity,
);

/**
 * PUT /step/activities/:activityKey/depth
 * Body: { proficiency_level, duration_months, weekly_frequency, currently_active,
 *         leadership_level, is_partial }
 * Updates depth. is_partial = false commits the activity.
 */
router.put(
  '/:activityKey/depth',
  validateActivityUpsertMiddleware,
  ctrl.updateActivityDepth,
);

/**
 * DELETE /step/activities/:activityKey
 * Removes the activity and all its achievements (via CASCADE).
 */
router.delete('/:activityKey', ctrl.removeActivity);

/**
 * POST /step/activities/:activityKey/achievements
 * Body: { achievement_title, achievement_level, achievement_position?, achievement_year? }
 */
router.post(
  '/:activityKey/achievements',
  validateAchievementInsertMiddleware,
  ctrl.addAchievement,
);

/**
 * DELETE /step/activities/achievements/:achievementId
 */
router.delete('/achievements/:achievementId', ctrl.removeAchievement);

/**
 * POST /step/activities/reflection
 * Body: { favorite_activity_key?, pursue_seriously_key?, proudest_achievement_text? }
 * Optional — never blocks step progression.
 */
router.post('/reflection', validateReflectionMiddleware, ctrl.upsertReflection);

/**
 * POST /step/activities/commit
 * Advances session to 'cognitive'. Requires signal_quality.is_sufficient = true.
 */
router.post('/commit', ctrl.commitStep);

module.exports = router;
