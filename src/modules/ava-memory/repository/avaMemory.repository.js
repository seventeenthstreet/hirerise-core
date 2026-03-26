'use strict';

/**
 * modules/ava-memory/repository/avaMemory.repository.js
 *
 * All Supabase operations for the ava_memory table.
 * Pure DB layer — no caching, no business logic.
 * Service layer handles Redis caching and message generation.
 */

const supabase = require('../../../core/supabaseClient');
const logger   = require('../../../utils/logger');

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Get the ava_memory row for a user. Returns null if no row exists yet.
 * @param {string} userId
 * @returns {Promise<AvaMemoryRow|null>}
 */
async function getMemory(userId) {
  const { data, error } = await supabase
    .from('ava_memory')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.error('[AvaMemoryRepo] getMemory failed', { userId, error: error.message });
    throw new Error(error.message);
  }
  return data; // null if user has no memory yet
}

// ─── Upsert (create or update) ────────────────────────────────────────────────

/**
 * Upsert a full memory row. Creates on first call, updates thereafter.
 * All fields are optional — only provided fields are changed.
 *
 * @param {string} userId
 * @param {Partial<AvaMemoryRow>} patch
 * @returns {Promise<AvaMemoryRow>}
 */
async function upsertMemory(userId, patch) {
  const { data, error } = await supabase
    .from('ava_memory')
    .upsert(
      { user_id: userId, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'user_id', returning: 'representation' }
    )
    .select()
    .single();

  if (error) {
    logger.error('[AvaMemoryRepo] upsertMemory failed', { userId, error: error.message });
    throw new Error(error.message);
  }
  return data;
}

// ─── Atomic increments (avoid race conditions) ────────────────────────────────

/**
 * Increment skills_added by delta (default 1).
 * Also stamps last_skill_added_at and last_active_date.
 */
async function incrementSkillsAdded(userId, delta = 1) {
  const now = new Date().toISOString();

  // Read → increment → write (safe for low-concurrency; use DB function for high scale)
  const existing = await getMemory(userId);
  const current  = existing?.skills_added ?? 0;

  return upsertMemory(userId, {
    skills_added:        current + delta,
    last_skill_added_at: now,
    last_active_date:    now,
  });
}

/**
 * Mark resume as improved and stamp last_resume_update.
 */
async function markResumeImproved(userId) {
  const now = new Date().toISOString();
  return upsertMemory(userId, {
    resume_improved:   true,
    last_resume_update: now,
    last_active_date:   now,
  });
}

/**
 * Increment jobs_applied by delta (default 1).
 */
async function incrementJobsApplied(userId, delta = 1) {
  const existing = await getMemory(userId);
  const current  = existing?.jobs_applied ?? 0;

  return upsertMemory(userId, {
    jobs_applied:     current + delta,
    last_active_date: new Date().toISOString(),
  });
}

/**
 * Update the current_score. Preserves last_score from previous value.
 */
async function updateScore(userId, newScore) {
  const existing = await getMemory(userId);
  return upsertMemory(userId, {
    last_score:    existing?.current_score ?? 0,
    current_score: newScore,
    last_active_date: new Date().toISOString(),
  });
}

// ─── Weekly snapshot ──────────────────────────────────────────────────────────

/**
 * Write a weekly snapshot and reset per-cycle counters.
 * Called by the weekly cron job (or on-demand from the route).
 */
async function writeWeeklySnapshot(userId) {
  const existing = await getMemory(userId);
  if (!existing) return null; // nothing to snapshot

  const weeklyProgress = (existing.current_score ?? 0) - (existing.last_score ?? 0);
  const now = new Date().toISOString();

  return upsertMemory(userId, {
    // Snapshot
    weekly_progress:     weeklyProgress,
    weekly_skills_added: existing.skills_added ?? 0,
    weekly_jobs_applied: existing.jobs_applied ?? 0,
    week_start_date:     now,
    // Archive current as new baseline
    last_score:          existing.current_score ?? 0,
    // Reset weekly counters
    skills_added:        0,
    jobs_applied:        0,
    resume_improved:     false,
  });
}

// ─── Bulk (cron) ──────────────────────────────────────────────────────────────

/**
 * Fetch all users whose last weekly snapshot is older than 7 days.
 * Used by the weekly cron to determine who needs a snapshot.
 */
async function getUsersDueForWeeklySnapshot() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('ava_memory')
    .select('user_id, current_score, last_score, skills_added, jobs_applied')
    .or(`week_start_date.is.null,week_start_date.lt.${cutoff}`);

  if (error) {
    logger.error('[AvaMemoryRepo] getUsersDueForWeeklySnapshot failed', { error: error.message });
    throw new Error(error.message);
  }
  return data ?? [];
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  getMemory,
  upsertMemory,
  incrementSkillsAdded,
  markResumeImproved,
  incrementJobsApplied,
  updateScore,
  writeWeeklySnapshot,
  getUsersDueForWeeklySnapshot,
};

/**
 * @typedef {Object} AvaMemoryRow
 * @property {string}  user_id
 * @property {number}  last_score
 * @property {number}  current_score
 * @property {number}  skills_added
 * @property {number}  jobs_applied
 * @property {boolean} resume_improved
 * @property {string|null} last_active_date
 * @property {string|null} last_skill_added_at
 * @property {string|null} last_resume_update
 * @property {number}  weekly_progress
 * @property {number}  weekly_skills_added
 * @property {number}  weekly_jobs_applied
 * @property {string|null} week_start_date
 * @property {string}  created_at
 * @property {string}  updated_at
 */








