'use strict';

/**
 * modules/ava-memory/services/avaMemory.service.js
 *
 * Business logic for the Ava Memory System.
 *
 * Responsibilities:
 *   - getAvaMemory(userId)         → { weeklySummary, reminder, nextStep, raw }
 *   - updateWeeklyMemory(userId)   → writes snapshot + resets counters
 *   - trackEvent(userId, event)    → routes events to correct repo increment
 *   - Personalised message generation (non-generic, data-driven)
 *
 * Redis cache (5 min TTL) sits in front of all reads.
 */

const repo         = require('../repository/avaMemory.repository');
const cacheManager = require('../../../core/cache/cache.manager');
const logger       = require('../../../utils/logger');

const CACHE_TTL = 5 * 60; // 5 minutes in seconds
const cacheKey  = (userId) => `ava_memory:${userId}`;

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function _get(key) {
  try {
    const raw = await cacheManager.getClient().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function _set(key, value) {
  try { await cacheManager.getClient().set(key, JSON.stringify(value), CACHE_TTL); }
  catch { /* non-fatal */ }
}

async function _del(key) {
  try { await cacheManager.getClient().delete(key); }
  catch { /* non-fatal */ }
}

// ─── Days-since helper ────────────────────────────────────────────────────────

function daysSince(isoDate) {
  if (!isoDate) return null;
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86_400_000);
}

// ─── Message generators ───────────────────────────────────────────────────────
// All copy is data-driven. No generic fallbacks.

/**
 * Build a personalised weekly summary string.
 * Only includes facts that are non-zero — no "you added 0 skills" noise.
 */
function buildWeeklySummary(memory) {
  if (!memory) {
    return "This is your first week — let's set your baseline.";
  }

  const parts = [];
  const wSkills = memory.weekly_skills_added ?? 0;
  const wJobs   = memory.weekly_jobs_applied  ?? 0;
  const wDelta  = memory.weekly_progress       ?? 0;

  if (wSkills > 0) {
    parts.push(`added ${wSkills} skill${wSkills > 1 ? 's' : ''}`);
  }
  if (memory.resume_improved) {
    parts.push('improved your resume');
  }
  if (wJobs > 0) {
    parts.push(`applied to ${wJobs} job${wJobs > 1 ? 's' : ''}`);
  }

  if (parts.length === 0) {
    if (wDelta > 0) {
      return `Your score improved by ${wDelta.toFixed(0)} pts last week — keep the momentum going.`;
    }
    return "No activity recorded last week. A small step today makes a big difference.";
  }

  const actionStr = parts.length === 1
    ? parts[0]
    : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];

  const scoreStr = wDelta > 0
    ? ` Your score improved by ${wDelta.toFixed(0)} pts.`
    : '';

  return `Last week you ${actionStr}.${scoreStr}`;
}

/**
 * Build a time-sensitive reminder based on inactivity or stale data.
 */
function buildReminder(memory) {
  if (!memory) return null;

  const daysSinceActive = daysSince(memory.last_active_date);
  const daysSinceResume = daysSince(memory.last_resume_update);
  const daysSinceSkill  = daysSince(memory.last_skill_added_at);

  // Prioritise inactivity
  if (daysSinceActive !== null && daysSinceActive >= 5) {
    return `You haven't updated your profile in ${daysSinceActive} day${daysSinceActive > 1 ? 's' : ''}. The job market moves fast — a quick check-in keeps your recommendations fresh.`;
  }
  if (daysSinceResume !== null && daysSinceResume >= 14) {
    return `Your resume was last updated ${daysSinceResume} days ago. Refreshing it weekly increases recruiter visibility.`;
  }
  if (daysSinceSkill !== null && daysSinceSkill >= 7) {
    return `It's been ${daysSinceSkill} days since you added a skill. Adding one new skill per week compoundsover time.`;
  }

  return null; // no reminder needed — user is active
}

/**
 * Determine the single most impactful next step.
 * Priority: score gap → skills → resume → jobs → general
 */
function buildNextStep(memory, currentScore) {
  const score = currentScore ?? memory?.current_score ?? 0;

  if (score < 60 && (memory?.skills_added ?? 0) === 0) {
    return { action: 'Add your first skill to unlock job recommendations.', href: '/skills', type: 'skills' };
  }
  if (!memory?.resume_improved) {
    return { action: 'Improve your resume to increase interview callbacks by ~20%.', href: '/resume-builder', type: 'resume' };
  }
  if (score < 70) {
    return { action: `Add ${Math.ceil((70 - score) / 4)} more skills to reach the 70% match threshold.`, href: '/skills', type: 'skills' };
  }
  if ((memory?.jobs_applied ?? 0) === 0) {
    return { action: 'Apply to your top job matches — your profile is ready.', href: '/job-matches', type: 'jobs' };
  }

  return { action: 'Explore new opportunities to stay ahead of the market.', href: '/opportunities', type: 'explore' };
}

/**
 * Build a motivational score-delta message.
 */
function buildScoreDelta(memory) {
  if (!memory) return null;
  const delta = (memory.current_score ?? 0) - (memory.last_score ?? 0);
  if (delta <= 0) return null;
  return `+${delta.toFixed(0)} pts since last week 🎉`;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * getAvaMemory(userId, currentScore?)
 *
 * Returns the full memory context Ava needs to personalise her responses.
 * Redis-cached for 5 minutes. Falls back to safe defaults for new users.
 *
 * @param {string} userId
 * @param {number} [currentScore]  — latest CHI/job-match from the request context
 * @returns {Promise<AvaMemoryContext>}
 */
async function getAvaMemory(userId, currentScore) {
  const key     = cacheKey(userId);
  const cached  = await _get(key);
  if (cached) return cached;

  let raw = null;
  try {
    raw = await repo.getMemory(userId);
  } catch (err) {
    logger.warn('[AvaMemoryService] getMemory DB error — returning defaults', { userId, err: err.message });
  }

  // If user has a current score and the DB is stale, update asynchronously
  if (currentScore != null && raw && Math.abs((raw.current_score ?? 0) - currentScore) > 2) {
    repo.updateScore(userId, currentScore).catch(() => { /* non-fatal */ });
    raw = { ...raw, current_score: currentScore };
  }

  const context = {
    // Raw row (null for brand-new users)
    raw,

    // Generated messages
    weeklySummary: buildWeeklySummary(raw),
    reminder:      buildReminder(raw),
    nextStep:      buildNextStep(raw, currentScore),
    scoreDelta:    buildScoreDelta(raw),

    // Stats for UI display
    stats: {
      skillsAddedThisWeek: raw?.skills_added         ?? 0,
      jobsAppliedThisWeek: raw?.jobs_applied          ?? 0,
      resumeImproved:      raw?.resume_improved       ?? false,
      weeklyProgress:      raw?.weekly_progress       ?? 0,
      currentScore:        raw?.current_score         ?? currentScore ?? 0,
      lastScore:           raw?.last_score            ?? 0,
      daysSinceActive:     daysSince(raw?.last_active_date),
      isNewUser:           raw === null,
    },
  };

  await _set(key, context);
  return context;
}

/**
 * updateWeeklyMemory(userId)
 *
 * Writes a weekly snapshot and resets per-cycle counters.
 * Called by the cron job every Monday, or on-demand via the route.
 *
 * @param {string} userId
 * @returns {Promise<AvaMemoryRow|null>}
 */
async function updateWeeklyMemory(userId) {
  try {
    const result = await repo.writeWeeklySnapshot(userId);
    await _del(cacheKey(userId));
    logger.info('[AvaMemoryService] Weekly snapshot written', { userId });
    return result;
  } catch (err) {
    logger.error('[AvaMemoryService] updateWeeklyMemory failed', { userId, err: err.message });
    throw err;
  }
}

/**
 * trackEvent(userId, eventType, payload?)
 *
 * Routes a career event to the appropriate repository increment.
 * Fire-and-forget safe — callers can .catch(() => {}) without side effects.
 *
 * @param {string} userId
 * @param {'skill_added'|'resume_improved'|'job_applied'|'score_updated'} eventType
 * @param {{ count?: number, score?: number }} [payload]
 */
async function trackEvent(userId, eventType, payload = {}) {
  try {
    switch (eventType) {
      case 'skill_added':
        await repo.incrementSkillsAdded(userId, payload.count ?? 1);
        break;
      case 'resume_improved':
        await repo.markResumeImproved(userId);
        break;
      case 'job_applied':
        await repo.incrementJobsApplied(userId, payload.count ?? 1);
        break;
      case 'score_updated':
        if (payload.score != null) await repo.updateScore(userId, payload.score);
        break;
      default:
        logger.warn('[AvaMemoryService] Unknown event type', { userId, eventType });
        return;
    }
    // Bust cache so next read reflects new state
    await _del(cacheKey(userId));
    logger.info('[AvaMemoryService] Event tracked', { userId, eventType });
  } catch (err) {
    logger.error('[AvaMemoryService] trackEvent failed', { userId, eventType, err: err.message });
    throw err;
  }
}

/**
 * runWeeklyCron()
 *
 * Process all users due for a weekly snapshot.
 * Called by a cron job (e.g. every Monday at 06:00 UTC).
 */
async function runWeeklyCron() {
  const users = await repo.getUsersDueForWeeklySnapshot();
  logger.info('[AvaMemoryService] Weekly cron — processing', { count: users.length });

  const results = await Promise.allSettled(
    users.map(u => updateWeeklyMemory(u.user_id))
  );

  const ok      = results.filter(r => r.status === 'fulfilled').length;
  const failed  = results.filter(r => r.status === 'rejected').length;
  logger.info('[AvaMemoryService] Weekly cron complete', { ok, failed });
  return { ok, failed, total: users.length };
}

module.exports = {
  getAvaMemory,
  updateWeeklyMemory,
  trackEvent,
  runWeeklyCron,
};

/**
 * @typedef {Object} AvaMemoryContext
 * @property {AvaMemoryRow|null} raw
 * @property {string}  weeklySummary
 * @property {string|null} reminder
 * @property {{ action: string, href: string, type: string }} nextStep
 * @property {string|null} scoreDelta
 * @property {{ skillsAddedThisWeek: number, jobsAppliedThisWeek: number,
 *              resumeImproved: boolean, weeklyProgress: number,
 *              currentScore: number, lastScore: number,
 *              daysSinceActive: number|null, isNewUser: boolean }} stats
 */








