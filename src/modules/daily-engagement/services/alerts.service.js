'use strict';

/**
 * modules/daily-engagement/services/alerts.service.js
 *
 * Production-grade Career Opportunity Alerts service.
 *
 * Improvements:
 * - stronger dedupe hashing
 * - centralized cache invalidation
 * - Redis TTL-safe writes
 * - reusable alert persistence flow
 * - better retry-storm safety
 */

const crypto = require('crypto');
const logger = require('../../../utils/logger');
const cacheManager = require('../../../core/cache/cache.manager');

const repo = require('../models/engagement.repository');
const {
  ALERT_TYPES,
  ALERT_PRIORITY,
  CacheKeys,
  CACHE_TTL_SEC,
} = require('../models/engagement.constants');

// ─────────────────────────────────────────────────────────────────────────────
// Cache helpers
// ─────────────────────────────────────────────────────────────────────────────

function getCacheClient() {
  return cacheManager.getClient();
}

async function cacheGet(key) {
  try {
    const raw = await getCacheClient().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    logger.debug('[AlertsService] Cache read failed', {
      key,
      error: error.message,
    });
    return null;
  }
}

async function cacheSet(key, value) {
  try {
    await getCacheClient().set(
      key,
      JSON.stringify(value),
      { ttl: CACHE_TTL_SEC }
    );
  } catch (error) {
    logger.debug('[AlertsService] Cache write failed', {
      key,
      error: error.message,
    });
  }
}

async function cacheDel(key) {
  try {
    await getCacheClient().delete(key);
  } catch (error) {
    logger.debug('[AlertsService] Cache delete failed', {
      key,
      error: error.message,
    });
  }
}

async function invalidateUserAlertCache(userId) {
  await Promise.all([
    cacheDel(CacheKeys.alerts(userId)),
    cacheDel(CacheKeys.unread(userId)),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function buildDedupKey(userId, alertType, signalId) {
  const today = new Date().toISOString().slice(0, 10);

  const hash = crypto
    .createHash('sha1')
    .update(String(signalId ?? 'general'))
    .digest('hex')
    .slice(0, 16);

  return `${userId}:${alertType}:${hash}:${today}`;
}

function resolvePriority(alertType, score = 0) {
  if (alertType === ALERT_TYPES.RISK_WARNING) {
    return ALERT_PRIORITY.HIGH;
  }

  if (alertType === ALERT_TYPES.JOB_MATCH) {
    if (score >= 85) return ALERT_PRIORITY.CRITICAL;
    if (score >= 70) return ALERT_PRIORITY.HIGH;
    return ALERT_PRIORITY.MEDIUM;
  }

  if (alertType === ALERT_TYPES.CAREER_OPPORTUNITY) {
    return ALERT_PRIORITY.HIGH;
  }

  if (alertType === ALERT_TYPES.SKILL_DEMAND) {
    return score >= 30
      ? ALERT_PRIORITY.HIGH
      : ALERT_PRIORITY.MEDIUM;
  }

  if (alertType === ALERT_TYPES.SALARY_TREND) {
    return ALERT_PRIORITY.MEDIUM;
  }

  if (alertType === ALERT_TYPES.MARKET_SHIFT) {
    return ALERT_PRIORITY.LOW;
  }

  return ALERT_PRIORITY.INFORMATIONAL;
}

async function persistAlert(userId, payload) {
  const alert = await repo.insertAlert(payload);

  if (alert) {
    await invalidateUserAlertCache(userId);
  }

  return alert;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factories
// ─────────────────────────────────────────────────────────────────────────────

async function createJobMatchAlert({
  userId,
  jobTitle,
  company,
  matchScore,
  jobId,
}) {
  const signalId =
    jobId ?? `${jobTitle}_${company ?? 'unknown'}`;

  return persistAlert(userId, {
    user_id: userId,
    alert_type: ALERT_TYPES.JOB_MATCH,
    title: `New job match found: ${jobTitle}`,
    description:
      `A ${jobTitle} role${company ? ` at ${company}` : ''} matches your profile ` +
      `with a score of ${matchScore}%. ` +
      (matchScore >= 80
        ? 'This is a strong match — act quickly.'
        : 'Review the role to see if it fits your goals.'),
    alert_priority: resolvePriority(
      ALERT_TYPES.JOB_MATCH,
      matchScore
    ),
    action_url: jobId ? `/jobs/${jobId}` : '/jobs',
    dedup_key: buildDedupKey(
      userId,
      ALERT_TYPES.JOB_MATCH,
      signalId
    ),
    payload: {
      job_title: jobTitle,
      company: company ?? null,
      match_score: matchScore ?? null,
      job_id: jobId ?? null,
    },
  });
}

async function createSkillDemandAlert({
  userId,
  skill,
  growthRate,
}) {
  return persistAlert(userId, {
    user_id: userId,
    alert_type: ALERT_TYPES.SKILL_DEMAND,
    title: `${skill} skill demand surging`,
    description:
      `Demand for ${skill} has increased by ${Math.round(growthRate)}% this month. ` +
      'This skill is trending in your industry — consider adding it to your profile.',
    alert_priority: resolvePriority(
      ALERT_TYPES.SKILL_DEMAND,
      growthRate
    ),
    action_url: `/skills?highlight=${encodeURIComponent(skill)}`,
    dedup_key: buildDedupKey(
      userId,
      ALERT_TYPES.SKILL_DEMAND,
      skill
    ),
    payload: {
      skill,
      growth_rate: growthRate,
    },
  });
}

async function createOpportunityAlert({
  userId,
  opportunityTitle,
  matchScore,
  opportunityId,
}) {
  return persistAlert(userId, {
    user_id: userId,
    alert_type: ALERT_TYPES.CAREER_OPPORTUNITY,
    title: `New career opportunity: ${opportunityTitle}`,
    description:
      `A new ${opportunityTitle} opportunity matches your profile with a score of ${matchScore}%. ` +
      'Review it in your Opportunity Radar.',
    alert_priority: resolvePriority(
      ALERT_TYPES.CAREER_OPPORTUNITY,
      matchScore
    ),
    action_url: '/career-opportunities',
    dedup_key: buildDedupKey(
      userId,
      ALERT_TYPES.CAREER_OPPORTUNITY,
      opportunityId ?? opportunityTitle
    ),
    payload: {
      opportunity_title: opportunityTitle,
      match_score: matchScore,
      opportunity_id: opportunityId ?? null,
    },
  });
}

async function createSalaryTrendAlert({
  userId,
  role,
  salaryChange,
  direction,
}) {
  const isPositive = direction === 'up' || salaryChange > 0;
  const pct = Math.abs(Math.round(salaryChange));

  return persistAlert(userId, {
    user_id: userId,
    alert_type: ALERT_TYPES.SALARY_TREND,
    title: `${role} salaries ${isPositive ? 'increased' : 'decreased'} by ${pct}%`,
    description:
      `Market salaries for ${role} have ${isPositive ? 'risen' : 'fallen'} ${pct}% this month. ` +
      (isPositive
        ? 'This could be a good time to negotiate or explore new roles.'
        : 'Review your career strategy for this role.'),
    alert_priority: ALERT_PRIORITY.LOW,
    action_url: '/analytics',
    dedup_key: buildDedupKey(
      userId,
      ALERT_TYPES.SALARY_TREND,
      role
    ),
    payload: {
      role,
      salary_change: salaryChange,
      direction,
    },
  });
}

async function createRiskWarningAlert({
  userId,
  riskScore,
  topFactor,
}) {
  return persistAlert(userId, {
    user_id: userId,
    alert_type: ALERT_TYPES.RISK_WARNING,
    title: 'Career risk level has increased',
    description:
      `Your career risk score is now ${riskScore}/100. ` +
      `${topFactor ? `Primary concern: ${topFactor}. ` : ''}` +
      'Take action to reduce exposure — review your skill plan.',
    alert_priority:
      riskScore >= 75
        ? ALERT_PRIORITY.CRITICAL
        : ALERT_PRIORITY.HIGH,
    action_url: '/career-health',
    dedup_key: buildDedupKey(
      userId,
      ALERT_TYPES.RISK_WARNING,
      `risk_${Math.floor(riskScore / 10) * 10}`
    ),
    payload: {
      risk_score: riskScore,
      top_factor: topFactor ?? null,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Queries
// ─────────────────────────────────────────────────────────────────────────────

async function getAlertsFeed(userId, opts = {}) {
  const cacheKey = CacheKeys.alerts(userId);

  const isDefault =
    !opts.unreadOnly &&
    !opts.alertType &&
    !opts.offset;

  if (isDefault) {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }
  }

  const [alerts, unreadCount] = await Promise.all([
    repo.getUserAlerts(userId, opts),
    repo.getUnreadAlertCount(userId),
  ]);

  const result = {
    alerts,
    unread_count: unreadCount,
    cached: false,
  };

  if (isDefault) {
    await cacheSet(cacheKey, result);
  }

  return result;
}

async function markAlertsRead(userId, ids = []) {
  const updated = await repo.markAlertsRead(userId, ids);

  await invalidateUserAlertCache(userId);

  const unreadCount = await repo.getUnreadAlertCount(userId);

  return {
    updated,
    unread_count: unreadCount,
  };
}

module.exports = {
  createJobMatchAlert,
  createSkillDemandAlert,
  createOpportunityAlert,
  createSalaryTrendAlert,
  createRiskWarningAlert,
  getAlertsFeed,
  markAlertsRead,
};