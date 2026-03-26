'use strict';

/**
 * eventWeights.config.js
 *
 * Single source of truth for all scoring weights and behavioral constants.
 * No weight logic must live inside services.
 * This file must remain pure configuration.
 */

/* -------------------------------------------------------------------------- */
/*                             SCORE VERSIONING                               */
/* -------------------------------------------------------------------------- */
/**
 * Increment this when scoring logic materially changes.
 * Allows analytics segmentation + safe migrations.
 */
const SCORE_VERSION = 2;

/* -------------------------------------------------------------------------- */
/*                         ENGAGEMENT-DIMENSION WEIGHTS                       */
/* -------------------------------------------------------------------------- */
/**
 * Measures feature adoption and platform engagement depth.
 */
const ENGAGEMENT_WEIGHTS = Object.freeze({
  resume_uploaded:            20,
  resume_scored:              10,
  skill_test_started:         15,
  profile_completion_updated: 12,

  // FIX G-05: Onboarding funnel events
  // Zero scoring weight — these are pure audit trail events that enable
  // funnel analytics (drop-off by step, time-to-complete, A/B testing).
  // The analytics team can assign weights without touching onboarding code.
  onboarding_step_completed:  0,   // fired at each step completion
  onboarding_completed:       0,   // fired when both tracks complete
});

/* -------------------------------------------------------------------------- */
/*                       MONETIZATION-DIMENSION WEIGHTS                       */
/* -------------------------------------------------------------------------- */
/**
 * Measures purchase and commercial intent signals.
 */
const MONETIZATION_WEIGHTS = Object.freeze({
  salary_locked_feature_clicked: 25,
  pricing_page_viewed:           15,
  subscription_started:          30,
  salary_report_viewed:          12,
});

/* -------------------------------------------------------------------------- */
/*                          DIMENSION BLENDING WEIGHTS                        */
/* -------------------------------------------------------------------------- */
/**
 * Used to compute totalIntentScore:
 * total = engagementScore * engagementWeight
 *       + monetizationScore * monetizationWeight
 *
 * MUST sum to 1.0
 */
const DIMENSION_WEIGHTS = Object.freeze({
  engagement:   0.6,
  monetization: 0.4,
});

/* -------------------------------------------------------------------------- */
/*                             COUNTER CONTROLS                               */
/* -------------------------------------------------------------------------- */
/**
 * Maximum repetitions per event contributing to score.
 * Prevents score inflation.
 */
const MAX_EVENT_REPETITIONS = 3;

/**
 * Hard ceiling for stored counters in aggregate document.
 * Prevents unbounded growth over time.
 * This does NOT affect scoring cap.
 */
const HARD_COUNTER_LIMIT = 10;

/* -------------------------------------------------------------------------- */
/*                               CACHE CONFIG                                 */
/* -------------------------------------------------------------------------- */
/**
 * Score cache TTL in seconds.
 * Used by conversionCache.provider.js
 */
const SCORE_CACHE_TTL_SECONDS = 5 * 60; // 5 minutes

/* -------------------------------------------------------------------------- */
/*                               TIME DECAY                                   */
/* -------------------------------------------------------------------------- */
/**
 * Separate decay windows allow dimension-specific decay.
 * Engagement usually decays faster than monetization.
 */
const ENGAGEMENT_DECAY_WINDOW_DAYS   = 7;
const MONETIZATION_DECAY_WINDOW_DAYS = 10;

/**
 * If you want unified decay instead, keep them equal.
 */

/* -------------------------------------------------------------------------- */
/*                           IDEMPOTENCY / DEDUPE                             */
/* -------------------------------------------------------------------------- */
/**
 * Duplicate events within this window are ignored.
 */
const DEDUP_WINDOW_MS = 10_000; // 10 seconds

/* -------------------------------------------------------------------------- */
/*                               VALIDATION                                    */
/* -------------------------------------------------------------------------- */

/**
 * Ensures dimension weights sum to 1.0
 */
(function validateDimensionWeights() {
  const sum =
    (DIMENSION_WEIGHTS.engagement || 0) +
    (DIMENSION_WEIGHTS.monetization || 0);

  if (Math.abs(sum - 1) > 0.0001) {
    throw new Error(
      `Invalid DIMENSION_WEIGHTS: must sum to 1.0, received ${sum}`
    );
  }
})();

module.exports = Object.freeze({
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








