'use strict';

/**
 * src/config/eventWeights.config.js
 *
 * Single source of truth for:
 * - scoring constants
 * - behavioral thresholds
 * - cache TTLs
 * - dedupe windows
 * - decay windows
 *
 * This file MUST remain:
 * - pure
 * - deterministic
 * - side-effect free (except startup validation)
 * - database agnostic
 *
 * No business logic should live here.
 */

/* -------------------------------------------------------------------------- */
/*                              INTERNAL HELPERS                              */
/* -------------------------------------------------------------------------- */

/**
 * Deep freezes nested config objects to prevent runtime mutation.
 *
 * @template T
 * @param {T} obj
 * @returns {Readonly<T>}
 */
function deepFreeze(obj) {
  if (!obj || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }

  for (const key of Object.getOwnPropertyNames(obj)) {
    const value = obj[key];
    if (value && typeof value === 'object') {
      deepFreeze(value);
    }
  }

  return Object.freeze(obj);
}

/**
 * Ensures a numeric config value is valid.
 *
 * @param {string} name
 * @param {number} value
 * @param {{ min?: number, max?: number }} [options]
 */
function assertNumber(name, value, options = {}) {
  const { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = options;

  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number. Received: ${value}`);
  }

  if (value < min || value > max) {
    throw new RangeError(
      `${name} must be between ${min} and ${max}. Received: ${value}`
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                             SCORE VERSIONING                               */
/* -------------------------------------------------------------------------- */

/**
 * Increment when scoring logic materially changes.
 * Enables:
 * - analytics segmentation
 * - score backfills
 * - safe A/B migrations
 */
const SCORE_VERSION = 2;

/* -------------------------------------------------------------------------- */
/*                         ENGAGEMENT-DIMENSION WEIGHTS                       */
/* -------------------------------------------------------------------------- */

const ENGAGEMENT_WEIGHTS = {
  resume_uploaded: 20,
  resume_scored: 10,
  skill_test_started: 15,
  profile_completion_updated: 12,

  // Onboarding funnel analytics events
  onboarding_step_completed: 0,
  onboarding_completed: 0,
};

/* -------------------------------------------------------------------------- */
/*                       MONETIZATION-DIMENSION WEIGHTS                       */
/* -------------------------------------------------------------------------- */

const MONETIZATION_WEIGHTS = {
  salary_locked_feature_clicked: 25,
  pricing_page_viewed: 15,
  subscription_started: 30,
  salary_report_viewed: 12,
};

/* -------------------------------------------------------------------------- */
/*                          DIMENSION BLENDING WEIGHTS                        */
/* -------------------------------------------------------------------------- */

/**
 * totalIntentScore =
 *   engagementScore * engagement
 * + monetizationScore * monetization
 */
const DIMENSION_WEIGHTS = {
  engagement: 0.6,
  monetization: 0.4,
};

/* -------------------------------------------------------------------------- */
/*                             COUNTER CONTROLS                               */
/* -------------------------------------------------------------------------- */

const MAX_EVENT_REPETITIONS = 3;
const HARD_COUNTER_LIMIT = 10;

/* -------------------------------------------------------------------------- */
/*                               CACHE CONFIG                                 */
/* -------------------------------------------------------------------------- */

const SCORE_CACHE_TTL_SECONDS = 5 * 60;

/* -------------------------------------------------------------------------- */
/*                               TIME DECAY                                   */
/* -------------------------------------------------------------------------- */

const ENGAGEMENT_DECAY_WINDOW_DAYS = 7;
const MONETIZATION_DECAY_WINDOW_DAYS = 10;

/* -------------------------------------------------------------------------- */
/*                           IDEMPOTENCY / DEDUPE                             */
/* -------------------------------------------------------------------------- */

const DEDUP_WINDOW_MS = 10_000;

/* -------------------------------------------------------------------------- */
/*                               STARTUP VALIDATION                           */
/* -------------------------------------------------------------------------- */

(function validateConfig() {
  const weightSum =
    (DIMENSION_WEIGHTS.engagement ?? 0) +
    (DIMENSION_WEIGHTS.monetization ?? 0);

  if (Math.abs(weightSum - 1) > 0.0001) {
    throw new Error(
      `Invalid DIMENSION_WEIGHTS: must sum to 1.0, received ${weightSum}`
    );
  }

  assertNumber('SCORE_VERSION', SCORE_VERSION, { min: 1 });
  assertNumber('MAX_EVENT_REPETITIONS', MAX_EVENT_REPETITIONS, { min: 1 });
  assertNumber('HARD_COUNTER_LIMIT', HARD_COUNTER_LIMIT, { min: 1 });
  assertNumber('SCORE_CACHE_TTL_SECONDS', SCORE_CACHE_TTL_SECONDS, { min: 1 });
  assertNumber('ENGAGEMENT_DECAY_WINDOW_DAYS', ENGAGEMENT_DECAY_WINDOW_DAYS, { min: 1 });
  assertNumber('MONETIZATION_DECAY_WINDOW_DAYS', MONETIZATION_DECAY_WINDOW_DAYS, { min: 1 });
  assertNumber('DEDUP_WINDOW_MS', DEDUP_WINDOW_MS, { min: 1 });
})();

/* -------------------------------------------------------------------------- */
/*                                   EXPORTS                                  */
/* -------------------------------------------------------------------------- */

module.exports = deepFreeze({
  SCORE_VERSION,

  ENGAGEMENT_WEIGHTS,
  MONETIZATION_WEIGHTS,
  DIMENSION_WEIGHTS,

  MAX_EVENT_REPETITIONS,
  HARD_COUNTER_LIMIT,

  SCORE_CACHE_TTL_SECONDS,

  ENGAGEMENT_DECAY_WINDOW_DAYS,
  MONETIZATION_DECAY_WINDOW_DAYS,

  DEDUP_WINDOW_MS,
});