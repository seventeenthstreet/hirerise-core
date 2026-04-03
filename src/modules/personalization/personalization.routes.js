'use strict';

/**
 * src/modules/personalization/personalization.routes.js
 *
 * Registers AI Personalization Engine endpoints.
 *
 * Preferred mount:
 *   app.use(
 *     `${API_PREFIX}`,
 *     authenticate,
 *     require('./modules/personalization/personalization.routes')
 *   );
 *
 * Endpoints:
 *   GET  /career/personalized-recommendations
 *   POST /user/behavior-event
 *   GET  /user/personalization-profile
 *   POST /user/update-behavior-profile
 *
 * Supabase migration notes:
 * - No Firebase dependencies existed
 * - Cleaned route structure for long-term scalability
 * - Hardened request validation boundaries
 * - Prepared for RBAC / tenant middleware layering
 */

const { Router } = require('express');
const { body } = require('express-validator');
const { validate } = require('../../middleware/requestValidator');
const controller = require('./personalization.controller');

const router = Router();

// ───────────────────────────────────────────────────────────────────────────────
// Validation constants
// ───────────────────────────────────────────────────────────────────────────────

const VALID_EVENT_TYPES = Object.freeze([
  'job_click',
  'job_apply',
  'job_save',
  'skill_view',
  'skill_search',
  'course_view',
  'learning_path_start',
  'career_path_view',
  'role_explore',
  'opportunity_click',
  'dashboard_module_usage',
  'advice_read',
  'salary_check',
]);

const VALID_ENTITY_TYPES = Object.freeze([
  'role',
  'skill',
  'course',
  'module',
  'path',
  'job',
  'opportunity',
]);

// ───────────────────────────────────────────────────────────────────────────────
// Validators
// ───────────────────────────────────────────────────────────────────────────────

const behaviorEventValidators = [
  body('event_type')
    .exists({ checkFalsy: true })
    .withMessage('event_type is required')
    .bail()
    .isString()
    .trim()
    .isIn(VALID_EVENT_TYPES)
    .withMessage(
      `event_type must be one of: ${VALID_EVENT_TYPES.join(', ')}`
    ),

  body('entity_type')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isIn(VALID_ENTITY_TYPES)
    .withMessage('entity_type must be a valid type'),

  body('entity_id')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 200 })
    .withMessage('entity_id must be 200 characters or fewer'),

  body('entity_label')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 200 })
    .withMessage('entity_label must be 200 characters or fewer'),

  body('metadata')
    .optional({ nullable: true })
    .isObject()
    .withMessage('metadata must be a valid object'),

  body('session_id')
    .optional({ nullable: true })
    .isString()
    .trim()
    .isLength({ max: 100 })
    .withMessage('session_id must be 100 characters or fewer'),
];

// ───────────────────────────────────────────────────────────────────────────────
// Career routes
// ───────────────────────────────────────────────────────────────────────────────

router.get(
  '/career/personalized-recommendations',
  controller.getPersonalizedRecommendations
);

// ───────────────────────────────────────────────────────────────────────────────
// User routes
// ───────────────────────────────────────────────────────────────────────────────

router.post(
  '/user/behavior-event',
  validate(behaviorEventValidators),
  controller.trackBehaviorEvent
);

router.get(
  '/user/personalization-profile',
  controller.getPersonalizationProfile
);

router.post(
  '/user/update-behavior-profile',
  controller.updateBehaviorProfile
);

module.exports = router;