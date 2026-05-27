'use strict';

/**
 * core/src/modules/student-onboarding/repositories/activity.repository.js
 *
 * DATABASE ACCESS LAYER — Activities & Achievement Intelligence (Phase 3B)
 *
 * PATTERN:
 *   Every function accepts a supabase service-role client and a userId.
 *   Zero business logic. Zero validation. Only Supabase queries.
 *
 * UPSERT STRATEGY:
 *   • student_activities → upsert on (user_id, activity_key)
 *   • student_activity_achievements → insert only (achievements are immutable records)
 *   • student_activity_reflections → upsert on (user_id)
 */

// ─────────────────────────────────────────────────────────────────────────────
// TAXONOMY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches the full active activity taxonomy, grouped by category.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @returns {Promise<Object[]>} Array of taxonomy rows ordered by category, display_order
 */
async function fetchActivityTaxonomy(supabase) {
  const { data, error } = await supabase
    .from('activity_taxonomy')
    .select('activity_key, display_name, category, description, tags, display_order')
    .eq('is_active', true)
    .order('category', { ascending: true })
    .order('display_order', { ascending: true });

  if (error) throw error;
  return data ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// READ — STUDENT ACTIVITIES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches all activities + achievements for a student in one query set.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<{ activities: Object[], achievements: Object[], reflection: Object|null }>}
 */
async function fetchStudentActivityData(supabase, userId) {
  const [activitiesResult, achievementsResult, reflectionResult] = await Promise.all([
    supabase
      .from('student_activities')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: true }),

    supabase
      .from('student_activity_achievements')
      .select('*')
      .eq('user_id', userId)
      .order('achievement_year', { ascending: false }),

    supabase
      .from('student_activity_reflections')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle(),
  ]);

  if (activitiesResult.error)  throw activitiesResult.error;
  if (achievementsResult.error) throw achievementsResult.error;
  if (reflectionResult.error)  throw reflectionResult.error;

  return {
    activities:   activitiesResult.data  ?? [],
    achievements: achievementsResult.data ?? [],
    reflection:   reflectionResult.data   ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// UPSERT — STUDENT ACTIVITY (add or update single activity)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upserts a single student_activities row.
 * Safe to call multiple times — uses ON CONFLICT DO UPDATE.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Object}  activity
 * @param {string}  activity.user_id
 * @param {string}  activity.activity_key
 * @param {string}  activity.activity_category
 * @param {string|null} activity.proficiency_level
 * @param {number|null} activity.duration_months
 * @param {number|null} activity.weekly_frequency
 * @param {boolean} activity.currently_active
 * @param {string}  activity.leadership_level
 * @param {boolean} activity.is_partial
 * @returns {Promise<Object>} The upserted row
 */
async function upsertStudentActivity(supabase, activity) {
  const { data, error } = await supabase
    .from('student_activities')
    .upsert(
      {
        user_id:           activity.user_id,
        activity_key:      activity.activity_key,
        activity_category: activity.activity_category,
        proficiency_level: activity.proficiency_level ?? null,
        duration_months:   activity.duration_months   ?? null,
        weekly_frequency:  activity.weekly_frequency  ?? null,
        currently_active:  activity.currently_active  ?? true,
        leadership_level:  activity.leadership_level  ?? 'participant',
        is_partial:        activity.is_partial        ?? true,
      },
      {
        onConflict:     'user_id,activity_key',
        ignoreDuplicates: false,
      },
    )
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

/**
 * Deletes a student activity and all its achievements (CASCADE).
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {string} activityKey
 * @returns {Promise<void>}
 */
async function deleteStudentActivity(supabase, userId, activityKey) {
  const { error } = await supabase
    .from('student_activities')
    .delete()
    .eq('user_id', userId)
    .eq('activity_key', activityKey);

  if (error) throw error;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACHIEVEMENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Inserts a new achievement record.
 * Achievements are immutable records — use insert, not upsert.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Object}  achievement
 * @param {string}  achievement.user_id
 * @param {string}  achievement.student_activity_id
 * @param {string}  achievement.achievement_title
 * @param {string}  achievement.achievement_level
 * @param {string|null} achievement.achievement_position
 * @param {number|null} achievement.achievement_year
 * @returns {Promise<Object>} The inserted row
 */
async function insertAchievement(supabase, achievement) {
  const { data, error } = await supabase
    .from('student_activity_achievements')
    .insert({
      user_id:              achievement.user_id,
      student_activity_id:  achievement.student_activity_id,
      achievement_title:    achievement.achievement_title,
      achievement_level:    achievement.achievement_level,
      achievement_position: achievement.achievement_position ?? null,
      achievement_year:     achievement.achievement_year     ?? null,
    })
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

/**
 * Deletes a specific achievement by ID.
 * Validates user_id ownership before deletion.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {string} achievementId
 * @returns {Promise<void>}
 */
async function deleteAchievement(supabase, userId, achievementId) {
  const { error } = await supabase
    .from('student_activity_achievements')
    .delete()
    .eq('id', achievementId)
    .eq('user_id', userId);

  if (error) throw error;
}

/**
 * Fetches all achievements for a specific student activity.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @param {string} studentActivityId
 * @returns {Promise<Object[]>}
 */
async function fetchAchievementsForActivity(supabase, userId, studentActivityId) {
  const { data, error } = await supabase
    .from('student_activity_achievements')
    .select('*')
    .eq('user_id', userId)
    .eq('student_activity_id', studentActivityId)
    .order('achievement_year', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

// ─────────────────────────────────────────────────────────────────────────────
// REFLECTIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Upserts the student's reflection data (Step 5).
 * One row per student — updated in place.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {Object}      reflection
 * @param {string}      reflection.user_id
 * @param {string|null} reflection.favorite_activity_key
 * @param {string|null} reflection.pursue_seriously_key
 * @param {string|null} reflection.proudest_achievement_text
 * @returns {Promise<Object>} The upserted row
 */
async function upsertReflection(supabase, reflection) {
  const { data, error } = await supabase
    .from('student_activity_reflections')
    .upsert(
      {
        user_id:                    reflection.user_id,
        favorite_activity_key:      reflection.favorite_activity_key      ?? null,
        pursue_seriously_key:       reflection.pursue_seriously_key       ?? null,
        proudest_achievement_text:  reflection.proudest_achievement_text  ?? null,
      },
      {
        onConflict:       'user_id',
        ignoreDuplicates: false,
      },
    )
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// SIGNAL QUALITY QUERY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns a lightweight signal quality summary for a student's activities.
 * Used to determine if the step is ready for commit.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {string} userId
 * @returns {Promise<{ total_count: number, committed_count: number, has_achievements: boolean, has_leadership: boolean }>}
 */
async function fetchActivitySignalQuality(supabase, userId) {
  const [activitiesResult, achievementsResult] = await Promise.all([
    supabase
      .from('student_activities')
      .select('id, is_partial, leadership_level', { count: 'exact' })
      .eq('user_id', userId),

    supabase
      .from('student_activity_achievements')
      .select('id', { count: 'exact' })
      .eq('user_id', userId),
  ]);

  if (activitiesResult.error)  throw activitiesResult.error;
  if (achievementsResult.error) throw achievementsResult.error;

  const activities     = activitiesResult.data  ?? [];
  const totalCount     = activitiesResult.count  ?? 0;
  const committedCount = activities.filter((a) => !a.is_partial).length;
  const hasAchievements = (achievementsResult.count ?? 0) > 0;
  const hasLeadership  = activities.some(
    (a) => a.leadership_level && a.leadership_level !== 'none' && a.leadership_level !== 'participant',
  );

  return {
    total_count:      totalCount,
    committed_count:  committedCount,
    has_achievements: hasAchievements,
    has_leadership:   hasLeadership,
    is_sufficient:    committedCount >= 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  fetchActivityTaxonomy,
  fetchStudentActivityData,
  upsertStudentActivity,
  deleteStudentActivity,
  insertAchievement,
  deleteAchievement,
  fetchAchievementsForActivity,
  upsertReflection,
  fetchActivitySignalQuality,
};
