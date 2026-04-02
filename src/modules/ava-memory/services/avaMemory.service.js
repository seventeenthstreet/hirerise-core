'use strict';

/**
 * modules/ava-memory/services/avaMemory.service.js
 *
 * Production-ready Ava Memory service
 * Optimized for:
 * - Supabase repository RPCs
 * - Redis cache safety
 * - lower DB round trips
 * - cron scalability
 * - stale score async sync
 */

const repo = require('../repository/avaMemory.repository');
const cacheManager = require('../../../core/cache/cache.manager');
const logger = require('../../../utils/logger');

const CACHE_TTL_SECONDS = 300;
const cacheKey = (userId) => `ava_memory:${userId}`;

// ─────────────────────────────────────────────────────────────────────────────
// Cache helpers
// ─────────────────────────────────────────────────────────────────────────────
async function getCache(key) {
  try {
    const client = cacheManager.getClient();
    if (!client) return null;

    const raw = await client.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    logger.warn('[AvaMemoryService] cache get failed', {
      key,
      error: err.message,
    });
    return null;
  }
}

async function setCache(key, value) {
  try {
    const client = cacheManager.getClient();
    if (!client) return;

    await client.set(key, JSON.stringify(value), CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn('[AvaMemoryService] cache set failed', {
      key,
      error: err.message,
    });
  }
}

async function deleteCache(key) {
  try {
    const client = cacheManager.getClient();
    if (!client) return;

    await client.delete(key);
  } catch (err) {
    logger.warn('[AvaMemoryService] cache delete failed', {
      key,
      error: err.message,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function daysSince(isoDate) {
  if (!isoDate) return null;

  const timestamp = new Date(isoDate).getTime();
  if (Number.isNaN(timestamp)) return null;

  return Math.floor((Date.now() - timestamp) / 86400000);
}

function buildWeeklySummary(memory) {
  if (!memory) {
    return "This is your first week — let's set your baseline.";
  }

  const parts = [];
  const skills = memory.weekly_skills_added ?? 0;
  const jobs = memory.weekly_jobs_applied ?? 0;
  const progress = memory.weekly_progress ?? 0;

  if (skills > 0) {
    parts.push(`added ${skills} skill${skills > 1 ? 's' : ''}`);
  }

  if (memory.resume_improved) {
    parts.push('improved your resume');
  }

  if (jobs > 0) {
    parts.push(`applied to ${jobs} job${jobs > 1 ? 's' : ''}`);
  }

  if (parts.length === 0) {
    return progress > 0
      ? `Your score improved by ${progress.toFixed(0)} pts last week — keep the momentum going.`
      : 'No activity recorded last week. A small step today makes a big difference.';
  }

  const actionText =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

  const scoreText =
    progress > 0 ? ` Your score improved by ${progress.toFixed(0)} pts.` : '';

  return `Last week you ${actionText}.${scoreText}`;
}

function buildReminder(memory) {
  if (!memory) return null;

  const inactiveDays = daysSince(memory.last_active_date);
  const resumeDays = daysSince(memory.last_resume_update);
  const skillDays = daysSince(memory.last_skill_added_at);

  if (inactiveDays !== null && inactiveDays >= 5) {
    return `You haven't updated your profile in ${inactiveDays} days. A quick update keeps recommendations fresh.`;
  }

  if (resumeDays !== null && resumeDays >= 14) {
    return `Your resume was last updated ${resumeDays} days ago. Refreshing it can improve recruiter visibility.`;
  }

  if (skillDays !== null && skillDays >= 7) {
    return `It's been ${skillDays} days since your last skill update. Adding one skill this week can improve match quality.`;
  }

  return null;
}

function buildNextStep(memory, currentScore) {
  const score = currentScore ?? memory?.current_score ?? 0;

  if (score < 60 && (memory?.skills_added ?? 0) === 0) {
    return {
      action: 'Add your first skill to unlock job recommendations.',
      href: '/skills',
      type: 'skills',
    };
  }

  if (!memory?.resume_improved) {
    return {
      action: 'Improve your resume to increase interview callbacks.',
      href: '/resume-builder',
      type: 'resume',
    };
  }

  if (score < 70) {
    return {
      action: `Add ${Math.ceil((70 - score) / 4)} more skills to reach the 70% threshold.`,
      href: '/skills',
      type: 'skills',
    };
  }

  if ((memory?.jobs_applied ?? 0) === 0) {
    return {
      action: 'Apply to your top job matches — your profile is ready.',
      href: '/job-matches',
      type: 'jobs',
    };
  }

  return {
    action: 'Explore new opportunities to stay ahead.',
    href: '/opportunities',
    type: 'explore',
  };
}

function buildScoreDelta(memory) {
  if (!memory) return null;

  const delta = (memory.current_score ?? 0) - (memory.last_score ?? 0);
  return delta > 0 ? `+${delta.toFixed(0)} pts since last week 🎉` : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────
async function getAvaMemory(userId, currentScore) {
  const key = cacheKey(userId);

  const cached = await getCache(key);
  if (cached) return cached;

  let raw = null;

  try {
    raw = await repo.getMemory(userId);
  } catch (err) {
    logger.warn('[AvaMemoryService] DB read failed', {
      userId,
      error: err.message,
    });
  }

  const scoreNeedsSync =
    currentScore != null &&
    raw &&
    Math.abs((raw.current_score ?? 0) - currentScore) > 2;

  if (scoreNeedsSync) {
    repo.updateScore(userId, currentScore).catch((err) => {
      logger.warn('[AvaMemoryService] async score sync failed', {
        userId,
        error: err.message,
      });
    });

    raw = {
      ...raw,
      current_score: currentScore,
    };
  }

  const context = {
    raw,
    weeklySummary: buildWeeklySummary(raw),
    reminder: buildReminder(raw),
    nextStep: buildNextStep(raw, currentScore),
    scoreDelta: buildScoreDelta(raw),
    stats: {
      skillsAddedThisWeek: raw?.skills_added ?? 0,
      jobsAppliedThisWeek: raw?.jobs_applied ?? 0,
      resumeImproved: raw?.resume_improved ?? false,
      weeklyProgress: raw?.weekly_progress ?? 0,
      currentScore: raw?.current_score ?? currentScore ?? 0,
      lastScore: raw?.last_score ?? 0,
      daysSinceActive: daysSince(raw?.last_active_date),
      isNewUser: raw === null,
    },
  };

  await setCache(key, context);
  return context;
}

async function updateWeeklyMemory(userId) {
  const result = await repo.writeWeeklySnapshot(userId);
  await deleteCache(cacheKey(userId));

  logger.info('[AvaMemoryService] weekly snapshot updated', { userId });

  return result;
}

async function trackEvent(userId, eventType, payload = {}) {
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
      if (payload.score != null) {
        await repo.updateScore(userId, payload.score);
      }
      break;
    default:
      logger.warn('[AvaMemoryService] unknown event', {
        userId,
        eventType,
      });
      return;
  }

  await deleteCache(cacheKey(userId));

  logger.info('[AvaMemoryService] event tracked', {
    userId,
    eventType,
  });
}

async function runWeeklyCron() {
  const BATCH_SIZE = 500;
  const MAX_ITERATIONS = 1000;

  let total = 0;
  let ok = 0;
  let failed = 0;
  let iteration = 0;

  logger.info('[AvaMemoryService] weekly cron started');

  while (iteration < MAX_ITERATIONS) {
    iteration++;

    let batch;
    try {
      batch = await repo.getUsersDueForWeeklySnapshot(BATCH_SIZE);
    } catch (err) {
      logger.warn('[AvaMemoryService] weekly cron batch fetch failed', {
        iteration,
        error: err.message,
      });
      break;
    }

    if (!batch || batch.length === 0) break;

    logger.info('[AvaMemoryService] weekly cron processing batch', {
      iteration,
      batchSize: batch.length,
    });

    const results = await Promise.allSettled(
      batch.map((u) => updateWeeklyMemory(u.user_id))
    );

    const batchOk = results.filter((r) => r.status === 'fulfilled').length;
    const batchFailed = results.length - batchOk;

    total += batch.length;
    ok += batchOk;
    failed += batchFailed;

    logger.info('[AvaMemoryService] weekly cron batch complete', {
      iteration,
      batchOk,
      batchFailed,
      runningTotal: total,
    });
  }

  if (iteration >= MAX_ITERATIONS) {
    logger.warn('[AvaMemoryService] weekly cron hit max iterations safety limit', {
      MAX_ITERATIONS,
      total,
    });
  }

  logger.info('[AvaMemoryService] weekly cron finished', {
    iterations: iteration,
    total,
    ok,
    failed,
  });

  return { total, ok, failed };
}

module.exports = {
  getAvaMemory,
  updateWeeklyMemory,
  trackEvent,
  runWeeklyCron,
};