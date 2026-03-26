'use strict';

/**
 * modules/daily-engagement/services/progress.service.js
 *
 * Career Progress Tracker — Supabase Version
 */

const logger       = require('../../../utils/logger');
const supabase     = require('../../../core/supabaseClient');
const cacheManager = require('../../../core/cache/cache.manager');

const repo = require('../models/engagement.repository');
const { CacheKeys, CACHE_TTL_SEC, PROGRESS_TRIGGERS } = require('../models/engagement.constants');

// ─── Cache helpers ────────────────────────────────────────────────────────────

async function _cacheGet(key) {
  try {
    const raw = await cacheManager.getClient().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function _cacheSet(key, value) {
  try {
    await cacheManager.getClient().set(key, JSON.stringify(value), CACHE_TTL_SEC);
  } catch { /* non-fatal */ }
}

async function _cacheDel(key) {
  try { await cacheManager.getClient().delete(key); } catch { /* non-fatal */ }
}

// ─── Supabase Data Readers ────────────────────────────────────────────────────

async function _readChiScore(userId) {
  try {
    const { data, error } = await supabase
      .from('chi_snapshots')
      .select('chi_score, score, career_health_index')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) throw error;

    return data?.chi_score || data?.score || data?.career_health_index || 0;
  } catch (err) {
    logger.warn('[ProgressService] CHI read failed', { userId, err: err.message });
    return 0;
  }
}

async function _readSkillsCount(userId) {
  try {
    const { data, error } = await supabase
      .from('user_skills')
      .select('skills')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;

    return (data?.skills || []).length;
  } catch (err) {
    logger.warn('[ProgressService] Skills count read failed', { userId, err: err.message });
    return 0;
  }
}

async function _readJobMatchScore(userId) {
  try {
    const { data, error } = await supabase
      .from('job_matches')
      .select('matches, best_match_score')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw error;

    const matches = data?.matches || [];

    if (matches.length > 0) {
      return Math.max(...matches.map(m => m.match_score || m.score || 0));
    }

    return data?.best_match_score || 0;
  } catch (err) {
    logger.warn('[ProgressService] JobMatch score read failed', { userId, err: err.message });
    return 0;
  }
}

// ─── Delta formatter ──────────────────────────────────────────────────────────

function _formatDelta(delta) {
  if (delta === null || delta === undefined) return null;
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function recordProgress({ userId, triggerEvent, overrides = {} }) {
  logger.info('[ProgressService] Recording progress', { userId, triggerEvent });

  const [chiScore, skillsCount, jobMatchScore] = await Promise.all([
    overrides.chi != null
      ? Promise.resolve(overrides.chi)
      : _readChiScore(userId),

    overrides.skills_count != null
      ? Promise.resolve(overrides.skills_count)
      : _readSkillsCount(userId),

    overrides.job_match_score != null
      ? Promise.resolve(overrides.job_match_score)
      : _readJobMatchScore(userId),
  ]);

  const snapshot = await repo.insertProgressSnapshot({
    user_id:             userId,
    career_health_index: chiScore,
    skills_count:        skillsCount,
    job_match_score:     jobMatchScore,
    trigger_event:       triggerEvent || PROGRESS_TRIGGERS.MANUAL,
    snapshot: {
      chi_score:       chiScore,
      skills_count:    skillsCount,
      job_match_score: jobMatchScore,
      recorded_by:     triggerEvent || 'manual',
    },
  });

  await _cacheDel(CacheKeys.progress(userId));

  logger.info('[ProgressService] Progress recorded', {
    userId,
    chi: chiScore,
    skills: skillsCount,
    jobMatch: jobMatchScore,
  });

  return snapshot;
}

async function getProgressReport(userId) {
  const cacheKey = CacheKeys.progress(userId);

  const cached = await _cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  const [history, latest] = await Promise.all([
    repo.getProgressHistory(userId, { limit: 30, days: 90 }),
    repo.getProgressHistory(userId, { limit: 2, days: 3650 }),
  ]);

  const current  = latest[latest.length - 1] || null;
  const previous = latest.length >= 2 ? latest[latest.length - 2] : null;

  const report = {
    current: current ? {
      career_health_index: current.career_health_index,
      skills_count:        current.skills_count,
      job_match_score:     current.job_match_score,
      recorded_at:         current.recorded_at,
    } : null,

    previous: previous ? {
      career_health_index: previous.career_health_index,
      skills_count:        previous.skills_count,
      job_match_score:     previous.job_match_score,
      recorded_at:         previous.recorded_at,
    } : null,

    improvement: current && previous ? {
      career_health_index: _formatDelta(current.chi_delta),
      skills_count:        _formatDelta(current.skills_delta),
      job_match_score:     _formatDelta(current.job_match_delta),
    } : null,

    history: history.map(h => ({
      recorded_at:         h.recorded_at,
      career_health_index: h.career_health_index,
      skills_count:        h.skills_count,
      job_match_score:     h.job_match_score,
      trigger_event:       h.trigger_event,
    })),

    has_data: history.length > 0,
    cached:   false,
  };

  await _cacheSet(cacheKey, report);

  return report;
}

module.exports = {
  recordProgress,
  getProgressReport,
};





