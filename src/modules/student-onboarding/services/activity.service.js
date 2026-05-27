'use strict';

/**
 * core/src/modules/student-onboarding/services/activity.service.js
 *
 * BUSINESS LOGIC — Activities & Achievement Intelligence (Phase 3B)
 *
 * DOES NOT:
 *   • access the database directly (delegates to activity.repository.js)
 *   • handle HTTP (belongs in controller)
 *   • run recommendation engines or AI inference
 *
 * PROGRESSIVE PERSISTENCE CONTRACT:
 *   • addActivity      — immediately persists (is_partial = true)
 *   • updateDepth      — upserts depth fields (is_partial = false on commit)
 *   • addAchievement   — immediately persists
 *   • removeAchievement — immediately deletes
 *   • upsertReflection — immediately persists (optional step)
 *   • commitActivitiesStep — advances session to 'cognitive' when signal is sufficient
 */

const repo          = require('../repositories/activity.repository');
const sessionService = require('./session.service');

const { MIN_ACTIVITIES_FOR_COMMIT } = require('../constants/activities');
const { addCompletedStep, resolveCurrentStep } = require('../helpers/progression');

// ─────────────────────────────────────────────────────────────────────────────
// GET ACTIVITIES STEP
// Returns full activity data + taxonomy + signal quality for the step.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object, diagnostics?: object }} ctx
 * @param {string} userId
 * @returns {Promise<{ taxonomy: object, activities: object[], achievements: object[], reflection: object|null, signal_quality: object }>}
 */
async function getActivitiesStep(ctx, userId) {
  const { supabase } = ctx;

  const [taxonomyRows, activityData, signalQuality] = await Promise.all([
    repo.fetchActivityTaxonomy(supabase),
    repo.fetchStudentActivityData(supabase, userId),
    repo.fetchActivitySignalQuality(supabase, userId),
  ]);

  return {
    taxonomy:       groupTaxonomyByCategory(taxonomyRows),
    activities:     activityData.activities,
    achievements:   activityData.achievements,
    reflection:     activityData.reflection,
    signal_quality: signalQuality,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ADD ACTIVITY (Step 1: Activity Discovery)
// Progressive persist: immediately creates a partial activity row.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object }} ctx
 * @param {string} userId
 * @param {object} validatedPayload — output of validateActivityUpsert()
 * @returns {Promise<{ activity: object, signal_quality: object }>}
 */
async function addActivity(ctx, userId, validatedPayload) {
  const { supabase } = ctx;

  const activity = await repo.upsertStudentActivity(supabase, {
    user_id:           userId,
    activity_key:      validatedPayload.activity_key,
    activity_category: validatedPayload.activity_category,
    proficiency_level: validatedPayload.proficiency_level ?? null,
    duration_months:   validatedPayload.duration_months   ?? null,
    weekly_frequency:  validatedPayload.weekly_frequency  ?? null,
    currently_active:  validatedPayload.currently_active  ?? true,
    leadership_level:  validatedPayload.leadership_level  ?? 'participant',
    is_partial:        true,
  });

  const signalQuality = await repo.fetchActivitySignalQuality(supabase, userId);

  return { activity, signal_quality: signalQuality };
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE DEPTH (Step 2: Participation Depth + Step 4: Leadership)
// Progressive persist: updates depth fields, optionally commits the activity.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object }} ctx
 * @param {string} userId
 * @param {string} activityKey
 * @param {object} validatedPayload — output of validateActivityUpsert(body, count, true)
 * @returns {Promise<{ activity: object, signal_quality: object }>}
 */
async function updateActivityDepth(ctx, userId, activityKey, validatedPayload) {
  const { supabase } = ctx;

  const { activities: existing } = await repo.fetchStudentActivityData(supabase, userId);
  const current = existing.find((a) => a.activity_key === activityKey);

  if (!current) {
    const err = new Error(`Activity not found: ${activityKey}`);
    err.status = 404;
    throw err;
  }

  const activity = await repo.upsertStudentActivity(supabase, {
    user_id:           userId,
    activity_key:      activityKey,
    activity_category: current.activity_category,
    proficiency_level: validatedPayload.proficiency_level ?? current.proficiency_level,
    duration_months:   validatedPayload.duration_months   ?? current.duration_months,
    weekly_frequency:  validatedPayload.weekly_frequency  ?? current.weekly_frequency,
    currently_active:  validatedPayload.currently_active  ?? current.currently_active,
    leadership_level:  validatedPayload.leadership_level  ?? current.leadership_level,
    is_partial:        validatedPayload.is_partial,
  });

  const signalQuality = await repo.fetchActivitySignalQuality(supabase, userId);

  return { activity, signal_quality: signalQuality };
}

// ─────────────────────────────────────────────────────────────────────────────
// REMOVE ACTIVITY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object }} ctx
 * @param {string} userId
 * @param {string} activityKey
 * @returns {Promise<{ signal_quality: object }>}
 */
async function removeActivity(ctx, userId, activityKey) {
  const { supabase } = ctx;

  await repo.deleteStudentActivity(supabase, userId, activityKey);
  const signalQuality = await repo.fetchActivitySignalQuality(supabase, userId);

  return { signal_quality: signalQuality };
}

// ─────────────────────────────────────────────────────────────────────────────
// ADD ACHIEVEMENT (Step 3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object }} ctx
 * @param {string} userId
 * @param {string} activityKey
 * @param {object} validatedPayload — output of validateAchievementInsert()
 * @returns {Promise<{ achievement: object }>}
 */
async function addAchievement(ctx, userId, activityKey, validatedPayload) {
  const { supabase } = ctx;

  const { activities } = await repo.fetchStudentActivityData(supabase, userId);
  const activity = activities.find((a) => a.activity_key === activityKey);

  if (!activity) {
    const err = new Error(`Activity not found: ${activityKey}`);
    err.status = 404;
    throw err;
  }

  const achievement = await repo.insertAchievement(supabase, {
    user_id:             userId,
    student_activity_id: activity.id,
    ...validatedPayload,
  });

  return { achievement };
}

// ─────────────────────────────────────────────────────────────────────────────
// REMOVE ACHIEVEMENT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object }} ctx
 * @param {string} userId
 * @param {string} achievementId
 * @returns {Promise<void>}
 */
async function removeAchievement(ctx, userId, achievementId) {
  const { supabase } = ctx;
  await repo.deleteAchievement(supabase, userId, achievementId);
}

// ─────────────────────────────────────────────────────────────────────────────
// UPSERT REFLECTION (Step 5, optional)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object }} ctx
 * @param {string} userId
 * @param {object} validatedPayload — output of validateReflectionUpsert()
 * @returns {Promise<{ reflection: object }>}
 */
async function upsertReflection(ctx, userId, validatedPayload) {
  const { supabase } = ctx;

  const reflection = await repo.upsertReflection(supabase, {
    user_id: userId,
    ...validatedPayload,
  });

  return { reflection };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMMIT ACTIVITIES STEP
// Advances onboarding session to 'cognitive' when signal is sufficient.
// Single-advance: checks session before writing to prevent double-advancement.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ supabase: object }} ctx
 * @param {string} userId
 * @param {string} sessionId
 * @returns {Promise<{ session: object, next_step: string, signal_quality: object }>}
 */
async function commitActivitiesStep(ctx, userId, sessionId) {
  const { supabase } = ctx;

  const signalQuality = await repo.fetchActivitySignalQuality(supabase, userId);

  if (!signalQuality.is_sufficient) {
    const err = new Error(
      `At least ${MIN_ACTIVITIES_FOR_COMMIT} activity must be added before proceeding.`,
    );
    err.status = 422;
    throw err;
  }

  // Fetch current session to compute progression correctly
  const currentSession = await sessionService.getSession(userId);

  // Compute new progression state — resolveCurrentStep guards against regression
  const newCompleted = addCompletedStep(currentSession.completed_steps, 'activities');
  const nextStep     = resolveCurrentStep('activities', currentSession.current_step);

  // Persist progression — session is now authoritative
  const updatedSession = await sessionService.updateProgression(userId, {
    completedStep:  'activities',
    nextStep,
    completedSteps: newCompleted,
  });

  return {
    session:        updatedSession,
    next_step:      nextStep,
    signal_quality: signalQuality,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PRIVATE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Groups flat taxonomy rows into a category-keyed structure.
 *
 * @param {object[]} rows
 * @returns {Record<string, { category: string, activities: object[] }>}
 */
function groupTaxonomyByCategory(rows) {
  return rows.reduce((acc, row) => {
    if (!acc[row.category]) {
      acc[row.category] = { category: row.category, activities: [] };
    }
    acc[row.category].activities.push({
      activity_key:  row.activity_key,
      display_name:  row.display_name,
      description:   row.description,
      tags:          row.tags,
      display_order: row.display_order,
    });
    return acc;
  }, {});
}

module.exports = {
  getActivitiesStep,
  addActivity,
  updateActivityDepth,
  removeActivity,
  addAchievement,
  removeAchievement,
  upsertReflection,
  commitActivitiesStep,
};
