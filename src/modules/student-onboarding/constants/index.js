'use strict';

/**
 * src/modules/student-onboarding/constants/index.js
 *
 * Single source of truth for all enum values and step ordering
 * used across the student-onboarding module.
 *
 * Rules:
 *  - All step ordering derives from ONBOARDING_STEPS array.
 *  - Progression helpers must not duplicate this order.
 *  - Add future steps here first, then wire routes/services.
 */

/**
 * Full canonical step sequence, in order.
 * 'processing' and 'result' are navigation states, not data steps.
 *
 * @type {readonly string[]}
 */
const ONBOARDING_STEPS = Object.freeze([
  'education',
  'academics',
  'activities',
  'cognitive',
  'aspiration',
  'processing',
  'result',
]);

/**
 * Steps that require active data submission from the student.
 * Excludes 'processing' and 'result' which are system-driven states.
 * Used for completion percentage calculation and "is done" detection.
 *
 * @type {readonly string[]}
 */
const COMPLETABLE_STEPS = Object.freeze([
  'education',
  'academics',
  'activities',
  'cognitive',
  'aspiration',
]);

/**
 * Valid education_level enum values.
 * Must match the CHECK constraint in the SQL migration.
 *
 * @type {readonly string[]}
 */
const EDUCATION_LEVELS = Object.freeze([
  'class_8',
  'class_9',
  'class_10',
  'class_11',
  'class_12',
]);

/**
 * Valid board_type enum values.
 * Must match the CHECK constraint in the SQL migration.
 *
 * @type {readonly string[]}
 */
const BOARD_TYPES = Object.freeze([
  'cbse',
  'icse',
  'state',
  'ib',
  'other',
]);

/**
 * Valid school_type enum values.
 * Must match the CHECK constraint in the SQL migration.
 *
 * @type {readonly string[]}
 */
const SCHOOL_TYPES = Object.freeze([
  'government',
  'private',
  'aided',
]);

/**
 * Engine version stamped onto new onboarding sessions.
 * Increment when intelligence engine weights change to allow
 * targeted reprocessing of older sessions.
 *
 * @type {string}
 */
const ENGINE_VERSION = '1.0.0';

module.exports = {
  ONBOARDING_STEPS,
  COMPLETABLE_STEPS,
  EDUCATION_LEVELS,
  BOARD_TYPES,
  SCHOOL_TYPES,
  ENGINE_VERSION,
};
