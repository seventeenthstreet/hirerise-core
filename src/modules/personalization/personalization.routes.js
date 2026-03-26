'use strict';

/**
 * personalization.routes.js
 *
 * Registers all AI Personalization Engine endpoints.
 *
 * Mount in server.js — TWO lines after existing route registrations:
 *
 *   app.use(`${API_PREFIX}/career`, authenticate,
 *     require('./modules/personalization/personalization.routes').careerRouter);
 *   app.use(`${API_PREFIX}/user`, authenticate,
 *     require('./modules/personalization/personalization.routes').userRouter);
 *
 * Or combined (simpler):
 *   const personalizationRoutes = require('./modules/personalization/personalization.routes');
 *   app.use(API_PREFIX, authenticate, personalizationRoutes);
 *
 * Endpoints:
 *   GET  /api/v1/career/personalized-recommendations  — personalized career list
 *   POST /api/v1/user/behavior-event                  — track user interaction
 *   GET  /api/v1/user/personalization-profile         — current signal profile
 *   POST /api/v1/user/update-behavior-profile         — manual profile refresh
 *
 * @module src/modules/personalization/personalization.routes
 */

const { Router }    = require('express');
const { body }      = require('express-validator');
const { validate }  = require('../../middleware/requestValidator');
const controller    = require('./personalization.controller');

const router = Router();

// ─── Validation schemas ────────────────────────────────────────────────────────

const VALID_EVENT_TYPES = [
  'job_click', 'job_apply', 'job_save',
  'skill_view', 'skill_search',
  'course_view', 'learning_path_start',
  'career_path_view', 'role_explore',
  'opportunity_click',
  'dashboard_module_usage',
  'advice_read', 'salary_check',
];

const behaviorEventValidators = [
  body('event_type')
    .isString().trim()
    .isIn(VALID_EVENT_TYPES)
    .withMessage(`event_type must be one of: ${VALID_EVENT_TYPES.join(', ')}`),
  body('entity_type')
    .optional({ nullable: true })
    .isString().trim()
    .isIn(['role', 'skill', 'course', 'module', 'path', 'job', 'opportunity'])
    .withMessage('entity_type must be a valid type'),
  body('entity_id')
    .optional({ nullable: true })
    .isString().trim()
    .isLength({ max: 200 }),
  body('entity_label')
    .optional({ nullable: true })
    .isString().trim()
    .isLength({ max: 200 }),
  body('metadata')
    .optional({ nullable: true })
    .isObject(),
  body('session_id')
    .optional({ nullable: true })
    .isString().trim()
    .isLength({ max: 100 }),
];

// ─── Career Routes ─────────────────────────────────────────────────────────────

/**
 * GET /career/personalized-recommendations
 *
 * Returns personalized career roles ranked by behavioral + market signals.
 * Cached for 10 minutes. Pass ?forceRefresh=true to bypass cache.
 */
router.get(
  '/career/personalized-recommendations',
  controller.getPersonalizedRecommendations
);

// ─── User Routes ────────────────────────────────────────────────────────────────

/**
 * POST /user/behavior-event
 *
 * Track a single user behavior event (fire-and-forget from frontend).
 * Validated strictly — unknown event_types are rejected.
 */
router.post(
  '/user/behavior-event',
  validate(behaviorEventValidators),
  controller.trackBehaviorEvent
);

/**
 * GET /user/personalization-profile
 *
 * Returns the user's current derived personalization profile.
 * Shows preferred roles, skills, engagement score, and completeness.
 */
router.get(
  '/user/personalization-profile',
  controller.getPersonalizationProfile
);

/**
 * POST /user/update-behavior-profile
 *
 * Manually triggers a profile analysis refresh.
 * Called automatically every 5 events — this is a manual override.
 */
router.post(
  '/user/update-behavior-profile',
  controller.updateBehaviorProfile
);

module.exports = router;









