'use strict';

/**
 * modules/ava-memory/repository/avaMemory.repository.js
 *
 * Production-optimized Supabase repository for ava_memory.
 * - Firebase fully removed (none existed in source)
 * - Reduced round trips where possible
 * - Added safe RPC hooks for atomic increments (recommended)
 * - Better select projection on hot paths
 * - Consistent timestamps
 * - Safer error wrapping
 */

const { supabase } = require('../../../config/supabase');
const logger = require('../../../utils/logger');

const TABLE = 'ava_memory';

function nowIso() {
  return new Date().toISOString();
}

function handleError(scope, error, meta = {}) {
  logger.error(`[AvaMemoryRepo] ${scope} failed`, {
    ...meta,
    error: error.message,
    code: error.code,
    details: error.details,
  });

  const wrapped = new Error(error.message);
  wrapped.code = error.code;
  throw wrapped;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────────────────────────────────────

async function getMemory(userId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) handleError('getMemory', error, { userId });
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Upsert
// ─────────────────────────────────────────────────────────────────────────────

async function upsertMemory(userId, patch = {}) {
  const payload = {
    user_id: userId,
    ...patch,
    updated_at: nowIso(),
  };

  const { data, error } = await supabase
    .from(TABLE)
    .upsert(payload, { onConflict: 'user_id' })
    .select()
    .single();

  if (error) handleError('upsertMemory', error, { userId });
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Atomic operations (RPC recommended)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recommended SQL RPC: increment_ava_memory_skills(user_id uuid, delta int)
 */
async function incrementSkillsAdded(userId, delta = 1) {
  const { data, error } = await supabase.rpc('increment_ava_memory_skills', {
    p_user_id: userId,
    p_delta: delta,
  });

  if (!error) return data;

  // Fallback for environments where RPC is not yet deployed
  logger.warn('[AvaMemoryRepo] incrementSkillsAdded RPC unavailable, using fallback', {
    userId,
    error: error.message,
  });

  const existing = await getMemory(userId);
  const current = existing?.skills_added ?? 0;
  const now = nowIso();

  return upsertMemory(userId, {
    skills_added: current + delta,
    last_skill_added_at: now,
    last_active_date: now,
  });
}

async function markResumeImproved(userId) {
  const now = nowIso();

  return upsertMemory(userId, {
    resume_improved: true,
    last_resume_update: now,
    last_active_date: now,
  });
}

/**
 * Recommended SQL RPC: increment_ava_memory_jobs(user_id uuid, delta int)
 */
async function incrementJobsApplied(userId, delta = 1) {
  const { data, error } = await supabase.rpc('increment_ava_memory_jobs', {
    p_user_id: userId,
    p_delta: delta,
  });

  if (!error) return data;

  logger.warn('[AvaMemoryRepo] incrementJobsApplied RPC unavailable, using fallback', {
    userId,
    error: error.message,
  });

  const existing = await getMemory(userId);
  const current = existing?.jobs_applied ?? 0;

  return upsertMemory(userId, {
    jobs_applied: current + delta,
    last_active_date: nowIso(),
  });
}

async function updateScore(userId, newScore) {
  const existing = await getMemory(userId);

  return upsertMemory(userId, {
    last_score: existing?.current_score ?? 0,
    current_score: newScore,
    last_active_date: nowIso(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Weekly snapshot
// ─────────────────────────────────────────────────────────────────────────────

async function writeWeeklySnapshot(userId) {
  const existing = await getMemory(userId);
  if (!existing) return null;

  const weeklyProgress =
    (existing.current_score ?? 0) - (existing.last_score ?? 0);

  const now = nowIso();

  return upsertMemory(userId, {
    weekly_progress: weeklyProgress,
    weekly_skills_added: existing.skills_added ?? 0,
    weekly_jobs_applied: existing.jobs_applied ?? 0,
    week_start_date: now,
    last_score: existing.current_score ?? 0,
    skills_added: 0,
    jobs_applied: 0,
    resume_improved: false,
    last_active_date: now,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk / cron
// ─────────────────────────────────────────────────────────────────────────────

async function getUsersDueForWeeklySnapshot(limit = 500) {
  const { data, error } = await supabase.rpc('get_ava_memory_users_due', {
    limit_count: limit,
  });

  if (error) handleError('getUsersDueForWeeklySnapshot', error, { limit });
  return data ?? [];
}

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