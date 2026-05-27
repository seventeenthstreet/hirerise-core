'use strict';

/**
 * core/src/modules/student-onboarding/validators/activities.validator.js
 *
 * SERVER-SIDE VALIDATION — Activities & Achievement Intelligence (Phase 3B)
 *
 * POSITION IN STACK:
 *   Route → [validateActivitiesPayload middleware] → Controller → Service
 *
 * VALIDATION PHILOSOPHY:
 *   • Server is authoritative. Frontend validation is UX-only.
 *   • Partial saves are supported — depth fields are nullable on partial.
 *   • Achievement saves require a committed (non-partial) parent activity.
 *   • All enum values are checked against constants (never hardcoded strings).
 *
 * ERROR SHAPE:
 *   All errors throw OnboardingValidationError({ message, field, status: 400 })
 */

const {
  ACTIVITY_CATEGORIES,
  PROFICIENCY_LEVELS,
  LEADERSHIP_LEVELS,
  ACHIEVEMENT_LEVELS,
  ACHIEVEMENT_POSITIONS,
  MIN_DURATION_MONTHS,
  MAX_DURATION_MONTHS,
  MAX_WEEKLY_FREQUENCY,
  MIN_ACHIEVEMENT_YEAR,
  MAX_ACHIEVEMENT_YEAR,
  MAX_ACHIEVEMENT_TITLE_LENGTH,
  MAX_REFLECTION_TEXT_LENGTH,
  MAX_ACHIEVEMENTS_PER_ACTIVITY,
  MAX_ACTIVITIES_PER_STUDENT,
} = require('../constants/activities');

// ─────────────────────────────────────────────────────────────────────────────
// Validation error
// ─────────────────────────────────────────────────────────────────────────────

class OnboardingValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name   = 'OnboardingValidationError';
    this.field  = field;
    this.status = 400;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitive validators
// ─────────────────────────────────────────────────────────────────────────────

function requireBody(body) {
  if (body === null || body === undefined || typeof body !== 'object' || Array.isArray(body)) {
    throw new OnboardingValidationError('Request body must be a JSON object.');
  }
}

function requireEnum(value, allowed, fieldName) {
  if (value === undefined || value === null) {
    throw new OnboardingValidationError(`${fieldName} is required.`, fieldName);
  }
  if (!allowed.includes(value)) {
    throw new OnboardingValidationError(
      `${fieldName} must be one of: ${allowed.join(', ')}.`,
      fieldName,
    );
  }
}

function optionalEnum(value, allowed, fieldName) {
  if (value === undefined || value === null) return; // allowed
  if (!allowed.includes(value)) {
    throw new OnboardingValidationError(
      `${fieldName} must be one of: ${allowed.join(', ')}.`,
      fieldName,
    );
  }
}

function requireString(value, fieldName, maxLen = 200) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OnboardingValidationError(`${fieldName} must be a non-empty string.`, fieldName);
  }
  if (value.trim().length > maxLen) {
    throw new OnboardingValidationError(
      `${fieldName} must not exceed ${maxLen} characters.`,
      fieldName,
    );
  }
}

function optionalString(value, fieldName, maxLen) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') {
    throw new OnboardingValidationError(`${fieldName} must be a string.`, fieldName);
  }
  if (maxLen && value.length > maxLen) {
    throw new OnboardingValidationError(
      `${fieldName} must not exceed ${maxLen} characters.`,
      fieldName,
    );
  }
}

function optionalInteger(value, fieldName, min, max) {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value)) {
    throw new OnboardingValidationError(`${fieldName} must be an integer.`, fieldName);
  }
  if (min !== undefined && value < min) {
    throw new OnboardingValidationError(`${fieldName} must be >= ${min}.`, fieldName);
  }
  if (max !== undefined && value > max) {
    throw new OnboardingValidationError(`${fieldName} must be <= ${max}.`, fieldName);
  }
}

function optionalNumber(value, fieldName, min, max) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || isNaN(value)) {
    throw new OnboardingValidationError(`${fieldName} must be a number.`, fieldName);
  }
  if (min !== undefined && value < min) {
    throw new OnboardingValidationError(`${fieldName} must be >= ${min}.`, fieldName);
  }
  if (max !== undefined && value > max) {
    throw new OnboardingValidationError(`${fieldName} must be <= ${max}.`, fieldName);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY UPSERT VALIDATOR
// Used for: POST /step/activities/add and PUT /step/activities/:key/depth
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the payload for adding or updating a student activity.
 *
 * @param {unknown}       body
 * @param {number}        currentActivityCount — used to enforce per-student cap
 * @param {boolean}       isUpdate             — if true, activity_key not required
 * @returns {{ activity_key, activity_category, proficiency_level, duration_months,
 *             weekly_frequency, currently_active, leadership_level, is_partial }}
 * @throws {OnboardingValidationError}
 */
function validateActivityUpsert(body, currentActivityCount, isUpdate = false) {
  requireBody(body);

  const {
    activity_key,
    activity_category,
    proficiency_level,
    duration_months,
    weekly_frequency,
    currently_active,
    leadership_level,
    is_partial,
  } = body;

  // activity_key: required for new activities, not required for depth updates
  if (!isUpdate) {
    requireString(activity_key, 'activity_key', 64);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(activity_key)) {
      throw new OnboardingValidationError(
        'activity_key must be a valid snake_case slug.',
        'activity_key',
      );
    }
    if (currentActivityCount >= MAX_ACTIVITIES_PER_STUDENT) {
      throw new OnboardingValidationError(
        `You may add a maximum of ${MAX_ACTIVITIES_PER_STUDENT} activities.`,
        'activity_key',
      );
    }
  }

  requireEnum(activity_category, ACTIVITY_CATEGORIES, 'activity_category');

  // Proficiency, duration, frequency, leadership: nullable on partial saves
  const isPartialSave = is_partial !== false; // default to partial-safe

  if (!isPartialSave) {
    // Committed save: require depth fields
    requireEnum(proficiency_level, PROFICIENCY_LEVELS, 'proficiency_level');
    requireEnum(leadership_level,  LEADERSHIP_LEVELS,  'leadership_level');
  } else {
    optionalEnum(proficiency_level, PROFICIENCY_LEVELS, 'proficiency_level');
    optionalEnum(leadership_level,  LEADERSHIP_LEVELS,  'leadership_level');
  }

  optionalInteger(duration_months, 'duration_months', MIN_DURATION_MONTHS, MAX_DURATION_MONTHS);
  optionalNumber(weekly_frequency, 'weekly_frequency', 0, MAX_WEEKLY_FREQUENCY);

  if (currently_active !== undefined && currently_active !== null &&
      typeof currently_active !== 'boolean') {
    throw new OnboardingValidationError('currently_active must be a boolean.', 'currently_active');
  }

  return {
    activity_key:      activity_key   ?? undefined,
    activity_category: activity_category,
    proficiency_level: proficiency_level ?? null,
    duration_months:   duration_months   ?? null,
    weekly_frequency:  weekly_frequency  ?? null,
    currently_active:  currently_active  ?? true,
    leadership_level:  leadership_level  ?? 'participant',
    is_partial:        isPartialSave,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ACHIEVEMENT VALIDATOR
// Used for: POST /step/activities/:key/achievements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates an achievement insertion payload.
 *
 * @param {unknown} body
 * @param {number}  existingAchievementCount — enforces per-activity cap
 * @returns {{ achievement_title, achievement_level, achievement_position, achievement_year }}
 * @throws {OnboardingValidationError}
 */
function validateAchievementInsert(body, existingAchievementCount = 0) {
  requireBody(body);

  const { achievement_title, achievement_level, achievement_position, achievement_year } = body;

  if (existingAchievementCount >= MAX_ACHIEVEMENTS_PER_ACTIVITY) {
    throw new OnboardingValidationError(
      `A maximum of ${MAX_ACHIEVEMENTS_PER_ACTIVITY} achievements are allowed per activity.`,
      'achievement_title',
    );
  }

  requireString(achievement_title, 'achievement_title', MAX_ACHIEVEMENT_TITLE_LENGTH);
  requireEnum(achievement_level, ACHIEVEMENT_LEVELS, 'achievement_level');
  optionalEnum(achievement_position, ACHIEVEMENT_POSITIONS, 'achievement_position');
  optionalInteger(achievement_year, 'achievement_year', MIN_ACHIEVEMENT_YEAR, MAX_ACHIEVEMENT_YEAR);

  return {
    achievement_title:    achievement_title.trim(),
    achievement_level:    achievement_level,
    achievement_position: achievement_position ?? null,
    achievement_year:     achievement_year     ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REFLECTION VALIDATOR
// Used for: POST /step/activities/reflection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates the optional reflection payload.
 *
 * @param {unknown} body
 * @returns {{ favorite_activity_key, pursue_seriously_key, proudest_achievement_text }}
 * @throws {OnboardingValidationError}
 */
function validateReflectionUpsert(body) {
  requireBody(body);

  const { favorite_activity_key, pursue_seriously_key, proudest_achievement_text } = body;

  optionalString(favorite_activity_key, 'favorite_activity_key', 64);
  optionalString(pursue_seriously_key,  'pursue_seriously_key',  64);
  optionalString(proudest_achievement_text, 'proudest_achievement_text', MAX_REFLECTION_TEXT_LENGTH);

  return {
    favorite_activity_key:     favorite_activity_key     ?? null,
    pursue_seriously_key:      pursue_seriously_key      ?? null,
    proudest_achievement_text: proudest_achievement_text ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS MIDDLEWARE WRAPPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Express middleware: validates activity upsert body.
 * Attaches req.validatedActivity on success.
 *
 * @type {import('express').RequestHandler}
 */
function validateActivityUpsertMiddleware(req, res, next) {
  try {
    const currentCount = req.currentActivityCount ?? 0;
    const isUpdate     = req.method === 'PUT' || req.method === 'PATCH';
    req.validatedActivity = validateActivityUpsert(req.body, currentCount, isUpdate);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Express middleware: validates achievement insert body.
 * Attaches req.validatedAchievement on success.
 *
 * @type {import('express').RequestHandler}
 */
function validateAchievementInsertMiddleware(req, res, next) {
  try {
    const existingCount = req.existingAchievementCount ?? 0;
    req.validatedAchievement = validateAchievementInsert(req.body, existingCount);
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Express middleware: validates reflection upsert body.
 * Attaches req.validatedReflection on success.
 *
 * @type {import('express').RequestHandler}
 */
function validateReflectionMiddleware(req, res, next) {
  try {
    req.validatedReflection = validateReflectionUpsert(req.body);
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  validateActivityUpsert,
  validateAchievementInsert,
  validateReflectionUpsert,
  validateActivityUpsertMiddleware,
  validateAchievementInsertMiddleware,
  validateReflectionMiddleware,
  OnboardingValidationError,
};
