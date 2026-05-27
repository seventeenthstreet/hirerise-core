'use strict';

/**
 * core/src/modules/student-onboarding/signals/activity.signals.js
 *
 * SIGNAL EXTRACTION INFRASTRUCTURE — Phase 3B
 *
 * ⚠️  PLACEHOLDER INFRASTRUCTURE ONLY ⚠️
 *
 * This module provides the function signatures and data contracts for the
 * future intelligence engine signal extraction layer.
 *
 * CRITICAL RULES:
 *   ✗ DO NOT implement recommendation engines here.
 *   ✗ DO NOT generate stream recommendations.
 *   ✗ DO NOT infer personality traits.
 *   ✗ DO NOT implement AI prediction logic.
 *
 * These functions:
 *   ✓ Normalize raw activity data into engine-compatible signal envelopes.
 *   ✓ Return structured, typed signal payloads.
 *   ✓ Are designed to be called by a future intelligence engine, NOT by the API.
 *
 * When the intelligence engine ships, it will:
 *   1. Call these normalizers to prepare the input signal.
 *   2. Feed the signal envelope into the scoring model.
 *   3. Write the result back to student_activities.signal_score
 *      and student_activity_achievements.normalized_score.
 *
 * The API layer and UI never call these functions directly.
 */

const {
  PROFICIENCY_WEIGHTS,
  LEADERSHIP_WEIGHTS,
  ACHIEVEMENT_LEVEL_WEIGHTS,
  ACHIEVEMENT_POSITION_WEIGHTS,
} = require('../constants/activities');

// ─────────────────────────────────────────────────────────────────────────────
// TYPE DOCUMENTATION (JSDoc — enforced by type consumers)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} ActivitySignalEnvelope
 * @property {string}          activity_key
 * @property {string}          category
 * @property {number}          proficiency_weight       — 0–5
 * @property {number}          leadership_weight        — 0–5
 * @property {number}          duration_months          — 0–N
 * @property {number}          weekly_frequency_hours   — 0–N
 * @property {boolean}         currently_active
 * @property {number}          achievement_count        — number of achievements
 * @property {number}          peak_achievement_level   — 0–6 (highest ACHIEVEMENT_LEVEL_WEIGHTS)
 * @property {number}          peak_achievement_weight  — combined level + position weight
 * @property {AchievementSignal[]} achievements
 */

/**
 * @typedef {Object} AchievementSignal
 * @property {string}       achievement_level
 * @property {string|null}  achievement_position
 * @property {number|null}  achievement_year
 * @property {number}       level_weight    — 0–6
 * @property {number}       position_weight — 0–3
 * @property {number}       composite_weight — level_weight + position_weight (0–9)
 */

/**
 * @typedef {Object} CategorySignalBundle
 * @property {string}   category
 * @property {number}   activity_count
 * @property {number}   max_proficiency_weight
 * @property {number}   max_leadership_weight
 * @property {number}   total_duration_months
 * @property {number}   max_achievement_composite
 * @property {boolean}  has_leadership
 * @property {boolean}  has_achievements
 */

// ─────────────────────────────────────────────────────────────────────────────
// normalizeAchievement()
// Converts a raw achievement row into a typed AchievementSignal.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalizes a raw achievement DB row into an engine-compatible signal.
 *
 * @param {Object}      achievement
 * @param {string}      achievement.achievement_level
 * @param {string|null} achievement.achievement_position
 * @param {number|null} achievement.achievement_year
 * @returns {AchievementSignal}
 */
function normalizeAchievement(achievement) {
  const levelWeight    = ACHIEVEMENT_LEVEL_WEIGHTS[achievement.achievement_level]    ?? 0;
  const positionWeight = ACHIEVEMENT_POSITION_WEIGHTS[achievement.achievement_position] ?? 0;

  return {
    achievement_level:    achievement.achievement_level,
    achievement_position: achievement.achievement_position ?? null,
    achievement_year:     achievement.achievement_year     ?? null,
    level_weight:         levelWeight,
    position_weight:      positionWeight,
    composite_weight:     levelWeight + positionWeight,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// normalizeActivitySignal()
// Converts a raw activity row + its achievements into an ActivitySignalEnvelope.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalizes a raw student_activities row + its achievements into a
 * future-engine-compatible ActivitySignalEnvelope.
 *
 * @param {Object}   activity        — raw student_activities row
 * @param {Object[]} achievements    — raw student_activity_achievements rows for this activity
 * @returns {ActivitySignalEnvelope}
 */
function normalizeActivitySignal(activity, achievements = []) {
  const proficiencyWeight = PROFICIENCY_WEIGHTS[activity.proficiency_level] ?? 0;
  const leadershipWeight  = LEADERSHIP_WEIGHTS[activity.leadership_level]   ?? 0;

  const normalizedAchievements = achievements.map(normalizeAchievement);

  const peakAchievementLevel = normalizedAchievements.reduce(
    (max, a) => Math.max(max, a.level_weight), 0,
  );

  const peakAchievementWeight = normalizedAchievements.reduce(
    (max, a) => Math.max(max, a.composite_weight), 0,
  );

  return {
    activity_key:           activity.activity_key,
    category:               activity.activity_category,
    proficiency_weight:     proficiencyWeight,
    leadership_weight:      leadershipWeight,
    duration_months:        activity.duration_months   ?? 0,
    weekly_frequency_hours: activity.weekly_frequency  ?? 0,
    currently_active:       activity.currently_active  ?? false,
    achievement_count:      normalizedAchievements.length,
    peak_achievement_level:  peakAchievementLevel,
    peak_achievement_weight: peakAchievementWeight,
    achievements:           normalizedAchievements,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// extractTechnicalSignals()
// Returns a filtered bundle for technical-category activities.
// FUTURE: intelligence engine calls this to extract STEM affinity signals.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {ActivitySignalEnvelope[]} envelopes
 * @returns {CategorySignalBundle}
 */
function extractTechnicalSignals(envelopes) {
  return extractCategorySignals(envelopes, 'technical');
}

// ─────────────────────────────────────────────────────────────────────────────
// extractCreativeSignals()
// Returns a filtered bundle for creative-category activities.
// FUTURE: intelligence engine calls this to extract creative affinity signals.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {ActivitySignalEnvelope[]} envelopes
 * @returns {CategorySignalBundle}
 */
function extractCreativeSignals(envelopes) {
  return extractCategorySignals(envelopes, 'creative');
}

/**
 * @param {ActivitySignalEnvelope[]} envelopes
 * @returns {CategorySignalBundle}
 */
function extractLeadershipSignals(envelopes) {
  return extractCategorySignals(envelopes, 'leadership');
}

/**
 * @param {ActivitySignalEnvelope[]} envelopes
 * @returns {CategorySignalBundle}
 */
function extractAcademicSignals(envelopes) {
  return extractCategorySignals(envelopes, 'academic');
}

/**
 * @param {ActivitySignalEnvelope[]} envelopes
 * @returns {CategorySignalBundle}
 */
function extractAthleticSignals(envelopes) {
  return extractCategorySignals(envelopes, 'athletic');
}

/**
 * @param {ActivitySignalEnvelope[]} envelopes
 * @returns {CategorySignalBundle}
 */
function extractSocialSignals(envelopes) {
  return extractCategorySignals(envelopes, 'social');
}

// ─────────────────────────────────────────────────────────────────────────────
// buildSignalBundle()
// Aggregates all activity signals into a single cross-category bundle.
// FUTURE: top-level entry point for the intelligence engine.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds the full signal bundle for all of a student's activities.
 * Intended as the top-level input to the intelligence engine.
 *
 * @param {Object[]} activities    — raw student_activities rows
 * @param {Object[]} achievements  — raw student_activity_achievements rows (all activities)
 * @returns {{
 *   envelopes:  ActivitySignalEnvelope[],
 *   byCategory: Record<string, CategorySignalBundle>,
 *   totals: {
 *     activity_count: number,
 *     achievement_count: number,
 *     has_any_leadership: boolean,
 *     has_any_achievements: boolean,
 *     peak_achievement_level: number,
 *   }
 * }}
 */
function buildSignalBundle(activities, achievements) {
  // Group achievements by student_activity_id
  const achievementsByActivityId = achievements.reduce((acc, ach) => {
    const key = ach.student_activity_id;
    if (!acc[key]) acc[key] = [];
    acc[key].push(ach);
    return acc;
  }, {});

  // Build per-activity envelopes
  const envelopes = activities.map((activity) =>
    normalizeActivitySignal(
      activity,
      achievementsByActivityId[activity.id] ?? [],
    ),
  );

  // Build per-category bundles
  const byCategory = {
    technical:  extractTechnicalSignals(envelopes),
    creative:   extractCreativeSignals(envelopes),
    leadership: extractLeadershipSignals(envelopes),
    academic:   extractAcademicSignals(envelopes),
    social:     extractSocialSignals(envelopes),
    athletic:   extractAthleticSignals(envelopes),
  };

  const peakAchievementLevel = envelopes.reduce(
    (max, e) => Math.max(max, e.peak_achievement_level), 0,
  );

  return {
    envelopes,
    byCategory,
    totals: {
      activity_count:         envelopes.length,
      achievement_count:      achievements.length,
      has_any_leadership:     envelopes.some((e) => e.leadership_weight > 1),
      has_any_achievements:   achievements.length > 0,
      peak_achievement_level: peakAchievementLevel,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal: extractCategorySignals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {ActivitySignalEnvelope[]} envelopes
 * @param {string} category
 * @returns {CategorySignalBundle}
 */
function extractCategorySignals(envelopes, category) {
  const filtered = envelopes.filter((e) => e.category === category);

  if (filtered.length === 0) {
    return {
      category,
      activity_count:             0,
      max_proficiency_weight:     0,
      max_leadership_weight:      0,
      total_duration_months:      0,
      max_achievement_composite:  0,
      has_leadership:             false,
      has_achievements:           false,
    };
  }

  return {
    category,
    activity_count:             filtered.length,
    max_proficiency_weight:     Math.max(...filtered.map((e) => e.proficiency_weight)),
    max_leadership_weight:      Math.max(...filtered.map((e) => e.leadership_weight)),
    total_duration_months:      filtered.reduce((s, e) => s + e.duration_months, 0),
    max_achievement_composite:  Math.max(...filtered.map((e) => e.peak_achievement_weight)),
    has_leadership:             filtered.some((e) => e.leadership_weight > 1),
    has_achievements:           filtered.some((e) => e.achievement_count > 0),
  };
}

module.exports = {
  normalizeAchievement,
  normalizeActivitySignal,
  buildSignalBundle,
  extractTechnicalSignals,
  extractCreativeSignals,
  extractLeadershipSignals,
  extractAcademicSignals,
  extractSocialSignals,
  extractAthleticSignals,
};
